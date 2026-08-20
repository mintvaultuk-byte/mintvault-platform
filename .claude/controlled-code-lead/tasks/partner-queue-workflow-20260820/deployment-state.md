# Deployment state — Partner queue evidence and shop-floor workflow

## Production

- Live commit: `ee7fbe43` via `/api/version` on 2026-08-20.
- Live Fly release: `v1112`; app `mintvault`.
- No production deployment, migration or data mutation is authorised for this task.

## Staging

- Live commit: `ee7fbe43` via `/api/version` on 2026-08-20.
- Live Fly release: `v545`; app `mintvault-v2`.
- Read-only staging record classification is in scope. A staging deployment is not yet authorised by the owner's current wording and remains pending an explicit staging deploy instruction after local gates.

## This task branch

- Branch: `codex/partner-queue-workflow-staging-20260820`
- Based on: `origin/main` `e057a67d`.
- Pushed: no.
- Deployed anywhere: no.
- Local verification: full suite passed in a disposable loopback-only database; no staging or production database was used for tests.

## Known divergence

- The previously reviewed full-resolution candidate `a4491693` is not in current `origin/main` or live `ee7fbe43`; it must be reconciled as a deliberate, reviewable change rather than assumed live.
