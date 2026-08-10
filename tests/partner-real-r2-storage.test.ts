/**
 * Real S3-compatible storage proof for the Partner pilot.
 *
 * Opt-in, because it performs real network I/O against a local S3-compatible service (MinIO).
 * When PARTNER_REAL_R2_PROOF=1 is set, missing storage is a hard failure, not a skip.
 *
 * ============================ WHY THE TARGETING IS PARANOID ============================
 * A previous revision of this file resolved its target from the ambient R2 endpoint and bucket
 * environment variables, falling back to localhost, then ran, in beforeAll and before
 * any assertion: an UNPREFIXED ListObjectsV2 -> bulk DeleteObjects -> DeleteBucket -> CreateBucket.
 *
 * The localhost defaults applied only when those vars were ABSENT, so an ambient production
 * configuration silently won. With real R2 credentials exported into the shell — the ordinary
 * `set -a; source .env` pattern; this repo's .env carries all four R2_* vars pointed at a remote
 * production-class endpoint — a single PARTNER_REAL_R2_PROOF=1 would have deleted up to 1,000 live
 * customer objects and then attempted to delete the production bucket. Nothing in the file
 * prevented it. The same trap reopens the instant R2_* secrets appear in a CI job that also sets
 * PARTNER_REAL_R2_PROOF.
 *
 * So this suite now:
 *   - reads its target ONLY from dedicated PARTNER_REAL_R2_PROOF_* vars, never from R2_*, which
 *     removes the "ambient production config wins" class rather than filtering it;
 *   - allow-lists the endpoint by EXACT hostname (substring checks pass
 *     https://evil.example/?h=127.0.0.1, so they are not used);
 *   - requires a disposable bucket name matching a fixed pattern;
 *   - writes everything under one unique per-run prefix;
 *   - refuses to touch a bucket that contains anything outside that prefix — the single strongest
 *     signal that the target is real;
 *   - never calls DeleteBucket or bulk DeleteObjects. Those commands are not even imported, and
 *     tests/partner-shop-workflow-source.test.ts pins their absence.
 *
 * Cleanup is prefix-scoped, paginated, per-key, re-asserts the prefix on every key it is about to
 * delete (the delete never trusts the list), and runs in afterAll so the suite cleans up after
 * itself instead of a destructive reset being load-bearing for the next run.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DeleteObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

const enabled = process.env.PARTNER_REAL_R2_PROOF === "1";

// Deliberately NOT R2_*. See the header.
const endpoint = process.env.PARTNER_REAL_R2_PROOF_ENDPOINT ?? "http://127.0.0.1:9010";
const bucket = process.env.PARTNER_REAL_R2_PROOF_BUCKET ?? "partner-real-r2-proof";
const accessKeyId = process.env.PARTNER_REAL_R2_PROOF_KEY ?? "minioadmin";
const secretAccessKey = process.env.PARTNER_REAL_R2_PROOF_SECRET ?? "minioadmin";

/** Loopback plus the GitHub Actions service-container DNS name. Exact hostname match only. */
const ALLOWED_STORAGE_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "minio"]);
/** Hostnames that are categorically real storage, as an independent second tripwire. */
const FORBIDDEN_HOST_FRAGMENTS = ["r2.cloudflarestorage.com", "amazonaws.com", "backblazeb2.com"];
const PROOF_BUCKET_RE = /^partner-real-r2-proof(-[a-z0-9]{1,16})?$/;

/** One prefix per run, so concurrent runs cannot collide and cleanup can never over-reach. */
const RUN_PREFIX = `ci-proof/${process.env.GITHUB_RUN_ID ?? "local"}-${randomUUID()}/`;

function endpointIsDisposable(raw: string): { ok: true } | { ok: false; why: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, why: `endpoint is not a valid URL: ${raw}` };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, why: `bad protocol ${u.protocol}` };
  const host = u.hostname.replace(/^\[|\]$/g, "");
  for (const bad of FORBIDDEN_HOST_FRAGMENTS) {
    if (host.includes(bad)) return { ok: false, why: `endpoint host ${host} is real storage` };
  }
  if (!ALLOWED_STORAGE_HOSTS.has(host)) return { ok: false, why: `endpoint host ${host} is not allow-listed` };
  return { ok: true };
}

/** Every condition must hold. Throws — never skips — so a misconfigured target is loud. */
export function assertProofTargetIsDisposable(): void {
  const ep = endpointIsDisposable(endpoint);
  if (!ep.ok) throw new Error(`Refusing to run the storage proof: ${ep.why}`);
  if (!PROOF_BUCKET_RE.test(bucket)) {
    throw new Error(`Refusing to run the storage proof: bucket "${bucket}" is not a disposable proof bucket`);
  }
}

function proofClient() {
  return new S3Client({
    region: "auto",
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

/**
 * Abort if the target bucket holds ANYTHING outside this run's prefix.
 *
 * This is the last line of defence and the strongest single signal: a disposable proof bucket is
 * empty; a real bucket is not. Runs before the first delete of the session.
 */
async function assertBucketIsEmptyOfForeignObjects(client: S3Client): Promise<void> {
  const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 50 }));
  const foreign = (page.Contents ?? []).map((o) => o.Key ?? "").filter((k) => k && !k.startsWith("ci-proof/"));
  if (foreign.length) {
    throw new Error(
      `Refusing to run the storage proof: bucket "${bucket}" contains ${foreign.length} object(s) outside ci-proof/, ` +
        `e.g. "${foreign[0]}". This does not look like a disposable bucket.`
    );
  }
}

