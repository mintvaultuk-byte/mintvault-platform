# Migration Upgrade Failure Root Cause

## Verdict

The failed G6D migration-upgrade suite was a **test-harness role mismatch**, not evidence that
0019 should run as the application/runtime role or that its security boundary should be weakened.

## Reproduction

Against a new local PostgreSQL 17.10 cluster, before this correction:

```sh
npx vitest run tests/partner-g6d-migration-upgrade.test.ts
```

failed in `applyMigrationsRealistic()` at
`tests/helpers/partner-realistic-db.ts:160` with:

```text
0019 ownership transfer must run as the deployment owner so its temporary
partner_credit_lifecycle_definer membership can be revoked atomically
```

The helper opened a `pn_migrator` connection and executed every requested SQL file with that one
connection. It was not the repository's numbered migration runner: it issued the migration SQL
directly and did not create a migration journal. The normal runner in `scripts/db/migrate.ts` uses
the supplied `MINTVAULT_DATABASE_URL`, runs transaction-safe migrations in a transaction under an
advisory lock, and journals `applied_by = current_user`.

## Why 0019 needs the owner-operated phase

0019 creates a no-login BYPASSRLS definer, grants it the least privileges needed by the release
function, grants it temporary `CREATE` on `public`, transfers ownership of five functions to it,
then revokes both temporary `CREATE` and the migration user's definer membership. PostgreSQL 16+
tracks membership grantors. A restricted login with an operator-granted membership cannot be
assumed to be able to revoke that membership, so the migration intentionally fails closed.

The migrated `pn_migrator` test role is non-superuser and non-BYPASSRLS, but it is a historical
schema/migration role, not an application runtime role. A PostgreSQL 17.10 disposable experiment
confirmed that a merely non-superuser `CREATEROLE` deployer cannot grant the BYPASSRLS definer role.
Granting broad role administration or BYPASSRLS to the application role would be an unsafe response.

## Classification

| Candidate explanation                            | Finding                                                                                                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Incorrect test-harness role                      | Confirmed. The helper sent 0019 to `pn_migrator` despite 0019's documented owner requirement.                                                                            |
| Incorrect repository migration-runner assumption | Not found. The runner applies using its configured deployment connection and journals the actual identity.                                                               |
| Production deployment-role mismatch              | Not established from repository evidence. It remains a mandatory staging/production preflight question.                                                                  |
| Unnecessarily owner-dependent migration          | Not established. The ownership transfer, temporary role membership, RLS boundary, and function ownership are required by the intended immutable credit-lifecycle design. |

No migration SQL was changed.
