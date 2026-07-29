# Disposable DB Role Verification

## Environment

- PostgreSQL `17.10 (Homebrew)` using a fresh temporary loopback cluster.
- `CREATE EXTENSION IF NOT EXISTS vector` succeeded.
- No configured application, shared, staging, or production database was opened.
- The test cluster and its data directory were stopped and removed by the disposable helper.

## Focused suite

```sh
npx vitest run \
  tests/partner-g6d-migration-upgrade.test.ts \
  tests/partner-submission-credit-lifecycle.test.ts \
  tests/partner-schema-parity.test.ts \
  tests/partner-credit-reservation-service.test.ts \
  tests/partner-credit-admin-service.test.ts
```

Result: **5 files passed, 84 tests passed.** This includes the repaired upgrade suite (6 tests),
the G6D lifecycle evidence, schema parity, G6B reserve/consume/release evidence, and G6C credit
admin race/immutability evidence.

## Owner-operated combined migration chain

```sh
MINTVAULT_PROJECT_CONTROL_CANDIDATE=/Users/cornelius/mintvault-project-control-reviewed-candidate \
  npx tsx scripts/audit/run-g6d-project-control-owner-verification.ts
```

Result:

```text
APPLIED_0001_0018=0001_partner_foundation.sql ... 0018_correction_audit_index.sql
POSTGRES=17.10 (Homebrew)
PGVECTOR=installed
APPLIED_0019=0027_partner_submission_credit_lifecycle.sql
APPLIED_0020=0020_project_control_dashboard.sql
JOURNAL=0001–0018 applied_by pn_migrator; 0019 and 0020 applied_by postgres
DEFINER_OWNER=partner_credit_lifecycle_definer, bypassrls=true, canlogin=false, superuser=false
RUNTIME_BOUNDARY=direct_reservation_update=false, narrow_release_execute=true, runtime_schema_create=false
G6D_APPEND_ONLY=enforced
PROJECT_CONTROL_APPEND_ONLY=enforced
```

`postgres` above is the local disposable cluster's deployment-owner connection. It is not a claim
about the identity configured in staging or production.

## Additional static verification

```sh
npm run check
npx eslint tests/helpers/partner-realistic-db.ts \
  tests/partner-g6d-migration-upgrade.test.ts \
  scripts/audit/run-g6d-project-control-owner-verification.ts
npm run db:lint-sql -- migrations/0027_partner_submission_credit_lifecycle.sql \
  /Users/cornelius/mintvault-project-control-reviewed-candidate/migrations/0020_project_control_dashboard.sql
```

All commands passed. The SQL linter reported no obvious destructive operations; it remains a regex
heuristic rather than a full PostgreSQL proof.
