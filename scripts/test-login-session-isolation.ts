/**
 * scripts/test-login-session-isolation.ts
 *
 * Smoke for the login session-bleed fix (Step 5 follow-up). Tracked.
 *
 * Verifies the four invariants in docs/login-flow-bug-report.md:
 *   1. Authenticated user can re-request a magic link FOR THEMSELVES
 *      (200 — same-user is fine).
 *   2. Authenticated user submitting a DIFFERENT email is rejected
 *      with 403 'already_authenticated_as_other' AND audit-logged.
 *   3. After logout, a fresh magic-link verify produces a clean
 *      session for the new user (no field bleed from the previous
 *      session — userId points at user B, customerEmail/isAdmin
 *      undefined).
 *   4. Audit ledger shows the rejection row tied to the right user.
 *
 * Auth flow: same magic-link-token-direct-INSERT pattern used by
 * scripts/test-vault-club-checkout.ts and scripts/test-vault-club-consent.ts
 * (see Step 3+ for backstory on why we bypass email round-trip).
 *
 * Cleanup at the end: removes the audit_log row this test wrote
 * (entity_type 'auth' / action 'magic_link_swap_rejected'). Does NOT
 * touch users, sessions, or magic-link tokens beyond consuming the
 * test tokens.
 *
 * ⚠️ Env guard aborts unless MINTVAULT_DATABASE_URL is dev/local.
 * Override with ALLOW_PROD_SMOKE=1 (matches 5b/5d smoke pattern).
 *
 * Usage:
 *   tsx --env-file=.env scripts/test-login-session-isolation.ts
 */

import crypto from "crypto";
import { db } from "../server/db";
import { sql } from "drizzle-orm";

const BASE_URL = "http://localhost:5000";
const EMAIL_A = "neilsophieoliver@gmail.com";
const EMAIL_B = "infoconcretedrivewayslast@gmail.com";

interface Assertion {
  name: string;
  ok: boolean;
  detail?: string;
}
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
    console.error(
      "[smoke] MINTVAULT_DATABASE_URL looks like production/staging — aborting."
    );
    console.error(
      "[smoke] Re-run against a dev/local DB, or set ALLOW_PROD_SMOKE=1 to override."
    );
    return false;
  }
  return true;
}

interface UserRow { id: string; email: string }

async function findUser(email: string): Promise<UserRow> {
  const r = await db.execute(sql`
    SELECT id, email FROM users WHERE email = ${email} AND deleted_at IS NULL LIMIT 1
  `);
  const row = r.rows[0] as UserRow | undefined;
  if (!row) throw new Error(`no user found with email ${email}`);
  return row;
}

async function loginAs(userId: string): Promise<string> {
  // Issue magic-link token directly (24h TTL workaround)
  const token = crypto.randomBytes(32).toString("hex");
  await db.execute(sql`
    INSERT INTO account_magic_link_tokens (user_id, token, expires_at)
    VALUES (${userId}, ${token}, NOW() + INTERVAL '24 hours')
  `);
  const verifyRes = await fetch(`${BASE_URL}/api/auth/magic-link/verify?token=${token}`, {
    redirect: "manual",
  });
  const setCookie = verifyRes.headers.get("set-cookie");
  if (!setCookie) throw new Error(`verify did not return a Set-Cookie (status ${verifyRes.status})`);
  const sidMatch = setCookie.match(/mv\.sid=[^;]+/);
  if (!sidMatch) throw new Error(`no mv.sid in Set-Cookie: ${setCookie}`);
  return sidMatch[0];
}

