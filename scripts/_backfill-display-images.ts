/**
 * scripts/_backfill-display-images.ts
 *
 * Re-runs old certs' display images through the v592 pipeline so they
 * match natively-scanned certs (PNG with alpha-transparent rounded
 * corners, 10 px tight trim, 8 px safety pad). For each cert in the
 * target range we:
 *
 *   1. Fetch the highest-quality preserved source (the resized JPEG at
 *      gradingFrontOriginal / gradingBackOriginal — see investigation
 *      report: this is the floor; no raw TIFF era exists in code).
 *   2. Call uploadImagesToCert(certId, frontBuf, backBuf?) — same
 *      function scan-ingest + attach-images call, zero duplicate pipeline
 *      logic. Writes new R2 artefacts + updates display + cropped +
 *      variant columns + crop_geometry.
 *   3. Surgical remediation in a finally block: restore
 *      grading_front_original / grading_back_original to their PRE-call
 *      values, because uploadImagesToCert overwrites those (it expects
 *      to be called on fresh scans, where those columns reflect the new
 *      upload). For backfill we want the legacy source-key pointers
 *      preserved so future backfills can re-run from the same source.
 *   4. Insert audit_log row recording before/after state.
 *
 * SAFETY:
 *   - DRY-RUN default ON. Real run requires --no-dry-run AND either an
 *     explicit --from+--to range OR the --all flag.
 *   - Pre-flight DB snapshot taken on every real run, written to
 *     scripts/_snapshots/ (gitignored). Path printed before any
 *     mutation. Snapshot covers every column the backfill touches.
 *   - Idempotent: certs whose front_image_path already ends in .png AND
 *     resolves on R2 are skipped (override with --force).
 *   - Sequential — one cert at a time, no R2 hammering, no parallel
 *     Fly CPU pressure.
 *   - No R2 deletions. Old .jpg keys remain; the row's column simply
 *     stops referencing them.
 *
 * Run:
 *   # SETUP (one-off, this session):
 *   #   1. Get prod R2 write creds from Fly secrets:
 *   #        fly ssh console -a mintvault -C 'printenv | grep ^R2_'
 *   #   2. Paste the R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY values into .env as:
 *   #        R2_PROD_WRITE_ACCESS_KEY_ID=...
 *   #        R2_PROD_WRITE_SECRET_ACCESS_KEY=...
 *   #   3. Remove both vars from .env after the backfill completes.
 *   #
 *   # dry-run, narrow range
 *   MINTVAULT_DATABASE_URL='postgresql://...wispy-morning...' \
 *     npx tsx --env-file=.env scripts/_backfill-display-images.ts \
 *     --from=MV100 --to=MV110
 *
 *   # real run, narrow range
 *   MINTVAULT_DATABASE_URL='...wispy-morning...' \
 *     npx tsx --env-file=.env scripts/_backfill-display-images.ts \
 *     --from=MV100 --to=MV110 --no-dry-run
 *
 *   # real run, ALL certs
 *   MINTVAULT_DATABASE_URL='...wispy-morning...' \
 *     npx tsx --env-file=.env scripts/_backfill-display-images.ts \
 *     --all --no-dry-run
 */
import { db } from "../server/db";
import { sql } from "drizzle-orm";
import { storage } from "../server/storage";
import { uploadImagesToCert } from "../server/scan-ingest-service";
import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { takeSnapshot } from "./_backfill-display-images-snapshot";

