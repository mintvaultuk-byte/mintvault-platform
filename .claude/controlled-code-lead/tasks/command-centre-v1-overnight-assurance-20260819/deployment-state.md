# Deployment state — Command Centre V1 overnight release assurance

## Production

- Prohibited. This pass will not query, inspect, deploy, configure, toggle or mutate production.

## Staging starting authority

- Prior reconciled evidence identifies app `mintvault-v2`, URL `https://mintvault-v2.fly.dev`, Fly version `532`, two healthy LHR machines and runtime artifact `60b9e2683c6866a385496d14de1a780615858468`.
- Fresh read-only staging identity/health/status inspection passed.
- The persisted flag authority is `super_admin_command_centre_enabled`; prior state was ON after an ON → OFF → ON proof.
- This pass may repeat staging ON → OFF → ON and may safe-redeploy staging only if application code changes. It may not perform any business-data mutation.

## Candidate

- Repaired runtime source: `3d65b960`.
- Proof-only mobile regression source: `bd0b3292ff229ca0e02b3989a1cd02e85cb71f41`.
- Repaired runtime image: `registry.fly.io/mintvault-v2:deployment-01M0E2K5QPTYAYN0N8GJGAJQSX` (`sha256:925e8f94d670ecb0adafaf0af19aea2d9ed2ebd686c687efb63882f94962b2cd`).
- Final evidence commit is deployed after the ledger is sealed; authoritative identity is Git HEAD plus staging `/api/version` in the owner handoff.
- Pushed: no. Production: untouched and unqueried.

## Acceptance and rollback

- Repaired image: both LHR machines healthy; live views/320/768/1280/keyboard passed.
- Protected load tiers: 1/1, 5/5, 10/10, 20/20.
- Protected soak: 90/90 over 15m44s, 322–981ms, average 454ms, no Command Centre timeout/error/5xx signature.
- Rollback executed to prior image `deployment-01M0DTK3VQNA3FESW58R851JGT`; 2/2 healthy and `/api/version=60b9e268`.
- Restore executed to repaired image; 2/2 healthy and `/api/version=3d65b960`.
- Exact-candidate Pilot OFF/ON proof remains open; authoritative flag was left ON.
