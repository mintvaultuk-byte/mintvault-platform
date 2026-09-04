export const CORE_RUNTIME_COMPONENT = {
  schemaVersion: 1,
  id: "core-runtime",
  owner: "core-platform",
  releaseMode: "required",
  runtimeState: "enabled",
  sourceRoots: ["server/index.ts", "server/routes.ts", "client/src/App.tsx"],
  requirements: {
    migrations: [
      { name: "0114_certificate_identity_authority.sql", order: 4 },
      { name: "0115_runtime_schema_convergence.sql", order: 5 },
      { name: "0121_main_runtime_role_authority.sql", order: 11 },
    ],
    relations: [
      { name: "public.schema_migrations", order: 0 },
      { name: "public.certificates", order: 1 },
      { name: "public.cert_counter", order: 2 },
      { name: "public.submissions", order: 3 },
    ],
    triggers: [
      { name: "trg_certificate_number_immutable", relation: "public.certificates", order: 0 },
      { name: "trg_cert_counter_identity_guard", relation: "public.cert_counter", order: 1 },
      { name: "trg_cert_counter_refuse_truncate", relation: "public.cert_counter", order: 2 },
    ],
    environment: [
      { name: "SIGNED_URL_SECRET", order: 5 },
      { name: "APP_URL", order: 6 },
    ],
    runtimeSignals: [{ name: "main_database_runtime_authority", order: 2 }],
  },
} as const;
