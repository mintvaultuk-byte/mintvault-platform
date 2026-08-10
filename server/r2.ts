import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

let s3Client: S3Client | null = null;

export function getR2Client(): S3Client {
  return getClient();
}

function getClient(): S3Client {
  if (s3Client) return s3Client;
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error("R2 credentials not configured (R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)");
  }
  s3Client = new S3Client({
    region: "auto",
    endpoint,
    forcePathStyle: process.env.R2_FORCE_PATH_STYLE === "1",
    credentials: { accessKeyId, secretAccessKey },
    // Cloudflare R2 doesn't require AWS's flexible-checksums protocol and
    // its body framing trips @smithy/hash-stream-node ("Unable to calculate
    // hash for flowing readable stream") on GetObject responses. Both
    // defaults flipped to WHEN_SUPPORTED around AWS SDK 3.729 — pin them
    // back to WHEN_REQUIRED so the middleware doesn't attach to R2 calls.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  return s3Client;
}

function getBucket(): string {
  const bucket = process.env.R2_BUCKET_NAME;
  if (!bucket) throw new Error("R2_BUCKET_NAME not set");
  return bucket;
}

// Default cache policy for uploads. Cert-keyed R2 objects are content-stable
// per cert number (overwrites re-create the same key), so aggressive caching
// is safe. With signed-URL access today this header only helps within a
// single presigned URL's lifetime (~10 min) and for back/forward browser
// navigation; it becomes meaningful once R2 is fronted by a CDN or served
// publicly. Harmless in the meantime.
const DEFAULT_CACHE_CONTROL = "public, max-age=31536000, immutable";

export async function uploadToR2(key: string, body: Buffer, contentType: string): Promise<string> {
  const client = getClient();
  await client.send(
    new PutObjectCommand({
      Bucket: getBucket(),
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: DEFAULT_CACHE_CONTROL,
    })
  );
  return key;
}

/**
 * Stores a content-addressed evidence object once. A retry may reuse only an
 * object whose recorded hash and byte count prove it is the identical body;
 * any other existing object is an overwrite attempt and fails closed.
 */
export async function uploadImmutableEvidenceToR2(
  key: string,
  body: Buffer,
  metadata: Record<string, string>,
  contentType: string
): Promise<string> {
  const client = getClient();
  const bucket = getBucket();
  try {
    const existing = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    if (
      existing.ContentLength === body.length &&
      existing.Metadata?.sha256 === metadata.sha256 &&
      existing.Metadata?.evidenceclass === metadata.evidenceclass
    ) {
      return key;
    }
    throw new Error(`Refusing to overwrite immutable evidence object ${key}`);
  } catch (error) {
    const candidate = error as { $metadata?: { httpStatusCode?: number }; name?: string };
    const status = candidate.$metadata?.httpStatusCode;
    if (status !== 404 && candidate.name !== "NotFound" && candidate.name !== "NoSuchKey") throw error;
  }

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: "private, no-store",
      Metadata: metadata,
      IfNoneMatch: "*",
    })
  );
  return key;
}

export async function getR2SignedUrl(key: string, expiresInSeconds: number = 600): Promise<string> {
  const client = getClient();
  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: getBucket(),
      Key: key,
    }),
    { expiresIn: expiresInSeconds }
  );
}

export async function deleteFromR2(key: string): Promise<void> {
  if (key.startsWith("evidence/")) {
    throw new Error("Evidence objects are immutable and cannot be deleted through the application");
  }
  const client = getClient();
  await client.send(
    new DeleteObjectCommand({
      Bucket: getBucket(),
      Key: key,
    })
  );
}

/** Download an R2 object into a Buffer (null on missing / any error). Used by the
 *  scan reconciler to re-drive processing from the retained raw scans. */
