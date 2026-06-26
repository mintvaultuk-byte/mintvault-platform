/**
 * scripts/backfill_graded_by_attribution.ts
 *
 * PHASE 3 one-shot backfill: populate certificates.graded_by for historical
 * certs that were graded + approved under the LEGACY single-operator flow,
 * before per-operator attribution existed.
 *
 * Background:
 *   Until Phase 3, the admin approve path hard-coded grade_approved_by =
 *   "Cornelius Oliver" and there was no separate "who graded" column. Every
 *   historical cert was graded AND approved by Cornelius himself through the
 *   admin panel. Phase 3 splits the two: graded_by (who graded) vs
 *   grade_approved_by (who approved). New submits now write graded_by; this
 *   backfill gives the historical rows the same attribution so per-operator
 *   reporting has complete history.
 *
 * Population (the 191 legacy certs):
 *   Every cert that was approved (grade_approved_at IS NOT NULL) but has no
 *   graded_by yet (graded_by IS NULL). These are the pre-Phase-3 records.
 *
 * Per row written:
 *   UPDATE certificates SET graded_by = <GRADED_BY_VALUE>, updated_at = NOW()
 *   WHERE id = $1 AND graded_by IS NULL
 *   audit_log row: entity_type='certificate', entity_id=cert_id,
 *     action='graded_by_backfill', admin_user='system',
 *     details={ before:{graded_by:null}, after:{graded_by:<value>},
 *               grade_approved_by, grade_approved_at,
 *               source:'phase3_operator_attribution_backfill_20260626' }
 *
 *   NOTE: operator_grade / operator_subgrades are intentionally left NULL for
 *   these rows. Historically the grader and the approver were the same person,
 *   so there is no independent operator attempt distinct from the approved
 *   grade — there is nothing to snapshot or random-check against. Only
 *   graded_by (attribution of who graded) is filled.
 *
 * Idempotent + resume-safe: the population filter is `graded_by IS NULL`, so a
 * committed row drops out of the population. Re-running after a partial/full
 * commit finds fewer (eventually zero) rows — safe to run twice, safe to
 * resume after a crash.
 *
 * Default: DRY-RUN. Prints the population count + each cert's before/after.
 * Re-run with --commit to actually write.
 *
 * The value written defaults to the same display string the legacy approve
 * path used ("Cornelius Oliver"), matching the existing grade_approved_by on
 * these rows. Override with GRADED_BY_VALUE=<...> if Cornelius wants a user id
 * instead — the dry-run shows exactly what will be written either way.
 *
 * ⚠️ Env guard: aborts against prod/staging Neon unless ALLOW_PROD_SMOKE=1 is
 * set (matches scripts/backfill_owner_email_sync.ts pattern). Confirm the host
 * before committing.
 *
 * Usage:
 *   tsx --env-file=.env scripts/backfill_graded_by_attribution.ts            # dry-run
 *   tsx --env-file=.env scripts/backfill_graded_by_attribution.ts --commit   # actually write
 */

import { db } from "../server/db";
import { sql } from "drizzle-orm";

const COMMIT_FLAG = "--commit";
const GRADED_BY_VALUE = process.env.GRADED_BY_VALUE || "Cornelius Oliver";
const SOURCE_TAG = "phase3_operator_attribution_backfill_20260626";

interface LegacyRow {
  cert_pk: number;
  cert_id: string;
  grade_approved_by: string | null;
  grade_approved_at: string | null;
}

function envSafe(): boolean {
  const url = process.env.MINTVAULT_DATABASE_URL || "";
  const looksLikeProd =
    url.includes("ep-wispy-morning") || url.includes("ep-purple-voice");
  if (looksLikeProd && process.env.ALLOW_PROD_SMOKE !== "1") {
    console.error("[backfill] DB looks like prod/staging — aborting. Set ALLOW_PROD_SMOKE=1 to override.");
    return false;
  }
  return true;
}

async function fetchLegacyPopulation(): Promise<LegacyRow[]> {
  const rows = await db.execute(sql`
    SELECT
      c.id                  AS cert_pk,
      c.certificate_number  AS cert_id,
      c.grade_approved_by   AS grade_approved_by,
      c.grade_approved_at   AS grade_approved_at
    FROM certificates c
    WHERE c.grade_approved_at IS NOT NULL
      AND c.graded_by IS NULL
      AND c.deleted_at IS NULL
    ORDER BY c.certificate_number ASC
  `);
  return rows.rows as unknown as LegacyRow[];
}

async function applyOne(row: LegacyRow): Promise<void> {
  // Guard the UPDATE itself with `graded_by IS NULL` so a concurrent run or a
  // re-run never overwrites a value already written (resume-safe).
  await db.execute(sql`
    UPDATE certificates
    SET graded_by = ${GRADED_BY_VALUE},
        updated_at = NOW()
    WHERE id = ${row.cert_pk} AND graded_by IS NULL
  `);
  await db.execute(sql`
    INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
    VALUES (
      'certificate',
      ${row.cert_id},
      'graded_by_backfill',
      'system',
      ${JSON.stringify({
        before: { graded_by: null },
        after: { graded_by: GRADED_BY_VALUE },
        grade_approved_by: row.grade_approved_by,
        grade_approved_at: row.grade_approved_at,
        source: SOURCE_TAG,
      })}::jsonb
    )
  `);
}

async function main(): Promise<void> {
  if (!envSafe()) process.exit(1);

  const commit = process.argv.includes(COMMIT_FLAG);
  const mode = commit ? "COMMIT" : "DRY-RUN";
  console.log(`[backfill] mode: ${mode}`);
  console.log(`[backfill] DB: ${process.env.MINTVAULT_DATABASE_URL?.match(/@([^/]+)/)?.[1] ?? "unknown"}`);
  console.log(`[backfill] graded_by value to write: "${GRADED_BY_VALUE}"\n`);

  console.log("[backfill] enumerating legacy (approved, graded_by IS NULL) certs…");
  const population = await fetchLegacyPopulation();
  console.log(`[backfill] legacy certs found: ${population.length}\n`);

  if (population.length === 0) {
    console.log("[backfill] nothing to do — exiting clean");
    process.exit(0);
  }

  console.log("[backfill] preview:");
  for (const r of population) {
    console.log(`  ${r.cert_id} (pk=${r.cert_pk})`);
    console.log(`    BEFORE: graded_by=NULL  grade_approved_by=${r.grade_approved_by ?? "NULL"}  grade_approved_at=${r.grade_approved_at ?? "NULL"}`);
    console.log(`    AFTER : graded_by="${GRADED_BY_VALUE}"`);
  }

  if (!commit) {
    console.log(`\n[backfill] DRY-RUN — no rows written. Re-run with ${COMMIT_FLAG} to commit.`);
    process.exit(0);
  }

  // Commit path
  console.log(`\n[backfill] committing…`);
  let writtenCount = 0;
  let errorCount = 0;
  for (const row of population) {
    try {
      await applyOne(row);
      writtenCount++;
      console.log(`  ✓ ${row.cert_id} → graded_by="${GRADED_BY_VALUE}"`);
    } catch (e: any) {
      errorCount++;
      console.error(`  ✗ ${row.cert_id}: ${e?.message ?? e}`);
    }
  }

  console.log(`\n[backfill] DONE — written=${writtenCount} errors=${errorCount}`);
  if (errorCount > 0) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill] unhandled error:", err);
  process.exit(1);
});