// ── Prod R2 env binding ────────────────────────────────────────────────────
// server/r2.ts's S3Client is a module-level singleton that lazily initialises
// from process.env.R2_* on its first call. There's no injection hook. To
// route the backfill's writes (uploadImagesToCert → uploadToR2) at prod R2
// rather than whatever scope-limited token is in local .env, we mutate
// process.env BEFORE the singleton initialises. The first uploadToR2 call
// happens inside uploadImagesToCert (per-cert loop) — well after this
// function runs at the top of run(), so the import-time / singleton order
// is safe.
//
// Reads (this script's own makeR2Client + the sentinel HEAD probe) use the
// same prod-write credentials. We don't split read vs write tokens — the
// prod runtime token has all four perms (Head/Get/Put/Delete) on the bucket,
// and a single-token path is simpler / fewer moving parts.
function bindProdR2Env(): { credSource: string; bucket: string; endpoint: string } {
  const writeAk  = process.env.R2_PROD_WRITE_ACCESS_KEY_ID;
  const writeSec = process.env.R2_PROD_WRITE_SECRET_ACCESS_KEY;
  const endpoint = process.env.R2_PROD_ENDPOINT
    ?? "https://ef26a9eb2862c598eb8cc23f6b2e45bc.r2.cloudflarestorage.com";
  const bucket   = process.env.R2_PROD_BUCKET ?? "mintvault-cards";

  if (!writeAk || !writeSec) {
    console.error("ERROR: backfill requires R2_PROD_WRITE_ACCESS_KEY_ID + R2_PROD_WRITE_SECRET_ACCESS_KEY in env.");
    console.error("       Get them from Fly secrets:");
    console.error("         fly ssh console -a mintvault -C 'printenv | grep ^R2_'");
    console.error("       Paste the R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY values into .env as");
    console.error("       R2_PROD_WRITE_ACCESS_KEY_ID + R2_PROD_WRITE_SECRET_ACCESS_KEY.");
    console.error("       Remove both vars from .env after the backfill completes.");
    process.exit(2);
  }

  // Override the singleton's env-var inputs BEFORE getClient() first fires.
  // Endpoint + bucket are typically identical to local .env already (shared
  // bucket), but explicit override defends against .env drift.
  process.env.R2_ENDPOINT          = endpoint;
  process.env.R2_BUCKET_NAME       = bucket;
  process.env.R2_ACCESS_KEY_ID     = writeAk;
  process.env.R2_SECRET_ACCESS_KEY = writeSec;

  return {
    credSource: "R2_PROD_WRITE_* (prod runtime token, shared reads+writes)",
    bucket,
    endpoint,
  };
}

// ── DB host guard ──────────────────────────────────────────────────────────
// The MintVault Neon project has asymmetric branches with diverged data:
//   prod    = ep-wispy-morning-ab6f4o08
//   staging = ep-purple-voice-abfez796
// Local .env points at staging. This script MUST run against prod —
// running against staging would mutate the wrong data (likely a different
// set of MV-numbered rows entirely). Don't trust NODE_ENV; inspect the
// real hostname from MINTVAULT_DATABASE_URL and abort if it isn't prod.
async function assertProdConnection(): Promise<void> {
  const url = process.env.MINTVAULT_DATABASE_URL || "";
  const host = url.match(/@([^/?]+)/)?.[1] ?? "(unknown)";
  const dbInfo = (await db.execute(sql`SELECT current_database() AS db`)).rows[0] as { db: string };

  let verdict: string;
  if (host.includes("wispy-morning")) verdict = "✓ PROD";
  else if (host.includes("purple-voice")) verdict = "⚠ STAGING — ABORTING";
  else verdict = "? unknown branch — ABORTING";

  console.log(`Connected:  db=${dbInfo.db}  host=${host}  [${verdict}]`);

  if (!host.includes("wispy-morning")) {
    console.error("");
    console.error("ERROR: backfill is prod-only. Connected host does not match the prod branch.");
    console.error("       Re-run with the prod MINTVAULT_DATABASE_URL set explicitly, e.g.:");
    console.error("         MINTVAULT_DATABASE_URL='postgresql://...wispy-morning...' \\");
    console.error("           npx tsx scripts/_backfill-display-images.ts <args>");
    process.exit(2);
  }
}

// ── CLI parsing ────────────────────────────────────────────────────────────
interface Args {
  fromNum?: number;
  toNum?: number;
  dryRun: boolean;
  force: boolean;
  limit?: number;
  all: boolean;
}

