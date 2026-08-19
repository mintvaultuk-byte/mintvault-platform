# Rollback — MintVault Command Centre V1 final reconciliation

## Trigger conditions

- A local release gate fails after Command Centre-only changes.
- The deployed staging identity is not the exact candidate SHA.
- Staging Pilot Flag state, sidebar and dashboard endpoint disagree.
- Command Centre affects an unrelated canonical MintVault workflow.

## Rollback steps

### Before commit/deployment

- Inspect the candidate diff and restore only the named Command Centre files if necessary; never reset the primary workspace or unrelated branch work.

### Staging only

1. In the established Super Admin Pilot Controls, set global `super_admin_command_centre_enabled` to disabled.
2. Verify sidebar removal and authenticated `GET /api/admin/command/dashboard` returns generic `404`.
3. Verify Partner Management still operates; no domain data rollback is required because Command Centre has no business mutation, migration, or persistence.
4. If application code must be rolled back, deploy the prior staging image through `scripts/safe-deploy.sh staging` only under the recorded staging approval.

### Production

No production deployment or flag change is authorised in this task.

## What rollback does NOT undo

No grading, payment, credit, Partner, station, Scanner, certificate, customer, storage, migration or production state is changed by this release scope.

## Verification after rollback

- Command Centre returns `404` while disabled.
- Core Partner Management UI and baseline health endpoint remain available.
