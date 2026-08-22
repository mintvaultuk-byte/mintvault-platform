# Deployment state — Partner supplies ordering

## Production

- Fly control plane: `mintvault` release `v1114`, two healthy LHR machines, observed 2026-08-20.
- No production deployment, migration, data mutation, provider action or stock fulfilment is authorised.

## Staging

- Fly control plane: `mintvault-v2` release `v546`, image `mintvault-v2:deployment-01M0G2MK681WB68TZRNYGPXY2C`, two healthy LHR machines, observed 2026-08-20.
- The live staging endpoint now reports `aab526ea`. Guarded preflight refused the Supplies-only candidate because that live commit is divergent, so a normal merge is required and is in progress; no bypass flag was used.
- This task is staging-only. A staging migration and a single staging test order are owner-authorised only as part of the final explicit rollout; neither has occurred.

## This task branch

- Branch: `codex/partner-supplies-staging-20260820`
- Candidate parents: Supplies `97bb6518a64958b891a707b15f5ce820819dc262` on current `origin/main` (`2d776db9`) and current staging `aab526eaf15b49424a258eb6b4fa5497d7a5c34d`; final merge SHA is recorded after its local commit.
- Pushed: no.
- Deployed anywhere: no.

## Known divergence

- Staging/prod schema must be inspected separately before any supplies migration. The target staging host is `ep-purple-voice-abfez796`; production host `ep-wispy-morning-ab6f4o08` is prohibited.