/** Paginated, prefix-scoped, per-key. The delete re-checks the prefix and never trusts the list. */
async function cleanupRunPrefix(client: S3Client): Promise<void> {
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: RUN_PREFIX, ContinuationToken: token })
    );
    for (const object of page.Contents ?? []) {
      const key = object.Key;
      if (!key) continue;
      if (!key.startsWith(RUN_PREFIX)) throw new Error(`refusing to delete out-of-prefix key: ${key}`);
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
}

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);
const tinyJpeg = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Amf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EFBQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EFBQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EFBABAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z",
  "base64"
);

describe("Partner real storage coverage is wired up", () => {
  it("is not silently skipped in CI, and its target is provably disposable", () => {
    if (process.env.CI || process.env.GITHUB_ACTIONS) {
      // A skip and a pass must not look identical. ci.yml records that three suites once shipped
      // self-gated but unwired, reporting describe.skip while the build stayed green on 48 tests
      // that never ran. This is the same class, so it gets the same guard.
      expect(enabled, "PARTNER_REAL_R2_PROOF must be 1 in CI so the storage proof actually runs").toBe(true);
    }
    if (enabled) {
      // Green here must never coexist with a production target.
      expect(() => assertProofTargetIsDisposable()).not.toThrow();
    } else {
      // eslint-disable-next-line no-console
      console.warn("[partner-real-r2] skipped: PARTNER_REAL_R2_PROOF is not 1");
    }
  });
});

(enabled ? describe : describe.skip)("Partner real R2/S3-compatible storage proof", () => {
  beforeAll(async () => {
    // Guard BEFORE anything else touches storage.
    assertProofTargetIsDisposable();
    await assertBucketIsEmptyOfForeignObjects(proofClient());
    // Only now point the application helper at the proven-disposable target.
    process.env.R2_ENDPOINT = endpoint;
    process.env.R2_BUCKET_NAME = bucket;
    process.env.R2_ACCESS_KEY_ID = accessKeyId;
    process.env.R2_SECRET_ACCESS_KEY = secretAccessKey;
    process.env.R2_FORCE_PATH_STYLE = "1";
  }, 30_000);

  afterAll(async () => {
    // Prefix-scoped, paginated, per-key. Runs even on failure, so nothing is left behind and the
    // next run never depends on a destructive reset.
    await cleanupRunPrefix(proofClient());
  }, 30_000);

  it("uploads, HEADs, signs, reads and deletes exact partner image bytes", async () => {
    const r2 = await import("../server/r2");
    const tenantId = "aaaaaaaa-r200-0000-0000-000000000001";
    const submissionId = "30000000-r200-0000-0000-000000000001";
    const cardId = "50000000-r200-0000-0000-000000000001";
    // Every object this suite writes lives under the unique per-run prefix, so cleanup can be
    // prefix-scoped and two concurrent runs cannot clobber each other's fixtures.
    const frontKey = `${RUN_PREFIX}partner-submissions/${tenantId}/${submissionId}/${cardId}/front-proof.png`;
    const backKey = `${RUN_PREFIX}partner-submissions/${tenantId}/${submissionId}/${cardId}/back-proof.jpg`;

    await expect(r2.uploadToR2(frontKey, tinyPng, "image/png")).resolves.toBe(frontKey);
    await expect(r2.uploadToR2(backKey, tinyJpeg, "image/jpeg")).resolves.toBe(backKey);

    await expect(r2.headR2(frontKey)).resolves.toEqual(
      expect.objectContaining({
        lastModified: expect.any(Date),
        contentLength: tinyPng.length,
        contentType: "image/png",
        eTag: expect.any(String),
      })
    );
    await expect(r2.headR2(backKey)).resolves.toEqual(
      expect.objectContaining({
        lastModified: expect.any(Date),
        contentLength: tinyJpeg.length,
        contentType: "image/jpeg",
        eTag: expect.any(String),
      })
    );

    await expect(r2.getR2Buffer(frontKey)).resolves.toEqual(tinyPng);
    await expect(r2.getR2Buffer(backKey)).resolves.toEqual(tinyJpeg);

    const frontSigned = await r2.getR2SignedUrl(frontKey, 60);
    const backSigned = await r2.getR2SignedUrl(backKey, 60);
    const [frontFetched, backFetched] = await Promise.all([
      fetch(frontSigned).then((res) => res.arrayBuffer()),
      fetch(backSigned).then((res) => res.arrayBuffer()),
    ]);
    expect(Buffer.from(frontFetched)).toEqual(tinyPng);
    expect(Buffer.from(backFetched)).toEqual(tinyJpeg);

    await expect(r2.headR2(`${frontKey}.missing`)).resolves.toBeNull();
    await expect(r2.getR2Buffer(`${frontKey}.missing`)).resolves.toBeNull();

    await r2.deleteFromR2(frontKey);
    await expect(r2.headR2(frontKey)).resolves.toBeNull();
    await expect(r2.getR2Buffer(frontKey)).resolves.toBeNull();
    await expect(r2.headR2(backKey)).resolves.toEqual(
      expect.objectContaining({
        lastModified: expect.any(Date),
        contentLength: tinyJpeg.length,
        contentType: "image/jpeg",
      })
    );
  }, 30_000);
});