export async function getR2Buffer(key: string): Promise<Buffer | null> {
  try {
    const out = await getClient().send(new GetObjectCommand({ Bucket: getBucket(), Key: key }));
    if (!out.Body) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of out.Body as any) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

/** Stream an R2 object (null on missing / any error) WITHOUT buffering it whole in
 *  memory. Used by the durable VQ export download so a finished pack/proxy can be
 *  streamed back same-origin (behind admin auth) from any machine — the bytes live
 *  in shared R2, not on the machine that rendered them. */
export async function getR2ObjectStream(
  key: string
): Promise<{ body: NodeJS.ReadableStream; contentLength?: number; contentType?: string } | null> {
  try {
    const out = await getClient().send(new GetObjectCommand({ Bucket: getBucket(), Key: key }));
    if (!out.Body) return null;
    return {
      body: out.Body as NodeJS.ReadableStream,
      contentLength: out.ContentLength,
      contentType: out.ContentType,
    };
  } catch {
    return null;
  }
}

/** List object keys under a prefix — used to locate raw_front.* / raw_back.*
 *  whose extension varies (.tif/.jpg/.png). */
export async function listR2Keys(prefix: string): Promise<string[]> {
  try {
    const out = await getClient().send(new ListObjectsV2Command({ Bucket: getBucket(), Prefix: prefix }));
    return (out.Contents || []).map((o) => o.Key || "").filter(Boolean);
  } catch {
    return [];
  }
}

/** List objects under a prefix WITH metadata (key + size + last-modified), paged.
 *  Read-only; used by the VQ orphan reconciler, whose age filter needs
 *  LastModified (which listR2Keys drops). Returns [] on any error. */
export async function listR2Objects(
  prefix: string
): Promise<{ key: string; sizeBytes: number | null; lastModified: Date | null }[]> {
  const out: { key: string; sizeBytes: number | null; lastModified: Date | null }[] = [];
  try {
    const client = getClient();
    const bucket = getBucket();
    let continuationToken: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken })
      );
      for (const o of page.Contents ?? []) {
        if (o.Key) out.push({ key: o.Key, sizeBytes: o.Size ?? null, lastModified: o.LastModified ?? null });
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
  } catch {
    return [];
  }
  return out;
}

/**
 * HEAD an R2 object — returns LastModified or null on any error.
 * Used by the logbook PDF cache stale-check (compare against cert.updated_at).
 * Failure modes (404, network, no creds) all return null → caller treats as
 * "no cache" and regenerates, which is the safe default.
 */
export async function headR2(key: string): Promise<{
  lastModified: Date;
  contentLength: number | null;
  contentType: string | null;
  eTag: string | null;
} | null> {
  try {
    const client = getClient();
    const result = await client.send(
      new HeadObjectCommand({
        Bucket: getBucket(),
        Key: key,
      })
    );
    return result.LastModified
      ? {
          lastModified: result.LastModified,
          contentLength: result.ContentLength ?? null,
          contentType: result.ContentType ?? null,
          eTag: result.ETag ?? null,
        }
      : null;
  } catch {
    return null;
  }
}

export function r2KeyForImage(certId: string, side: "front" | "back", ext: string): string {
  return `images/${certId}/${side}.${ext}`;
}

export function r2KeyForLabel(certId: string, side: "front" | "back" | "both", format: "png" | "pdf"): string {
  return `labels/${certId}/${side}.${format}`;
}

// Safety-net cleanup: delete any pre-grade-checker objects older than maxAgeMs.
// In normal operation this prefix should always be empty because the estimate endpoint
// never writes to R2. This job exists purely as a failsafe in case something changes.
export async function cleanupStalePreGradeImages(maxAgeMs = 60 * 60 * 1000): Promise<number> {
  let client: S3Client;
  let bucket: string;
  try {
    client = getClient();
    bucket = getBucket();
  } catch {
    // R2 not configured in this environment — skip silently
    return 0;
  }

  const prefix = "pre-grade-checker/";
  const cutoff = Date.now() - maxAgeMs;
  let deleted = 0;
  let continuationToken: string | undefined;

  do {
    const list = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );

    for (const obj of list.Contents ?? []) {
      if (!obj.Key) continue;
      const lastModified = obj.LastModified?.getTime() ?? 0;
      if (lastModified < cutoff) {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key }));
        deleted++;
      }
    }

    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (continuationToken);

  return deleted;
}
