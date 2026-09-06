export const PARTNER_OPERATIONS_COMPONENT = {
  schemaVersion: 1,
  id: "partner-operations",
  owner: "partner-platform",
  releaseMode: "required",
  runtimeState: "enabled",
  sourceRoots: ["server/partner/", "client/src/pages/partner/", "client/src/components/partner/"],
  requirements: {
    migrations: [
      { name: "0077_partner_credential_lifecycle_hardening.sql", order: 0 },
      { name: "0089_partner_shared_rate_limit_buckets.sql", order: 2 },
    ],
    relations: [
      { name: "public.partner_organisations", order: 4 },
      { name: "public.partner_rate_limit_buckets", order: 9 },
    ],
    triggers: [],
    environment: [{ name: "PARTNER_ADMIN_DATABASE_URL", order: 18 }],
    runtimeSignals: [
      { name: "partner_shared_rate_limit_store", order: 0 },
      { name: "partner_admin_database_authority", order: 3 },
    ],
  },
} as const;
