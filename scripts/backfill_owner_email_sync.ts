/**
 * scripts/backfill_owner_email_sync.ts
 *
 * One-shot backfill: re-syncs certificates.owner_email and
 * certificates.owner_name with the user record pointed to by
 * certificates.current_owner_user_id.
 *
 * Population:
 *   Every claimed, non-voided, non-deleted cert where
 *   LOWER(certificates.owner_email) <> LOWER(users.email)  OR
 *   certificates.owner_email IS NULL while users.email IS NOT NULL.
 *
 *   Soft-skipped: certs whose owner has users.email NULL or empty
 *   (shouldn't exist post-2026-04-19 unification, but defensive).
 *
 * Per row written:
 *   UPDATE certificates SET owner_email = u.email,
 *                            owner_name = u.display_name,
 *                            updated_at = NOW()
 *   WHERE id = $1
 *   audit_log row: entity_type='certificate', entity_id=cert_id,
 *     action='owner_email_backfill', admin_user='system',
 *     details={ before: {owner_email,owner_name}, after: {owner_email,owner_name},
 *              source: 'assignOwnerManual_drift_fix_20260503' }
 *
 * Default: dry-run. Prints the population count + each cert's
 * before/after. Re-run with --commit to actually write.
 *
 * ⚠️ Env guard: aborts unless MINTVAULT_DATABASE_URL is dev/local OR
 * ALLOW_PROD_SMOKE=1 is set (matches existing scripts/test-*.ts +
 * scripts/backfill-cert-owner-users.ts pattern).
 *
 * Usage:
 *   tsx --env-file=.env scripts/backfill_owner_email_sync.ts            # dry-run
 *   tsx --env-file=.env scripts/backfill_owner_email_sync.ts --commit   # actually write
 */

import { db } from "../server/db";
import { sql } from "drizzle-orm";

const COMMIT_FLAG = "--commit";

interface DriftRow {
  cert_pk: number;
  cert_id: string;
  current_owner_user_id: string;
  cert_owner_email: string | null;
  cert_owner_name: string | null;
  user_email: string;
  user_display_name: string | null;
}

function envSafe(): boolean {
  const url = process.env.MINTVAULT_DATABASE_URL || "";
  const looksLikeProd =
    url.includes("ep-wispy-morning") || url.includes("ep-purple-voice");
  if (looksLikeProd && process.env.ALLOW_PROD_SMOKE !== "1") {
    console.error("[backfill] DB looks like prod — aborting. Set ALLOW_PROD_SMOKE=1 to override.");
    return false;
  }
  return true;
}

async function fetchDriftPopulation(): Promise<DriftRow[]> {
  const rows = await db.execute(sql`
    SELECT
      c.id                        AS cert_pk,
      c.certificate_number        AS cert_id,
      c.current_owner_user_id     AS current_owner_user_id,
      c.owner_email               AS cert_owner_email,
      c.owner_name                AS cert_owner_name,
      u.email                     AS user_email,
      u.display_name              AS user_display_name
    FROM certificates c
    JOIN users u ON u.id = c.current_owner_user_id
    WHERE c.current_owner_user_id IS NOT NULL
      AND c.deleted_at IS NULL
      AND c.status != 'voided'
      AND u.email IS NOT NULL
      AND u.email <> ''
      AND u.deleted_at IS NULL
      AND (
        LOWER(c.owner_email) <> LOWER(u.email)
        OR (c.owner_email IS NULL AND u.email IS NOT NULL)
      )
    ORDER BY c.certificate_number ASC
  `);
  return rows.rows as unknown as DriftRow[];
}

async function applyOne(row: DriftRow): Promise<void> {
  const before = {
    owner_email: row.cert_owner_email,
    owner_name: row.cert_owner_name,
  };
  const after = {
    owner_email: row.user_email.toLowerCase(),
    owner_name: row.user_display_name ?? null,
  };
  await db.execute(sql`
    UPDATE certificates
    SET owner_email = ${after.owner_email},
        owner_name = ${after.owner_name},
        updated_at = NOW()
    WHERE id = ${row.cert_pk}
  `);
  await db.execute(sql`
    INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
    VALUES (
      'certificate',
      ${row.cert_id},
      'owner_email_backfill',
      'system',
      ${JSON.stringify({
        before,
        after,
        current_owner_user_id: row.current_owner_user_id,
        source: "assignOwnerManual_drift_fix_20260503",
      })}::jsonb
    )
  `);
}

async function main(): Promise<void> {
  if (!envSafe()) process.exit(1);

  const commit = process.argv.includes(COMMIT_FLAG);
  const mode = commit ? "COMMIT" : "DRY-RUN";
  console.log(`[backfill] mode: ${mode}`);
  console.log(`[backfill] DB: ${process.env.MINTVAULT_DATABASE_URL?.match(/@([^/]+)/)?.[1] ?? "unknown"}\n`);

  console.log("[backfill] enumerating drift…");
  const population = await fetchDriftPopulation();
  console.log(`[backfill] drifted certs found: ${population.length}\n`);

  if (population.length === 0) {
    console.log("[backfill] nothing to do — exiting clean");
    process.exit(0);
  }

  console.log("[backfill] preview:");
  for (const r of population) {
    console.log(`  ${r.cert_id} (pk=${r.cert_pk})`);
    console.log(`    BEFORE: owner_email=${r.cert_owner_email ?? "NULL"}  owner_name=${r.cert_owner_name ?? "NULL"}`);
    console.log(`    AFTER : owner_email=${r.user_email.toLowerCase()}  owner_name=${r.user_display_name ?? "NULL"}`);
    console.log(`    user_id=${r.current_owner_user_id}`);
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
      console.log(`  ✓ ${row.cert_id} synced`);
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
