/**
 * scripts/test-login-unification.ts
 *
 * Smoke for the login-unification work: every magic-link verify (no
 * matter which entry point) produces a session with BOTH userId AND
 * customerEmail set, and finds-or-creates the users row when needed.
 *
 * 9 assertions cover both code paths against a freshly-created test
 * email so we know the path runs end-to-end without colliding with
 * existing rows.
 *
 * Auth flow: bypasses email round-trip via direct token-table INSERT
 * (same pattern as scripts/test-vault-club-checkout.ts).
 *
 * Cleanup at the end: deletes the test users row + audit_log entries
 * the test wrote. Magic-link tokens consumed by verify are left
 * (they're row-state changes, not orphan rows).
 *
 * ⚠️ Env guard aborts unless MINTVAULT_DATABASE_URL is dev/local. Use
 * ALLOW_PROD_SMOKE=1 to override (matches 5b/5d pattern).
 *
 * Usage:
 *   tsx --env-file=.env scripts/test-login-unification.ts
 */

import crypto from "crypto";
import { db } from "../server/db";
import { sql } from "drizzle-orm";

const BASE_URL = "http://localhost:5000";
// Throwaway email per run — guaranteed never to collide with an existing
// users row. Stamped with a random suffix so re-runs don't trip on
// previous test runs that didn't clean up.
const TEST_EMAIL = `smoke-unification-${crypto.randomBytes(6).toString("hex")}@example.test`;

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

interface UsersRowSlim { id: string; email: string }

async function findUser(email: string): Promise<UsersRowSlim | null> {
  const r = await db.execute(sql`
    SELECT id, email FROM users WHERE LOWER(email) = LOWER(${email}) AND deleted_at IS NULL LIMIT 1
  `);
  return (r.rows[0] as UsersRowSlim | undefined) ?? null;
}

// ── Cert-owner verify (sets userId + customerEmail; should find-or-create) ─
async function customerVerify(email: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  await db.execute(sql`
    INSERT INTO customer_magic_link_tokens (email, token, expires_at)
    VALUES (${email.toLowerCase()}, ${token}, NOW() + INTERVAL '24 hours')
  `);
  const verifyRes = await fetch(`${BASE_URL}/api/customer/verify/${token}`, { redirect: "manual" });
  const setCookie = verifyRes.headers.get("set-cookie");
  if (!setCookie) throw new Error(`customer-verify did not return Set-Cookie (status ${verifyRes.status} → ${verifyRes.headers.get("location")})`);
  const sidMatch = setCookie.match(/mv\.sid=[^;]+/);
  if (!sidMatch) throw new Error(`no mv.sid in Set-Cookie`);
  return sidMatch[0];
}

// ── Account-holder verify (sets userId + userEmail + customerEmail) ────────
async function accountVerify(userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  await db.execute(sql`
    INSERT INTO account_magic_link_tokens (user_id, token, expires_at)
    VALUES (${userId}, ${token}, NOW() + INTERVAL '24 hours')
  `);
  const verifyRes = await fetch(`${BASE_URL}/api/auth/magic-link/verify?token=${token}`, { redirect: "manual" });
  const setCookie = verifyRes.headers.get("set-cookie");
  if (!setCookie) throw new Error(`account-verify did not return Set-Cookie (status ${verifyRes.status})`);
  const sidMatch = setCookie.match(/mv\.sid=[^;]+/);
  if (!sidMatch) throw new Error(`no mv.sid in Set-Cookie`);
  return sidMatch[0];
}

