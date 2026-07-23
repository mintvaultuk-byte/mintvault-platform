# Focused Fix Record

## Scope and change

The correction changes only the realistic migration test infrastructure, its focused assertions,
the database-migration runbook, and isolated verification/handover material.

| File                                                          | Change                                                                                                                                                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/helpers/partner-realistic-db.ts`                       | Splits migration execution: ordinary migrations use `pn_migrator`; 0019 uses the disposable deployment-owner connection. Returns the executed phase inventory for focused assertions. |
| `tests/partner-g6d-migration-upgrade.test.ts`                 | Proves 0019 used the owner phase, the release function owner is the no-login BYPASSRLS definer, and a connector runtime login cannot run DDL or forge accounting evidence.            |
| `scripts/audit/run-g6d-project-control-owner-verification.ts` | New isolated PG17 chain proof for 0001–0018 → 0019 → frozen 0020, including journal, grants, ownership, and append-only checks.                                                       |
| `docs/runbooks/db-migration-safety.md`                        | Adds the governed 0019 deployment-owner runbook.                                                                                                                                      |

The following were deliberately not changed: `migrations/0019_partner_submission_credit_lifecycle.sql`,
the frozen Project Control candidate, migration 0020, application role grants, feature flags, and
production/staging configuration.

## Why the correction is safe

- It removes the false test assumption rather than adding privilege to `pn_migrator`,
  `partner_runtime`, or `partner_connector_runtime`.
- It preserves the migration's atomic temporary-membership revoke and validates that no definer
  membership remains for the restricted migrator.
- It retains the original direct-write denials and narrow connector `EXECUTE` grant.
- It leaves immutable accounting evidence, credit holds, RLS, security-definer ownership, and
  function search-path controls intact.

## Known shared-test reconciliation

The focused change does not alter the recommended post-Opus reconciliation:

1. Keep G6D's numeric cleanup of all migrations `>17` in
   `tests/partner-credit-reservation-service.test.ts`.
2. Build the single ordered 0001–0020 inventory, including both 0019 and 0020, in
   `tests/partner-schema-parity.test.ts`.

Those changes remain for the approved future integration branch; nothing was ported into the frozen
Project Control candidate.
