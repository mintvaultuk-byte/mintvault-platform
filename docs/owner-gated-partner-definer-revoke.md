# 🚨 OWNER-GATED DATABASE ACTION — revoke `partner_definer` from the migration login

> **THIS IS AN OWNER-GATED DATABASE ACTION.**
>
> - It **MUST NOT be executed on production.**
> - It may be executed on **staging only after explicit, per-execution owner approval.**
> - It requires a role the migration login does not have, so nobody can run it by accident and no
>   migration can run it silently.
> - Everything in this document was proved on a **disposable PostgreSQL 17 cluster** created and
>   destroyed by `scripts/db/partner-definer-revoke-proof.ts`. It has been executed **nowhere else**.

**Status:** proposed, unapproved, unexecuted.
**Branch:** `rep/lock-safety`.
**Severity:** high on a cluster where the migration login is `NOBYPASSRLS`; **no impact on Neon** —
see §7.

---

## 1. What is wrong

`migrations/0006_partner_definer_role.sql`, step 3:

```sql
DO $$
BEGIN
  BEGIN
    EXECUTE format('GRANT partner_definer TO %I', current_user);
  EXCEPTION WHEN insufficient_privilege OR duplicate_object THEN
    NULL;
  END;
END$$;
```

The membership is granted so the migration can `ALTER FUNCTION … OWNER TO partner_definer` — a
legitimate, transient need. It is **never revoked**.

`partner_definer` is `BYPASSRLS`. So the migration login retains a permanent, standing ability to
`SET ROLE partner_definer` and read **every tenant's data**, with row-level security switched off,
for as long as that membership exists.

The newer, hostile-reviewed `0041_partner_submission_credit_lifecycle.sql` (lines ~657 and ~662)
does exactly the right thing for its own definer role — it revokes the membership _and_ the ADMIN
option, then asserts the migrator can no longer reach it. **0006 is the outlier.**

---

## 2. BEFORE proof (disposable cluster)

Realistic role model: non-superuser, `NOBYPASSRLS` `pn_migrator` owning the schema, all partner
migrations applied through 0050, two tenants seeded.

```
========== BEFORE ==========
membership rows for pn_migrator on partner_definer:
  {"grantor":"postgres","admin_option":false,"inherit_option":true,"set_option":true}
capability: {"set":true,"usage":true}
bypassrls of partner_definer: true
cross-tenant read as pn_migrator: SET ROLE SUCCEEDED — read 2 partner_users row(s) with NO tenant
context; sample email=tenant-a@example.test
```

Two tenants exist. The migration login escalated into the `BYPASSRLS` definer and read **both** of
them, with no tenant context set. That is the whole tenant-isolation model bypassed by a login that
only needed the role for a one-off ownership transfer six migrations ago.

---

## 3. Why a migration CANNOT fix this

The membership's **grantor** is the elevated/provider role, not the migrator. PostgreSQL only lets
the grantor (or a role with ADMIN option) revoke it. Executed as `pn_migrator`:

```
========== WHY A MIGRATION CANNOT FIX THIS ==========
  as pn_migrator: "REVOKE partner_definer FROM pn_migrator"
      -> 42501 permission denied to revoke role "partner_definer"
  as pn_migrator: "REVOKE ADMIN OPTION FOR partner_definer FROM pn_migrator"
      -> 42501 permission denied to revoke role "partner_definer"
  capability after the migrator's own attempt: {"set":true,"usage":true}
  cross-tenant read still possible: SET ROLE SUCCEEDED — read 2 partner_users row(s) ...
```

And the grantor can **never** be the migrator, because a `NOBYPASSRLS` role is structurally
incapable of creating a `BYPASSRLS` role — so `partner_definer` is always provisioned by an elevated
role, which is therefore always the grantor:

```
ERROR:  permission denied to create role
DETAIL:  Only roles with the BYPASSRLS attribute may create roles with the BYPASSRLS attribute.
```

0006's own header says the same thing in prose: _"provision it once with an elevated role … then
re-apply 0006."_

**A migration that tried this and swallowed the error would be journalled as `applied` while the
hole stayed wide open** — which is precisely the anti-pattern the repo's pre-flight guards exist to
prevent, and precisely how 0006 got here (its `EXCEPTION WHEN insufficient_privilege THEN NULL`).
This is therefore written down as an owner-gated operator action, **not** as migration 0052.

---

## 4. The action

**Required executing role:** the **grantor** of the membership row — the elevated / provider-owner
role (on the disposable proof cluster, `postgres`). Not the migration login. Confirm it first:

```sql
-- Run as any role. Read-only. Tells you WHO must execute the revoke.
SELECT g.rolname   AS must_execute_as,
       m.admin_option, m.inherit_option, m.set_option
  FROM pg_auth_members m
  JOIN pg_roles role   ON role.oid   = m.roleid
  JOIN pg_roles member ON member.oid = m.member
  JOIN pg_roles g      ON g.oid      = m.grantor
 WHERE role.rolname = 'partner_definer'
   AND member.rolname = '<the migration login>';
```

If that returns **no rows**, there is nothing to do — stop.

**The exact SQL** (run as the grantor identified above; substitute the real migration login for
`<migration_login>`):

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';

-- 1. Remove the administration option first. PostgreSQL 16+ can leave an ADMIN-only row behind
--    after a plain REVOKE; 0041 removes both for its own definer and this mirrors that.
--    Harmless and idempotent when admin_option is already false.
REVOKE ADMIN OPTION FOR partner_definer FROM <migration_login>;

