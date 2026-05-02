/**
 * scripts/backfill-cert-owner-users.ts
 *
 * One-shot backfill for cert-owners who entered via the legacy
 * cert-owner magic-link flow (which only set req.session.customerEmail
 * and never touched the users table). Post-login-unification, every
 * verify produces a users row — but historic cert-owners predating
 * that change need rows backfilled so they can use /vault-club,
 * /account/settings, etc.
 *
 * Idempotent: re-running is a no-op for emails already in users. Safe
 * to ship now and re-run after each new cert-owner sign-up if you want
 * (though the verify endpoint creates the row automatically going
 * forward — this script only matters for the legacy population).
 *
 * Population:
 *   DISTINCT LOWER(submissions.customer_email) where there is no
 *   matching users.email row.
 *   Certificates have NO direct email column — they link to users via
 *   current_owner_user_id, which means already-claimed certs already
 *   have user rows. Submissions are the only source of orphan emails.
 *
 * Per row written:
 *   INSERT INTO users (email, email_verified, created_at)
 *     VALUES (LOWER(email), TRUE, MIN(submissions.created_at))
 *   audit_log row: entity_type='users', action='cert_owner_backfill_create',
 *     admin_user='system', details={source, email, earliest_submission_at}.
 *
 * Default: dry-run. Prints population count + first 5 rows.
 * Re-run with --commit to actually insert.
 *
 * ⚠️ Env guard: aborts unless MINTVAULT_DATABASE_URL is dev/local OR
 * ALLOW_PROD_SMOKE=1 is set (matches 5b/5d/login-bug-fix smoke pattern).
 *
 * Batching: if population > 1000, processes in batches of 250 with a
 * 500ms pause between (Neon-friendly).
 *
 * Usage:
 *   tsx --env-file=.env scripts/backfill-cert-owner-users.ts            # dry-run
 *   tsx --env-file=.env scripts/backfill-cert-owner-users.ts --commit   # actually insert
 */

import { db } from "../server/db";
import { sql } from "drizzle-orm";
import { storage } from "../server/storage";

const COMMIT_FLAG = "--commit";
const BATCH_SIZE = 250;
const BATCH_PAUSE_MS = 500;
const PRINT_PREVIEW_COUNT = 50;

interface OrphanRow {
  email: string;
  earliest_seen: string;
}

function envSafe(): boolean {
  const url = process.env.MINTVAULT_DATABASE_URL || "";
  const looksLikeProd =
    url.includes("ep-wispy-morning") || url.includes("ep-purple-voice");
  if (looksLikeProd && process.env.ALLOW_PROD_SMOKE !== "1") {
    console.error(
      "[backfill] MINTVAULT_DATABASE_URL looks like production/staging — aborting."
    );
    console.error(
      "[backfill] Re-run against dev/local, or set ALLOW_PROD_SMOKE=1 to override."
    );
    return false;
  }
  return true;
}

async function fetchOrphanPopulation(): Promise<OrphanRow[]> {
  const rows = await db.execute(sql`
    SELECT LOWER(s.customer_email) AS email,
           MIN(s.created_at)::text AS earliest_seen
    FROM submissions s
    WHERE s.customer_email IS NOT NULL
      AND s.customer_email <> ''
      AND NOT EXISTS (
        SELECT 1 FROM users u
        WHERE LOWER(u.email) = LOWER(s.customer_email)
          AND u.deleted_at IS NULL
      )
    GROUP BY LOWER(s.customer_email)
    ORDER BY MIN(s.created_at) ASC
  `);
  return rows.rows as unknown as OrphanRow[];
}

async function backfillOne(row: OrphanRow): Promise<{ id: string; created: boolean }> {
  // Re-check NOT EXISTS at insert time — between the SELECT and the
  // INSERT, another process could have created the row (the verify
  // endpoint, a parallel script, etc.). Use INSERT … ON CONFLICT
  // semantics by checking first; createUser doesn't expose ON CONFLICT.
  const existing = await storage.getUserByEmail(row.email);
  if (existing) return { id: existing.id, created: false };

  // createUser sets email + defaults. We then UPDATE to set
  // email_verified=true and created_at=earliest_seen (cert-owner has
  // proved email control via the magic-link flow that produced their
  // submissions; the original verify timestamp isn't preserved, so we
  // anchor created_at at the earliest submission they made).
  const newUser = await storage.createUser({ email: row.email });
  await db.execute(sql`
    UPDATE users
    SET email_verified = TRUE,
        email_verified_at = ${row.earliest_seen}::timestamptz,
        created_at = ${row.earliest_seen}::timestamptz
    WHERE id = ${newUser.id}
  `);
  await storage.writeAuditLog(
    "users",
    newUser.id,
    "cert_owner_backfill_create",
    "system",
    {
      source: "login_unification_migration",
      email: row.email,
      earliest_submission_at: row.earliest_seen,
    },
  );
  return { id: newUser.id, created: true };
}

async function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  if (!envSafe()) process.exit(1);

  const commit = process.argv.includes(COMMIT_FLAG);
  const mode = commit ? "COMMIT" : "DRY-RUN";
  console.log(`[backfill] mode: ${mode}`);
  console.log(`[backfill] DB: ${process.env.MINTVAULT_DATABASE_URL?.match(/@([^/]+)/)?.[1] ?? "unknown"}\n`);

  console.log("[backfill] enumerating orphan emails…");
  const population = await fetchOrphanPopulation();
  console.log(`[backfill] orphan emails found: ${population.length}`);

  if (population.length === 0) {
    console.log("[backfill] nothing to do — exiting clean");
    process.exit(0);
  }

  console.log(`\n[backfill] preview (first ${Math.min(PRINT_PREVIEW_COUNT, population.length)}):`);
  for (const r of population.slice(0, PRINT_PREVIEW_COUNT)) {
    console.log(`  ${r.email}  (earliest: ${r.earliest_seen})`);
  }
  if (population.length > PRINT_PREVIEW_COUNT) {
    console.log(`  … and ${population.length - PRINT_PREVIEW_COUNT} more`);
  }

  if (!commit) {
    console.log(`\n[backfill] DRY-RUN — no rows written. Re-run with ${COMMIT_FLAG} to commit.`);
    process.exit(0);
  }

  // Commit path
  console.log(`\n[backfill] committing in batches of ${BATCH_SIZE}…`);
  let createdCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  for (let i = 0; i < population.length; i += BATCH_SIZE) {
    const batch = population.slice(i, i + BATCH_SIZE);
    for (const row of batch) {
      try {
        const result = await backfillOne(row);
        if (result.created) createdCount++;
        else skippedCount++;
      } catch (e: any) {
        errorCount++;
        console.error(`  ✗ ${row.email}: ${e?.message ?? e}`);
      }
    }
    console.log(
      `  batch ${Math.floor(i / BATCH_SIZE) + 1}: created=${createdCount} skipped=${skippedCount} errors=${errorCount} processed=${i + batch.length}/${population.length}`
    );
    if (i + BATCH_SIZE < population.length) {
      await sleep(BATCH_PAUSE_MS);
    }
  }

  console.log(
    `\n[backfill] DONE — created=${createdCount} skipped(already-existed)=${skippedCount} errors=${errorCount}`
  );
  if (errorCount > 0) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill] unhandled error:", err);
  process.exit(1);
});
