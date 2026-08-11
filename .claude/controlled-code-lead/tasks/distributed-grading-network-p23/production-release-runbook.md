# Production release runbook — signed-station scanner + Partner runtime bootstrap

Date: 2026-08-11 · Branch `psp/partner-rbac-hybrid`

**This runbook is NOT executed.** It is blocked at Step 1 on an access dependency
(below). Everything downstream is written, ordered and pre-validated so it can be
run in one sitting once Step 1 is unblocked.

## Verified current production state (read-only, this session)

| Fact | Value | How verified |
| --- | --- | --- |
| Live Fly release | **v1067** | `fly releases --app mintvault` |
| Live commit | **6f182624** | `GET https://mintvaultuk.com/api/version` |
| Health | 200 | `GET /health` |
| `/api/partner/me` | **404** | signed-station surface absent from prod |
| `/api/partner/stations/enrolment-locations` | **404** | the route that 503'd as v1066 is not present at all |
| `PARTNER_DATABASE_URL` | **absent** | `fly secrets list` (names only) |
| `PARTNER_MFA_ENC_KEY` | **absent** | `fly secrets list` (names only) |

**Correction to the brief:** production is on **v1067**, not v1065. The rollback
was performed by redeploying the previous image as a *new* release. The correct
rollback target for this deployment is therefore **v1067 / commit 6f182624** —
rolling back to "v1065" would be wrong.

## THE BLOCKER — why Step 1 cannot run in this session

Creating the restricted Partner runtime LOGIN requires either the **Neon console**
or a **production database credential with `CREATE ROLE`**. This session has
neither:

- Local `.env` `MINTVAULT_DATABASE_URL` → **staging** (`ep-purple-voice`), not production.
- Production `MINTVAULT_DATABASE_URL` exists **only as a Fly secret**, and Fly
  never returns secret values (`fly secrets list` shows name + digest only).
- No `NEON_API_KEY` / `NEON_API_TOKEN` in the environment, repo or Fly secrets;
  no `neonctl` installed.

This is an owner-physical action: it needs the Neon console. It is not something
that can be worked around, and it must not be worked around by reusing
`neondb_owner` — that credential is `BYPASSRLS` and would silently defeat every
tenant boundary in the Partner runtime.

## Step 1 — Restricted Partner runtime LOGIN (OWNER, in Neon console)

Run against production `neondb`. **Do not create a second database.**

```sql
CREATE ROLE partner_runtime_app WITH LOGIN PASSWORD '<generate 32+ random chars>'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
GRANT partner_runtime TO partner_runtime_app;
```

Then verify — all three must hold:

```sql
SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolcanlogin
  FROM pg_roles WHERE rolname = 'partner_runtime_app';
-- expect: super=f bypassrls=f createrole=f createdb=f replication=f canlogin=t

SELECT pg_has_role('partner_runtime_app', 'partner_runtime', 'member');  -- expect t

-- RLS actually applies to this role (the whole point):
SET ROLE partner_runtime_app;
SELECT count(*) FROM partner_organisations;   -- expect 0 rows with no app.tenant_id set
RESET ROLE;
```

The connection URL must point at the **same** `neondb` (direct or `-pooler`
hostname; `server/partner/db.ts` normalises the `-pooler` label and asserts
same-database topology at startup).

## Step 2 — Generate the MFA key (OWNER or Lead)

`server/partner/mfa.ts` decodes **exactly 32 bytes** (64 hex chars, or base64
decoding to 32 bytes), AES-256-GCM for TOTP secrets and HMAC-SHA-256 for
recovery-code hashes.

```bash
openssl rand -hex 32
```

Production currently has **zero** Partner MFA and recovery-code rows, so there is
no ciphertext-compatibility burden *before first use*. After the first enrolment
there is — see the rotation note at the end.

## Step 3 — Set the two secrets (single restart)

```bash
fly secrets set --app mintvault \
  PARTNER_DATABASE_URL='<step 1 URL>' \
  PARTNER_MFA_ENC_KEY='<step 2 hex>'
```

Setting both in one command avoids a window where the mount has a DB URL but no
MFA key (which returns 503 by design).

## Step 4 — Pre-flight the RBAC seed (READ-ONLY, against production)

All five are `SELECT`s. Do not proceed if any fails its expectation.

```sql
-- (a) 0001 is applied, and what else the runner would consider pending
SELECT filename, status FROM schema_migrations ORDER BY filename;
-- (b) catalogue currently empty (stated premise)
SELECT (SELECT count(*) FROM partner_roles), (SELECT count(*) FROM partner_permissions),
       (SELECT count(*) FROM partner_role_permissions);          -- expect 0 / 0 / 0
-- (c) label conflicts that would abort 0034 — expect 0 rows
SELECT code, label FROM partner_roles
 WHERE code IN ('PARTNER_OWNER','PARTNER_MANAGER','MVGS_ASSESSMENT_TECHNICIAN',
                'PARTNER_RECEPTION','PARTNER_FINANCE_VIEWER','PARTNER_TRAINEE')
   AND (code,label) NOT IN (('PARTNER_OWNER','Partner Owner'),('PARTNER_MANAGER','Partner Manager'),
        ('MVGS_ASSESSMENT_TECHNICIAN','MVGS Assessment Technician'),('PARTNER_RECEPTION','Reception'),
        ('PARTNER_FINANCE_VIEWER','Finance Viewer'),('PARTNER_TRAINEE','Trainee'))
UNION ALL SELECT code, label FROM partner_permissions WHERE label <> code;
-- (d) pre-existing over-grant mappings — expect 0 rows
SELECT r.code, p.code FROM partner_role_permissions rp
  JOIN partner_roles r ON r.id=rp.role_id JOIN partner_permissions p ON p.id=rp.permission_id;
-- (e) TEMP privilege (0034 uses ON COMMIT DROP temp tables)
SELECT has_database_privilege(current_user, current_database(), 'TEMP');   -- expect t
```

