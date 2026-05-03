/**
 * scripts/_test-assign-owner-sync.ts
 *
 * Regression smoke for the owner_email / owner_name sync fix in
 * assignOwnerManual (storage.ts). Picks an unclaimed dev cert, runs
 * the storage method directly, asserts the cert row is fully in sync
 * (current_owner_user_id, owner_email, owner_name all match a single
 * user), then unwinds the test rows.
 *
 * ⚠️ Hits the same Neon DB as prod (mintvault and mintvault-v2 share
 * one DB). Cleanup at the end is best-effort: if the script crashes
 * mid-flight, you'll have one orphan ownership_history row + one
 * audit_log row. Cert state is restored.
 *
 * Aborts via env-guard unless ALLOW_PROD_SMOKE=1 (matches existing
 * scripts/test-*.ts pattern).
 *
 * Usage:
 *   tsx --env-file=.env scripts/_test-assign-owner-sync.ts
 */

import crypto from "crypto";
import { db } from "../server/db";
import { sql } from "drizzle-orm";
import { storage } from "../server/storage";

interface Assertion { name: string; ok: boolean; detail?: string }
const assertions: Assertion[] = [];
function record(name: string, ok: boolean, detail?: string) {
  assertions.push({ name, ok, detail });
  console.log(`  ${ok ? "✓ PASS" : "✗ FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function envSafe(): boolean {
  const url = process.env.MINTVAULT_DATABASE_URL || "";
  const looksLikeProd =
    url.includes("ep-wispy-morning") || url.includes("ep-purple-voice");
  if (looksLikeProd && process.env.ALLOW_PROD_SMOKE !== "1") {
    console.error("[smoke] DB looks like prod — aborting. Set ALLOW_PROD_SMOKE=1 to override.");
    return false;
  }
  return true;
}

async function pickUnclaimedCert(): Promise<{ certId: string; previousState: any } | null> {
  // Find a single active, unclaimed cert. We'll write to it and unwind.
  const rows = await db.execute(sql`
    SELECT certificate_number AS cert_id,
           ownership_status,
           current_owner_user_id,
           owner_email,
           owner_name,
           claim_code_used_at,
           ownership_token,
           ownership_token_generated_at
    FROM certificates
    WHERE ownership_status = 'unclaimed'
      AND status = 'active'
      AND deleted_at IS NULL
    ORDER BY id ASC
    LIMIT 1
  `);
  if (rows.rows.length === 0) return null;
  const r = rows.rows[0] as any;
  return { certId: r.cert_id, previousState: r };
}

async function unwind(certId: string, previousState: any, testUserId: string, testEmail: string) {
  // Restore the cert to its prior state — undo the UPDATE the smoke just ran.
  await db.execute(sql`
    UPDATE certificates
    SET current_owner_user_id = ${previousState.current_owner_user_id ?? null},
        owner_email = ${previousState.owner_email ?? null},
        owner_name = ${previousState.owner_name ?? null},
        ownership_status = ${previousState.ownership_status},
        claim_code_used_at = ${previousState.claim_code_used_at ?? null},
        ownership_token = ${previousState.ownership_token ?? null},
        ownership_token_generated_at = ${previousState.ownership_token_generated_at ?? null},
        updated_at = NOW()
    WHERE certificate_number = ${certId}
  `);
  // Remove the test ownership_history row and audit_log row + the test user.
  await db.execute(sql`
    DELETE FROM ownership_history
    WHERE cert_id = ${certId}
      AND to_user_id = ${testUserId}
  `);
  await db.execute(sql`
    DELETE FROM audit_log
    WHERE entity_type = 'certificate'
      AND entity_id = ${certId}
      AND action = 'OWNER_ASSIGNED'
      AND details->>'userId' = ${testUserId}
  `);
  await db.execute(sql`DELETE FROM users WHERE id = ${testUserId} AND email = ${testEmail}`);
}

async function main() {
  if (!envSafe()) process.exit(1);

  const TEST_EMAIL = `assign-sync-smoke-${crypto.randomBytes(4).toString("hex")}@example.test`;
  console.log(`[smoke] test email: ${TEST_EMAIL}`);

  const target = await pickUnclaimedCert();
  if (!target) {
    console.error("[smoke] no unclaimed active cert found in DB — cannot run regression");
    process.exit(2);
  }
  console.log(`[smoke] target cert: ${target.certId} (was ${target.previousState.ownership_status})`);

  // Pre-create the user with a display_name so we can assert owner_name
  // also synced. Mirrors the realistic case where the assignee has a
  // populated profile.
  await db.execute(sql`
    INSERT INTO users (email, display_name, email_verified)
    VALUES (${TEST_EMAIL}, 'Smoke User', true)
  `);
  const userRow = await db.execute(sql`
    SELECT id, email, display_name FROM users WHERE email = ${TEST_EMAIL} LIMIT 1
  `);
  const testUserId = (userRow.rows[0] as any).id;

  // ── Run the storage method ────────────────────────────────────────────────
  await storage.assignOwnerManual(target.certId, TEST_EMAIL, "smoke-test", "regression smoke");

  // ── Read the cert back ────────────────────────────────────────────────────
  const after = await db.execute(sql`
    SELECT certificate_number AS cert_id,
           current_owner_user_id, owner_email, owner_name, ownership_status
    FROM certificates
    WHERE certificate_number = ${target.certId}
  `);
  const a = after.rows[0] as any;

  // ── Assertions ────────────────────────────────────────────────────────────
  record("current_owner_user_id matches test user", a.current_owner_user_id === testUserId, `got=${a.current_owner_user_id}`);
  record("owner_email matches test email (THE FIX)", a.owner_email === TEST_EMAIL, `got=${a.owner_email}`);
  record("owner_name matches user.display_name (THE FIX)", a.owner_name === "Smoke User", `got=${a.owner_name}`);
  record("ownership_status = claimed", a.ownership_status === "claimed", `got=${a.ownership_status}`);

  // ownership_history row was written
  const hist = await db.execute(sql`
    SELECT event_type, from_user_id, to_user_id, to_email FROM ownership_history
    WHERE cert_id = ${target.certId} AND to_user_id = ${testUserId}
  `);
  record("ownership_history row exists for this assign", hist.rows.length === 1, `n=${hist.rows.length}`);

  if (hist.rows.length === 1) {
    const expectedEventType = target.previousState.current_owner_user_id ? "transfer" : "initial_claim";
    const expectedFromUserId = target.previousState.current_owner_user_id ?? null;

    record("ownership_history.to_email matches test email",
      (hist.rows[0] as any).to_email === TEST_EMAIL,
      `got=${(hist.rows[0] as any).to_email}`,
    );
    record("ownership_history.event_type matches branch",
      (hist.rows[0] as any).event_type === expectedEventType,
      `got=${(hist.rows[0] as any).event_type}, expected=${expectedEventType}`,
    );
    record("ownership_history.from_user_id matches previous owner",
      (hist.rows[0] as any).from_user_id === expectedFromUserId,
      `got=${(hist.rows[0] as any).from_user_id}, expected=${expectedFromUserId}`,
    );
  }

  // audit_log row written
  const audit = await db.execute(sql`
    SELECT action, details FROM audit_log
    WHERE entity_type = 'certificate' AND entity_id = ${target.certId}
      AND action = 'OWNER_ASSIGNED'
      AND details->>'userId' = ${testUserId}
  `);
  record("audit_log OWNER_ASSIGNED row created", audit.rows.length === 1, `n=${audit.rows.length}`);

  // ── Unwind ────────────────────────────────────────────────────────────────
  await unwind(target.certId, target.previousState, testUserId, TEST_EMAIL);
  console.log(`[smoke] unwound: cert ${target.certId} restored, test user + audit + history rows removed`);

  // ── Summary ───────────────────────────────────────────────────────────────
  const failed = assertions.filter(a => !a.ok);
  console.log(`\n[smoke] ${assertions.length - failed.length}/${assertions.length} assertions passed`);
  if (failed.length > 0) {
    console.log("[smoke] FAILED:");
    for (const a of failed) console.log(`  - ${a.name}${a.detail ? ` (${a.detail})` : ""}`);
    process.exit(1);
  }
  console.log("[smoke] OK");
  process.exit(0);
}

main().catch(async (err) => {
  console.error("[smoke] unhandled error:", err);
  process.exit(1);
});
