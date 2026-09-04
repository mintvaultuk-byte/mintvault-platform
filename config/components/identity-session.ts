export const IDENTITY_SESSION_COMPONENT = {
  schemaVersion: 1,
  id: "identity-session",
  owner: "identity-platform",
  releaseMode: "required",
  runtimeState: "enabled",
  sourceRoots: [
    "server/auth.ts",
    "server/routes/auth.ts",
    "client/src/lib/admin-session.tsx",
    "client/src/lib/queryClient.ts",
  ],
  requirements: {
    migrations: [{ name: "0119_session_store_authority.sql", order: 9 }],
    relations: [
      { name: "public.public_rate_limit_buckets", order: 10 },
      { name: "public.session", order: 13 },
    ],
    triggers: [],
    environment: [{ name: "SESSION_SECRET", order: 4 }],
    runtimeSignals: [],
  },
} as const;