async function main(): Promise<void> {
  if (!envSafe()) process.exit(1);
  console.log(`[smoke] test email: ${TEST_EMAIL}\n`);

  // Pre-condition: user row should NOT exist yet.
  const before = await findUser(TEST_EMAIL);
  if (before) throw new Error(`unexpected: test email ${TEST_EMAIL} already has a users row`);

  // ── Path 1: cert-owner verify creates the user row ──────────────────────
  console.log("[smoke] step 1 — cert-owner verify on a brand-new email");
  const cookie1 = await customerVerify(TEST_EMAIL);

  const user = await findUser(TEST_EMAIL);
  record("users row created by cert-owner verify", !!user, `id=${user?.id ?? "null"}`);

  const me1 = await fetch(`${BASE_URL}/api/auth/me`, { headers: { Cookie: cookie1 } });
  const meBody1 = await me1.json().catch(() => null);
  record("/api/auth/me returns the new user (proves userId set)", meBody1?.email?.toLowerCase() === TEST_EMAIL.toLowerCase(), `email=${meBody1?.email}`);

  const cust1 = await fetch(`${BASE_URL}/api/customer/me`, { headers: { Cookie: cookie1 } });
  const custBody1 = await cust1.json().catch(() => null);
  record("/api/customer/me returns the new user (proves customerEmail set)", custBody1?.email?.toLowerCase() === TEST_EMAIL.toLowerCase(), `email=${custBody1?.email}`);

  // ── Step 2: logout — drop the cookie, no further action needed ──────────
  console.log("\n[smoke] step 2 — logout (drop cookie)");

  // ── Path 2: account-holder verify on the SAME email ─────────────────────
  console.log("\n[smoke] step 3 — account-holder verify (existing user from step 1)");
  if (!user) throw new Error("can't continue without users row from step 1");
  const cookie2 = await accountVerify(user.id);

  const me2 = await fetch(`${BASE_URL}/api/auth/me`, { headers: { Cookie: cookie2 } });
  const meBody2 = await me2.json().catch(() => null);
  record("post-account-verify /api/auth/me returns user", meBody2?.id === user.id, `id=${meBody2?.id}`);

  const cust2 = await fetch(`${BASE_URL}/api/customer/me`, { headers: { Cookie: cookie2 } });
  const custBody2 = await cust2.json().catch(() => null);
  record(
    "post-account-verify /api/customer/me succeeds (proves account flow ALSO sets customerEmail)",
    custBody2?.email?.toLowerCase() === TEST_EMAIL.toLowerCase(),
    `email=${custBody2?.email}`
  );

  // Exactly ONE users row for this email (no duplicate-create on the
  // account-holder path)
  const dupCheck = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM users WHERE LOWER(email) = LOWER(${TEST_EMAIL}) AND deleted_at IS NULL
  `);
  record("exactly one users row for the email", (dupCheck.rows[0] as any).n === 1, `count=${(dupCheck.rows[0] as any).n}`);

  // Audit row from the cert-owner verify (proves the audit trail is
  // wired)
  const auditRows = await db.execute(sql`
    SELECT id, action FROM audit_log
    WHERE entity_type = 'users' AND entity_id = ${user.id} AND action = 'cert_owner_verify_create'
  `);
  record("cert_owner_verify_create audit row exists", auditRows.rows.length === 1, `count=${auditRows.rows.length}`);

  // ── Cleanup ─────────────────────────────────────────────────────────────
  await db.execute(sql`
    DELETE FROM audit_log WHERE entity_type = 'users' AND entity_id = ${user.id}
  `);
  await db.execute(sql`
    DELETE FROM customer_magic_link_tokens WHERE LOWER(email) = LOWER(${TEST_EMAIL})
  `);
  await db.execute(sql`DELETE FROM account_magic_link_tokens WHERE user_id = ${user.id}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${user.id}`);
  console.log(`\n[smoke] cleanup: removed test user ${user.id} + audit + tokens`);

  // Bonus assertion: post-cleanup the row is gone
  const after = await findUser(TEST_EMAIL);
  record("post-cleanup users row removed", after === null);

  // Summary
  const failed = assertions.filter((a) => !a.ok);
  console.log(`\n[smoke] ${assertions.length - failed.length}/${assertions.length} assertions passed`);
  if (failed.length > 0) {
    console.log("[smoke] FAILED:");
    for (const a of failed) console.log(`  - ${a.name}${a.detail ? ` (${a.detail})` : ""}`);
    process.exit(1);
  }
  console.log("[smoke] OK");
  process.exit(0);
}

main().catch((err) => { console.error("[smoke] unhandled error:", err); process.exit(1); });
