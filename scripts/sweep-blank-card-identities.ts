/**
 * scripts/sweep-blank-card-identities.ts
 *
 * One-shot sweep: auto-identify certs that have a BLANK card name — the cards
 * scanned during the broken window (PR #121), before at-scan auto-identify
 * existed, that nobody has opened yet to trigger the on-open identify.
 *
 * Reuses the SAME identify path the scanner + grading panel use
 * (runAiOnCert, identify-only mode → TCGdex prefill) — no forked logic. For each
 * candidate it fetches the cropped front (+back) from R2 and runs identify.
 *
 * Population:
 *   (card_name IS NULL OR card_name = '') AND grade_approved_at IS NULL
 *   AND deleted_at IS NULL
 *   — only un-approved, un-named certs. Never touches a published grade or a
 *   card that already has a name. Certs with no cropped front in R2 are skipped
 *   (logged) — there's nothing to identify yet.
 *
 * Default: DRY-RUN. Calls runAiOnCert(..., { dryRun: true }) which runs the full
 * identify + TCGdex resolution and RETURNS the would-be name but writes NOTHING.
 * Prints, per cert, the name each resolves to (or "no confident match").
 *
 * --commit: runs the real identify (writes card_name/set_name/ai_analysis +
 * dbSource via the CASE-guarded UPDATE — only fills an empty name, never
 * overwrites). Writes a per-cert sweep audit_log row in addition to
 * runAiOnCert's own 'ai_scan_ingest' row.
 *
 * Idempotent + resume-safe: the population filter is "name is empty", so a
 * filled cert drops out; the UPDATE itself is CASE-guarded on empty. Safe to
 * run twice / resume after a crash.
 *
 * Requires the ai_auto_ingest_enabled master switch ON (runAiOnCert returns a
 * null name with no work when it's off — the dry-run will then show all nulls).
 *
 * ⚠️ Env guard: refuses to run against PROD (ep-wispy-morning) unless
 * ALLOW_PROD=1. Staging (ep-purple-voice) and local run freely. Confirm the host
 * printed at startup before --commit.
 *
 * Usage:
 *   tsx --env-file=.env scripts/sweep-blank-card-identities.ts            # dry-run
 *   tsx --env-file=.env scripts/sweep-blank-card-identities.ts --commit   # write
 */

import { db } from "../server/db";
import { sql } from "drizzle-orm";
import { runAiOnCert } from "../server/scan-ingest-service";
import { getR2Buffer, listR2Keys } from "../server/r2";

const COMMIT_FLAG = "--commit";

interface BlankRow {
  cert_pk: number;
  cert_id: string;
  card_name: string | null;
}

function envSafe(): boolean {
  const url = process.env.MINTVAULT_DATABASE_URL || "";
  if (url.includes("ep-wispy-morning") && process.env.ALLOW_PROD !== "1") {
    console.error("[sweep] DB host is PROD (ep-wispy-morning) — refusing. Set ALLOW_PROD=1 to override.");
    return false;
  }
  return true;
}

async function fetchBlankPopulation(): Promise<BlankRow[]> {
  const rows = await db.execute(sql`
    SELECT id AS cert_pk, certificate_number AS cert_id, card_name
    FROM certificates
    WHERE (card_name IS NULL OR card_name = '')
      AND grade_approved_at IS NULL
      AND deleted_at IS NULL
    ORDER BY certificate_number ASC
  `);
  return rows.rows as unknown as BlankRow[];
}

// Fetch the cropped front (+back) the identify consumes — same R2 keys as the
// on-open ensureAiDraft path.
async function fetchCropped(certPk: number): Promise<{ front: Buffer; back: Buffer | null } | null> {
  const fk = (await listR2Keys(`images/grading/${certPk}/front_cropped`))[0];
  if (!fk) return null;
  const bk = (await listR2Keys(`images/grading/${certPk}/back_cropped`))[0];
  const [front, back] = await Promise.all([getR2Buffer(fk), bk ? getR2Buffer(bk) : Promise.resolve(null)]);
  if (!front) return null;
  return { front, back };
}

async function main(): Promise<void> {
  if (!envSafe()) process.exit(1);

  const commit = process.argv.includes(COMMIT_FLAG);
  console.log(`[sweep] mode: ${commit ? "COMMIT" : "DRY-RUN"}`);
  console.log(`[sweep] DB: ${process.env.MINTVAULT_DATABASE_URL?.match(/@([^/]+)/)?.[1] ?? "unknown"}\n`);

  const population = await fetchBlankPopulation();
  console.log(`[sweep] blank-name certs found: ${population.length}\n`);
  if (population.length === 0) {
    console.log("[sweep] nothing to do — exiting clean");
    process.exit(0);
  }

  let identified = 0;
  let noMatch = 0;
  let noImage = 0;
  let errors = 0;

  for (const r of population) {
    try {
      const imgs = await fetchCropped(r.cert_pk);
      if (!imgs) {
        noImage++;
        console.log(`  ${r.cert_id}: SKIP — no cropped front in R2 yet (nothing to identify)`);
        continue;
      }

      const result = await runAiOnCert(r.cert_pk, imgs.front, imgs.back, { dryRun: !commit });
      const name = result.cardName;

      if (!name) {
        noMatch++;
        console.log(`  ${r.cert_id}: no confident TCGdex match — would stay blank (needs manual override)`);
        continue;
      }

      identified++;
      if (commit) {
        // runAiOnCert already wrote card_name/set_name + its own 'ai_scan_ingest'
        // audit row. Add a sweep-specific trail for this backfill.
        await db.execute(sql`
          INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details, created_at)
          VALUES ('certificate', ${r.cert_id}, 'identity_sweep_backfill', 'system',
            ${JSON.stringify({ before: { card_name: r.card_name ?? null }, after: { card_name: name }, source: "sweep_blank_card_identities" })}::jsonb,
            NOW())
        `);
        console.log(`  ✓ ${r.cert_id}: identified → "${name}"`);
      } else {
        console.log(`  ${r.cert_id}: WOULD identify → "${name}"`);
      }
    } catch (e: any) {
      errors++;
      console.error(`  ✗ ${r.cert_id}: ${e?.message ?? e}`);
    }
  }

  console.log(
    `\n[sweep] ${commit ? "DONE" : "DRY-RUN"} — ${commit ? "identified" : "would identify"}=${identified} no-match=${noMatch} no-image=${noImage} errors=${errors}`
  );
  if (!commit) console.log(`[sweep] DRY-RUN — no rows written. Re-run with ${COMMIT_FLAG} to write.`);
  process.exit(errors > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[sweep] unhandled error:", err);
  process.exit(1);
});
