/**
 * Backblaze B2 cold-archive client.
 *
 * S3-compatible API; same @aws-sdk/client-s3 lib as server/r2.ts.
 *
 * Object Lock: bucket `mintvault-cold-archive` has Compliance retention
 * enabled with a 90-day default. Every uploadToB2 call passes an explicit
 * ObjectLockRetainUntilDate (90 days from now by default) so the retention
 * is set per-object regardless of bucket-level defaults.
 *
 * NO delete helper exported. Object Lock in Compliance mode prevents
 * deletion within retention anyway; not even the bucket owner can override.
 * If a future migration needs object eviction, that's a phase 3 conversation
 * with explicit Governance retention or Legal Hold workflows.
 */
import { S3Client, PutObjectCommand, HeadObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";

let b2Client: S3Client | null = null;

export function getB2Client(): S3Client {
  if (b2Client) return b2Client;
  const endpoint = process.env.B2_ENDPOINT;
  const accessKeyId = process.env.B2_KEY_ID;
  const secretAccessKey = process.env.B2_APPLICATION_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error("B2 credentials not configured (B2_ENDPOINT, B2_KEY_ID, B2_APPLICATION_KEY)");
  }
  b2Client = new S3Client({
    region: "auto",
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    // B2's S3-compatible API has the same checksum-protocol quirks as R2 —
    // pin both to WHEN_REQUIRED so @smithy/hash-stream-node doesn't attach
    // its flexible-checksums middleware to GetObject responses.
    // (See r2.ts comment for the original context.)
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  return b2Client;
}

export function getB2Bucket(): string {
  const bucket = process.env.B2_BUCKET;
  if (!bucket) throw new Error("B2_BUCKET not set");
  return bucket;
}

/**
 * Upload an object to B2 with Object Lock Compliance retention.
 *
 * Caller passes the raw object body + the original content-type. No
 * Cache-Control is set: cold tier, never served directly to clients.
 *
 * Retention: defaults to 90 days. Pass a different value for one-off
 * imports or future tiers; nothing reads the parameter dynamically yet
 * but the door is open.
 */
export async function uploadToB2(
  key: string,
  body: Buffer,
  contentType: string,
  retentionDays: number = 90,
): Promise<string> {
  const client = getB2Client();
  const retainUntil = new Date(Date.now() + retentionDays * 86_400_000);
  await client.send(new PutObjectCommand({
    Bucket: getB2Bucket(),
    Key: key,
    Body: body,
    ContentType: contentType,
    ObjectLockMode: "COMPLIANCE",
    ObjectLockRetainUntilDate: retainUntil,
  }));
  return key;
}

/**
 * Returns true if an object exists at `key`. Returns false on 404 / NotFound.
 * Throws on any other error (auth failure, network, bucket-not-found, etc.)
 * so the caller can fail loudly rather than silently double-uploading.
 */
export async function existsInB2(key: string): Promise<boolean> {
  const client = getB2Client();
  try {
    await client.send(new HeadObjectCommand({
      Bucket: getB2Bucket(),
      Key: key,
    }));
    return true;
  } catch (err: any) {
    // S3-compatible APIs report missing objects as 404 / NotFound /
    // NoSuchKey. Normalise across SDK shapes.
    const status = err?.$metadata?.httpStatusCode ?? err?.statusCode;
    const name = err?.name ?? err?.Code;
    if (status === 404 || name === "NotFound" || name === "NoSuchKey") return false;
    throw err;
  }
}

/**
 * Paginated ListObjectsV2 over a prefix. Returns every matched object.
 * Used by verification queries and admin status endpoint. Don't call this
 * for very wide prefixes in hot paths — it pages until exhausted.
 */
export async function listB2Prefix(prefix: string): Promise<{ key: string; size: number; lastModified: Date | undefined }[]> {
  const client = getB2Client();
  const out: { key: string; size: number; lastModified: Date | undefined }[] = [];
  let token: string | undefined = undefined;
  do {
    const r: any = await client.send(new ListObjectsV2Command({
      Bucket: getB2Bucket(),
      Prefix: prefix,
      ContinuationToken: token,
      MaxKeys: 1000,
    }));
    for (const o of (r.Contents ?? [])) {
      if (!o.Key) continue;
      out.push({
        key: o.Key,
        size: o.Size ?? 0,
        lastModified: o.LastModified,
      });
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}
