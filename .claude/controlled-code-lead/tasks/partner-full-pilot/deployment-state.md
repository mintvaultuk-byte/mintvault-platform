# Deployment state — partner-full-pilot continuation

- Environment: staging app `mintvault-v2` only.
- Production: untouched; no production release, migration, database, storage, or Stripe action is authorised.
- Pre-repair deployed application: `f51f0a4c122bd91a49c4df557fc6c7e9a97d8db4`.
- Staging migration journal: 0071 applied and preflight/public-preflight passed before the pilot.
- Restore point: staging archive `staging-pre-migration.dump`, SHA-256 `97a42eb5f024f2a86157b11820690ed23ba4ca12519fa4041f0db5a1a2883f3a`, recorded 2026-08-10T20:54:19.256Z.
- Rollback of this code repair: deploy the prior staging release only if the targeted live probes fail; data/schema rollback is neither needed nor authorised.
- Activation gate: exact pushed commit must have terminal CI before staging deploy; verify `/api/version` plus the two repaired live paths afterwards.
