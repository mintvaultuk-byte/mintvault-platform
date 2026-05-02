/**
 * scripts/test-vault-club-reminders.ts
 *
 * Smoke test for the Phase 1 Step 5b reminder dispatcher. Tracked.
 *
 * What it does:
 *   1. Inserts a fake reminder row scheduled for NOW() - 1 minute,
 *      reminder_type 'trial_ending'. Pinned to a user_id that exists
 *      in the dev DB (defaults to 53929879 — Cornelius's account) and
 *      a fake subscription_id that intentionally does NOT exist in
 *      vault_club_subscriptions.
 *   2. Runs runReminderDispatcher() once.
 *   3. Verifies the row was processed: sent_at populated AND email_message_id
 *      starts with "skipped:" (because the dispatcher's sub-not-in-db
 *      guard fires before any Resend call). Audit log gets a
 *      "reminder_skipped" row.
 *   4. Runs the dispatcher AGAIN — confirms a second run is a no-op
 *      (no further audit_log row written; sent_at stays the same).
 *   5. Cleans up the test reminder row.
 *
 * The skip path is exactly what we want to test in dev: it exercises
 * the dispatcher's row-selection, the eligibility guard, the
 * markReminderSkipped helper, the audit writes, and the idempotency
 * across runs — all without making any Resend API calls. Sending a
 * real email from a smoke test would either spam Cornelius or hit
 * Resend's allowlist.
 *
 * Usage:
 *   tsx --env-file=.env scripts/test-vault-club-reminders.ts [user_id]
 *
 * DO NOT run against production — the script writes to the DB it points
 * at via MINTVAULT_DATABASE_URL. Use a dev or staging connection string.
 *
 * Prints per-assertion pass/fail. Exit code 0 = all pass, 1 = any fail.
 */

import { db } from "../server/db";
import { sql } from "drizzle-orm";
import { migrateSubscriptionRemindersSchema } from "../server/vault-club-reminders-schema";
import { runReminderDispatcher } from "../server/vault-club-reminders-dispatcher";

const USER_ID = process.argv[2] || "53929879";
// Fake subscription id — chosen so it cannot collide with any real
// Stripe sub id (no `sub_` prefix) and won't be in vault_club_subscriptions.
const FAKE_SUB_ID = `sub_TEST_REMINDERS_SMOKE_${Date.now()}`;
const REMINDER_TYPE = "trial_ending" as const;

interface Assertion {
  name: string;
  ok: boolean;
  detail?: string;
}

const assertions: Assertion[] = [];
function record(name: string, ok: boolean, detail?: string) {
  assertions.push({ name, ok, detail });
  const tag = ok ? "✓ PASS" : "✗ FAIL";
  console.log(`  ${tag}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function loadReminderRow(id: string) {
  const r = await db.execute(sql`
    SELECT id, sent_at, email_message_id, send_error
    FROM subscription_reminders WHERE id = ${id}
  `);
  return (r.rows[0] as any) ?? null;
}

async function countAuditRows(reminderId: string): Promise<number> {
  const r = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM audit_log
    WHERE entity_type = 'subscription_reminder' AND entity_id = ${reminderId}
  `);
  return (r.rows[0] as any).n as number;
}

async function main() {
  console.log(`[smoke] user_id: ${USER_ID}`);
  console.log(`[smoke] fake subscription_id: ${FAKE_SUB_ID}\n`);

  // 0. Ensure the schema is in place (idempotent — server startup also
  //    runs this; calling here lets the smoke test bootstrap a fresh DB).
  console.log("[smoke] step 0 — ensure subscription_reminders table exists");
  await migrateSubscriptionRemindersSchema();
  console.log("  ok\n");

  // 1. Insert the fake reminder row
  console.log("[smoke] step 1 — insert fake reminder row");
  const insert = await db.execute(sql`
    INSERT INTO subscription_reminders
      (subscription_id, user_id, reminder_type, scheduled_for)
    VALUES
      (${FAKE_SUB_ID}, ${USER_ID}, ${REMINDER_TYPE}, NOW() - INTERVAL '1 minute')
    RETURNING id
  `);
  const reminderId = (insert.rows[0] as any).id as string;
  console.log(`  inserted: ${reminderId}\n`);

  try {
    // 2. First dispatcher run
    console.log("[smoke] step 2 — first dispatcher run");
    const result1 = await runReminderDispatcher();
    console.log(`  result: ${JSON.stringify(result1)}`);
    record(
      "first run scanned at least 1 row",
      result1.scanned >= 1,
      `scanned=${result1.scanned}`
    );
    record(
      "first run skipped at least 1 row",
      result1.skipped >= 1,
      `skipped=${result1.skipped}`
    );

    // 3. Verify row was processed
    console.log("\n[smoke] step 3 — verify row state after first run");
    const row1 = await loadReminderRow(reminderId);
    record("reminder row still exists", row1 !== null);
    record("sent_at populated", !!row1?.sent_at, `sent_at=${row1?.sent_at ?? "null"}`);
    record(
      "email_message_id starts with 'skipped:'",
      typeof row1?.email_message_id === "string" && row1.email_message_id.startsWith("skipped:"),
      `email_message_id=${row1?.email_message_id ?? "null"}`
    );
    record("send_error is null", row1?.send_error === null);

    // 4. Verify audit row written
    const auditCount1 = await countAuditRows(reminderId);
    record(
      "exactly 1 audit_log row written",
      auditCount1 === 1,
      `count=${auditCount1}`
    );

    // 5. Second dispatcher run — should be a no-op for this row
    console.log("\n[smoke] step 4 — second dispatcher run (idempotency check)");
    const result2 = await runReminderDispatcher();
    console.log(`  result: ${JSON.stringify(result2)}`);

    const row2 = await loadReminderRow(reminderId);
    record(
      "sent_at unchanged after second run",
      row2?.sent_at === row1?.sent_at,
      `before=${row1?.sent_at} after=${row2?.sent_at}`
    );
    const auditCount2 = await countAuditRows(reminderId);
    record(
      "no new audit_log row added on second run",
      auditCount2 === auditCount1,
      `was=${auditCount1} now=${auditCount2}`
    );
  } finally {
    // Cleanup — soft-delete-only convention doesn't apply to test
    // fixtures; this row was synthetic and explicitly created for
    // this run.
    await db.execute(sql`
      DELETE FROM subscription_reminders WHERE id = ${reminderId}
    `);
    await db.execute(sql`
      DELETE FROM audit_log
      WHERE entity_type = 'subscription_reminder' AND entity_id = ${reminderId}
    `);
    console.log(`\n[smoke] cleanup: removed reminder row + audit rows for ${reminderId}`);
  }

  // Summary
  const failed = assertions.filter((a) => !a.ok);
  console.log(
    `\n[smoke] ${assertions.length - failed.length}/${assertions.length} assertions passed`
  );
  if (failed.length > 0) {
    console.log("[smoke] FAILED:");
    for (const a of failed) console.log(`  - ${a.name}${a.detail ? ` (${a.detail})` : ""}`);
    process.exit(1);
  }
  console.log("[smoke] OK");
  process.exit(0);
}

main().catch((err) => {
  console.error("[smoke] unhandled error:", err);
  process.exit(1);
});
