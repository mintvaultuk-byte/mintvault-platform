import Stripe from 'stripe';

function getSecretKey(): string {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY env var is not set');
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
  return key;
}

export async function getStripeSecretKey(): Promise<string> {
  return getSecretKey();
}
