/**
 * server/stripeClient.ts
 *
 * Single source of truth for Stripe SDK secret + publishable keys + webhook
 * signing secrets. Switches on NODE_ENV:
 *   - production → STRIPE_SECRET_KEY        (sk_live_*)  + STRIPE_PUBLISHABLE_KEY        (pk_live_*)  + STRIPE_WEBHOOK_SECRET[_2]
 *   - anything else → STRIPE_SECRET_KEY_TEST (sk_test_*) + STRIPE_PUBLISHABLE_KEY_TEST (pk_test_*) + STRIPE_WEBHOOK_SECRET_TEST
 *
 * Goal: zero direct reads of STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET anywhere
 * else in server/. Every Stripe SDK init / signature verify MUST go through
 * the helpers below.
 */

import Stripe from "stripe";

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function readSecretKey(): string {
  const prod = isProduction();
  const key = prod ? process.env.STRIPE_SECRET_KEY : process.env.STRIPE_SECRET_KEY_TEST;
  if (!key) {
    const expected = prod ? "STRIPE_SECRET_KEY" : "STRIPE_SECRET_KEY_TEST";
    throw new Error(
      `${expected} is not set (NODE_ENV=${process.env.NODE_ENV || "development"})`
    );
  }
  return key;
}

/**
 * Publishable key reader.
 *
 * Production is strict: STRIPE_PUBLISHABLE_KEY only, no fallback.
 *
 * Dev (NODE_ENV !== "production") tries STRIPE_PUBLISHABLE_KEY_TEST first,
 * then falls back to STRIPE_PUBLISHABLE_KEY with a one-time warning. This
 * fallback is safe because publishable keys are designed to be exposed —
 * the worst case is Stripe.js initialises against the live account, which
 * fails harmlessly when the server-side flow uses the test secret key
 * (account IDs don't match).
 *
 * NOTE: same fallback is INTENTIONALLY NOT applied to the secret key.
 * Falling back from STRIPE_SECRET_KEY_TEST → STRIPE_SECRET_KEY in dev is
 * how you accidentally take real money during local testing — exactly the
 * scenario the dev/prod split is supposed to prevent. Secret stays strict.
 */
let publishableFallbackWarned = false;
function readPublishableKey(): string {
  if (isProduction()) {
    const key = process.env.STRIPE_PUBLISHABLE_KEY;
    if (!key) {
      throw new Error(
        `STRIPE_PUBLISHABLE_KEY is not set (NODE_ENV=${process.env.NODE_ENV || "development"})`
      );
    }
    return key;
  }

  const testKey = process.env.STRIPE_PUBLISHABLE_KEY_TEST;
  if (testKey) return testKey;

  const liveKey = process.env.STRIPE_PUBLISHABLE_KEY;
  if (liveKey) {
    if (!publishableFallbackWarned) {
      console.warn(
        "[stripe] STRIPE_PUBLISHABLE_KEY_TEST not set, falling back to STRIPE_PUBLISHABLE_KEY for dev. Set STRIPE_PUBLISHABLE_KEY_TEST in .env to silence this."
      );
      publishableFallbackWarned = true;
    }
    return liveKey;
  }

  throw new Error(
    `STRIPE_PUBLISHABLE_KEY_TEST is not set (NODE_ENV=${process.env.NODE_ENV || "development"})`
  );
}

export function hasStripeSecretKey(): boolean {
  const prod = isProduction();
  return Boolean(prod ? process.env.STRIPE_SECRET_KEY : process.env.STRIPE_SECRET_KEY_TEST);
}

export function hasStripePublishableKey(): boolean {
  if (isProduction()) return Boolean(process.env.STRIPE_PUBLISHABLE_KEY);
  // Dev: TEST preferred, but live publishable is an acceptable fallback.
  return Boolean(
    process.env.STRIPE_PUBLISHABLE_KEY_TEST || process.env.STRIPE_PUBLISHABLE_KEY
  );
}

export function expectedStripeKeyName(kind: "secret" | "publishable"): string {
  const prod = isProduction();
  if (kind === "secret") return prod ? "STRIPE_SECRET_KEY" : "STRIPE_SECRET_KEY_TEST";
  return prod ? "STRIPE_PUBLISHABLE_KEY" : "STRIPE_PUBLISHABLE_KEY_TEST";
}

export async function getUncachableStripeClient(): Promise<Stripe> {
  return new Stripe(readSecretKey(), {
    apiVersion: "2025-08-27.basil" as any,
  });
}

export async function getStripePublishableKey(): Promise<string> {
  return readPublishableKey();
}

export async function getStripeSecretKey(): Promise<string> {
  return readSecretKey();
}

/**
 * Webhook signing secret(s).
 *
 * Production: STRIPE_WEBHOOK_SECRET (primary), with optional STRIPE_WEBHOOK_SECRET_2
 * for DNS cutovers when two endpoints are registered simultaneously
 * (e.g. mintvault.fly.dev + mintvaultuk.com).
 *
 * Dev: STRIPE_WEBHOOK_SECRET_TEST only — the Stripe CLI's `stripe listen`
 * prints this to the terminal on first run.
 *
 * Returns { primary, secondary? } so callers can try-then-fallback for
 * signature verification.
 */
export interface StripeWebhookSecrets {
  primary: string;
  secondary?: string;
}

export function getStripeWebhookSecrets(): StripeWebhookSecrets {
  if (isProduction()) {
    const primary = process.env.STRIPE_WEBHOOK_SECRET;
    if (!primary) {
      throw new Error(
        `STRIPE_WEBHOOK_SECRET is not set (NODE_ENV=production)`
      );
    }
    const secondary = process.env.STRIPE_WEBHOOK_SECRET_2 || undefined;
    return secondary ? { primary, secondary } : { primary };
  }

  const primary = process.env.STRIPE_WEBHOOK_SECRET_TEST;
  if (!primary) {
    throw new Error(
      `STRIPE_WEBHOOK_SECRET_TEST is not set (NODE_ENV=${process.env.NODE_ENV || "development"}). Run 'stripe listen --forward-to localhost:5000/api/stripe/webhook' and copy the printed whsec_... into your .env.`
    );
  }
  return { primary };
}
