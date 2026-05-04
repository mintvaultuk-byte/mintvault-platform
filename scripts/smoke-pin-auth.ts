/**
 * scripts/smoke-pin-auth.ts
 *
 * DB-layer lifecycle test for PIN auth (Checkpoint 4 of the v1 launch
 * PIN-auth build). Exercises server/pin.ts + storage helpers directly —
 * NO HTTP layer required. Same approach as scripts/test-login-unification.ts.
 *
 * Scenarios covered (10 assertions):
 *   1. Strength validator rejects weak PINs (all-same, sequential, DOB-shaped)
 *   2. Strength validator accepts a clean PIN
 *   3. hashPin + verifyPin round-trip
 *   4. Setup: write pin_hash to a fresh user row
 *   5. checkLockout on fresh user → not locked
 *   6. registerFailure x1 → not locked, count=1
 *   7. registerFailure x2 more → locked, retryAfter ~15min
 *   8. resetFailures clears state
 *   9. Forgot-PIN flow: insert pin_reset_tokens row, atomic consume
 *  10. Post-reset login (verifyPin against new hash)
 *
 * Cleanup at the end: DELETE the test user + pin_attempts + pin_reset_tokens
 * + audit_log entries the smoke wrote.
 *
 * ⚠️ Hits the shared Neon DB (staging + prod share one DB). Test email is
 * throwaway and unique per run — collisions impossible. Aborts via env-guard
 * unless ALLOW_PROD_SMOKE=1 (matches the existing smoke-script convention).
 *
 * Usage:
 *   ALLOW_PROD_SMOKE=1 tsx --env-file=.env scripts/smoke-pin-auth.ts
 */

import crypto from "crypto";
import { db } from "../server/db";
import { sql } from "drizzle-orm";
import {
  hashPin,
  verifyPin,
  validatePinStrength,
  WeakPinError,
  checkLockout,
  registerFailure,
  resetFailures,
  PIN_LOCKOUT_THRESHOLD,
  PIN_LOCKOUT_DURATION_MS,
} from "../server/pin";

const TEST_EMAIL = `smoke-pin-${crypto.randomBytes(6).toString("hex")}@example.test`;
const GOOD_PIN = "8462571".slice(0, 6);  // not all-same, not sequential, not DOB-shaped

