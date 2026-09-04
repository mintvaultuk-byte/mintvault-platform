export const COMMERCE_COMPONENT = {
  schemaVersion: 1,
  id: "commerce",
  owner: "commerce-platform",
  releaseMode: "required",
  runtimeState: "enabled",
  sourceRoots: ["server/vault-club.ts", "server/routes/submissions.ts", "server/stripeClient.ts"],
  requirements: {
    migrations: [{ name: "0117_grading_payment_fulfilment_outbox.sql", order: 7 }],
    relations: [
      { name: "public.estimate_credit_reservations", order: 11 },
      { name: "public.grading_payment_fulfilments", order: 12 },
    ],
    triggers: [],
    environment: [
      { name: "STRIPE_ENV", order: 0 },
      { name: "STRIPE_SECRET_KEY", order: 1 },
      { name: "STRIPE_PUBLISHABLE_KEY", order: 2 },
      { name: "STRIPE_WEBHOOK_SECRET", order: 3 },
    ],
    runtimeSignals: [],
  },
} as const;