-- 2. Remove the membership itself (this is what removes SET ROLE and inherited use).
REVOKE partner_definer FROM <migration_login>;

-- 3. Fail closed: refuse to commit unless the capability is actually gone.
DO $$
BEGIN
  IF pg_has_role('<migration_login>', 'partner_definer', 'set')
     OR pg_has_role('<migration_login>', 'partner_definer', 'usage') THEN
    RAISE EXCEPTION
      'REFUSING TO COMMIT: <migration_login> can still use partner_definer (set=% usage=%)',
      pg_has_role('<migration_login>', 'partner_definer', 'set'),
      pg_has_role('<migration_login>', 'partner_definer', 'usage');
  END IF;
END$$;

COMMIT;
```

The assertion in step 3 matters: if the executing role is not really the grantor, PostgreSQL raises
`42501` at step 1 or 2 and the transaction aborts. If the revoke were ever to _silently_ not take
effect, step 3 aborts the transaction rather than reporting a false success.

The `SET LOCAL lock_timeout` is consistent with the migration lock-safety policy
(`docs/partner-migration-lock-safety.md`); role revocation takes no table locks, so it should never
fire.

---

## 5. AFTER proof (same disposable cluster)

```
========== THE OWNER-GATED ACTION (executed as the GRANTOR) ==========
  as grantor: "REVOKE ADMIN OPTION FOR partner_definer FROM pn_migrator" -> OK
  as grantor: "REVOKE partner_definer FROM pn_migrator" -> OK

========== AFTER ==========
membership rows: (none)
capability: {"set":false,"usage":false}
cross-tenant read as pn_migrator: blocked: permission denied to set role "partner_definer"
```

Regression check — the pre-auth `SECURITY DEFINER` path is untouched:

```
========== REGRESSION: the partner runtime still works ==========
  partner_auth_lookup owner = partner_definer (unchanged by the revoke)
  partner_session_lookup owner = partner_definer (unchanged by the revoke)
  partner_reset_token_tenant owner = partner_definer (unchanged by the revoke)
  partner_auth_lookup as partner_runtime -> 1 row(s) (SECURITY DEFINER path intact)
```

Function ownership is unaffected — the revoke removes the _migrator's membership_, not the definer
role or anything it owns. Partner login continues to work.

### The one real consequence to plan for

After the revoke, the migration login is **no longer an owner** of
`partner_auth_lookup` / `partner_session_lookup` / `partner_reset_token_tenant` and can no longer
`CREATE OR REPLACE` or `ALTER` them. Observed directly during the proof: the migrator got
`42501 permission denied for function partner_auth_lookup`.

This is the same operational deadlock 0041 hit and solved. **Consequence:** any _future_ migration
that needs to maintain those three functions will fail closed until the owner re-grants
membership — the same shape as the 0041 role repair, and a controlled failure rather than a silent
one. Before approving, confirm no pending migration in the release touches those three functions.
At the time of writing, 0047–0051 do not.

---

## 6. Rollback

Re-grant, as the same grantor:

```sql
GRANT partner_definer TO <migration_login>;
```

Proved on the disposable cluster:

```
========== ROLLBACK (re-grant, as the grantor) ==========
  re-granted; capability: {"set":true,"usage":true}
  cross-tenant read restored: SET ROLE SUCCEEDED — read 2 partner_users row(s) ...
```

Fully reversible in one statement, with no downtime and no data change. Note that rolling back
**restores the hole** — it is an incident lever, not a resting state.

---

## 7. Applicability — read this before scheduling anything

**No impact on Neon.** On Neon the migration role is _already_ `BYPASSRLS`, so revoking
`partner_definer` removes nothing it does not already have by attribute. The action would be
**cosmetic there and would not close anything.** Both MintVault databases (staging
`ep-purple-voice`, production `ep-wispy-morning`) are Neon.

So this document is:

- **a hardening prerequisite** for any move to a cluster where the migration role is
  `NOBYPASSRLS` (self-managed PostgreSQL, or a provider that permits a least-privileged migration
  role), and
- **a correction to 0006's shape** — the grant should never have been left standing, and 0041 shows
  the house style.

Before this is scheduled at all, confirm the current attribute (read-only, safe to run anywhere):

```sql
SELECT current_user,
       (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS migration_login_bypassrls;
```

If that returns `true`, **the action is pointless on that database** — the correct fix is at the
provider role level, which is a different, larger decision. Do not run it just to tick a box.

---

## 8. Deployment timing guidance

1. **Do not bundle this with the 0047–0051 staging run.** It is a role change, not a schema change;
   mixing them means a single failure has two candidate causes.
2. Run the §7 applicability check first. On Neon, expect `true` and **stop**.
3. If it does apply: run it **after** the migration batch has been applied and verified, never
   before — a migration that still needs to transfer function ownership would fail closed.
4. Quiet window: **not required.** No table locks, no schema change, no downtime. It takes
   milliseconds.
5. Immediately afterwards, re-run the BEFORE queries in §2 as verification, plus one real partner
   login against staging.
6. Keep the §6 re-grant to hand for the duration of the release.
7. **Production: not authorised by this document under any circumstances.** A separate, explicitly
   approved change is required, and only after staging has run clean for a full release cycle.

---

## 9. Reproducing the proofs

```bash
LC_ALL=C LANG=C npx tsx scripts/db/partner-definer-revoke-proof.ts
```

Creates its own disposable PostgreSQL 17 container, applies the real partner migrations as a real
non-superuser migrator, runs BEFORE / attempted-self-revoke / action / AFTER / regression /
rollback, and destroys the container. It touches no shared cluster, no staging and no production.