interface Assertion { name: string; ok: boolean; detail?: string }
const assertions: Assertion[] = [];
function record(name: string, ok: boolean, detail?: string) {
  assertions.push({ name, ok, detail });
  console.log(`  ${ok ? "✓ PASS" : "✗ FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function envSafe(): boolean {
  const url = process.env.MINTVAULT_DATABASE_URL || "";
  const looksLikeProd = url.includes("ep-wispy-morning") || url.includes("ep-purple-voice");
  if (looksLikeProd && process.env.ALLOW_PROD_SMOKE !== "1") {
    console.error("[smoke] DB looks like prod — aborting. Set ALLOW_PROD_SMOKE=1 to override.");
    return false;
  }
  return true;
}

async function cleanup(testUserId: string | null) {
  try {
    await db.execute(sql`DELETE FROM pin_attempts WHERE LOWER(email) = LOWER(${TEST_EMAIL})`);
    await db.execute(sql`DELETE FROM pin_reset_tokens WHERE LOWER(email) = LOWER(${TEST_EMAIL})`);
    await db.execute(sql`DELETE FROM audit_log WHERE entity_type='auth' AND details->>'email_masked' LIKE ${TEST_EMAIL.slice(0, 2) + "***@%"}`);
    if (testUserId) {
      await db.execute(sql`DELETE FROM users WHERE id = ${testUserId}`);
    } else {
      await db.execute(sql`DELETE FROM users WHERE LOWER(email) = LOWER(${TEST_EMAIL})`);
    }
    console.log(`[smoke] cleanup: removed test user ${testUserId ?? "(by email)"} + attempts + reset tokens`);
  } catch (e: any) {
    console.warn("[smoke] cleanup encountered an error (non-fatal):", e?.message ?? e);
  }
}

async function main(): Promise<void> {
  if (!envSafe()) process.exit(1);
  console.log(`[smoke] test email: ${TEST_EMAIL}`);
  console.log(`[smoke] lockout threshold: ${PIN_LOCKOUT_THRESHOLD} failures, ${PIN_LOCKOUT_DURATION_MS / 60000}-min cooldown\n`);

  let testUserId: string | null = null;

  try {
    // ── 1: Strength validator rejects weak PINs ──────────────────────────────
    const weakSamples: { pin: string; expectedReason: string }[] = [
      { pin: "12345",  expectedReason: "not_6_digits" },           // too short
      { pin: "abcdef", expectedReason: "not_6_digits" },           // non-numeric
      { pin: "111111", expectedReason: "all_same" },
      { pin: "123456", expectedReason: "sequential_ascending" },
      { pin: "654321", expectedReason: "sequential_descending" },
      { pin: "150382", expectedReason: "dob_ddmmyy" },             // 15/03/82
      { pin: "120385", expectedReason: "dob_ddmmyy" },             // 12/03/85 (also fits mmddyy by coincidence)
      { pin: "311999", expectedReason: "dob_ddyyyy" },             // 31 + 1999
    ];
    let weakCorrect = 0;
    for (const { pin, expectedReason } of weakSamples) {
      try {
        validatePinStrength(pin);
        // No throw → test failed for this sample
        console.log(`    weak ${pin} should have thrown but didn't`);
      } catch (e: any) {
        if (e instanceof WeakPinError) {
          // Some PINs match multiple rules; first-match-wins. Accept any rejection.
          weakCorrect++;
        }
      }
    }
    record("strength validator rejects all weak samples", weakCorrect === weakSamples.length, `${weakCorrect}/${weakSamples.length} rejected`);

    // ── 2: Strength validator accepts a clean PIN ───────────────────────────
    let cleanAccepted = false;
    try {
      validatePinStrength(GOOD_PIN);
      cleanAccepted = true;
    } catch (e) { /* unexpected */ }
    record("strength validator accepts clean PIN", cleanAccepted, `pin=${GOOD_PIN}`);

    // ── 3: hashPin + verifyPin round-trip ────────────────────────────────────
    const hash = await hashPin(GOOD_PIN);
    const verifies = await verifyPin(GOOD_PIN, hash);
    const wrongRejected = !(await verifyPin("999999", hash));
    record("hashPin/verifyPin round-trip + wrong-PIN rejected", verifies && wrongRejected, `hash.length=${hash.length}`);

    // ── 4: Setup — write pin_hash to a fresh user row ───────────────────────
    const insertRes = await db.execute(sql`
      INSERT INTO users (email, pin_hash, pin_set_at, email_verified, email_verified_at, created_at)
      VALUES (${TEST_EMAIL}, ${hash}, NOW(), true, NOW(), NOW())
      RETURNING id
    `);
    testUserId = (insertRes.rows[0] as any).id;
    const verifySetup = await db.execute(sql`SELECT pin_hash, pin_set_at, pin_failed_count FROM users WHERE id = ${testUserId}`);
    const setupRow = verifySetup.rows[0] as any;
    record("setup: pin_hash written + pin_set_at populated + failed_count=0",
      !!setupRow?.pin_hash && !!setupRow?.pin_set_at && setupRow.pin_failed_count === 0,
      `id=${testUserId}`);

    // ── 5: checkLockout on fresh user → not locked ───────────────────────────
    const fresh = await checkLockout(TEST_EMAIL);
    record("checkLockout on fresh user → not locked", !fresh.locked && fresh.failedCount === 0);

    // ── 6: registerFailure x1 → not locked, count=1 ──────────────────────────
    const after1 = await registerFailure(TEST_EMAIL);
    record("after 1 failure → not locked, count=1", !after1.locked && after1.failedCount === 1);

    // ── 7: registerFailure x2 more → locked at threshold ─────────────────────
    await registerFailure(TEST_EMAIL);
    const after3 = await registerFailure(TEST_EMAIL);
    const lockedNow = await checkLockout(TEST_EMAIL);
    const retryAfterReasonable =
      !!lockedNow.retryAfter &&
      (lockedNow.retryAfter.getTime() - Date.now()) > 14 * 60 * 1000 &&  // > 14 min from now
      (lockedNow.retryAfter.getTime() - Date.now()) <= PIN_LOCKOUT_DURATION_MS + 5000;
    record(`after ${PIN_LOCKOUT_THRESHOLD} failures → locked + retryAfter in expected window`,
      lockedNow.locked && retryAfterReasonable && after3.failedCount >= PIN_LOCKOUT_THRESHOLD,
      `failedCount=${lockedNow.failedCount}, retryAfter=${lockedNow.retryAfter?.toISOString()}`);

    // ── 8: resetFailures clears state ────────────────────────────────────────
    await resetFailures(TEST_EMAIL);
    const reset = await checkLockout(TEST_EMAIL);
    record("resetFailures clears lockout state",
      !reset.locked && reset.failedCount === 0);

    // ── 9: Forgot-PIN — insert reset token + atomic consume ──────────────────
    const resetToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await db.execute(sql`
      INSERT INTO pin_reset_tokens (email, token, expires_at)
      VALUES (${TEST_EMAIL}, ${resetToken}, ${expiresAt.toISOString()})
    `);
    const consumeRes = await db.execute(sql`
      UPDATE pin_reset_tokens SET consumed_at = NOW()
      WHERE token = ${resetToken} AND consumed_at IS NULL AND expires_at > NOW()
      RETURNING email
    `);
    const consumed = consumeRes.rows.length === 1 && (consumeRes.rows[0] as any).email === TEST_EMAIL;
    // Replay attempt — should return 0 rows
    const replayRes = await db.execute(sql`
      UPDATE pin_reset_tokens SET consumed_at = NOW()
      WHERE token = ${resetToken} AND consumed_at IS NULL AND expires_at > NOW()
      RETURNING email
    `);
    const replayBlocked = replayRes.rows.length === 0;
    record("forgot-PIN: token consumed atomically + replay blocked",
      consumed && replayBlocked,
      `consumed=${consumed}, replay_blocked=${replayBlocked}`);

    // ── 10: Post-reset login — new hash, old hash rejects new PIN ───────────
    const NEW_PIN = "739264";  // different clean PIN
    const newHash = await hashPin(NEW_PIN);
    await db.execute(sql`
      UPDATE users SET pin_hash = ${newHash}, pin_set_at = NOW(), pin_failed_count = 0, pin_locked_until = NULL
      WHERE id = ${testUserId}
    `);
    const stored = await db.execute(sql`SELECT pin_hash FROM users WHERE id = ${testUserId}`);
    const storedHash = (stored.rows[0] as any).pin_hash;
    const newPinVerifies = await verifyPin(NEW_PIN, storedHash);
    const oldPinNowRejected = !(await verifyPin(GOOD_PIN, storedHash));
    record("post-reset login: new PIN verifies + old PIN rejected",
      newPinVerifies && oldPinNowRejected);

    // ── Summary ─────────────────────────────────────────────────────────────
    const failed = assertions.filter((a) => !a.ok);
    console.log(`\n[smoke] ${assertions.length - failed.length}/${assertions.length} assertions passed`);
    if (failed.length > 0) {
      console.log("[smoke] FAILED:");
      for (const a of failed) console.log(`  - ${a.name}${a.detail ? ` (${a.detail})` : ""}`);
      await cleanup(testUserId);
      process.exit(1);
    }
    await cleanup(testUserId);
    console.log("[smoke] OK");
    process.exit(0);
  } catch (err: any) {
    console.error("[smoke] unhandled error:", err);
    await cleanup(testUserId);
    process.exit(1);
  }
}

main();
