import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command, HeadObjectCommand } from "@aws-sdk/client-s3";
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
  await client.send(new PutObjectCommand({
    Bucket: getBucket(),
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: DEFAULT_CACHE_CONTROL,
  }));
  return key;
}

export async function getR2SignedUrl(key: string, expiresInSeconds: number = 600): Promise<string> {
  const client = getClient();
  return getSignedUrl(client, new GetObjectCommand({
    Bucket: getBucket(),
    Key: key,
  }), { expiresIn: expiresInSeconds });
}

export async function deleteFromR2(key: string): Promise<void> {
  const client = getClient();
  await client.send(new DeleteObjectCommand({
    Bucket: getBucket(),
    Key: key,
  }));
}

/**
 * HEAD an R2 object — returns LastModified or null on any error.
 * Used by the logbook PDF cache stale-check (compare against cert.updated_at).
 * Failure modes (404, network, no creds) all return null → caller treats as
 * "no cache" and regenerates, which is the safe default.
 */
export async function headR2(key: string): Promise<{ lastModified: Date } | null> {
  try {
    const client = getClient();
    const result = await client.send(new HeadObjectCommand({
      Bucket: getBucket(),
      Key: key,
    }));
    return result.LastModified ? { lastModified: result.LastModified } : null;
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
    const list = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));

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
