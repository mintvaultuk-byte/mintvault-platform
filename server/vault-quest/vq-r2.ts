/**
 * Vault Quest dedicated R2 (object storage) client.
 *
 * Vault Quest reads VAULT_QUEST_R2_* ONLY. It NEVER falls back to the MintVault
 * grading bucket (R2_BUCKET_NAME / server/r2.ts) — this client physically cannot
 * reach grading or customer-upload paths. Missing credentials fail CLOSED: reads
 * and writes throw a clear error on Vault Quest routes; the MintVault app still
 * boots (the client is built lazily on first use).
 *
 * The Vault Quest write-prefix guard (assertVqWriteKey / VQ_WRITE_PREFIXES) lives
 * here — the transport layer — and is enforced inside uploadToVqR2 as well as at
 * every call site. render-saved.ts re-exports it for existing importers. Grading
 * server/r2.ts is untouched.
 */
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

let vqS3: S3Client | null = null;

function getClient(): S3Client {
  if (vqS3) return vqS3;
  const endpoint = process.env.VAULT_QUEST_R2_ENDPOINT;
  const accessKeyId = process.env.VAULT_QUEST_R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.VAULT_QUEST_R2_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "Vault Quest R2 is not configured (VAULT_QUEST_R2_ENDPOINT, VAULT_QUEST_R2_ACCESS_KEY_ID, " +
        "VAULT_QUEST_R2_SECRET_ACCESS_KEY). Vault Quest fails closed and never uses the grading R2 bucket.",
    );
  }
  vqS3 = new S3Client({
    region: "auto",
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    // Same checksum-protocol pinning as grading r2.ts (R2 trips the flexible-checksums middleware).
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  return vqS3;
}

/** For scripts/tests: the dedicated Vault Quest S3 client (throws if unconfigured). */
export function getVqR2Client(): S3Client {
  return getClient();
}

export function getVqR2Bucket(): string {
  const bucket = process.env.VAULT_QUEST_R2_BUCKET;
  if (!bucket) {
    throw new Error(
      "VAULT_QUEST_R2_BUCKET is not set — Vault Quest object storage is not configured. " +
        "Vault Quest fails closed and never uses the grading R2 bucket.",
    );
  }
  return bucket;
}

/** True when all four VAULT_QUEST_R2_* variables are present — check config without connecting. */
export function vaultQuestR2Configured(): boolean {
  return !!(
    process.env.VAULT_QUEST_R2_ENDPOINT &&
    process.env.VAULT_QUEST_R2_ACCESS_KEY_ID &&
    process.env.VAULT_QUEST_R2_SECRET_ACCESS_KEY &&
    process.env.VAULT_QUEST_R2_BUCKET
  );
}

const DEFAULT_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * HARD prefix guard for every Vault Quest R2 WRITE. VQ may only ever write inside
 * its own isolated prefixes — never MintVault grading / customer paths (images/,
 * labels/, scans/, uploads/, …). Enforced inside uploadToVqR2 AND at every call
 * site. R2 keys are literal strings, so this is defence-in-depth that makes the
 * isolation a hard invariant instead of a convention.
 */
export const VQ_WRITE_PREFIXES = ["vq/art-candidates/", "vq/art/", "vq/characters/"] as const;
export function assertVqWriteKey(key: string): string {
  const ok =
    VQ_WRITE_PREFIXES.some((p) => key.startsWith(p)) &&
    !key.includes("..") &&
    !key.includes("\\") &&
    !key.startsWith("/") &&
    // eslint-disable-next-line no-control-regex
    !/[\x00-\x1f]/.test(key);
  if (!ok) throw new Error(`blocked R2 write outside Vault Quest prefixes: "${key.slice(0, 80)}"`);
  return key;
}

/** Upload an object to the Vault Quest bucket. Enforces the VQ write-prefix guard. */
export async function uploadToVqR2(key: string, body: Buffer, contentType: string): Promise<string> {
  assertVqWriteKey(key);
  const client = getClient();
  const bucket = getVqR2Bucket();
  await client.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, CacheControl: DEFAULT_CACHE_CONTROL }),
  );
  return key;
}

/**
 * Download a Vault Quest object into a Buffer. Config problems (missing creds /
 * bucket) fail CLOSED before the request. An object-not-found or transient S3
 * error returns null — same graceful behaviour as grading getR2Buffer, so a
 * missing image never 500s a page.
 */
export async function getVqR2Buffer(key: string): Promise<Buffer | null> {
  const client = getClient(); // fail-closed on missing VAULT_QUEST_R2_* creds
  const bucket = getVqR2Bucket(); // fail-closed on missing bucket
  try {
    const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!out.Body) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of out.Body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  } catch {
    return null; // object-not-found / transient → null (matches grading getR2Buffer)
  }
}
