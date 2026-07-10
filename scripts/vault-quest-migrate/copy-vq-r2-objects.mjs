/**
 * Phase 2 · Step 4 — copy all vq/ objects from the shared grading bucket into the
 * dedicated Vault Quest bucket, PRESERVING KEYS (so the DB-stored keys still resolve).
 *
 *   SOURCE (read-only): R2_* / R2_BUCKET_NAME              (grading bucket)
 *   DEST   (write):     VAULT_QUEST_R2_* / VAULT_QUEST_R2_BUCKET (new VQ bucket)
 *
 *   DRY-RUN (default): lists source vq/ objects + total size; writes nothing.
 *   --commit         : copies each object and re-reads it from DEST to verify md5.
 *
 * Only touches the vq/ prefix. Never writes to SOURCE. Refuses same-bucket copy.
 *
 *   R2_ENDPOINT=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET_NAME=... \
 *   VAULT_QUEST_R2_ENDPOINT=... VAULT_QUEST_R2_ACCESS_KEY_ID=... VAULT_QUEST_R2_SECRET_ACCESS_KEY=... VAULT_QUEST_R2_BUCKET=... \
 *     node scripts/vault-quest-migrate/copy-vq-r2-objects.mjs [--commit]
 */
import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { md5, requireEnv, isCommit } from "./lib.mjs";

const PREFIX = "vq/";
const commit = isCommit();

function makeClient(endpoint, accessKeyId, secretAccessKey) {
  return new S3Client({
    region: "auto",
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

const source = {
  client: makeClient(requireEnv("R2_ENDPOINT"), requireEnv("R2_ACCESS_KEY_ID"), requireEnv("R2_SECRET_ACCESS_KEY")),
  bucket: requireEnv("R2_BUCKET_NAME"),
};
const dest = {
  client: makeClient(requireEnv("VAULT_QUEST_R2_ENDPOINT"), requireEnv("VAULT_QUEST_R2_ACCESS_KEY_ID"), requireEnv("VAULT_QUEST_R2_SECRET_ACCESS_KEY")),
  bucket: requireEnv("VAULT_QUEST_R2_BUCKET"),
};

if (source.bucket === dest.bucket) {
  throw new Error("[copy-r2] SOURCE and DEST buckets are identical — refusing (would copy onto itself).");
}

async function toBuffer(body) {
  const chunks = [];
  for await (const c of body) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

async function listAll(client, bucket) {
  const out = [];
  let token;
  do {
    const r = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: PREFIX, ContinuationToken: token, MaxKeys: 1000 }));
    for (const o of r.Contents ?? []) if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0 });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}

console.log(`[copy-r2] SOURCE bucket=${source.bucket} (read-only) → DEST bucket=${dest.bucket}  mode=${commit ? "COMMIT" : "DRY-RUN"}`);

try {
  const objs = await listAll(source.client, source.bucket);
  const totalBytes = objs.reduce((a, o) => a + o.size, 0);
  console.log(`[copy-r2] found ${objs.length} object(s) under ${PREFIX} · ${totalBytes} bytes total`);

  if (!commit) {
    for (const o of objs.slice(0, 50)) console.log(`  would copy ${o.key} (${o.size}B)`);
    if (objs.length > 50) console.log(`  … and ${objs.length - 50} more`);
    console.log(`[copy-r2] DRY-RUN — re-run with --commit to copy + verify.`);
  } else {
    let copied = 0;
    let mismatches = 0;
    for (const o of objs) {
      const g = await source.client.send(new GetObjectCommand({ Bucket: source.bucket, Key: o.key }));
      const buf = await toBuffer(g.Body);
      const srcHash = md5(buf);
      await dest.client.send(new PutObjectCommand({ Bucket: dest.bucket, Key: o.key, Body: buf, ContentType: g.ContentType || "application/octet-stream" }));
      const g2 = await dest.client.send(new GetObjectCommand({ Bucket: dest.bucket, Key: o.key }));
      const destHash = md5(await toBuffer(g2.Body));
      const okHash = srcHash === destHash;
      if (!okHash) mismatches++;
      copied++;
      console.log(`  copied ${o.key} (${o.size}B) md5 ${okHash ? "✓" : "✗ MISMATCH"}`);
    }
    console.log(`[copy-r2] DONE — copied=${copied} mismatches=${mismatches}. ${mismatches ? "INVESTIGATE MISMATCHES." : "Run verify-r2.mjs for an independent check."}`);
    process.exitCode = mismatches ? 1 : 0;
  }
} catch (err) {
  console.error(`[copy-r2] FAILED:`, err.message);
  process.exitCode = 1;
}