function parseArgs(): Args {
  const out: Args = { dryRun: true, force: false, all: false };
  for (const arg of process.argv.slice(2)) {
    const m1 = arg.match(/^--(from|to)=MV(\d+)$/);
    const m2 = arg.match(/^--limit=(\d+)$/);
    if (m1) {
      const n = parseInt(m1[2], 10);
      if (m1[1] === "from") out.fromNum = n;
      else                  out.toNum = n;
    } else if (m2) {
      out.limit = parseInt(m2[1], 10);
    } else if (arg === "--no-dry-run") {
      out.dryRun = false;
    } else if (arg === "--dry-run") {
      out.dryRun = true;
    } else if (arg === "--force") {
      out.force = true;
    } else if (arg === "--all") {
      out.all = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: tsx _backfill-display-images.ts [opts]\n" +
        "  --from=MV<n>     inclusive lower bound\n" +
        "  --to=MV<n>       inclusive upper bound\n" +
        "  --all            process every cert (required if --from/--to omitted in real run)\n" +
        "  --limit=N        cap on number of certs processed\n" +
        "  --dry-run        default ON\n" +
        "  --no-dry-run     actually write R2 + DB\n" +
        "  --force          re-process certs whose front_image_path already ends in .png"
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return out;
}

// ── R2 helpers ─────────────────────────────────────────────────────────────
// Reads prod R2 creds from process.env AFTER bindProdR2Env() has overridden
// them. Same client is used for HEAD (skip-check + sentinel) and GET (source
// fetch); writes go via server/r2.ts's singleton using the same env vars.
function makeR2Client(): { client: S3Client; bucket: string } {
  const endpoint = process.env.R2_ENDPOINT!;
  const bucket   = process.env.R2_BUCKET_NAME!;
  const akid     = process.env.R2_ACCESS_KEY_ID!;
  const secret   = process.env.R2_SECRET_ACCESS_KEY!;
  return {
    client: new S3Client({
      region: "auto",
      endpoint,
      credentials: { accessKeyId: akid, secretAccessKey: secret },
    }),
    bucket,
  };
}

// ── R2 reach probe ─────────────────────────────────────────────────────────
// Sentinel HEAD against a known-good prod object (MV109's display key,
// confirmed reachable via the public verify page earlier). If HEAD returns
// 401 / 403 / 404 the creds in scope cannot read prod source files and the
// whole backfill would produce all-MISSING output. Fail fast instead.
const R2_REACH_SENTINEL = "images/MV109/front.jpg";
async function assertR2ReadAccess(client: S3Client, bucket: string): Promise<void> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: R2_REACH_SENTINEL }));
    console.log(`R2 access:   sentinel=${R2_REACH_SENTINEL} [✓ READABLE]`);
  } catch (e: any) {
    const code = e?.$metadata?.httpStatusCode ?? e?.name ?? "?";
    console.error(`R2 access:   sentinel=${R2_REACH_SENTINEL} [✗ ${code} — ABORTING]`);
    console.error("");
    console.error("ERROR: prod R2 sentinel HEAD failed. The configured credentials cannot");
    console.error("       read prod source objects. Check that R2_PROD_WRITE_* are the");
    console.error("       actual values from `fly ssh console -a mintvault -C \"printenv | grep ^R2_\"`,");
    console.error("       not stale or transcribed-incorrectly. Refusing to continue —");
    console.error("       the backfill would otherwise produce all-MISSING output.");
    process.exit(2);
  }
}

