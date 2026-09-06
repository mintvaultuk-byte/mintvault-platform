export const CUSTOMER_NOTIFICATIONS_COMPONENT = {
  schemaVersion: 1,
  id: "customer-notifications",
  owner: "customer-platform",
  releaseMode: "required",
  runtimeState: "enabled",
  sourceRoots: ["server/customer-notification-outbox.ts", "server/email.ts"],
  requirements: {
    migrations: [{ name: "0120_customer_notification_outbox.sql", order: 10 }],
    relations: [{ name: "public.customer_notification_outbox", order: 14 }],
    triggers: [],
    environment: [
      { name: "RESEND_API_KEY", order: 15 },
      { name: "RESEND_DOMAIN_VERIFIED", order: 16 },
      { name: "CUSTOMER_NOTIFICATION_ENC_KEY_VERSION", order: 17 },
    ],
    runtimeSignals: [],
  },
} as const;
