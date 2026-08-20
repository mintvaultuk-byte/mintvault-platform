# Deployment state — Command Centre V1 overnight release assurance

## Production

- Prohibited. This pass did not query, inspect, deploy, configure, toggle or mutate production.

## Current-main and live reconciliation

- Current `origin/main`: `e057a67d116162e65f0898c02f52d9a249c25069`.
- Candidate is 0 behind and descends from current main.
- The concurrently deployed staging grading commit `a4491693` is preserved as an actual candidate ancestor; safe-deploy therefore fast-forwarded rather than overwriting live work.

## Runtime candidate

- Runtime source: `8c1aac561498f49f87c0c8a92a929a92e51e5ee2`.
- Fly release: v544.
- Image: `registry.fly.io/mintvault-v2:deployment-01M0ET8GH7D6MWY4845F0SWW9W`.
- Digest: `sha256:a79cf53ffe264c9f145a9e8152fa0d9619cebc8771dcbef112cf4cc8bdf43fe3`.
- Both LHR machines started with 1/1 checks and returned `/api/version=8c1aac56`.
- Final evidence commit is deployed after this ledger is sealed; exact Git and `/api/version` identity is reported in the owner handoff.
- Pushed: no. Production: untouched and unqueried.

## Exact-candidate acceptance

- Native Super Admin Pilot Controls completed ON → OFF → ON with the real confirmation dialog.
- OFF persisted across refresh, removed Command Centre navigation and made `/admin/command` fail closed without privileged data.
- ON persisted across refresh, restored navigation and returned the authorised live dashboard.
- Final staging flag: ON.
- Admin IP/auth: 194/194; independent hostile IP matrix: 136/136.
- Command Centre: 109/109; protected grading/current-code: 765/765.
- Partner isolated: 70/70 suites and 1,313 assertions; Scanner app: 152/152.
- Typecheck, ESLint, canonical build, diff check and 320px zero-overflow control passed.

## Rollback

- Immediate containment is the persisted Super Admin Pilot OFF control.
- Immediate pre-change recovery image: Fly v543, `registry.fly.io/mintvault-v2:deployment-01M0ERFXFDRYJ2EP44HWAKRHQ9`, digest `sha256:d018716271b2ccb1681d44bbdc41c0e99e44c233dfd2b76c6367591a194a9b03`, embedded source `a4491693`.
- The earlier direct-image staging rollback to v532 (`60b9e268`) and restore were executed and verified 2/2 healthy.
- No migration or business-data rollback is required for this two-gate change.
