/**
 * Create the storage-proof bucket for CI, and refuse to do so anywhere real.
 *
 * tests/partner-real-r2-storage.test.ts no longer creates buckets: CreateBucket, DeleteBucket and
 * the bulk DeleteObjects path were removed from it, because an earlier revision resolved its target
 * from ambient R2_* configuration and then ran an unprefixed list -> bulk delete -> DeleteBucket in
 * beforeAll. With real credentials exported that would have destroyed live customer objects and
 * then the production bucket.
 *
 * So bucket creation lives here instead, and carries the same guard the suite does. This script is
 * the only place in CI that creates a bucket, and it can only ever create a disposable one:
 *
 *   - the endpoint hostname must be an EXACT allow-list match. Substring checks are not used —
 *     "https://evil.example/?h=127.0.0.1" passes those;
 *   - an independent forbidden-host check rejects real storage providers outright, so widening the
 *     allow-list by accident is not sufficient to reach production;
 *   - the bucket name must match a fixed disposable pattern;
 *   - it reads ONLY the dedicated PARTNER_REAL_R2_PROOF_* variables, never R2_*, so an ambient
 *     production configuration cannot become the target.
 *
 * It is deliberately idempotent: BucketAlreadyOwnedByYou is success, so a re-run of the job is not
 * a failure.
 */
import { S3Client, CreateBucketCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";

const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "minio"]);
const FORBIDDEN_HOST_FRAGMENTS = ["r2.cloudflarestorage.com", "amazonaws.com", "backblazeb2.com"];
const PROOF_BUCKET_RE = /^partner-real-r2-proof(-[a-z0-9]{1,16})?$/;

const endpoint = process.env.PARTNER_REAL_R2_PROOF_ENDPOINT;
const bucket = process.env.PARTNER_REAL_R2_PROOF_BUCKET;
const accessKeyId = process.env.PARTNER_REAL_R2_PROOF_KEY;
const secretAccessKey = process.env.PARTNER_REAL_R2_PROOF_SECRET;

function fail(message) {
  console.error(`[ensure-proof-bucket] ${message}`);
  process.exit(1);
}

if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
  fail(
    "PARTNER_REAL_R2_PROOF_ENDPOINT / _BUCKET / _KEY / _SECRET must all be set. " +
      "Do NOT substitute R2_* variables — the whole point of the dedicated names is that ambient " +
      "production storage configuration can never become the target."
  );
}

let host;
try {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" && url.protocol !== "https:") fail(`bad protocol ${url.protocol}`);
  host = url.hostname.replace(/^\[|\]$/g, "");
} catch {
  fail(`endpoint is not a valid URL: ${endpoint}`);
}
for (const bad of FORBIDDEN_HOST_FRAGMENTS) {
  if (host.includes(bad)) fail(`endpoint host ${host} is real storage; refusing to create a bucket there`);
}
if (!ALLOWED_HOSTS.has(host)) fail(`endpoint host ${host} is not allow-listed`);
if (!PROOF_BUCKET_RE.test(bucket)) fail(`bucket "${bucket}" is not a disposable proof bucket name`);

const client = new S3Client({
  region: "auto",
  endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey },
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});

try {
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  console.log(`[ensure-proof-bucket] created ${bucket} at ${endpoint}`);
} catch (err) {
  const name = err?.name ?? "";
  if (name === "BucketAlreadyOwnedByYou" || name === "BucketAlreadyExists") {
    console.log(`[ensure-proof-bucket] ${bucket} already exists`);
  } else {
    fail(`could not create ${bucket}: ${name} ${err?.message ?? err}`);
  }
}

// Report what is in it. A CI bucket should be empty; anything else is worth seeing in the log,
// and the suite's own foreign-object guard will refuse to run if it is not disposable-clean.
const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 10 }));
const count = (listed.Contents ?? []).length;
console.log(`[ensure-proof-bucket] ${bucket} currently holds ${count} object(s)`);
