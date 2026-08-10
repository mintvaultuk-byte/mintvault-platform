#!/usr/bin/env node
/**
 * Inventory EVERY bucket and EVERY object on this matrix's MinIO server.
 *
 * Two jobs:
 *   • before the run — prove the namespace starts genuinely clean (any object at all is a signal
 *     that a previous run leaked, which is exactly what the A/B independence claim depends on);
 *   • after the run  — prove the suites cleaned up after themselves, so a passing matrix cannot
 *     hide 62 orphaned fixture objects (which is what an earlier prefix-only cleanup did).
 *
 * READ-ONLY. It lists; it never deletes. Cleanup belongs to the suites' own cleanup() and to
 * teardown.sh, which destroys the whole server.
 */
import { S3Client, ListBucketsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";

const label = (process.argv[2] ?? "").toUpperCase();
const phase = process.argv[3] ?? "before";
if (label !== "A" && label !== "B") throw new Error("usage: storage-inventory.mjs <A|B> <before|after>");

const endpoint = process.env.PARTNER_REAL_R2_PROOF_ENDPOINT;
const accessKeyId = process.env.PARTNER_REAL_R2_PROOF_KEY;
const secretAccessKey = process.env.PARTNER_REAL_R2_PROOF_SECRET;
if (!endpoint || !accessKeyId || !secretAccessKey) {
  throw new Error("PARTNER_REAL_R2_PROOF_ENDPOINT/_KEY/_SECRET must be exported");
}
// Same exact-hostname allow-list the suites use: a substring check would pass
// "https://evil.example/?h=127.0.0.1".
const host = new URL(endpoint).hostname.replace(/^\[|\]$/g, "");
if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
  throw new Error(`refusing to inventory non-loopback storage host ${host}`);
}

const client = new S3Client({
  region: "auto",
  endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey },
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});

const buckets = (await client.send(new ListBucketsCommand({}))).Buckets ?? [];
const report = { matrix: label, phase, endpoint, buckets: [], totalObjects: 0 };

for (const b of buckets) {
  const name = b.Name;
  let token;
  const keys = [];
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: name, ContinuationToken: token }));
    for (const o of page.Contents ?? []) keys.push(o.Key);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  report.buckets.push({ name, objects: keys.length, sample: keys.slice(0, 10) });
  report.totalObjects += keys.length;
}

console.log(JSON.stringify(report, null, 2));

if (phase === "before" && report.totalObjects !== 0) {
  console.error(`[storage-inventory] REFUSED: matrix ${label} storage is not empty at start (${report.totalObjects} objects)`);
  process.exit(1);
}
if (phase === "after" && report.totalObjects !== 0) {
  console.error(`[storage-inventory] matrix ${label} left ${report.totalObjects} object(s) behind after the run`);
  process.exit(2); // distinct code: a leak is a finding, not a harness failure
}