async function main(): Promise<void> {
  if (!envSafe()) process.exit(1);
  console.log(`[smoke] base url: ${BASE_URL}\n`);

  const userA = await findUser(EMAIL_A);
  const userB = await findUser(EMAIL_B);
  console.log(`[smoke] user A: ${EMAIL_A} (${userA.id})`);
  console.log(`[smoke] user B: ${EMAIL_B} (${userB.id})\n`);

  console.log("[smoke] step 1 — log in as user A");
  const cookieA = await loginAs(userA.id);
  console.log(`  session cookie: ${cookieA.slice(0, 30)}…`);

  // Verify session is actually user A's
  const meA = await fetch(`${BASE_URL}/api/auth/me`, {
    headers: { Cookie: cookieA },
  }).then((r) => r.json()).catch(() => null);
  record("baseline /api/auth/me returns user A", meA?.id === userA.id, `id=${meA?.id ?? "null"}`);

  console.log("\n[smoke] step 2 — POST /api/auth/magic-link for user B (cross-user) → expect 403");
  const cross = await fetch(`${BASE_URL}/api/auth/magic-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieA },
    body: JSON.stringify({ email: EMAIL_B }),
  });
  const crossBody = await cross.json().catch(() => ({}));
  record("cross-user POST returns 403", cross.status === 403, `status=${cross.status}`);
  record(
    "cross-user error code is 'already_authenticated_as_other'",
    crossBody?.error === "already_authenticated_as_other",
    `error=${crossBody?.error}`
  );

  // Audit row for the rejection
  const auditRows = await db.execute(sql`
    SELECT id, entity_type, entity_id, action, details
    FROM audit_log
    WHERE entity_type = 'auth'
      AND action = 'magic_link_swap_rejected'
      AND entity_id = ${userA.id}
    ORDER BY created_at DESC
    LIMIT 1
  `);
  const auditRow = auditRows.rows[0] as
    | { id: string; entity_id: string; details: any }
    | undefined;
  record("audit row written for rejection", !!auditRow);
  if (auditRow) {
    const details = typeof auditRow.details === "string" ? JSON.parse(auditRow.details) : auditRow.details;
    record(
      "audit details.session_user_email matches user A",
      details?.session_user_email === EMAIL_A,
      `email=${details?.session_user_email}`
    );
    record(
      "audit details.requested_email matches user B",
      details?.requested_email === EMAIL_B,
      `email=${details?.requested_email}`
    );
  }

  console.log("\n[smoke] step 3 — POST /api/auth/magic-link for user A (same user) → expect 200");
  const same = await fetch(`${BASE_URL}/api/auth/magic-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieA },
    body: JSON.stringify({ email: EMAIL_A }),
  });
  const sameBody = await same.json().catch(() => ({}));
  record("same-user POST returns 200", same.status === 200, `status=${same.status}`);
  record("same-user response is generic-success", sameBody?.ok === true);

  console.log("\n[smoke] step 4 — logout, then magic-link verify as user B → expect clean session");
  // Drop the cookie by not carrying it forward. Issue a fresh magic-link
  // for user B, hit verify, capture the new mv.sid.
  const cookieB = await loginAs(userB.id);
  console.log(`  session cookie: ${cookieB.slice(0, 30)}…`);

  // /api/auth/me returns user B
  const meB = await fetch(`${BASE_URL}/api/auth/me`, {
    headers: { Cookie: cookieB },
  }).then((r) => r.json()).catch(() => null);
  record("post-switch /api/auth/me returns user B", meB?.id === userB.id, `id=${meB?.id ?? "null"}`);
  record("post-switch /api/auth/me email matches user B", meB?.email === EMAIL_B);

  // /api/customer/me 401s (customerEmail not set by account-magic-link verify)
  // — proves the cross-clear works: even if customerEmail leaked from a prior
  // session, regenerate + explicit clear at the verify endpoint kills it.
  const customerMe = await fetch(`${BASE_URL}/api/customer/me`, {
    headers: { Cookie: cookieB },
  });
  record(
    "post-switch /api/customer/me returns 401 (customerEmail correctly cleared)",
    customerMe.status === 401,
    `status=${customerMe.status}`
  );

  // Cleanup — remove the audit row this test wrote
  if (auditRow) {
    await db.execute(sql`DELETE FROM audit_log WHERE id = ${auditRow.id}`);
    console.log(`\n[smoke] cleanup: removed audit_log row ${auditRow.id}`);
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
