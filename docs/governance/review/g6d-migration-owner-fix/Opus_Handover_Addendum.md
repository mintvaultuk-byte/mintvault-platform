# Opus Handover Addendum

## What changed since the lineage audit

The audit's only code-verification blocker was the G6D migration-upgrade test applying 0019 with
the restricted `pn_migrator` role. The repair makes the helper run pre-0019 migrations as that role
and 0019 only as the disposable deployment owner. Migration 0019 itself is unchanged.

## Independent review challenge points

1. Confirm that the production/staging migration job's `MINTVAULT_DATABASE_URL` identity is the
   governed owner/deployer capable of 0019's atomic temporary membership grant/revoke. It must not
   be an application or connector runtime account.
2. Confirm that `partner_credit_lifecycle_definer` is pre-provisioned, where required, as no-login,
   non-superuser, non-`CREATEROLE`, BYPASSRLS, and that it owns only the five G6D definer functions.
3. Confirm a controlled migration window for 0019 DDL locks and an owner-approved historic active
   reservation/destination reconciliation plan.
4. Confirm that any recovery after 0020 follows an owner-approved reverse-order plan rather than
   editing migration files or journal rows.
5. Re-run the frozen Project Control candidate manifest before replay. 0020 remains unchanged and
   has no direct G6D schema dependency, but must follow 0019 in the integrated numbered inventory.

## Evidence supplied

- Reproduced failure and root-cause classification: `Migration_Upgrade_Failure_Root_Cause.md`.
- Governed role model and statement-level privilege rationale: `Database_Role_and_Ownership_Model.md`.
- Focused test result: 84/84 across five G6D-related files; repaired upgrade suite 6/6.
- Fresh PG17.10 + pgvector owner-split chain: 0001–0018 → 0019 → frozen 0020, journal and append-only
  checks passed.

The frozen Project Control candidate was not modified. No commit, push, merge, PR, staging action,
deployment, shared/live database mutation, or feature-flag change occurred.
