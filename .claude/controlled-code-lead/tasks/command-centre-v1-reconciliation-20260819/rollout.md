# Rollout — MintVault Command Centre V1 final reconciliation

**Classification:** B/C — coordinated read-only server/client surface with staging-only proof.

## Pre-rollout checklist

- [x] Exact candidate has no foreign Scanner, finance, webhook, migration or package paths.
- [x] All local gates in `change-manifest.md` pass for runnable affected scope; broad root-suite DB-provisioning limitation is explicitly recorded.
- [x] Staging artifact SHA `60b9e268` and current-main parent `facfd36f` are recorded.
- [x] Staging-only owner authorisation is recorded; production remains prohibited.

## Steps

1. Deploy only the exact local candidate to staging through `scripts/safe-deploy.sh staging --yes`.
2. Confirm staging `/health` and `/api/version` identify the candidate.
3. Use existing Super Admin Pilot Controls to exercise `super_admin_command_centre_enabled`: enabled → disabled → enabled.
4. Record direct API/nav/refresh behaviour and all final control outcomes; leave staging in the agreed enabled state only if acceptance passes.
5. Do not deploy or change production.

## Staging verification evidence

- `scripts/safe-deploy.sh staging --yes --reconciled-from ad71baf6` completed for `60b9e268`.
- Fly deployment version `532`: two LHR machines started, each with passing health check; `/health` returned `ok`; `/api/version` returned commit `60b9e268`.
- Persisted Pilot Flag passed ON → OFF → ON and was left enabled after acceptance.
- The live DOM contained 68 controls, recorded row-by-row in `COMMAND_CENTRE_V1_CONTROL_AUDIT.md`; 52 was an unsupported legacy assertion, not the actual count.

## Who/what is affected

- Staging Super Admin Command Centre only; no production user or canonical domain mutation is in scope.
