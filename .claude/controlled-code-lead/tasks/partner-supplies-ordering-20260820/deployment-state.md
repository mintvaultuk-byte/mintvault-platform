# Deployment state — Partner supplies ordering

## Production

- Fly control plane: `mintvault` release `v1114`, two healthy LHR machines, observed 2026-08-20.
- No production deployment, migration, data mutation, provider action or stock fulfilment is authorised.

## Staging

- Fly control plane: `mintvault-v2` release `v546`, image `mintvault-v2:deployment-01M0G2MK681WB68TZRNYGPXY2C`, two healthy LHR machines, observed 2026-08-20.
- The currently prepared Partner staging candidate is not deployed because the guarded release requires a live `/api/version` proof and local DNS resolves `mintvault-v2.fly.dev` as `SERVFAIL`.
- This task is staging-only. A staging migration and a single staging test order are owner-authorised only as part of the final explicit rollout; neither has occurred.

## This task branch

- Branch: `codex/partner-queue-workflow-staging-20260820`
- Commit at baseline: `41245d5f31fa98d567130b50ecef0d7f063ed052`
- Pushed: no.
- Deployed anywhere: no.

## Known divergence

- Staging/prod schema must be inspected separately before any supplies migration. The target staging host is `ep-purple-voice-abfez796`; production host `ep-wispy-morning-ab6f4o08` is prohibited.
