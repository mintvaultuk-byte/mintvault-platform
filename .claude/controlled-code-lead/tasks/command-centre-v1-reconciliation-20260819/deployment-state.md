# Deployment state — MintVault Command Centre V1 final reconciliation

## Production

- Production deployment/flag state: not queried or modified in this pass; production is prohibited by task scope.

## Staging

- Historical Command Centre evidence: release `v530`, commit `3ad2a900`, app `mintvault-v2`; superseded for this reconciliation.
- Current staging identity: deployment version `532`, app `mintvault-v2`, two LHR machines started with passing health checks. `/health` is `ok`; `/api/version` reports `60b9e268`.

## This task's branch

- Branch: `codex/command-centre-v1-reconciliation-20260819`
- Baseline: `c50617526d454eb1911b9d4dcd819fb296844424`; rebased parent: `facfd36f4ec8f164d017aba7a4386bab04a4aa6d`
- Pushed: no.
- Deployed anywhere: staging only, exact artifact `60b9e2683c6866a385496d14de1a780615858468`.

## Known divergence between environments

- The old staging candidate contained foreign Scanner/payment/credit/migration history. This candidate must not.
- The Command Centre kill switch authority is the persisted global Partner Pilot Flag `super_admin_command_centre_enabled`, not `SUPER_ADMIN_COMMAND_CENTRE_ENABLED`.
- Staging Pilot Flag was exercised ON → OFF → ON and left ON; production was neither queried nor modified.
