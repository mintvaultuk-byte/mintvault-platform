/**
 * scripts/test-vault-club-consent.ts
 *
 * Smoke test for the Phase 1 Step 5d consent capture flow. Tracked.
 *
 * What it does (3 assertions):
 *   1. POST /api/vault-club/checkout with consent_accepted: false
 *      → expect 400 with error 'consent_required'.
 *   2. POST with consent_accepted: true + a stale (wrong) hash
 *      → expect 400 with error 'consent_text_stale'.
 *   3. POST with the canonical hash from /api/vault-club/consent-text
 *      → expect 200 with a Stripe Checkout URL, AND
 *        - vault_club_consents has a fresh row for the user with the
 *          right TERMS_VERSION and consent_text_hash, AND
 *        - that row has stripe_customer_id + stripe_session_id populated
 *          (post-creation attach).
 *
 * Cleanup at the end:
 *   - DELETEs the vault_club_consents row created by step 3
 *   - DELETEs any audit_log rows the test wrote
 *   - The Stripe Checkout Session is left to expire naturally (Stripe
 *     auto-expires unconverted sessions; we don't have a delete API for
 *     them). Stripe Customer record is reused via users.stripe_customer_id
 *     so it's not orphaned.
 *
 * ⚠️ DO NOT run against production. The script auto-aborts if the DB
 * URL looks like the production Neon branch (substring match). Override
 * with ALLOW_PROD_SMOKE=1 only if you really know what you're doing —
 * step 3 creates a real Stripe Checkout Session in whatever Stripe mode
 * the server is configured for.
 *
 * Auth: same magic-link-token pattern as scripts/test-vault-club-checkout.ts.
 *
 * Usage:
 *   tsx --env-file=.env scripts/test-vault-club-consent.ts [user_email]
 */

import crypto from "crypto";
import Stripe from "stripe";
import { db } from "../server/db";
import { sql } from "drizzle-orm";

const BASE_URL = "http://localhost:5000";
const TARGET_EMAIL = process.argv[2] || "oliveflopizzeria@gmail.com";

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

// ── Env guard — abort if we look like we're pointed at prod ─────────────
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

async function loginAsUser(): Promise<{ userId: string; cookie: string }> {
  // Find user
  const userRows = await db.execute(sql`
    SELECT id FROM users WHERE email = ${TARGET_EMAIL} AND deleted_at IS NULL LIMIT 1
  `);
  const user = userRows.rows[0] as { id: string } | undefined;
  if (!user) throw new Error(`no user found with email ${TARGET_EMAIL}`);

  // Issue magic-link token (24h TTL — same workaround as the checkout smoke
  // script; see Step 3/5b for backstory on why this is here).
  const token = crypto.randomBytes(32).toString("hex");
  await db.execute(sql`
    INSERT INTO account_magic_link_tokens (user_id, token, expires_at)
    VALUES (${user.id}, ${token}, NOW() + INTERVAL '24 hours')
  `);

  const verifyRes = await fetch(`${BASE_URL}/api/auth/magic-link/verify?token=${token}`, {
    redirect: "manual",
  });
  const setCookie = verifyRes.headers.get("set-cookie");
  if (!setCookie) throw new Error(`verify did not return a Set-Cookie (status ${verifyRes.status})`);
  const sidMatch = setCookie.match(/mv\.sid=[^;]+/);
  if (!sidMatch) throw new Error(`no mv.sid in Set-Cookie: ${setCookie}`);
  return { userId: user.id, cookie: sidMatch[0] };
}

async function fetchCanonicalHash(): Promise<{ termsVersion: string; consentTextHash: string }> {
  const res = await fetch(`${BASE_URL}/api/vault-club/consent-text`);
  if (!res.ok) throw new Error(`consent-text fetch failed: ${res.status}`);
  const data = await res.json();
  return {
    termsVersion: String(data.termsVersion),
    consentTextHash: String(data.consentTextHash),
  };
}

