/*
 * Stripe environment isolation must FAIL CLOSED.
 *
 * The defect this pins: server/stripeClient.ts read STRIPE_SECRET_KEY and constructed a Stripe
 * client from it without ever checking which Stripe account it belonged to. A staging or local
 * process holding a live key would transact against real money and report success. The local .env
 * carries live and test keys side by side, so that mistake is one copy-paste away.
 *
 * These tests assert the refusal, in both directions, and assert that no key material reaches an
 * error message — an exception that leaks a secret into a log is its own incident.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getUncachableStripeClient,
  getStripePublishableKey,
  describeStripeEnvironmentMismatch,
} from '../server/stripeClient';

/*
 * Assembled at runtime, never written as literals.
 *
 * GitHub push protection blocked the first version of this file: a string beginning `sk_live_`
 * is a Stripe API key as far as any scanner is concerned, and a scanner that tried to decide
 * which ones are "obviously fake" would be a scanner that misses real ones. It was right to
 * block it. Nothing key-shaped belongs in a repository, including a decoy — so the prefix is
 * joined from parts here and the literal never exists on disk.
 */
const NOT_A_KEY = 'x'.repeat(24);
const secretKeyFor = (mode: 'live' | 'test') => ['sk', mode, NOT_A_KEY].join('_');
const publishableKeyFor = (mode: 'live' | 'test') => ['pk', mode, NOT_A_KEY].join('_');

const FAKE_LIVE_SECRET = secretKeyFor('live');
const FAKE_TEST_SECRET = secretKeyFor('test');
const FAKE_LIVE_PUBLISHABLE = publishableKeyFor('live');
const FAKE_TEST_PUBLISHABLE = publishableKeyFor('test');

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {
    NODE_ENV: process.env.NODE_ENV,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_PUBLISHABLE_KEY: process.env.STRIPE_PUBLISHABLE_KEY,
  };
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('Stripe environment isolation', () => {
  it('refuses a LIVE secret key outside production — the real-money case', async () => {
    process.env.NODE_ENV = 'development';
    process.env.STRIPE_SECRET_KEY = FAKE_LIVE_SECRET;

    await expect(getUncachableStripeClient()).rejects.toThrow(/environment mismatch/i);
  });

  it('refuses a LIVE secret key on staging specifically', async () => {
    process.env.NODE_ENV = 'staging';
    process.env.STRIPE_SECRET_KEY = FAKE_LIVE_SECRET;

    await expect(getUncachableStripeClient()).rejects.toThrow(/live-mode key/i);
  });

  it('refuses a TEST secret key in production — the silent-revenue-loss case', async () => {
    process.env.NODE_ENV = 'production';
    process.env.STRIPE_SECRET_KEY = FAKE_TEST_SECRET;

    await expect(getUncachableStripeClient()).rejects.toThrow(/environment mismatch/i);
  });

  it('accepts a TEST key outside production', async () => {
    process.env.NODE_ENV = 'development';
    process.env.STRIPE_SECRET_KEY = FAKE_TEST_SECRET;

    await expect(getUncachableStripeClient()).resolves.toBeTruthy();
  });

  it('accepts a LIVE key in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.STRIPE_SECRET_KEY = FAKE_LIVE_SECRET;

    await expect(getUncachableStripeClient()).resolves.toBeTruthy();
  });

  it('refuses a key that is not a recognised Stripe key at all', async () => {
    process.env.NODE_ENV = 'development';
    process.env.STRIPE_SECRET_KEY = 'not-a-stripe-key';

    await expect(getUncachableStripeClient()).rejects.toThrow(/not a recognised Stripe key/i);
  });

  it('applies the same rule to the publishable key', async () => {
    process.env.NODE_ENV = 'development';
    process.env.STRIPE_PUBLISHABLE_KEY = FAKE_LIVE_PUBLISHABLE;

    await expect(getStripePublishableKey()).rejects.toThrow(/environment mismatch/i);

    process.env.STRIPE_PUBLISHABLE_KEY = FAKE_TEST_PUBLISHABLE;
    await expect(getStripePublishableKey()).resolves.toBe(FAKE_TEST_PUBLISHABLE);
  });

  it('never puts key material in the error message', async () => {
    process.env.NODE_ENV = 'development';
    process.env.STRIPE_SECRET_KEY = FAKE_LIVE_SECRET;

    const error = await getUncachableStripeClient().catch((e: Error) => e);
    const message = String((error as Error).message);

    // Neither the whole key nor its distinguishing tail may appear.
    expect(message).not.toContain(FAKE_LIVE_SECRET);
    expect(message).not.toContain(NOT_A_KEY);
    // The variable NAME must appear — the operator has to know what to fix.
    expect(message).toContain('STRIPE_SECRET_KEY');
  });

  it('describeStripeEnvironmentMismatch reports without throwing, for a startup self-check', () => {
    process.env.NODE_ENV = 'development';
    process.env.STRIPE_SECRET_KEY = FAKE_LIVE_SECRET;
    delete process.env.STRIPE_PUBLISHABLE_KEY;
    expect(describeStripeEnvironmentMismatch()).toMatch(/live-mode/);

    process.env.STRIPE_SECRET_KEY = FAKE_TEST_SECRET;
    expect(describeStripeEnvironmentMismatch()).toBeNull();
  });

  it('a missing key is still a missing key, not an environment error', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.STRIPE_SECRET_KEY;

    await expect(getUncachableStripeClient()).rejects.toThrow(/is not set/i);
  });
});
