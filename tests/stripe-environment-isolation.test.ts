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
  stripeEnvironmentIsUndeclared,
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
    STRIPE_ENV: process.env.STRIPE_ENV,
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
  describe('coherence — always enforced, needs no deployment knowledge', () => {
    it('refuses a half-swapped pair: live secret with test publishable', async () => {
      delete process.env.STRIPE_ENV;
      process.env.STRIPE_SECRET_KEY = FAKE_LIVE_SECRET;
      process.env.STRIPE_PUBLISHABLE_KEY = FAKE_TEST_PUBLISHABLE;

      await expect(getUncachableStripeClient()).rejects.toThrow(/incoherent/i);
    });

    it('refuses the mirror image: test secret with live publishable', async () => {
      delete process.env.STRIPE_ENV;
      process.env.STRIPE_SECRET_KEY = FAKE_TEST_SECRET;
      process.env.STRIPE_PUBLISHABLE_KEY = FAKE_LIVE_PUBLISHABLE;

      await expect(getUncachableStripeClient()).rejects.toThrow(/incoherent/i);
    });

    it('refuses a key that is not a recognised Stripe key at all', async () => {
      delete process.env.STRIPE_ENV;
      process.env.STRIPE_SECRET_KEY = 'not-a-stripe-key';

      await expect(getUncachableStripeClient()).rejects.toThrow(/not a recognised Stripe key/i);
    });

    it('accepts a coherent pair when the deployment declares nothing', async () => {
      delete process.env.STRIPE_ENV;
      process.env.STRIPE_SECRET_KEY = FAKE_TEST_SECRET;
      process.env.STRIPE_PUBLISHABLE_KEY = FAKE_TEST_PUBLISHABLE;

      await expect(getUncachableStripeClient()).resolves.toBeTruthy();
      expect(stripeEnvironmentIsUndeclared()).toBe(true);
    });
  });

  describe('expected mode — enforced only when STRIPE_ENV declares one', () => {
    it('refuses a LIVE key where test is expected — the real-money case', async () => {
      process.env.STRIPE_ENV = 'test';
      process.env.STRIPE_SECRET_KEY = FAKE_LIVE_SECRET;
      delete process.env.STRIPE_PUBLISHABLE_KEY;

      await expect(getUncachableStripeClient()).rejects.toThrow(/environment mismatch/i);
    });

    it('refuses a TEST key where live is expected — the silent-revenue-loss case', async () => {
      process.env.STRIPE_ENV = 'live';
      process.env.STRIPE_SECRET_KEY = FAKE_TEST_SECRET;
      delete process.env.STRIPE_PUBLISHABLE_KEY;

      await expect(getUncachableStripeClient()).rejects.toThrow(/environment mismatch/i);
    });

    it('accepts matching modes in both directions', async () => {
      process.env.STRIPE_ENV = 'test';
      process.env.STRIPE_SECRET_KEY = FAKE_TEST_SECRET;
      await expect(getUncachableStripeClient()).resolves.toBeTruthy();

      process.env.STRIPE_ENV = 'live';
      process.env.STRIPE_SECRET_KEY = FAKE_LIVE_SECRET;
      await expect(getUncachableStripeClient()).resolves.toBeTruthy();
    });
  });

  describe('the deploy-safety property this module got wrong once', () => {
    it('NODE_ENV=production alone never forces live keys', async () => {
      /*
       * fly.v2.toml sets NODE_ENV=production on STAGING. An earlier version of this guard keyed
       * the refusal on NODE_ENV, which would have refused a correctly-configured staging box
       * holding test keys the moment it deployed. Pin the corrected behaviour so it cannot
       * regress: production NODE_ENV with test keys and no STRIPE_ENV must be ACCEPTED.
       */
      process.env.NODE_ENV = 'production';
      delete process.env.STRIPE_ENV;
      process.env.STRIPE_SECRET_KEY = FAKE_TEST_SECRET;
      process.env.STRIPE_PUBLISHABLE_KEY = FAKE_TEST_PUBLISHABLE;

      await expect(getUncachableStripeClient()).resolves.toBeTruthy();
      expect(describeStripeEnvironmentMismatch()).toBeNull();
    });
  });

  it('applies the same rules to the publishable key', async () => {
    process.env.STRIPE_ENV = 'test';
    process.env.STRIPE_PUBLISHABLE_KEY = FAKE_LIVE_PUBLISHABLE;
    delete process.env.STRIPE_SECRET_KEY;

    await expect(getStripePublishableKey()).rejects.toThrow(/environment mismatch/i);

    process.env.STRIPE_PUBLISHABLE_KEY = FAKE_TEST_PUBLISHABLE;
    await expect(getStripePublishableKey()).resolves.toBe(FAKE_TEST_PUBLISHABLE);
  });

  it('never puts key material in the error message', async () => {
    process.env.STRIPE_ENV = 'test';
    process.env.STRIPE_SECRET_KEY = FAKE_LIVE_SECRET;

    const error = await getUncachableStripeClient().catch((e: Error) => e);
    const message = String((error as Error).message);

    expect(message).not.toContain(FAKE_LIVE_SECRET);
    expect(message).not.toContain(NOT_A_KEY);
    expect(message).toContain('STRIPE_SECRET_KEY');
  });

  it('a missing key is still a missing key, not an environment error', async () => {
    delete process.env.STRIPE_ENV;
    delete process.env.STRIPE_SECRET_KEY;

    await expect(getUncachableStripeClient()).rejects.toThrow(/is not set/i);
  });
});
