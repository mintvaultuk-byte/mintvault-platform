import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

let s3Client: S3Client | null = null;

/**
 * A deliberately opt-in adapter for physical scanner proof on a developer
 * workstation. The checked-in development database currently shares an R2
 * bucket with production, so a real card capture must never fall through to
 * those credentials. This adapter is unavailable in production and mirrors
 * only the object semantics the local proof needs.
 */
function localEvidenceDirectory(): string | null {
  const configured = process.env.MINTVAULT_LOCAL_EVIDENCE_DIR?.trim();
  if (!configured) return null;
  if (process.env.NODE_ENV === "production") {
    throw new Error("MINTVAULT_LOCAL_EVIDENCE_DIR is development-only and cannot be enabled in production");
  }
  if (!path.isAbsolute(configured)) {
    throw new Error("MINTVAULT_LOCAL_EVIDENCE_DIR must be an absolute path");
  }
  return path.resolve(configured);
}

function localEvidencePath(root: string, key: string): string {
  const normalised = path.posix.normalize(String(key).replaceAll("\\", "/"));
  if (
    !normalised ||
    normalised === "." ||
    normalised.startsWith("../") ||
    path.posix.isAbsolute(normalised) ||
    normalised.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Local evidence object key is invalid");
  }
  const candidate = path.resolve(root, ...normalised.split("/"));
  if (!candidate.startsWith(`${root}${path.sep}`)) throw new Error("Local evidence object key escapes its root");
  return candidate;
}

