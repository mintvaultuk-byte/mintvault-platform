# Deployment state — partner-full-pilot continuation

- Environment: staging app `mintvault-v2` only.
- Production: untouched; no production release, migration, database, storage, or Stripe action is authorised.
- Staging application: `6f4e26527e601fde821898d154cb010c872467c6` (`6f4e2652`), deployed through `scripts/safe-deploy.sh staging`; `/api/version` and `/api/health` both passed.
- Staging migration journal: 0071 applied and preflight/public-preflight passed before the pilot.
- Restore point: staging archive `staging-pre-migration.dump`, SHA-256 `97a42eb5f024f2a86157b11820690ed23ba4ca12519fa4041f0db5a1a2883f3a`, recorded 2026-08-10T20:54:19.256Z.
- Prior staging rollback image: `registry.fly.io/mintvault-v2:deployment-01KZPYA7BFCK4CK66QYAPYPFAW`. No schema/data rollback is needed or authorised for this bounded code repair.
- Required CI on `6f4e2652`: Secret scan, dependency review, AMD64 image/boot, CodeQL SAST, and lint/type-check/test/build all terminal green before deploy.
- Live repair proof: picker returns both imported certificates; connector detail has two reservations/no conflict; audited recovery of the historic staging test item settled exactly two credits (98 available / 0 reserved / 2 consumed).
