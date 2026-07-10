/**
 * Vault Quest dedicated Backblaze B2 cold-archive client.
 *
 * ARCHIVE ONLY — never on a live request path. Vault Quest reads VAULT_QUEST_B2_*
 * ONLY and never falls back to the grading archive (B2_* / server/b2.ts). Missing
 * credentials fail CLOSED. No delete helper is exported (Object Lock Compliance
 * prevents deletion within retention anyway; if a future migration needs
 * eviction, that's a separate Governance-retention / Legal-Hold conversation).
 *
 * S3-compatible API; same @aws-sdk/client-s3 lib as grading b2.ts. Grading b2.ts
 * is untouched. This module is created in Phase 1 so the archive client is ready;
 * it is NOT wired into any route or live read path.
 */
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
} from "@aws-sdk/client-s3";

let vqB2: S3Client | null = null;

export function getVqB2Client(): S3Client {
  if (vqB2) return vqB2;
  const endpoint = process.env.VAULT_QUEST_B2_ENDPOINT;
  const accessKeyId = process.env.VAULT_QUEST_B2_KEY_ID;
  const secretAccessKey = process.env.VAULT_QUEST_B2_APPLICATION_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "Vault Quest B2 archive is not configured (VAULT_QUEST_B2_ENDPOINT, VAULT_QUEST_B2_KEY_ID, " +
        "VAULT_QUEST_B2_APPLICATION_KEY). Fails closed; never uses the grading B2 archive.",
    );
  }
  vqB2 = new S3Client({
    region: "auto",
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  return vqB2;
}

export function getVqB2Bucket(): string {
  const bucket = process.env.VAULT_QUEST_B2_BUCKET;
  if (!bucket) throw new Error("VAULT_QUEST_B2_BUCKET is not set — Vault Quest archive fails closed.");
  return bucket;
}

/** True when all four VAULT_QUEST_B2_* variables are present. */
export function vaultQuestB2Configured(): boolean {
  return !!(
    process.env.VAULT_QUEST_B2_ENDPOINT &&
    process.env.VAULT_QUEST_B2_KEY_ID &&
    process.env.VAULT_QUEST_B2_APPLICATION_KEY &&
    process.env.VAULT_QUEST_B2_BUCKET
  );
}

/**
 * Upload an object to the Vault Quest archive with Object Lock Compliance
 * retention (default 90 days). Archive-only — never called on a request path.
 * The target bucket must have Object Lock enabled at creation for this to succeed.
 */
export async function uploadToVqB2(
  key: string,
  body: Buffer,
  contentType: string,
  retentionDays: number = 90,
): Promise<string> {
  const client = getVqB2Client();
  const retainUntil = new Date(Date.now() + retentionDays * 86_400_000);
  await client.send(
    new PutObjectCommand({
      Bucket: getVqB2Bucket(),
      Key: key,
      Body: body,
      ContentType: contentType,
      ObjectLockMode: "COMPLIANCE",
      ObjectLockRetainUntilDate: retainUntil,
    }),
  );
  return key;
}

/** True if an object exists at `key`; false on 404/NotFound; throws on other errors. */
export async function existsInVqB2(key: string): Promise<boolean> {
  const client = getVqB2Client();
  try {
    await client.send(new HeadObjectCommand({ Bucket: getVqB2Bucket(), Key: key }));
    return true;
  } catch (err: unknown) {
    const e = err as { $metadata?: { httpStatusCode?: number }; statusCode?: number; name?: string; Code?: string };
    const status = e?.$metadata?.httpStatusCode ?? e?.statusCode;
    const name = e?.name ?? e?.Code;
    if (status === 404 || name === "NotFound" || name === "NoSuchKey") return false;
    throw err;
  }
}

/** Paginated ListObjectsV2 over a prefix — used by archive verification, not hot paths. */
export async function listVqB2Prefix(
  prefix: string,
): Promise<{ key: string; size: number; lastModified: Date | undefined }[]> {
  const client = getVqB2Client();
  const out: { key: string; size: number; lastModified: Date | undefined }[] = [];
  let token: string | undefined = undefined;
  do {
    const r: ListObjectsV2CommandOutput = await client.send(
      new ListObjectsV2Command({ Bucket: getVqB2Bucket(), Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 }),
    );
    for (const o of r.Contents ?? []) {
      if (!o.Key) continue;
      out.push({ key: o.Key, size: o.Size ?? 0, lastModified: o.LastModified });
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}
