import Stripe from 'stripe';

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
 * RULE. The key's own prefix declares its environment; Stripe guarantees that. So we compare it
 * against the environment the process believes it is in and REFUSE on disagreement:
 *
 *   NODE_ENV=production   → sk_live_ / pk_live_ required, a test key is refused
 *   anything else         → sk_test_ / pk_test_ required, a LIVE key is refused
 *
 * Refusing a test key in production is not symmetry for its own sake: a production box quietly on
 * test keys takes orders that never collect money, which is a revenue incident that looks healthy
 * from every dashboard.
 *
 * FAIL CLOSED, AND LATE. The check runs when a client is constructed, not at import, so a
 * misconfigured box still boots and still serves every non-payment route — a config error must not
 * become a total outage. The payment path, and only the payment path, refuses.
 *
 * NEVER LOGGED. Messages name the variable and the expected prefix. No key material, not even a
 * suffix, appears in an error, a log line, or a stack trace.
 */

type StripeEnvironment = 'live' | 'test';

function expectedEnvironment(): StripeEnvironment {
  return process.env.NODE_ENV === 'production' ? 'live' : 'test';
}

/** The environment a key declares about itself, or null if it is not a recognised Stripe key. */
function declaredEnvironment(key: string): StripeEnvironment | null {
  if (/^(sk|pk|rk)_live_/.test(key)) return 'live';
  if (/^(sk|pk|rk)_test_/.test(key)) return 'test';
  return null;
}

function assertEnvironmentMatches(varName: string, key: string): void {
  const expected = expectedEnvironment();
  const declared = declaredEnvironment(key);

  if (declared === null) {
    throw new Error(
      `${varName} is not a recognised Stripe key (expected an ${expected}-mode key beginning ` +
        `sk_${expected}_, pk_${expected}_ or rk_${expected}_). Refusing to construct a Stripe client.`
    );
  }

  if (declared !== expected) {
    const nodeEnv = process.env.NODE_ENV || 'development';
    throw new Error(
      `Stripe environment mismatch: ${varName} is a ${declared}-mode key but NODE_ENV=${nodeEnv} ` +
        `requires a ${expected}-mode key. Refusing to construct a Stripe client. ` +
        (declared === 'live'
          ? 'A non-production process must never hold live Stripe credentials — it would move real money.'
          : 'A production process on test credentials would take orders that never collect payment.')
    );
  }
}

function getSecretKey(): string {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY env var is not set');
  assertEnvironmentMatches('STRIPE_SECRET_KEY', key);
  return key;
}

export async function getUncachableStripeClient() {
  return new Stripe(getSecretKey(), {
    apiVersion: '2025-08-27.basil' as any,
  });
}

export async function getStripePublishableKey(): Promise<string> {
  const key = process.env.STRIPE_PUBLISHABLE_KEY;
  if (!key) throw new Error('STRIPE_PUBLISHABLE_KEY env var is not set');
  assertEnvironmentMatches('STRIPE_PUBLISHABLE_KEY', key);
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
  for (const varName of ['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY'] as const) {
    const key = process.env[varName];
    if (!key) continue;
    const declared = declaredEnvironment(key);
    if (declared === null) return `${varName} is not a recognised Stripe key`;
    if (declared !== expected) return `${varName} is a ${declared}-mode key but this process expects ${expected}-mode`;
  }
  return null;
}