async function r2Head(client: S3Client, bucket: string, key: string): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function r2Get(client: S3Client, bucket: string, key: string): Promise<Buffer> {
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const chunks: Buffer[] = [];
  for await (const c of res.Body as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

// ── Cert fetch ─────────────────────────────────────────────────────────────
interface CertRow {
  id: number;
  certificate_number: string;
  front_image_path: string | null;
  back_image_path: string | null;
  grading_front_original: string | null;
  grading_back_original: string | null;
  status: string | null;
  deleted_at: Date | null;
}

async function fetchCerts(args: Args): Promise<CertRow[]> {
  const fromNum = args.fromNum ?? 0;
  const toNum   = args.toNum   ?? Number.MAX_SAFE_INTEGER;
  const limit   = args.limit;

  const limitClause = limit ? sql` LIMIT ${limit}` : sql``;

  const rows = (await db.execute(sql`
    SELECT id, certificate_number, front_image_path, back_image_path,
           grading_front_original, grading_back_original, status, deleted_at
    FROM certificates
    WHERE certificate_number ~ '^MV[0-9]+$'
      AND (regexp_replace(certificate_number, '^MV', ''))::int >= ${fromNum}
      AND (regexp_replace(certificate_number, '^MV', ''))::int <= ${toNum}
    ORDER BY id ASC
    ${limitClause}
  `)).rows as unknown as CertRow[];
  return rows;
}

// ── Skip checks ────────────────────────────────────────────────────────────
type SkipReason = "already_png" | "no_front_original" | "deleted" | "status_void" | "status_other";
interface ProcessPlan {
  cert: CertRow;
  skip: SkipReason | null;
  frontKey: string | null;
  backKey: string | null;
}

async function planForCert(cert: CertRow, r2c: S3Client, bucket: string, force: boolean): Promise<ProcessPlan> {
  if (cert.deleted_at) return { cert, skip: "deleted", frontKey: null, backKey: null };
  if (cert.status === "voided") return { cert, skip: "status_void", frontKey: null, backKey: null };
  if (cert.status && cert.status !== "active" && cert.status !== "draft") {
    return { cert, skip: "status_other", frontKey: null, backKey: null };
  }

  // Idempotency: already-PNG + still on R2 → skip (unless --force)
  if (!force && cert.front_image_path && cert.front_image_path.endsWith(".png")) {
    const exists = await r2Head(r2c, bucket, cert.front_image_path);
    if (exists) return { cert, skip: "already_png", frontKey: null, backKey: null };
  }

  if (!cert.grading_front_original) {
    return { cert, skip: "no_front_original", frontKey: null, backKey: null };
  }

  return {
    cert,
    skip: null,
    frontKey: cert.grading_front_original,
    backKey:  cert.grading_back_original ?? null,
  };
}

// ── Main loop ──────────────────────────────────────────────────────────────
interface RunSummary {
  total: number;
  processed: number;
  skipped: Record<SkipReason, number>;
  failed: { cert: string; error: string }[];
}

async function run(args: Args): Promise<RunSummary> {
  // Guard #1 (must run FIRST): bind prod R2 env vars before server/r2.ts's
  // singleton lazily initialises. Without this, writes would go via the
  // scope-limited token in local .env and reads would 401 on prod keys.
  const r2bind = bindProdR2Env();

  // Guard #2 (unconditional, applies to dry-run too): require prod DB branch.
  // Even a dry-run against staging would generate misleading output, so we
  // fail fast before any other work.
  await assertProdConnection();

  // Guard #3 (R2 connectivity probe): build the read client now that env is
  // bound, then HEAD the sentinel. Catches mistyped / stale R2_PROD_WRITE_*
  // values before any per-cert work.
  const { client: r2c, bucket } = makeR2Client();
  console.log(`R2:          bucket=${r2bind.bucket}  endpoint=${r2bind.endpoint}`);
  console.log(`             creds=${r2bind.credSource}`);
  await assertR2ReadAccess(r2c, bucket);

  // Guard #4: real run requires explicit range OR --all
  if (!args.dryRun) {
    const hasRange = args.fromNum !== undefined && args.toNum !== undefined;
    if (!hasRange && !args.all) {
      console.error("ERROR: --no-dry-run requires --from + --to (range) or --all (whole table).");
      console.error("       Refusing to mutate every cert by default.");
      process.exit(2);
    }
  }

  console.log(`[backfill] mode=${args.dryRun ? "DRY-RUN" : "LIVE"} from=${args.fromNum ?? "*"} to=${args.toNum ?? "*"} force=${args.force} limit=${args.limit ?? "none"}`);

  // Pre-flight snapshot (real run only)
  if (!args.dryRun) {
    console.log("[backfill] taking pre-flight DB snapshot…");
    const snapPath = await takeSnapshot({ fromNum: args.fromNum, toNum: args.toNum });
    console.log(`[backfill] snapshot written: ${snapPath}`);
    console.log(`[backfill] (restore via: psql "$MINTVAULT_DATABASE_URL" -f ${snapPath})`);
    console.log("");
  }

  const certs = await fetchCerts(args);
  console.log(`[backfill] fetched ${certs.length} cert(s) in range`);

  // r2c + bucket already built above for the reach probe — reuse here.

  const summary: RunSummary = {
    total: certs.length,
    processed: 0,
    skipped: { already_png: 0, no_front_original: 0, deleted: 0, status_void: 0, status_other: 0 },
    failed: [],
  };

  for (const cert of certs) {
    const plan = await planForCert(cert, r2c, bucket, args.force);

    if (plan.skip) {
      summary.skipped[plan.skip]++;
      console.log(`  SKIP ${cert.certificate_number} (id=${cert.id}) reason=${plan.skip}`);
      continue;
    }

    const tag = `${cert.certificate_number} (id=${cert.id})`;
    const t0 = Date.now();

    if (args.dryRun) {
      // Dry-run: just HEAD-check both source keys to surface broken R2 references
      const frontOk = await r2Head(r2c, bucket, plan.frontKey!);
      const backOk  = plan.backKey ? await r2Head(r2c, bucket, plan.backKey) : null;
      console.log(
        `  WOULD-PROCESS ${tag}  front=${plan.frontKey} [${frontOk ? "OK" : "MISSING"}]  ` +
        `back=${plan.backKey ?? "—"} [${plan.backKey ? (backOk ? "OK" : "MISSING") : "n/a"}]  ` +
        `→ images/${cert.certificate_number}/front.png + back.png`
      );
      if (!frontOk) {
        console.warn(`    ⚠ source front key not readable on R2 — real run will fail for this cert`);
      }
      summary.processed++;
      continue;
    }

    // Real run
    try {
      console.log(`  PROCESS ${tag} …`);

      // Fetch source buffers
      const frontBuf = await r2Get(r2c, bucket, plan.frontKey!);
      const backBuf  = plan.backKey ? await r2Get(r2c, bucket, plan.backKey).catch(() => null) : null;

      // Capture pre-call state of *_original columns for finally-block restore
      const preOriginalFront = cert.grading_front_original;
      const preOriginalBack  = cert.grading_back_original;

      let pipelineError: Error | null = null;
      try {
        await uploadImagesToCert(cert.id, frontBuf, backBuf);
      } catch (e: any) {
        pipelineError = e;
      } finally {
        // Always restore the *_original columns. uploadImagesToCert's UPDATE
        // overwrites these (it expects a fresh scan); for backfill we keep
        // them pointing at the legacy source so future re-runs work.
        try {
          await db.execute(sql`
            UPDATE certificates SET
              grading_front_original = ${preOriginalFront},
              grading_back_original  = ${preOriginalBack},
              updated_at             = NOW()
            WHERE id = ${cert.id}
          `);
        } catch (restoreErr: any) {
          console.error(`    !! original-ref restore FAILED for ${tag}: ${restoreErr.message}`);
          console.error(`    !! manual fix: UPDATE certificates SET grading_front_original='${preOriginalFront ?? ""}', grading_back_original='${preOriginalBack ?? ""}' WHERE id=${cert.id};`);
        }
      }

      if (pipelineError) throw pipelineError;

      // Audit log
      const after = (await db.execute(sql`
        SELECT front_image_path, back_image_path,
               grading_front_cropped, grading_back_cropped
        FROM certificates WHERE id = ${cert.id}
      `)).rows[0] as Record<string, string | null>;

      await storage.writeAuditLog(
        "certificate",
        cert.certificate_number,
        "display_images_backfilled",
        "backfill_script",
        {
          cert_id: cert.id,
          before: {
            front_image_path:       cert.front_image_path,
            back_image_path:        cert.back_image_path,
            grading_front_original: preOriginalFront,
            grading_back_original:  preOriginalBack,
          },
          after,
          source_sizes_bytes: {
            front: frontBuf.length,
            back:  backBuf ? backBuf.length : null,
          },
          pipeline_version: "converged_v1_v592",
          runtime_ms:       Date.now() - t0,
        },
      );

      summary.processed++;
      const ms = Date.now() - t0;
      console.log(
        `  OK    ${tag}  src_front=${(frontBuf.length / 1024).toFixed(0)}KB` +
        `${backBuf ? ` src_back=${(backBuf.length / 1024).toFixed(0)}KB` : ""}  ${ms}ms`
      );
    } catch (e: any) {
      const msg = e?.message || String(e);
      summary.failed.push({ cert: cert.certificate_number, error: msg });
      console.error(`  FAIL  ${tag}: ${msg}`);
      if (e?.stack) console.error(e.stack);
    }
  }

  return summary;
}

// ── Entry ──────────────────────────────────────────────────────────────────
const args = parseArgs();
run(args)
  .then((s) => {
    console.log("");
    console.log("─── Summary ────────────────────────────────────────");
    console.log(`Total in range:       ${s.total}`);
    console.log(`Processed:            ${s.processed}`);
    console.log(`Skipped already_png:  ${s.skipped.already_png}`);
    console.log(`Skipped no_original:  ${s.skipped.no_front_original}`);
    console.log(`Skipped deleted:      ${s.skipped.deleted}`);
    console.log(`Skipped void:         ${s.skipped.status_void}`);
    console.log(`Skipped other status: ${s.skipped.status_other}`);
    console.log(`Failed:               ${s.failed.length}`);
    if (s.failed.length) {
      console.log("Failed certs:");
      for (const f of s.failed) console.log(`  ${f.cert}: ${f.error}`);
    }
    process.exit(s.failed.length > 0 ? 1 : 0);
  })
  .catch((e) => {
    console.error("[backfill] FATAL:", e);
    process.exit(1);
  });
