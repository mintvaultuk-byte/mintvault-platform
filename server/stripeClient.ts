/**
 * server/stripeClient.ts
 *
 * Single source of truth for Stripe SDK secret + publishable keys.
 * Switches on NODE_ENV:
 *   - production → STRIPE_SECRET_KEY        (sk_live_*)  + STRIPE_PUBLISHABLE_KEY        (pk_live_*)
 *   - anything else → STRIPE_SECRET_KEY_TEST (sk_test_*) + STRIPE_PUBLISHABLE_KEY_TEST (pk_test_*)
 *
 * Goal: zero direct reads of STRIPE_SECRET_KEY anywhere else in server/.
 * Every Stripe SDK init MUST go through getStripeClient() / getStripeSecretKey().
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

function readPublishableKey(): string {
  const prod = isProduction();
  const key = prod
    ? process.env.STRIPE_PUBLISHABLE_KEY
    : process.env.STRIPE_PUBLISHABLE_KEY_TEST;
  if (!key) {
    const expected = prod ? "STRIPE_PUBLISHABLE_KEY" : "STRIPE_PUBLISHABLE_KEY_TEST";
    throw new Error(
      `${expected} is not set (NODE_ENV=${process.env.NODE_ENV || "development"})`
    );
  }
  return key;
}

export function hasStripeSecretKey(): boolean {
  const prod = isProduction();
  return Boolean(prod ? process.env.STRIPE_SECRET_KEY : process.env.STRIPE_SECRET_KEY_TEST);
}

export function hasStripePublishableKey(): boolean {
  const prod = isProduction();
  return Boolean(
    prod ? process.env.STRIPE_PUBLISHABLE_KEY : process.env.STRIPE_PUBLISHABLE_KEY_TEST
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
