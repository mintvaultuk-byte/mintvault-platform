/**
 * scripts/backfill-labels.ts
 *
 * Regenerate front + back label PNGs for every certificate in the DB and
 * upload them to R2 under the canonical key pattern:
 *   labels/{certId}/front.png
 *   labels/{certId}/back.png
 *
 * Uses the same generateLabelPNG() that the admin label endpoints call,
 * and applies label_overrides exactly the same way (so re-renders reflect
 * any per-cert display field tweaks).
 *
 * Note: as of the time this script was written, no existing code path
 * READS labels/* from R2 — both label endpoints (routes.ts:5630 and
 * routes.ts:6065) regenerate live and stream to the response. This script
 * is the first writer. If a future endpoint starts reading from this
 * prefix, it should fall back to live generation when the object is
 * missing (e.g. for certs minted before this backfill ran).
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/backfill-labels.ts --dry-run
 *     Logs what would happen. NO R2 writes.
 *   npx tsx --env-file=.env scripts/backfill-labels.ts
 *     Live run. Uploads PNGs sequentially.
 *   npx tsx --env-file=.env scripts/backfill-labels.ts --from MV1 --to MV460
 *     Range-limit by numeric cert sequence.
 *
 * Processes sequentially to avoid hammering R2 / the canvas renderer.
 */

import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { certificates, labelOverrides } from "../shared/schema";
import { generateLabelPNG, applyLabelOverrides } from "../server/labels";
import { uploadToR2, r2KeyForLabel } from "../server/r2";

interface Args {
  dryRun: boolean;
  fromSeq: number | undefined;
  toSeq: number | undefined;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const from = flag("--from");
  const to = flag("--to");
  return { dryRun, fromSeq: certSeq(from), toSeq: certSeq(to) };
}

function normalizeCertId(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.replace(/^(MV)0+(\d)/i, "$1$2").toUpperCase();
}

function certSeq(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = normalizeCertId(raw).match(/^MV(\d+)$/);
  return m ? parseInt(m[1], 10) : undefined;
}

async function main() {
  const { dryRun, fromSeq, toSeq } = parseArgs();

  const DATABASE_URL = process.env.MINTVAULT_DATABASE_URL;
  if (!DATABASE_URL) {
    console.error("MINTVAULT_DATABASE_URL not set in environment");
    process.exit(1);
  }
  if (!dryRun) {
    // Sanity: ensure R2 creds are present for a live run so we fail before
    // doing any work rather than mid-cert.
    for (const v of ["R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"]) {
      if (!process.env[v]) {
        console.error(`Live run requires ${v} — set it or pass --dry-run`);
        process.exit(1);
      }
    }
  }

  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const db = drizzle(pool);

  console.log(`[backfill-labels] mode=${dryRun ? "DRY-RUN" : "LIVE"} from=${fromSeq ?? "*"} to=${toSeq ?? "*"}`);

  const allCerts = await db.select().from(certificates).orderBy(certificates.id);
  const inScope = allCerts.filter((c) => {
    const seq = certSeq(c.certId);
    if (seq === undefined) return false;
    if (fromSeq !== undefined && seq < fromSeq) return false;
    if (toSeq !== undefined && seq > toSeq) return false;
    return true;
  });

  console.log(`[backfill-labels] scope: ${inScope.length} cert(s) (of ${allCerts.length} total in DB)`);

  let ok = 0;
  let err = 0;
  const startedAt = Date.now();

  for (let idx = 0; idx < inScope.length; idx++) {
    const rawCert = inScope[idx];
    const certId = normalizeCertId(rawCert.certId);
    const prefix = `[${idx + 1}/${inScope.length}] ${certId}`;
    try {
      const overrideRows = await db.select().from(labelOverrides).where(eq(labelOverrides.certId, certId)).limit(1);
      const cert = applyLabelOverrides({ ...rawCert, certId }, overrideRows[0] ?? null);

      const frontKey = r2KeyForLabel(certId, "front", "png");
      const backKey = r2KeyForLabel(certId, "back", "png");

      if (dryRun) {
        console.log(`${prefix} DRY-RUN — would upload ${frontKey} + ${backKey}`);
        ok++;
        continue;
      }

      const t0 = Date.now();
      const frontPng = await generateLabelPNG(cert, "front");
      await uploadToR2(frontKey, frontPng, "image/png");
      const backPng = await generateLabelPNG(cert, "back");
      await uploadToR2(backKey, backPng, "image/png");
      const dt = Date.now() - t0;

      console.log(`${prefix} OK — uploaded ${frontKey} + ${backKey} (${dt}ms)`);
      ok++;
    } catch (e: any) {
      console.log(`${prefix} ERR — ${e?.message ?? String(e)}`);
      err++;
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `[backfill-labels] DONE: ok=${ok} err=${err} elapsed=${elapsed}s${dryRun ? " (dry-run, no R2 writes)" : ""}`
  );

  await pool.end();
}

main().catch((e) => {
  console.error("[backfill-labels] fatal:", e);
  process.exit(1);
});
