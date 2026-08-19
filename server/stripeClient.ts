import Stripe from "stripe";

/*
 * STRIPE ENVIRONMENT ISOLATION — FAIL CLOSED.
 *
 * WHY. Until now this module read STRIPE_SECRET_KEY and handed it to the Stripe SDK without ever
 * asking which Stripe account it belonged to. Nothing in the process could tell a live key from a
 * test key, so a non-production deployment holding a live key would transact against real money
 * silently and successfully — the most expensive possible way to be wrong. The local .env on this
 * project carries BOTH (`STRIPE_SECRET_KEY_LIVE` and `STRIPE_SECRET_KEY_TEST`) alongside the
 * unsuffixed key the code actually reads, which is precisely the shape that makes a mistaken copy
 * a one-character edit away.
 *
 * RULE. The key's own prefix declares its environment; Stripe guarantees that. Two checks:
 *
 *   1. COHERENCE, always enforced, needs no knowledge of where we are running. The secret and
 *      publishable keys must be the SAME mode, and both must be recognisable Stripe keys. A
 *      half-swapped pair — live secret, test publishable — is a misconfiguration under every
 *      possible deployment story, so it can be refused unconditionally.
 *
 *   2. EXPECTED MODE, enforced only when STRIPE_ENV explicitly says which mode this deployment
 *      is supposed to be in (`live` or `test`). Set it, and a mismatch is refused in both
 *      directions: a live key where test is expected moves real money; a test key where live is
 *      expected takes orders that never collect, which is a revenue incident that looks healthy
 *      from every dashboard.
 *
 * WHY NOT NODE_ENV. It was the obvious discriminator and it is the wrong one HERE: `fly.v2.toml`
 * sets NODE_ENV=production on STAGING as well as production, because it governs asset building,
 * not money. Keying the refusal on NODE_ENV would have declared staging to be production, and a
 * correctly-configured staging box holding test keys would have had its payment path refused the
 * moment this shipped. An environment signal that cannot tell staging from production must not be
 * used to decide which Stripe account is legitimate.
 *
 * So the strict check is OPT-IN BY CONFIGURATION rather than inferred. Unset STRIPE_ENV keeps
 * check 1 only — which is still strictly safer than what this module did before, and cannot
 * break a running deployment. Setting STRIPE_ENV on each app is the follow-up that makes the
 * refusal total; it is a secrets change and therefore the owner's to make.
 *
 * FAIL CLOSED, AND LATE. The check runs when a client is constructed, not at import, so a
 * misconfigured box still boots and still serves every non-payment route — a config error must not
 * become a total outage. The payment path, and only the payment path, refuses.
 *
 * NEVER LOGGED. Messages name the variable and the expected prefix. No key material, not even a
 * suffix, appears in an error, a log line, or a stack trace.
 */

export type StripeEnvironment = "live" | "test";

/** The mode this deployment declares it is supposed to be in, or null when it declares nothing. */
function expectedEnvironment(): StripeEnvironment | null {
  const declared = (process.env.STRIPE_ENV || "").trim().toLowerCase();
  if (declared === "live" || declared === "test") return declared;
  return null;
}

/**
 * The explicitly declared Stripe mode, without constructing a client or reading key material.
 * Partner-credit fulfilment uses this as a mandatory, fail-closed attribution input: a webhook
 * event from the wrong Stripe account must never become wallet capacity.
 */
export function declaredStripeEnvironment(): StripeEnvironment | null {
  return expectedEnvironment();
}

/** The environment a key declares about itself, or null if it is not a recognised Stripe key. */
function declaredEnvironment(key: string): StripeEnvironment | null {
  if (/^(sk|pk|rk)_live_/.test(key)) return "live";
  if (/^(sk|pk|rk)_test_/.test(key)) return "test";
  return null;
}

function assertEnvironmentMatches(varName: string, key: string): void {
  const declared = declaredEnvironment(key);

  if (declared === null) {
    throw new Error(
      `${varName} is not a recognised Stripe key (expected one beginning sk_live_, sk_test_, ` +
        `pk_live_, pk_test_, rk_live_ or rk_test_). Refusing to construct a Stripe client.`
    );
  }

  // CHECK 1 — coherence. Wrong under every deployment story, so refused unconditionally.
  const counterpartName = varName === "STRIPE_SECRET_KEY" ? "STRIPE_PUBLISHABLE_KEY" : "STRIPE_SECRET_KEY";
  const counterpart = process.env[counterpartName];
  if (counterpart) {
    const counterpartMode = declaredEnvironment(counterpart);
    if (counterpartMode !== null && counterpartMode !== declared) {
      throw new Error(
        `Stripe key pair is incoherent: ${varName} is a ${declared}-mode key but ${counterpartName} ` +
          `is a ${counterpartMode}-mode key. Refusing to construct a Stripe client — half-swapped ` +
          `credentials are a misconfiguration in every environment.`
      );
    }
  }

  // CHECK 2 — expected mode, only when this deployment declares one.
  const expected = expectedEnvironment();
  if (expected !== null && declared !== expected) {
    throw new Error(
      `Stripe environment mismatch: ${varName} is a ${declared}-mode key but STRIPE_ENV=${expected} ` +
        `requires a ${expected}-mode key. Refusing to construct a Stripe client. ` +
        (declared === "live"
          ? "This deployment must never hold live Stripe credentials — it would move real money."
          : "A live deployment on test credentials would take orders that never collect payment.")
    );
  }
}

function getSecretKey(): string {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY env var is not set");
  assertEnvironmentMatches("STRIPE_SECRET_KEY", key);
  return key;
}

export async function getUncachableStripeClient() {
  return new Stripe(getSecretKey(), {
    apiVersion: "2025-08-27.basil" as any,
  });
}

export async function getStripePublishableKey(): Promise<string> {
  const key = process.env.STRIPE_PUBLISHABLE_KEY;
  if (!key) throw new Error("STRIPE_PUBLISHABLE_KEY env var is not set");
  assertEnvironmentMatches("STRIPE_PUBLISHABLE_KEY", key);
  return key;
}

export async function getStripeSecretKey(): Promise<string> {
  return getSecretKey();
}

/**
 * Exported for tests and for a startup self-check that wants to REPORT a misconfiguration without
 * taking a payment path. Returns the disagreement as a string, or null when the configuration is
 * coherent. Never returns key material.
 */
export function describeStripeEnvironmentMismatch(): string | null {
  const expected = expectedEnvironment();
  const modes: Partial<Record<string, StripeEnvironment>> = {};

  for (const varName of ["STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY"] as const) {
    const key = process.env[varName];
    if (!key) continue;
    const declared = declaredEnvironment(key);
    if (declared === null) return `${varName} is not a recognised Stripe key`;
    modes[varName] = declared;
    if (expected !== null && declared !== expected) {
      return `${varName} is a ${declared}-mode key but STRIPE_ENV=${expected}`;
    }
  }

  const secret = modes.STRIPE_SECRET_KEY;
  const publishable = modes.STRIPE_PUBLISHABLE_KEY;
  if (secret && publishable && secret !== publishable) {
    return `STRIPE_SECRET_KEY is ${secret}-mode but STRIPE_PUBLISHABLE_KEY is ${publishable}-mode`;
  }

  if (expected === null) return null;
  return null;
}

/**
 * True when this deployment has NOT declared which Stripe mode it expects, so only the coherence
 * check is active. Surfaced so a startup log can say so out loud rather than implying full cover.
 */
export function stripeEnvironmentIsUndeclared(): boolean {
  return expectedEnvironment() === null;
}
