/**
 * scripts/cleanup-step3-test-events.ts
 *
 * One-shot cleanup for the failed Step 3 webhook test run on 2026-05-01.
 *
 * The Stripe API version bug (current_period_start/end moved to
 * SubscriptionItem) caused every webhook handler that called
 * upsertSubscriptionRow to throw "Invalid time value", returning 400 to
 * Stripe. The handlers had already written rows into vault_club_events
 * before the throw — so re-running the smoke test after the fix won't
 * re-process those events because insertVaultClubEvent's
 * ON CONFLICT (stripe_event_id) DO NOTHING fires and isNewEvent is false.
 *
 * Deleting these rows lets Stripe's retry (or a fresh smoke run) re-fire
 * the same handlers, which now reach the upsert + audit write.
 *
 * Targets only rows from today's failed testing — user 53929879,
 * created_at >= 2026-05-01. Prints rows BEFORE deleting as proof.
 *
 * Usage:
 *   tsx --env-file=.env scripts/cleanup-step3-test-events.ts
 *
 * NOT committed — one-shot. Delete the file once Cornelius runs it.
 */

import { db } from "../server/db";
import { sql } from "drizzle-orm";

const USER_ID = "53929879";

async function main(): Promise<void> {
  console.log(`[cleanup] target user_id: ${USER_ID}`);
  console.log(`[cleanup] cutoff: created_at >= 2026-05-01`);

  const beforeRows = await db.execute(sql`
    SELECT id, user_id, stripe_event_id, event_type, status, created_at
    FROM vault_club_events
    WHERE user_id = ${USER_ID}
      AND created_at >= '2026-05-01'
    ORDER BY created_at ASC
  `);

  console.log(`\n[cleanup] rows to delete: ${beforeRows.rows.length}`);
  for (const row of beforeRows.rows) {
    console.log(JSON.stringify(row, null, 2));
  }

  if (beforeRows.rows.length === 0) {
    console.log("[cleanup] nothing to do — exiting clean");
    process.exit(0);
  }

  const result = await db.execute(sql`
    DELETE FROM vault_club_events
    WHERE user_id = ${USER_ID}
      AND created_at >= '2026-05-01'
  `);
  console.log(`\n[cleanup] deleted ${result.rowCount ?? "?"} rows`);

  // Verify
  const after = await db.execute(sql`
    SELECT COUNT(*) AS n FROM vault_club_events
    WHERE user_id = ${USER_ID}
      AND created_at >= '2026-05-01'
  `);
  console.log(`[cleanup] remaining matching rows: ${(after.rows[0] as any).n}`);

  process.exit(0);
}

main().catch((err) => {
  console.error("[cleanup] error:", err);
  process.exit(1);
});
