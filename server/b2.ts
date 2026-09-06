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
import { createHash } from "node:crypto";
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectRetentionCommand,
  type ListObjectsV2CommandOutput,
} from "@aws-sdk/client-s3";

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
  retentionDays: number = 90
): Promise<string> {
  const client = getB2Client();
  const retainUntil = new Date(Date.now() + retentionDays * 86_400_000);
  await client.send(
    new PutObjectCommand({
      Bucket: getB2Bucket(),
      Key: key,
      Body: body,
      ContentType: contentType,
      // B2 does not expose a portable SHA-256 for every historical S3 object.
      // Keep the source digest alongside new objects for operator inspection,
      // while inspectB2ObjectIntegrity still hashes the stored bytes rather than
      // trusting caller-controlled metadata.
      Metadata: {
        sha256: createHash("sha256").update(body).digest("hex"),
        byte_length: String(body.length),
      },
      ObjectLockMode: "COMPLIANCE",
      ObjectLockRetainUntilDate: retainUntil,
    })
  );
  return key;
}

/** Provider-side conditional B2 creation for the durable object coordinator. */
export async function uploadCreateOnlyToB2(
  key: string,
  body: Buffer,
  contentType: string,
  minimumRetainUntil: Date,
  abortSignal?: AbortSignal
): Promise<string> {
  if (!Number.isFinite(minimumRetainUntil.getTime()) || minimumRetainUntil.getTime() <= Date.now()) {
    throw new Error("B2 Compliance retention deadline must be in the future");
  }
  await getB2Client().send(
    new PutObjectCommand({
      Bucket: getB2Bucket(),
      Key: key,
      Body: body,
      ContentType: contentType,
      Metadata: {
        sha256: createHash("sha256").update(body).digest("hex"),
        byte_length: String(body.length),
      },
      ObjectLockMode: "COMPLIANCE",
      ObjectLockRetainUntilDate: minimumRetainUntil,
      IfNoneMatch: "*",
    }),
    abortSignal ? { abortSignal } : undefined
  );
  return key;
}

/**
 * Extend the COMPLIANCE retention of an existing object version addressed by
 * `key`. This never shortens retention and cannot repair a non-COMPLIANCE or
 * corrupt object; callers must inspect first and re-inspect afterwards. The B2
 * application key therefore needs the provider capability that permits writing
 * file retention settings in addition to ordinary object writes.
 */
export async function extendB2ComplianceRetention(key: string, retainUntil: Date): Promise<void> {
  if (!Number.isFinite(retainUntil.getTime()) || retainUntil.getTime() <= Date.now()) {
    throw new Error("B2 Compliance retention extension must end in the future");
  }
  await getB2Client().send(
    new PutObjectRetentionCommand({
      Bucket: getB2Bucket(),
      Key: key,
      Retention: {
        Mode: "COMPLIANCE",
        RetainUntilDate: retainUntil,
      },
    })
  );
}

export type B2ObjectIntegrity =
  | { exists: false }
  | {
      exists: true;
      byteLength: number;
      sha256: string;
      contentType: string | undefined;
      versionId: string;
      objectLockMode: string | undefined;
      objectLockRetainUntil: Date | undefined;
    };

function isNotFoundError(err: unknown): boolean {
  const shaped = err as {
    $metadata?: { httpStatusCode?: number };
    statusCode?: number;
    name?: string;
    Code?: string;
  };
  const status = shaped?.$metadata?.httpStatusCode ?? shaped?.statusCode;
  const name = shaped?.name ?? shaped?.Code;
  return status === 404 || name === "NotFound" || name === "NoSuchKey";
}

/**
 * Read and hash the bytes actually stored in B2.
 *
 * A HEAD/existence check cannot prove archive integrity: a stale, truncated or
 * unrelated object under the expected key would look successful. This helper
 * first uses HEAD for a cheap size sanity check, then streams GET bytes through
 * SHA-256. It therefore also verifies historical B2 objects which pre-date the
 * sha256 user metadata written by uploadToB2.
 */
export async function inspectB2ObjectIntegrity(key: string, abortSignal?: AbortSignal): Promise<B2ObjectIntegrity> {
  const client = getB2Client();
  let head;
  try {
    head = await client.send(
      new HeadObjectCommand({
        Bucket: getB2Bucket(),
        Key: key,
      }),
      abortSignal ? { abortSignal } : undefined
    );
    if (!head.VersionId) {
      throw new Error(`B2 object ${key} did not expose the immutable version selected by HEAD`);
    }
  } catch (err: unknown) {
    if (isNotFoundError(err)) return { exists: false };
    throw err;
  }

  try {
    const object = await client.send(
      new GetObjectCommand({
        Bucket: getB2Bucket(),
        Key: key,
        VersionId: head.VersionId,
      }),
      abortSignal ? { abortSignal } : undefined
    );
    if (!object.Body) throw new Error(`B2 object ${key} returned no body`);

    const hash = createHash("sha256");
    let byteLength = 0;
    for await (const chunk of object.Body as AsyncIterable<Uint8Array>) {
      const bytes = Buffer.from(chunk);
      byteLength += bytes.length;
      hash.update(bytes);
    }

    if (head.ContentLength !== undefined && Number(head.ContentLength) !== byteLength) {
      throw new Error(
        `B2 object ${key} changed or was truncated while reading (HEAD=${head.ContentLength}, GET=${byteLength})`
      );
    }

    return {
      exists: true,
      byteLength,
      sha256: hash.digest("hex"),
      contentType: object.ContentType ?? head.ContentType,
      versionId: head.VersionId,
      objectLockMode: head.ObjectLockMode,
      objectLockRetainUntil: head.ObjectLockRetainUntilDate,
    };
  } catch (err: unknown) {
    // A concurrent disappearance is treated as missing and may be uploaded by
    // the caller. Other read/auth/integrity errors remain loud and fail closed.
    if (isNotFoundError(err)) return { exists: false };
    throw err;
  }
}

/**
 * Returns true if an object exists at `key`. Returns false on 404 / NotFound.
 * Throws on any other error (auth failure, network, bucket-not-found, etc.)
 * so the caller can fail loudly rather than silently double-uploading.
 */
export async function existsInB2(key: string): Promise<boolean> {
  const client = getB2Client();
  try {
    await client.send(
      new HeadObjectCommand({
        Bucket: getB2Bucket(),
        Key: key,
      })
    );
    return true;
  } catch (err: unknown) {
    // S3-compatible APIs report missing objects as 404 / NotFound /
    // NoSuchKey. Normalise across SDK shapes.
    if (isNotFoundError(err)) return false;
    throw err;
  }
}

/**
 * Paginated ListObjectsV2 over a prefix. Returns every matched object.
 * Used by verification queries and admin status endpoint. Don't call this
 * for very wide prefixes in hot paths — it pages until exhausted.
 */
export async function listB2Prefix(
  prefix: string
): Promise<{ key: string; size: number; lastModified: Date | undefined }[]> {
  const client = getB2Client();
  const out: { key: string; size: number; lastModified: Date | undefined }[] = [];
  let token: string | undefined = undefined;
  do {
    const r: ListObjectsV2CommandOutput = await client.send(
      new ListObjectsV2Command({
        Bucket: getB2Bucket(),
        Prefix: prefix,
        ContinuationToken: token,
        MaxKeys: 1000,
      })
    );
    for (const o of r.Contents ?? []) {
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
