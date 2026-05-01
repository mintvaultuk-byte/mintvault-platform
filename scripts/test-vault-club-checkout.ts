/**
 * scripts/test-vault-club-checkout.ts
 *
 * Server-side smoke test for POST /api/vault-club/checkout.
 *
 * Bypasses the browser magic-link flow (which on localhost still requires an
 * email round-trip) by:
 *   1. Looking up an existing user in the dev DB by email
 *   2. Issuing an `account_magic_link_tokens` row directly via SQL
 *   3. Hitting GET /api/auth/magic-link/verify?token=... with redirect:manual
 *      to capture the Set-Cookie (mv.sid) that express-session signs
 *   4. POSTing /api/vault-club/checkout with that cookie
 *   5. Printing the Stripe Checkout URL — paste into a browser to finish
 *
 * Usage:
 *   tsx --env-file=.env scripts/test-vault-club-checkout.ts [email] [interval]
 *
 *   email     defaults to oliveflopizzeria@gmail.com (Cornelius's account)
 *   interval  "month" (default) or "year"
 *
 * Requires the dev server running on localhost:5000 in NODE_ENV=development
 * (the Stripe key switch picks STRIPE_SECRET_KEY_TEST).
 *
 * Safe to re-run — issues a fresh token each invocation. Old tokens are
 * marked consumed by the verify handler.
 */

import crypto from "crypto";
import { db } from "../server/db";
import { sql } from "drizzle-orm";

const BASE_URL = "http://localhost:5000";
const TARGET_EMAIL = process.argv[2] || "oliveflopizzeria@gmail.com";
const INTERVAL = (process.argv[3] || "month") as "month" | "year";

if (INTERVAL !== "month" && INTERVAL !== "year") {
  console.error(`[test] invalid interval: ${INTERVAL} (expected "month" or "year")`);
  process.exit(1);
}

async function main(): Promise<void> {
  console.log(`[test] target user:   ${TARGET_EMAIL}`);
  console.log(`[test] interval:      ${INTERVAL}`);
  console.log(`[test] base url:      ${BASE_URL}`);

  // 1. Look up user
  const userRows = await db.execute(sql`
    SELECT id, email FROM users WHERE email = ${TARGET_EMAIL} AND deleted_at IS NULL LIMIT 1
  `);
  const user = userRows.rows[0] as { id: string; email: string } | undefined;
  if (!user) {
    console.error(`[test] no user found with email "${TARGET_EMAIL}"`);
    console.error(`[test] tip: pass an email that exists in the dev DB as the first arg`);
    process.exit(1);
  }
  console.log(`[test] user.id:       ${user.id}`);

  // 2. Issue a magic-link token directly (bypass email send). 24-hour TTL
  //    is generous for re-running the script over a long debug session.
  const token = crypto.randomBytes(32).toString("hex");
  await db.execute(sql`
    INSERT INTO account_magic_link_tokens (user_id, token, expires_at)
    VALUES (${user.id}, ${token}, NOW() + INTERVAL '24 hours')
  `);
  console.log(`[test] issued token:  ${token.slice(0, 12)}...`);

  // 3. Verify magic link → capture Set-Cookie (mv.sid)
  const verifyRes = await fetch(`${BASE_URL}/api/auth/magic-link/verify?token=${token}`, {
    redirect: "manual",
  });
  const setCookie = verifyRes.headers.get("set-cookie");
  if (!setCookie) {
    console.error(`[test] no Set-Cookie on verify (status=${verifyRes.status}, location=${verifyRes.headers.get("location")})`);
    process.exit(1);
  }
  const sidMatch = setCookie.match(/mv\.sid=[^;]+/);
  if (!sidMatch) {
    console.error(`[test] no mv.sid in Set-Cookie: ${setCookie}`);
    process.exit(1);
  }
  const cookie = sidMatch[0];
  console.log(`[test] session cookie: ${cookie.slice(0, 30)}...`);
  console.log(`[test] verify status:  ${verifyRes.status} → ${verifyRes.headers.get("location")}`);

  // 4. POST checkout
  const checkoutRes = await fetch(`${BASE_URL}/api/vault-club/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ interval: INTERVAL }),
  });
  const text = await checkoutRes.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = text; }

  console.log(`\n[test] checkout status: ${checkoutRes.status}`);
  console.log(`[test] checkout body:`, body);

  if (checkoutRes.ok && body && typeof body.url === "string") {
    console.log("\n========================================================");
    console.log("STRIPE CHECKOUT URL (paste into browser):");
    console.log(body.url);
    console.log("========================================================");
    console.log("Use Stripe test card: 4242 4242 4242 4242");
    console.log("Any future expiry, any 3-digit CVC, any postcode.\n");
    process.exit(0);
  }

  console.error("[test] FAIL — checkout did not return a URL");
  process.exit(1);
}

main().catch((err) => {
  console.error("[test] unhandled error:", err);
  process.exit(1);
});
