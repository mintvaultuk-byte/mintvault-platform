# Database Role and Ownership Model

## Governed roles

| Role / identity                       | Intended authority                                                                                                                                                   | Must not do                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Database/elevated operator            | Provision the no-login BYPASSRLS definer when the managed service requires it; approve controlled DDL.                                                               | Run the application or grant runtime roles broad DDL/ownership.                               |
| Deployment migration owner            | Run `npm run db:migrate -- --apply` for owner-sensitive migrations, including 0019; it must be able to grant and revoke the temporary definer membership atomically. | Be used as the runtime pool identity.                                                         |
| `pn_migrator` (disposable test model) | Owns/apply ordinary pre-0019 Partner migrations. It is non-superuser/non-BYPASSRLS but has legacy schema/migration authority.                                        | Be mistaken for a runtime role or run G6D ownership transfer.                                 |
| `partner_credit_lifecycle_definer`    | `NOLOGIN`, `NOSUPERUSER`, `NOCREATEROLE`, `NOCREATEDB`, `NOREPLICATION`, `BYPASSRLS`; owns exactly the G6D security-definer functions.                               | Login, hold standing schema `CREATE`, or receive wallet/ledger mutation grants.               |
| `partner_connector_runtime`           | Execute the narrow release function only.                                                                                                                            | Directly read/mutate reservations, reservation events, accounting evidence, holds, or schema. |
| `partner_runtime`                     | Normal tenant-scoped Partner application access.                                                                                                                     | Bypass RLS, own definer functions, or perform migrations.                                     |
| CI disposable owner connection        | Model the controlled deployment phase for 0019/0020.                                                                                                                 | Be used to validate against a shared, staging, or live database.                              |

## Repository evidence

- `scripts/db/migrate.ts` applies each transaction-safe migration in `BEGIN`/`COMMIT`, records
  `applied_by = current_user`, and has no code path that substitutes an application role.
- `docs/runbooks/db-migration-safety.md` requires production and staging schema change through
  numbered migrations with owner approval, and already documents the analogous 0006 definer model.
- 0019 lines 376–393 and 622–667 require temporary membership, function ownership transfer, and
  immediate revocation. Its role assertions reject an incorrectly configured definer.
- The disposable journal proof records 0001–0018 as `pn_migrator` and 0019/0020 as `postgres`, the
  local test deployment owner. The release function ends owned by the no-login, non-superuser
  `partner_credit_lifecycle_definer`.

## Owner-sensitive 0019 operations

| Operation                                                      | Requirement and purpose                                                                                   |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Create/reconcile `partner_credit_lifecycle_definer`            | Requires elevated role management when the role is absent; it fails closed if role attributes are unsafe. |
| Create/replace security-definer functions and triggers         | Requires ownership of the affected schema/tables and establishes the hold/immutability controls.          |
| Enable/force RLS and create policy                             | Owner-level schema control protects accounting-exception tenant isolation.                                |
| Grant data access to definer, revoke runtime/PUBLIC access     | Defines the narrow release capability without giving the connector direct accounting access.              |
| Temporary membership and `CREATE` on `public`                  | PostgreSQL requires membership in the target role and schema `CREATE` before function ownership transfer. |
| `ALTER FUNCTION ... OWNER TO partner_credit_lifecycle_definer` | Moves only five functions to the no-login RLS-bypassing definer.                                          |
| Revoke `CREATE` and membership                                 | Removes post-migration schema creation and `SET ROLE` paths before the transaction commits.               |

0019 is transaction-safe (`noTransaction=false`); 0018 is the preceding documented concurrent,
non-transactional migration. The release function uses a pinned `pg_catalog, public, pg_temp`
search path, and both its grants and ownership are revalidated by the focused tests.

## Production/staging validation questions for independent review

1. Which exact identity is supplied to `MINTVAULT_DATABASE_URL` for the migration job, and can it
   complete 0019's grant/revoke sequence on the managed PostgreSQL service?
2. Is the no-login BYPASSRLS definer pre-provisioned with exactly the required attributes, and is
   the provisioning/audit path approved?
3. Does the deployment execution record preserve the runner journal and `applied_by` identity?
4. Has a maintenance window been approved for 0019's ordinary DDL locks and has historic active
   reservation/destination reconciliation been completed?