async function main(): Promise<void> {
  if (!envSafe()) process.exit(1);

  console.log(`[smoke] target user:   ${TARGET_EMAIL}`);
  console.log(`[smoke] base url:      ${BASE_URL}\n`);

  // Pre-flight: clear any existing live subscriptions for this user — the
  // duplicate-sub guards (Layer 1 DB + Layer 2 Stripe) would short-circuit
  // step 3 before consent recording. We need both sides clean:
  //   - DB rows in vault_club_subscriptions (Layer 1)
  //   - Live Stripe subs on the Customer (Layer 2)
  // Stripe-side runs in test mode (NODE_ENV=development picks
  // STRIPE_SECRET_KEY_TEST). Cancellations fire customer.subscription.deleted
  // webhooks which the Step 3 dual-write picks up; both sides end up
  // canceled cleanly.
  const userRows = await db.execute(sql`
    SELECT id, stripe_customer_id FROM users WHERE email = ${TARGET_EMAIL} LIMIT 1
  `);
  const userRow = userRows.rows[0] as { id: string; stripe_customer_id: string | null } | undefined;
  if (!userRow) throw new Error(`no user found with email ${TARGET_EMAIL}`);

  await db.execute(sql`
    DELETE FROM vault_club_subscriptions
    WHERE user_id = ${userRow.id}
      AND status IN ('trialing', 'active', 'past_due', 'incomplete')
  `);

  if (userRow.stripe_customer_id) {
    const stripeKey = process.env.STRIPE_SECRET_KEY_TEST;
    if (!stripeKey) {
      throw new Error("STRIPE_SECRET_KEY_TEST not set — can't pre-flight Stripe cleanup");
    }
    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" as any });
    const subs = await stripe.subscriptions.list({
      customer: userRow.stripe_customer_id,
      status: "all",
      limit: 20,
    });
    const live = subs.data.filter((s) =>
      ["trialing", "active", "past_due", "incomplete"].includes(s.status)
    );
    for (const s of live) {
      await stripe.subscriptions.cancel(s.id);
      console.log(`[smoke] pre-flight cancel: ${s.id} (was ${s.status})`);
    }
    if (live.length > 0) {
      // Tiny pause so cancellation webhooks land before we proceed; Layer 2
      // re-queries Stripe directly so this isn't strictly needed, but keeps
      // the DB and Stripe in sync for any subsequent assertion.
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  const { userId, cookie } = await loginAsUser();
  console.log(`[smoke] user.id: ${userId}`);
  console.log(`[smoke] session cookie: ${cookie.slice(0, 30)}...\n`);

  const { termsVersion, consentTextHash } = await fetchCanonicalHash();
  console.log(`[smoke] terms_version:    ${termsVersion}`);
  console.log(`[smoke] canonical hash:   ${consentTextHash.slice(0, 16)}…\n`);

  // ── Step 1 — consent_required ────────────────────────────────────────
  console.log("[smoke] step 1 — POST without consent_accepted");
  const r1 = await fetch(`${BASE_URL}/api/vault-club/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ interval: "month", consent_accepted: false }),
  });
  const body1 = await r1.json().catch(() => ({}));
  record("step 1 status is 400", r1.status === 400, `status=${r1.status}`);
  record("step 1 error is 'consent_required'", body1?.error === "consent_required", `error=${body1?.error}`);

  // ── Step 2 — consent_text_stale ──────────────────────────────────────
  console.log("\n[smoke] step 2 — POST with stale hash");
  const r2 = await fetch(`${BASE_URL}/api/vault-club/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      interval: "month",
      consent_accepted: true,
      consent_text_hash: "0".repeat(64),
    }),
  });
  const body2 = await r2.json().catch(() => ({}));
  record("step 2 status is 400", r2.status === 400, `status=${r2.status}`);
  record("step 2 error is 'consent_text_stale'", body2?.error === "consent_text_stale", `error=${body2?.error}`);

  // ── Step 3 — happy path ──────────────────────────────────────────────
  console.log("\n[smoke] step 3 — POST with valid hash");
  const r3 = await fetch(`${BASE_URL}/api/vault-club/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      interval: "month",
      consent_accepted: true,
      consent_text_hash: consentTextHash,
    }),
  });
  const body3 = await r3.json().catch(() => ({}));
  record("step 3 status is 200", r3.status === 200, `status=${r3.status}`);
  record(
    "step 3 returns a checkout.stripe.com URL",
    typeof body3?.url === "string" && body3.url.startsWith("https://checkout.stripe.com/"),
    `url=${body3?.url ? body3.url.slice(0, 50) + "…" : "missing"}`
  );

  // Verify a consent row was written
  const consentRows = await db.execute(sql`
    SELECT id, terms_version, consent_text_hash, interval,
           stripe_customer_id, stripe_session_id, ip_address, user_agent
    FROM vault_club_consents
    WHERE user_id = ${userId}
    ORDER BY captured_at DESC
    LIMIT 1
  `);
  const consentRow = consentRows.rows[0] as
    | {
        id: string;
        terms_version: string;
        consent_text_hash: string;
        interval: string;
        stripe_customer_id: string | null;
        stripe_session_id: string | null;
        ip_address: string | null;
        user_agent: string | null;
      }
    | undefined;
  record("consent row created", !!consentRow);
  if (consentRow) {
    record("consent.terms_version matches", consentRow.terms_version === termsVersion);
    record("consent.consent_text_hash matches", consentRow.consent_text_hash === consentTextHash);
    record("consent.interval = 'month'", consentRow.interval === "month");
    record("consent.stripe_customer_id populated", !!consentRow.stripe_customer_id);
    record("consent.stripe_session_id populated", !!consentRow.stripe_session_id);
  }

  // Verify audit rows
  let consentRecordedAuditCount = 0;
  let consentLinkedAuditCount = 0;
  if (consentRow) {
    const auditRows = await db.execute(sql`
      SELECT action FROM audit_log
      WHERE entity_type = 'vault_club_consent' AND entity_id = ${consentRow.id}
    `);
    for (const r of auditRows.rows as Array<{ action: string }>) {
      if (r.action === "consent_recorded") consentRecordedAuditCount++;
      if (r.action === "consent_linked") consentLinkedAuditCount++;
    }
  }
  record(
    "exactly 1 consent_recorded audit row",
    consentRecordedAuditCount === 1,
    `count=${consentRecordedAuditCount}`
  );
  record(
    "exactly 1 consent_linked audit row",
    consentLinkedAuditCount === 1,
    `count=${consentLinkedAuditCount}`
  );

  // Cleanup — synthetic test rows only
  if (consentRow) {
    await db.execute(sql`
      DELETE FROM audit_log WHERE entity_type = 'vault_club_consent' AND entity_id = ${consentRow.id}
    `);
    await db.execute(sql`
      DELETE FROM vault_club_consents WHERE id = ${consentRow.id}
    `);
    console.log(`\n[smoke] cleanup: removed consent ${consentRow.id} + audit rows`);
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