## Step 5 — Apply 0034 (MIGRATION, owner-gated)

⚠️ **The migration runner has no single-file selector — `--apply` applies EVERY
pending migration.** Dry-run first and read the output carefully:

```bash
MINTVAULT_DATABASE_URL='<prod>' npm run db:migrate
```

**Proceed only if the pending list is exactly `0034_partner_rbac_seed.sql` and
nothing else.** If other files appear, STOP — the owner's authorisation does not
cover them.

```bash
MINTVAULT_DATABASE_URL='<prod>' npm run db:migrate -- --apply
```

⚠️ **Never `psql -f` this file.** It has no `BEGIN` (the runner supplies the
transaction) and its temp tables are `ON COMMIT DROP`. Under psql autocommit
every subsequent statement errors and **psql still exits 0** — a false green that
writes nothing. Verified on a disposable cluster: exit 0, 0 roles / 0 perms / 0 maps.

Verify by **row count, never by exit code**:

```sql
SELECT (SELECT count(*) FROM partner_roles), (SELECT count(*) FROM partner_permissions),
       (SELECT count(*) FROM partner_role_permissions);          -- expect 6 / 20 / 70
```

**Rollback window:** `rollback-0034-partner-rbac-seed.sql` is fail-closed and
refuses once any `partner_user_roles` row exists. The practical window closes at
the first operator role assignment (Step 7).

## Step 6 — Deploy the candidate

Capture the rollback target first (**v1067**), then deploy via the repo's
anti-clobber wrapper rather than raw `fly deploy`:

```bash
scripts/safe-deploy.sh prod
```

Post-deploy health gate — all must pass before any card is touched:

```bash
curl -s https://mintvaultuk.com/api/version      # expect the candidate SHA
curl -s -o /dev/null -w '%{http_code}\n' https://mintvaultuk.com/health
curl -s -o /dev/null -w '%{http_code}\n' https://mintvaultuk.com/api/partner/stations/enrolment-locations
# must NOT be 503 — 503 means PARTNER_DATABASE_URL/PARTNER_MFA_ENC_KEY did not take effect
```

**Rollback if red:** `fly deploy --image <v1067 image>` (application only).
Do **not** drop 0045/0046/0047 or the 0034 catalogue as a rollback — they are
additive and intentionally retained. Certificate identities already committed are
never rolled back; anything stateful is forward-fix only.

## Step 7 — Minimum bootstrap (one HQ location, one operator, one station)

1. One internal/HQ Partner location (reuse if one exists — do not duplicate).
2. One operator with **`MVGS_ASSESSMENT_TECHNICIAN`** — the least-privileged role
   carrying `partner.cards.scan`. Audited: it holds 10 permissions and has **no**
   credit visibility, **no** `partner.orders.submit` (the credit-consuming gate),
   **no** user administration and **no** session revocation. Do not grant
   `PARTNER_OWNER` merely to scan.
3. MFA enrolment through the real flow (test success, bad OTP, and the recovery path).
4. Enrol this Mac as a signed station; Super Admin approves; secret in Keychain.
5. Flags: `partner_portal_enabled=true`, `partner_login_enabled=true`; confirm
   `partner_emergency_stop` remains false/absent. Enable nothing else.

## Step 8 — Physical canary

Blocked independently of everything above: **the Canon LiDE 400 is not connected
to this Mac** (no USB match in `system_profiler SPUSBDataType`, no device in
`/Library/Image Capture/Devices/`). The canary needs the owner to connect the
scanner and place a real card.

At canary time, re-read the counter and use whatever number is naturally next —
do **not** force MV837:

```sql
SELECT last_issued FROM cert_counter WHERE id = 1;
```

Last read (this session, via the prior pass's read-only reconciliation):
`last_issued = 836`. That is a **stale snapshot**, not a reservation — another
legitimate issuance may consume 837 first, and that is correct behaviour.

## MFA key rotation design (§43)

Required before the *second* key ever exists, not before the first:

1. Store keys as a versioned keyring, not a single value
   (`PARTNER_MFA_ENC_KEY_V1`, `_V2`), with an explicit "current" pointer.
2. Ciphertext already carries a version tag — `v1:<iv>:<tag>:<ciphertext>` — so
   decrypt selects the key by tag; only encryption uses "current".
3. Recovery-code HMACs are **not** reversible: rotation requires reissuing
   recovery codes per user, not re-hashing. Plan the user-facing reissue.
4. Re-encrypt TOTP secrets in a background pass, then retire the old key only
   once zero `v<old>:` ciphertexts remain.
5. Never remove an old key while any ciphertext still references it — that is an
   unrecoverable lockout of every enrolled operator.