async function writeLocalObject(root: string, key: string, body: Buffer): Promise<string> {
  const target = localEvidencePath(root, key);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.pending-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await fs.writeFile(temporary, body, { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
  return key;
}

async function readLocalObject(root: string, key: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(localEvidencePath(root, key));
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function listLocalEvidence(root: string): Promise<Array<{ key: string; sizeBytes: number; lastModified: Date }>> {
  const entries: Array<{ key: string; sizeBytes: number; lastModified: Date }> = [];
  const walk = async (directory: string): Promise<void> => {
    try {
      const children = await fs.readdir(directory, { withFileTypes: true, encoding: "utf8" });
      for (const child of children) {
        const childPath = path.join(directory, child.name);
        if (child.isDirectory()) {
          await walk(childPath);
        } else if (child.isFile() && !child.name.endsWith(".mintvault-metadata.json")) {
          const stat = await fs.stat(childPath);
          entries.push({
            key: path.relative(root, childPath).split(path.sep).join("/"),
            sizeBytes: stat.size,
            lastModified: stat.mtime,
          });
        }
      }
    } catch (error: any) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  };
  await walk(root);
  return entries;
}

export function getR2Client(): S3Client {
  if (localEvidenceDirectory())
    throw new Error("R2 client is unavailable while the local development evidence adapter is enabled");
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
  const localRoot = localEvidenceDirectory();
  if (localRoot) return writeLocalObject(localRoot, key, body);
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
 * Create an evidence object once. The caller supplies a content-addressed key;
 * an existing object is accepted only when its recorded SHA-256 and byte count
 * prove it is the exact same object. This prevents a retry or a second scanner
 * from silently overwriting master evidence.
 *
 * Bucket credentials must additionally deny DeleteObject/PutObject overwrite for
 * the `evidence/masters/` prefix in production. Application checks cannot stop
 * a credential holder from using the R2 API directly.
 */
export async function uploadImmutableEvidenceToR2(
  key: string,
  body: Buffer,
  metadata: Record<string, string>
): Promise<string> {
  const localRoot = localEvidenceDirectory();
  if (localRoot) {
    const target = localEvidencePath(localRoot, key);
    const metadataPath = `${target}.mintvault-metadata.json`;
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    try {
      const [existing, storedMetadata] = await Promise.all([fs.readFile(target), fs.readFile(metadataPath, "utf8")]);
      const parsed = JSON.parse(storedMetadata) as Record<string, string>;
      if (
        existing.length === body.length &&
        parsed.sha256 === metadata.sha256 &&
        parsed.evidenceclass === metadata.evidenceclass
      ) {
        return key;
      }
      throw new Error(`Refusing to overwrite immutable local evidence object ${key}`);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    try {
      const handle = await fs.open(target, "wx", 0o600);
      try {
        await handle.writeFile(body);
      } finally {
        await handle.close();
      }
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      const [existing, storedMetadata] = await Promise.all([fs.readFile(target), fs.readFile(metadataPath, "utf8")]);
      const parsed = JSON.parse(storedMetadata) as Record<string, string>;
      if (
        existing.length === body.length &&
        parsed.sha256 === metadata.sha256 &&
        parsed.evidenceclass === metadata.evidenceclass
      ) {
        return key;
      }
      throw new Error(`Refusing to overwrite immutable local evidence object ${key}`);
    }
    await fs.writeFile(metadataPath, JSON.stringify(metadata), { mode: 0o600 });
    return key;
  }
  const client = getClient();
  const bucket = getBucket();
  try {
    const existing = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    if (
      existing.ContentLength === body.length &&
      existing.Metadata?.sha256 === metadata.sha256 &&
      existing.Metadata?.evidenceclass === metadata.evidenceclass
    ) {
      return key; // idempotent re-drive of the identical evidence bytes
    }
    throw new Error(`Refusing to overwrite immutable evidence object ${key}`);
  } catch (err: any) {
    const status = err?.$metadata?.httpStatusCode;
    const name = err?.name;
    if (status !== 404 && name !== "NotFound" && name !== "NoSuchKey") throw err;
  }

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: "image/tiff",
      CacheControl: "private, no-store",
      Metadata: metadata,
      // Conditional creation closes the normal racing-PUT window. If the
      // backend reports a precondition failure, a re-drive will HEAD and verify
      // the existing content on its next attempt instead of overwriting it.
      IfNoneMatch: "*",
    })
  );
  return key;
}

export async function getR2SignedUrl(key: string, expiresInSeconds: number = 600): Promise<string> {
  if (localEvidenceDirectory()) {
    throw new Error(`Local development evidence has no browser signed URL for ${key}`);
  }
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

export type ScannerEvidenceStagingUpload =
  | { transport: "direct"; uploadUrl: string; headers: Record<string, string>; expiresInSeconds: number }
  | { transport: "server_multipart"; uploadUrl: null; headers: Record<string, string>; expiresInSeconds: number };

/**
 * Mint a one-purpose PUT URL for an already server-owned staging key.  Callers
 * never provide a bucket or arbitrary object name: the capture-session service
 * creates and persists the opaque key before this function is reached.
 *
 * Local evidence deliberately has no pseudo-presigned URL.  The development
 * scanner uses the bounded multipart compatibility route instead, so a local
 * test cannot accidentally exercise production object-store authority.
 */
export async function createScannerEvidenceStagingUpload(
  key: string,
  expiresInSeconds: number = 15 * 60
): Promise<ScannerEvidenceStagingUpload> {
  if (localEvidenceDirectory()) {
    return { transport: "server_multipart", uploadUrl: null, headers: {}, expiresInSeconds };
  }
  const uploadUrl = await getSignedUrl(
    getClient(),
    new PutObjectCommand({
      Bucket: getBucket(),
      Key: key,
      ContentType: "image/tiff",
      CacheControl: "private, no-store",
    }),
    { expiresIn: expiresInSeconds }
  );
  return {
    transport: "direct",
    uploadUrl,
    // The signed command binds this exact representation.  Electron supplies
    // only these server-returned headers plus Content-Length for its file stream.
    headers: { "content-type": "image/tiff", "cache-control": "private, no-store" },
    expiresInSeconds,
  };
}

export async function deleteFromR2(key: string): Promise<void> {
  const localRoot = localEvidenceDirectory();
  if (localRoot) {
    const target = localEvidencePath(localRoot, key);
    await Promise.all([fs.unlink(target), fs.unlink(`${target}.mintvault-metadata.json`)]).catch(async (error: any) => {
      if (error?.code === "ENOENT") return;
      throw error;
    });
    return;
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
  const localRoot = localEvidenceDirectory();
  if (localRoot) return readLocalObject(localRoot, key);
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
  const localRoot = localEvidenceDirectory();
  if (localRoot) {
    try {
      const target = localEvidencePath(localRoot, key);
      const stat = await fs.stat(target);
      return { body: createReadStream(target), contentLength: stat.size };
    } catch (error: any) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }
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
  const localRoot = localEvidenceDirectory();
  if (localRoot)
    return (await listLocalEvidence(localRoot)).map((entry) => entry.key).filter((key) => key.startsWith(prefix));
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
  const localRoot = localEvidenceDirectory();
  if (localRoot) {
    return (await listLocalEvidence(localRoot))
      .filter((entry) => entry.key.startsWith(prefix))
      .map((entry) => ({ ...entry }));
  }
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
export async function headR2(key: string): Promise<{ lastModified: Date } | null> {
  const localRoot = localEvidenceDirectory();
  if (localRoot) {
    try {
      return { lastModified: (await fs.stat(localEvidencePath(localRoot, key))).mtime };
    } catch (error: any) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }
  try {
    const client = getClient();
    const result = await client.send(
      new HeadObjectCommand({
        Bucket: getBucket(),
        Key: key,
      })
    );
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
  const localRoot = localEvidenceDirectory();
  if (localRoot) {
    const cutoff = Date.now() - maxAgeMs;
    const stale = (await listLocalEvidence(localRoot)).filter(
      (entry) => entry.key.startsWith("pre-grade-checker/") && entry.lastModified.getTime() < cutoff
    );
    for (const entry of stale) await deleteFromR2(entry.key);
    return stale.length;
  }
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
