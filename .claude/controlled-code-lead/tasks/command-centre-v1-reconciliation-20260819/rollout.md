# Rollout — MintVault Command Centre V1 final reconciliation

**Classification:** B/C — coordinated read-only server/client surface with staging-only proof.

## Pre-rollout checklist

- [ ] Exact candidate has no foreign Scanner, finance, webhook, migration or package paths.
- [ ] All local gates in `change-manifest.md` pass.
- [ ] Final local commit and candidate SHA are recorded.
- [ ] Staging-only owner authorisation is recorded; production remains prohibited.

## Steps

1. Deploy only the exact local candidate to staging through `scripts/safe-deploy.sh staging --yes`.
2. Confirm staging `/health` and `/api/version` identify the candidate.
3. Use existing Super Admin Pilot Controls to exercise `super_admin_command_centre_enabled`: enabled → disabled → enabled.
4. Record direct API/nav/refresh behaviour and all final control outcomes; leave staging in the agreed enabled state only if acceptance passes.
5. Do not deploy or change production.

## Staging verification evidence

- Pending exact-SHA deployment and final 52-control ledger.

## Who/what is affected

- Staging Super Admin Command Centre only; no production user or canonical domain mutation is in scope.
