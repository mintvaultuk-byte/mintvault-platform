# STAGING ROLE REPAIR — owner write gate

**Status: NOT EXECUTED.** Awaiting the owner's explicit go-ahead. Staging only. Production not
contacted and not in scope.

## The exact statement (CORRECTED — see the warning below)

```sql
GRANT partner_credit_lifecycle_definer TO neondb_owner WITH INHERIT TRUE, SET FALSE;
```

That is the whole repair. One statement.

## ⚠️ CORRECTION to the previous version of this document

The earlier draft proposed `... WITH INHERIT TRUE;` and asserted that SET ROLE would not become
possible. **That was wrong.** PostgreSQL 16+ defaults a role grant to `SET TRUE` when the WITH
clause does not say otherwise, so the earlier statement would have granted SET ROLE into the
lifecycle definer — the exact privilege this repair is supposed to withhold.

This was caught by the new non-superuser harness, not by review: the test
`REPAIR PROOF: the owner-approved GRANT (INHERIT only) restores maintenance without SET ROLE`
executed the proposed statement and then found `SET ROLE partner_credit_lifecycle_definer`
**succeeded**. `SET FALSE` is therefore load-bearing and explicit.

That is also the clearest possible evidence that the harness repair was worth doing: the first
defect it caught was in the remediation itself, before it reached staging.

## Why this and not the broader form

The reviewer panel proposed `WITH SET TRUE, INHERIT TRUE`. **SET is neither necessary nor
granted.** PostgreSQL's ownership check for `CREATE OR REPLACE FUNCTION` and `DROP FUNCTION` is
`object_ownercheck` → `has_privs_of_role`, which is the **INHERIT** form
(`pg_has_role(..., 'usage')`), not the SET form. `INHERIT TRUE` alone restores both operations.

Consequence, now proven rather than asserted: **SET ROLE does NOT become possible.** The
harness executes this exact statement and then asserts `SET ROLE` still fails with `42501`.

## Verified current state (read-only, staging, 2026-08-03)

`pg_auth_members` for `partner_credit_lifecycle_definer` — exactly one row:

| member | grantor | admin_option | inherit_option | set_option | is_database_owner |
|---|---|---|---|---|---|
| `neondb_owner` | `cloud_admin` | **true** | false | false | **true** |

`neondb_owner`: `rolsuper=false`, `rolcreaterole=true`, `rolbypassrls=true`.
`pg_has_role(neondb_owner, partner_credit_lifecycle_definer, 'usage') = **false**`.
All five lifecycle functions owned by `partner_credit_lifecycle_definer`.

**Why the GRANT is permitted without a superuser:** `neondb_owner` already holds `admin_option`
on the role (provider-granted by `cloud_admin`), and ADMIN OPTION is precisely the right to grant
that role onward — including to itself. No superuser is involved or required. Neon exposes none.

## Why it does not elevate partner runtime access

The grant names `neondb_owner` only. It changes nothing for `partner_runtime`,
`partner_connector_runtime`, `partner_app_staging` or `partner_connector_staging` — none of them
is a member of the lifecycle definer, and none gains any privilege from this statement.

`neondb_owner` gains nothing it did not already have in substance: it is already `BYPASSRLS`, is
already the database owner, and already owns every table the definer can touch. The definer's
entire grant set is `SELECT` on connector/submission tables plus column-scoped `UPDATE` on
`partner_credit_reservations` and `INSERT` on `partner_credit_reservation_events` — all of which
`neondb_owner` can already do as table owner. **The repair restores a maintenance capability, not
a data capability.**

## Post-repair guard policy (already implemented, already verified)

`server/partner/definer-guard.ts` has been changed from a row-based check to a **capability-based**
one, so migration-time and runtime rules are now the same rule:

- ADMIN-option-only rows → tolerated (this is what BLOCKER 2 was: the provider row the migration
  explicitly tolerates but the guard treated as fatal, causing HTTP 409 on every settlement).
- The **database owner** holding SET/INHERIT → tolerated (required for this repair).
- **Any other role** holding SET or INHERIT → violation.

Verified against live staging and by simulation:

| State | Verdict |
|---|---|
| Staging today (ADMIN-only row) | **PASS** (old policy: VIOLATION) |
| After this repair (owner + INHERIT) | **PASS** |
| `partner_runtime` granted SET | **VIOLATION** ✅ |

So the repair does not require any further guard change, and it cannot be used to smuggle a
runtime role into the definer without the guard firing.

## What it unblocks

- `CREATE OR REPLACE FUNCTION` → migration 0041 becomes re-runnable (it currently fails at
  line 166, before reaching anything else).
- `DROP FUNCTION` → `rollback-partner-submission-credit-lifecycle.sql` becomes executable (it
  currently fails at line 62).
- Any future migration that must replace a lifecycle function — including the 0042 required to
  make the SQL release function per-card aware.

Migration 0041 itself is **not renamed, edited or replaced**; its checksum ratchet on staging
stays intact.

## Exact pre-state query (run before)

```sql
SELECT m.admin_option, m.inherit_option, m.set_option, g.rolname AS grantor
  FROM pg_auth_members m
  JOIN pg_roles r ON r.oid = m.roleid
  JOIN pg_roles mem ON mem.oid = m.member
  JOIN pg_roles g ON g.oid = m.grantor
 WHERE r.rolname = 'partner_credit_lifecycle_definer' AND mem.rolname = 'neondb_owner';
```
Expected: one row — `admin_option=t, inherit_option=f, set_option=f, grantor=cloud_admin`.
Guard result before: **PASS** (verified against live staging).

## Exact post-state query (run after)

Same query. Expected: an additional row with `inherit_option=t, set_option=f,
grantor=neondb_owner`. Then confirm SET ROLE is still refused:

```sql
SET ROLE partner_credit_lifecycle_definer;  -- must fail with 42501
```
Guard result after: **PASS** (proven in the harness by the REPAIR PROOF test).

## Rollback / revocation

```sql
REVOKE INHERIT OPTION FOR partner_credit_lifecycle_definer FROM neondb_owner;
```

Returns the membership to exactly the ADMIN-option-only state observed today. The provider row
itself cannot be removed by `neondb_owner` and is not affected. Note that revoking re-bricks
re-apply and rollback, so it should be run only after the migration work is finished — and the
guard tolerates both states, so no code change is needed either way.

## Audit

`GRANT`/`REVOKE` are DDL and are captured by the Neon audit trail with `neondb_owner` as actor.
Record the approval in `.claude/controlled-code-lead/approvals/`. Staging only — the equivalent
production decision must be taken separately, after re-running the read-only probes there, since
the whole failure mode depends on a per-project provider artefact.

## Outstanding before this is worth executing

The statement is safe to run now, but its *purpose* is to let 0042 land. 0042 does not exist yet
(see the repair status report) — so executing the grant early buys nothing except an
immediately-testable rollback path. Owner's call on sequencing.

## Required test (not yet written)

A harness test that provisions a **non-superuser, CREATEROLE** migration principal mirroring the
Neon shape, applies 0041, asserts the provider-style ADMIN row survives, asserts the guard passes,
applies 0041 a **second** time, and runs the rollback happy path. Today the harness applies 0041
as `postgres` (superuser) at `tests/helpers/partner-realistic-db.ts:195`, which is exactly why
BLOCKER 2 and the re-apply/rollback deadlock both shipped undetected.
