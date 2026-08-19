# Deployment state — MintVault Command Centre V1 final reconciliation

## Production

- Production deployment/flag state: not queried or modified in this pass; production is prohibited by task scope.

## Staging

- Historical Command Centre evidence: release `v530`, commit `3ad2a900`, app `mintvault-v2`; this is stale once the reconciled candidate differs.
- Current staging identity: pending read-only confirmation immediately before authorised deployment.

## This task's branch

- Branch: `codex/command-centre-v1-reconciliation-20260819`
- Baseline: `c50617526d454eb1911b9d4dcd819fb296844424`
- Pushed: no.
- Deployed anywhere: no.

## Known divergence between environments

- The old staging candidate contained foreign Scanner/payment/credit/migration history. This candidate must not.
- The Command Centre kill switch authority is the persisted global Partner Pilot Flag `super_admin_command_centre_enabled`, not `SUPER_ADMIN_COMMAND_CENTRE_ENABLED`.
