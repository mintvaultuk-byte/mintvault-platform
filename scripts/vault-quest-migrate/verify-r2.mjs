/**
 * Phase 2 · Step 5 — independent verification of the R2 copy: object count, per-key
 * size, and per-key md5 (downloads both sides). Read-only on both buckets.
 *
 *   SOURCE: R2_* / R2_BUCKET_NAME     DEST: VAULT_QUEST_R2_* / VAULT_QUEST_R2_BUCKET
 *
 *   R2_ENDPOINT=... (+creds+bucket) VAULT_QUEST_R2_ENDPOINT=... (+creds+bucket) \
 *     node scripts/vault-quest-migrate/verify-r2.mjs
 */
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { md5, requireEnv } from "./lib.mjs";

const PREFIX = "vq/";
const mk = (e, a, s) => new S3Client({ region: "auto", endpoint: e, credentials: { accessKeyId: a, secretAccessKey: s }, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" });

const source = { client: mk(requireEnv("R2_ENDPOINT"), requireEnv("R2_ACCESS_KEY_ID"), requireEnv("R2_SECRET_ACCESS_KEY")), bucket: requireEnv("R2_BUCKET_NAME") };
const dest = { client: mk(requireEnv("VAULT_QUEST_R2_ENDPOINT"), requireEnv("VAULT_QUEST_R2_ACCESS_KEY_ID"), requireEnv("VAULT_QUEST_R2_SECRET_ACCESS_KEY")), bucket: requireEnv("VAULT_QUEST_R2_BUCKET") };

async function toBuffer(body) {
  const chunks = [];
  for await (const c of body) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}
async function listMap(client, bucket) {
  const m = new Map();
  let token;
  do {
    const r = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: PREFIX, ContinuationToken: token, MaxKeys: 1000 }));
    for (const o of r.Contents ?? []) if (o.Key) m.set(o.Key, o.Size ?? 0);
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return m;
}
async function hashOf(client, bucket, key) {
  const g = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return md5(await toBuffer(g.Body));
}

console.log(`[verify-r2] SOURCE bucket=${source.bucket}  DEST bucket=${dest.bucket}`);

try {
  const s = await listMap(source.client, source.bucket);
  const d = await listMap(dest.client, dest.bucket);
  const sBytes = [...s.values()].reduce((a, b) => a + b, 0);
  const dBytes = [...d.values()].reduce((a, b) => a + b, 0);
  console.log(`  count:  source=${s.size}  dest=${d.size}  ${s.size === d.size ? "✓" : "✗"}`);
  console.log(`  bytes:  source=${sBytes}  dest=${dBytes}  ${sBytes === dBytes ? "✓" : "✗"}`);

  let missing = 0;
  let sizeBad = 0;
  let hashBad = 0;
  for (const [key, size] of s) {
    if (!d.has(key)) {
      missing++;
      console.log(`  MISSING in dest: ${key}`);
      continue;
    }
    if (d.get(key) !== size) {
      sizeBad++;
      console.log(`  SIZE differs: ${key} (source=${size} dest=${d.get(key)})`);
      continue;
    }
    const [sh, dh] = await Promise.all([hashOf(source.client, source.bucket, key), hashOf(dest.client, dest.bucket, key)]);
    if (sh !== dh) {
      hashBad++;
      console.log(`  HASH differs: ${key}`);
    }
  }
  const pass = s.size === d.size && sBytes === dBytes && missing === 0 && sizeBad === 0 && hashBad === 0;
  console.log(`[verify-r2] ${pass ? "ALL OBJECTS MATCH ✓" : `MISMATCH ✗ (missing=${missing} size=${sizeBad} hash=${hashBad}) — do NOT cut over`}`);
  process.exitCode = pass ? 0 : 1;
} catch (err) {
  console.error(`[verify-r2] FAILED:`, err.message);
  process.exitCode = 1;
}
