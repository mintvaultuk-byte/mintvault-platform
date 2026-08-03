# CORRECTED STAGING CHECKLIST — Partner tables in the existing staging MintVault database

**Status:** PREPARED — NOTHING EXECUTED. No role created, no migration run, no secret set, no deploy, no flag, no email.
**Topology:** Option A (owner-approved, STAGING ONLY). Production topology explicitly NOT approved and out of scope.
**Target commit:** `7630bf19` · **Staging app:** `mintvault-v2` (currently `6b30136f`) · **Staging origin:** `https://mintvault-v2.fly.dev` (approved, not yet applied)

---

## 1. Two structural findings that change the shape of this work

### F-A — The migration runner cannot select a "Partner-only chain". It does not need to.
`scripts/db/migrate.ts` selects files with `FILE_RE = /^(\d{4,})_.+\.sql$/` — **every** numbered migration, core and Partner alike — and connects to **`process.env.MINTVAULT_DATABASE_URL`**. There is no Partner filter, no `--only` flag.

This is safe *because* the runner skips files already recorded in `schema_migrations`, not because it can be pointed at a subset. The consequence is a hard precondition rather than a code change:

> **Before any apply, the journal must be verified to already contain every core migration.** If a core migration is missing from the journal, the run would apply it as a side effect. That is the stop condition, and it is why step 5 below is non-negotiable.

**No remediation package is proposed.** Adding a selection flag would be a change to the migration runner — the single most safety-critical script in the repo — to solve a problem the journal check already solves.

### F-B — The Partner migrations are, per the governance record, ALREADY APPLIED to staging.
`tasks/partner-user-management-hostile-review/deployment-state.md` records staging going from 24 → **26 journalled** on 2026-07-29, with `0031` and `0032` applied and object-level verified (`partner_invitations` present, RLS enabled **and forced**, three constraint triggers, `partner_runtime` granted SELECT/INSERT/UPDATE and no PUBLIC grant). Migrations `0001`–`0017` were applied to both databases earlier in the programme.

**If confirmed live, steps 6–8 below are largely no-ops** and the real work is role verification, secrets, deploy and fail-closed proof. This is documentary evidence, not live proof — see §2.

---

## 2. Verified staging database identity — **I CANNOT VERIFY THIS FROM HERE**

**Blocking gap.** The local `.env` `MINTVAULT_DATABASE_URL` is **malformed and unusable** (parses to no host, no port, no database; a connection attempt falls through to a default and fails). I therefore have **no live staging database access** from this workstation and cannot execute steps 1–2 of the corrected sequence.

| Item | Status |
|---|---|
| Neon project / branch / endpoint | **UNVERIFIED** — must be read at execution time |
| Database name | UNVERIFIED (expected `neondb`) |
| PostgreSQL version | UNVERIFIED (expected 17) |
| Region | UNVERIFIED |
| Direct + pooled endpoints | UNVERIFIED |
| Separation from production compute | **Documented** — staging `ep-purple-voice-*`, production `ep-wispy-morning-*`; different Neon computes. **Must be re-proved live at execution time.** |

**Owner action required:** supply a working staging `MINTVAULT_DATABASE_URL` (or run the §3 preflight yourself and return the non-secret output). Everything below is derived from the merged migrations and runtime code, which I *can* read exactly — but the live state must be confirmed before anything is applied.

**Identity proof to run (read-only, inside `BEGIN TRANSACTION READ ONLY`):**
```sql
SELECT current_database(), split_part(version(),' ',2) AS pg_version,
       inet_server_addr() AS server_ip, inet_server_port() AS port;
-- Prove NOT production: the endpoint host must contain the staging endpoint id,
-- and must NOT match the production endpoint id. Compare host prefixes only; never paste the URL.
```

---

## 3. Core prerequisite inventory (read-only preflight)

```sql
BEGIN TRANSACTION READ ONLY;

-- 3.1 Core tables the Partner chain depends on (0010 GRANTs on these; apply FAILS without them)
SELECT table_name FROM information_schema.tables
 WHERE table_schema='public' AND table_name IN ('users','submissions','submission_items')
 ORDER BY table_name;                         -- EXPECT exactly 3 rows

-- 3.2 Sequences 0010 grants USAGE on
SELECT sequence_name FROM information_schema.sequences
 WHERE sequence_schema='public'
   AND sequence_name IN ('submissions_id_seq','submission_items_id_seq');   -- EXPECT 2 rows

-- 3.3 Journal — the F-A safety gate
SELECT filename FROM schema_migrations ORDER BY filename;                    -- EXPECT 26 rows

-- 3.4 Partner objects already present?
SELECT count(*) FROM information_schema.tables
 WHERE table_schema='public' AND table_name LIKE 'partner\_%';

-- 3.5 Roles
SELECT rolname, rolcanlogin, rolbypassrls, rolsuper, rolinherit
  FROM pg_roles WHERE rolname LIKE 'partner%' ORDER BY rolname;

-- 3.6 Flag rows (expect ZERO — fail-closed)
SELECT count(*) FROM partner_feature_flags;

-- 3.7 Definer function ownership (portal 503s if wrong)
SELECT p.proname, r.rolname AS owner, p.prosecdef
  FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
 WHERE p.proname IN ('partner_auth_lookup','partner_session_lookup','partner_reset_token_tenant');

ROLLBACK;
```

**STOP conditions**
- 3.1 returns fewer than 3 rows → **STOP.** Migration 0010 cannot apply. Wrong database.
- 3.2 returns fewer than 2 rows → **STOP.** Same reason.
- 3.3 is missing **any core** migration → **STOP.** A run would apply core migrations as a side effect (F-A).
- 3.6 returns > 0 → **STOP and report.** Flags must be absent; a stray row could open a surface on deploy.
- 3.7 shows an owner other than `partner_definer` for any of the three, or `prosecdef=false` → **STOP.** The portal's definer-health gate will 503 and the cause must be understood first.

---

## 4. Exact role matrix (derived from migrations 0001, 0006, 0008, 0010)

### 4.1 The critical structural fact
`partner_runtime` (0001:16) and `partner_connector_runtime` (0008:23) are created by the migrations as **NOLOGIN group roles**. 0001's own comment is explicit: *"NOLOGIN group role; the partner app's login role is GRANTed this role in infra (owner-provisioned, not here)."*

**Therefore the migrations do NOT create anything the application can log in as.** The provisioning work is creating **LOGIN roles** and granting them membership in the group roles. This is the single most misunderstood part of this setup.

### 4.2 Group roles — created BY migrations, do not create manually

| Role | Created by | LOGIN | BYPASSRLS | INHERIT | Other attrs | Privileges (exact) |
|---|---|---|---|---|---|---|
| `partner_runtime` | 0001 | **NO** | **NO** (0006:66 raises if not) | default | NOSUPERUSER | `USAGE ON SCHEMA public`; `SELECT` on the three RBAC reference tables; per-table `SELECT,INSERT` / `SELECT` / `SELECT,INSERT,UPDATE,DELETE` per 0001:262-269; **no sequence grants** (0001:273 — Partner PKs are `gen_random_uuid()`; a blanket sequence grant would wrongly expose core sequences) |
| `partner_connector_runtime` | 0008 | **NO** | **NO** (0008:35 raises if not) | default | NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION | `USAGE ON SCHEMA public`; `SELECT,INSERT,UPDATE` on `partner_connector_records` (no DELETE); `SELECT,INSERT` on `partner_connector_events` (append-only); `SELECT` on `partner_submission_handoffs`, `partner_submissions`; `SELECT,INSERT` on `partner_connector_customer_links`, `partner_connector_imports`; **column-scoped** `UPDATE (state, destination_submission_id, completed_at, reconciled_at, last_safe_error_code, updated_at)`; `USAGE ON partner_connector_submission_ref_seq`; **on CORE tables:** `SELECT,INSERT ON users, submissions, submission_items` + `USAGE ON SEQUENCE submissions_id_seq, submission_items_id_seq` (0010:127-133) — **no UPDATE, no DELETE on any core table** |
| `partner_definer` | 0006 | **NO** | **YES** (required) | default | NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION | `USAGE ON SCHEMA public`; `SELECT` on exactly `partner_users`, `partner_organisations`, `partner_sessions`, `partner_locations`, `partner_password_reset_tokens`. **Owns** the three SECURITY DEFINER pre-auth functions and nothing else. |

⚠️ **0006 provisioning note (migration-time authority):** creating a BYPASSRLS role requires the applying role to be a **superuser** *or* to hold **CREATEROLE + BYPASSRLS**. On Neon the default owner (`neondb_owner`) is not a superuser. 0006 raises a clear exception if it lacks authority. **If `partner_definer` does not already exist, this must be provisioned once with an elevated role before 0006 can apply.** Per F-B it should already exist on staging — verify at 3.5/3.7.

### 4.3 LOGIN roles — YOU create these (the actual provisioning task)

| Proposed name | LOGIN | BYPASSRLS | INHERIT | CREATEDB | CREATEROLE | Member of | Password | Destination variable |
|---|---|---|---|---|---|---|---|---|
| `partner_app_staging` | **YES** | **NO** | **YES** (must inherit the group's grants) | NO | NO | `partner_runtime` | Yes — 32+ chars, generated, never reused | `PARTNER_DATABASE_URL` |
| `partner_admin_staging` | **YES** | **YES** ⚠️ | YES | NO | NO | *(none — needs no group)* | Yes | `PARTNER_ADMIN_DATABASE_URL` |
| `partner_connector_staging` | **YES** | **NO** | **YES** | NO | NO | `partner_connector_runtime` | Yes | `PARTNER_CONNECTOR_DATABASE_URL` |

**Why `partner_admin_staging` needs BYPASSRLS:** `server/partner/admin-capability.ts` probes `pg_roles.rolbypassrls` for `current_user` and **fails closed** with `PARTNER_ADMIN_BYPASSRLS_REQUIRED` if false — every super-admin Partner route 503s, and the connector parks. It also asserts the **runtime** role is **NOT** BYPASSRLS, returning `PARTNER_RUNTIME_BYPASSRLS_FORBIDDEN` if it is. Both directions are enforced.

**Why the admin route needs it at all:** the G4/G5/dashboard surfaces read across tenants on FORCE-RLS tables. FORCE RLS subjects even the table owner to policy, so cross-tenant reads are impossible without BYPASSRLS. Tenant isolation on those routes is enforced by explicit `WHERE tenant_id = $1` in the queries, not by RLS — a documented, reviewed trade-off (finding A4 from the G5 review).

**`INHERIT` is mandatory** on the two group-member roles: without it the login role would hold membership but not the privileges, and every query would fail on permission.

**`search_path`:** do **not** set a custom `search_path` on any role. The migrations and the definer functions pin `public, pg_temp` where required; overriding it risks resolving objects unexpectedly.

**PUBLIC revocations:** 0031's verification already confirms *"no PUBLIC grant"* on the tables it creates. Do **not** issue a blanket `REVOKE ALL ON SCHEMA public FROM PUBLIC` — on a shared database that would affect core MintVault objects. Verify per-table instead (§8).

**Default privileges:** none required. All grants are explicit and per-table by design; adding `ALTER DEFAULT PRIVILEGES` would silently widen future objects.

**Function EXECUTE:** the three definer functions are invoked by the runtime role; ownership is `partner_definer` and `EXECUTE` is granted by 0006's own grants. No manual grant needed. Do not re-grant.

---

## 5. Exact Partner migration chain

| # | File | Prereqs | Creates/alters | Touches CORE? | Rollback |
|---|---|---|---|---|---|
| 0001 | `partner_foundation` | none | 14 tables, `partner_runtime` group, FORCE RLS, policies, grants | No | `rollback-0001-*` (refuses if 0002+ applied) |
| 0002 | `partner_auth_support` | 0001 | lockout cols, reset tokens, recovery codes, 2 definer fns | No | phase-1 comprehensive only |
| 0003 | `partner_auth_hardening` | 0002 | global-unique lower(email), reset-token tenant fn | No | as above |
| 0004 | `partner_mfa_enrol` | 0003 | one-active MFA unique index | No | as above |
| 0005 | `partner_mfa_replay_and_grants` | 0004 | `last_totp_counter`; REVOKEs writes on `partner_user_locations` | No | as above |
| 0006 | `partner_definer_role` | 0005 | **`partner_definer` (BYPASSRLS)**, fn ownership, search_path | No | as above |
| 0007 | `partner_submissions` | 0006 | 6 intake tables | No | as above |
| 0008 | `partner_connector_foundation` | 0007 | connector role + records/events | No | `rollback-partner-connector-g1` |
| 0009 | `partner_connector_validation` | 0008 | validation runs/findings | No | `…-g2` |
| **0010** | `partner_connector_import` | 0009 **+ core tables** | ref sequence, customer links, imports | **YES — GRANTs on `users`, `submissions`, `submission_items` + their sequences** | `…-g3` |
| 0011 | `partner_connector_reconciliation` | 0010 | state widening | No | `…-g3e` |
| 0012 | `partner_connector_import_attempts` | 0011 | append-only attempts | No | `…-g3f` |
| 0013 | `partner_connector_claim_index` | 0012 | claim index replacement | No | g3f |
| 0014 | `partner_connector_admin_actions` | 0013 | admin action ledger | No | `rollback-partner-connector-admin-actions` |
| 0015 | `partner_management` | 0014 | 5 CRM tables | No | `rollback-partner-management` (refuses if 0016+) |
| 0016 | `partner_wallet_ledger` | 0015 | wallet + ledger + triggers + view | No | `rollback-partner-wallet-ledger` (refuses if 0017+ or data) |
| 0017 | `partner_credit_reservations` | 0016 | reservations + triggers + view | No | `rollback-partner-credit-reservations` |
| 0031 | `partner_user_management` | 0017 | `partner_invitations`, name cols, audit widening | No | `rollback-0031-*` |
| 0032 | `partner_final_owner_invariant` | 0031 | marker table + 3 deferrable constraint triggers | No | `rollback-0032-*` |

**Executing role:** the staging database owner (`neondb_owner` per the 0032 verification record), which is the role that applied every prior migration. **Exception:** 0006 needs elevated authority if `partner_definer` is absent (§4.2).

**Not in this chain and must NOT be applied here:** `0018`, `0019`, `0022`, `0023`, `0024`, `0026`, `0030` are core MintVault migrations. They should already be journalled (§3.3). Gate-4 migrations `0033`/`0034` **do not exist** and are blocked.

---

## 6. Migration safety plan

**Preflight:** §3 in full, plus `SELECT filename FROM schema_migrations ORDER BY filename` captured verbatim as the before-state.

**Dry-run:** `npm run db:migrate` **without** `--apply` (the runner requires `--apply` to write; the default is a plan). Expected on a staging database already carrying 26 rows: **0 pending, 0 checksum mismatches, 0 inconsistent, 0 destructive findings.**

**Expected journal after:** unchanged at 26 rows if F-B holds. **If the dry-run shows pending Partner migrations**, capture the list and stop for a decision before applying — that would contradict the governance record and must be understood, not overridden.

**Transaction behaviour:** the runner takes a session advisory lock on a **direct, non-pooler** endpoint and refuses to run concurrently; it asserts a dedicated backend. Each file applies in its own transaction; a failure rolls that file back and halts the run.

**Partial failure:** because this database is **not disposable** (it holds staging core data), the "drop and recreate" recovery from the earlier plan **does not apply**. Recovery is: halt, capture the journal and the error, and use the per-phase rollback script for the failed migration only — each refuses if a later migration is journalled, which is the intended guard.

**Fresh vs existing:** every earlier assumption about a fresh database is now void. This is an **existing** database with core data. No destructive operation is authorised.

**Connection requirement:** the migrator must connect via the **direct (non-pooler)** endpoint. The recorded pooler-leak incident (a session `SET` leaking across PgBouncer-multiplexed backends) is why.

---

## 7. Runtime connection map

| Variable | Endpoint | Role | Purpose | Pool max | Timeouts | Failure behaviour | Core access? | Bypasses RLS? |
|---|---|---|---|---|---|---|---|---|
| `PARTNER_DATABASE_URL` | **pooled** | `partner_app_staging` | tenant-scoped portal queries, flag resolution | `PARTNER_DB_POOL_MAX` (default 8) | no acquire timeout in code — see §8 | absent ⇒ portal 503, main app unaffected | **No** | **No** |
| `PARTNER_ADMIN_DATABASE_URL` | **direct** (preferred) | `partner_admin_staging` | super-admin reads, flag writes, connector sweep | pg default | — | absent ⇒ super-admin 503; connector parks `admin_url_not_pinned` | Reads only what its queries name | **Yes** |
| `PARTNER_CONNECTOR_DATABASE_URL` | **direct** (recommended) | `partner_connector_staging` | connector claim/validate/import | `PARTNER_CONNECTOR_WORKERS`-bounded | lease/backoff env-tunable | absent ⇒ runtime `not_configured`, no-ops | **Yes — INSERT into `users`/`submissions`/`submission_items`** | **No** |

**Direct for the connector** because it holds transactions across claim→validate→import and uses `FOR UPDATE SKIP LOCKED`; PgBouncer transaction pooling adds no benefit and complicates lock semantics. This is an owner decision (§10).

---

## 8. Capacity safeguards — Partner and core now share staging compute

This is the direct consequence of Option A and the reason finding F1 (unauthenticated `/api/partner` DB amplification) still matters on staging.

| Control | Recommended staging setting | Why |
|---|---|---|
| `PARTNER_DB_POOL_MAX` | **4** (down from default 8) | Caps Partner's share of the shared Neon connection budget |
| Connector `PARTNER_CONNECTOR_WORKERS` | **1** | One worker is sufficient for synthetic E2E; minimises lock contention |
| `PARTNER_CONNECTOR_POLL_INTERVAL_MS` | **30000** (up from 15000) | Halves idle query load against a shared database |
| `PARTNER_CONNECTOR_SWEEP_LIMIT` / `_PROCESS_LIMIT` / `_REQUEUE_LIMIT` | **10 / 5 / 5** | Small batches bound transaction duration and lock hold time |
| `statement_timeout` | **15s** on the three Partner login roles (`ALTER ROLE … SET statement_timeout`) | A runaway Partner query cannot pin a shared backend |
| `idle_in_transaction_session_timeout` | **30s** on the three Partner login roles | Prevents a stuck Partner transaction holding locks against core tables |
| `lock_timeout` | **5s** on the connector role | The connector touches core `submissions`; it must never block a grading write |
| Retry backoff | defaults (5s → 5min, park after 10) | Already implemented; do not loosen |
| Queue depth | watch `/worker/runtime` backlog counters | Rising `pending_handoffs` with flat imports = stall |
| Emergency stop | `partner_emergency_stop` ON | Halts the surface and the connector within one cycle |
| Main-app health | poll `/api/version` + a grading read throughout | **Any core degradation ⇒ flags OFF immediately** |

Per-role timeouts are the highest-value safeguard here: they are enforced by Postgres regardless of application behaviour, and they scope only to the Partner roles, leaving core sessions untouched.

---

## 9. APP_URL and reset safety
`APP_URL = https://mintvault-v2.fly.dev` — approved, **not applied**. The reset proof uses the existing exported `setResetDeliveryAdapter()` capture seam (already exercised in `tests/partner-runtime-integration.test.ts`); no code change, no new framework, **no external provider delivery**. The proof asserts: HTTPS scheme · host `mintvault-v2.fly.dev` · path exactly `/partner/reset` · token in the query parameter only · token absent from application logs · token absent from audit metadata · anti-enumeration unchanged · expiry and single-use pass. The `RESEND_API_KEY` removal method is **withdrawn**.

---

## 10. Revised execution sequence

| # | Step | Gate |
|---|---|---|
| 1 | Verify staging DB identity + production isolation (§2) | Endpoint ≠ production endpoint |
| 2 | Core prerequisite inventory (§3) | All STOP conditions clear |
| 3 | Verify role-creation capability and existing roles (§3.5, §4) | Owner can create LOGIN roles; `partner_definer` exists with BYPASSRLS |
| 4 | Create the three LOGIN roles + memberships + per-role timeouts (§4.3, §8) | Capability matrix matches exactly |
| 5 | Verify runner file selection against the journal (§5, F-A) | Journal holds every core migration |
| 6 | Migration dry-run (§6) | 0 pending, 0 mismatches — or STOP if Partner files are pending |
| 7 | Apply the approved chain **only if** step 6 shows pending Partner files | Runner exits 0 |
| 8 | Verify journal, objects, grants, FORCE RLS, definer ownership | Matches §4/§5 |
| 9 | Configure secrets + `APP_URL` (flags remain absent) | No flag row created |
| 10 | Deploy `7630bf19` to staging via `scripts/safe-deploy.sh staging` | `/api/version` = `7630bf19` |
| 11 | Verify main-app health **first** | No grading/cert regression |
| 12 | Verify Partner fail-closed with all flags OFF | `/api/partner/session` → **503** |
| 13 | Verify connector disabled state | `/worker/runtime` parks/no-ops visibly |
| 14 | Non-activation readiness checks + reset-link capture proof (§9) | All pass |
| 15 | **STOP before flags** | — |

---

## 11. Remaining owner decisions

1. **Live staging DB access** — supply a working `MINTVAULT_DATABASE_URL`, or run §3 yourself and return the non-secret output. **Blocking for steps 1–8.**
2. **Migrator identity** — confirm the existing staging owner (`neondb_owner`) applies the chain, as it did for every prior migration.
3. **BYPASSRLS creation authority** — confirm `partner_definer` already exists (expected per F-B); if not, an elevated role is needed once.
4. **Connector endpoint** — approve **direct** (recommended) vs pooled.
5. **Connection limits** — approve `PARTNER_DB_POOL_MAX=4` and the per-role timeouts in §8.
6. **Login role names** — approve `partner_app_staging` / `partner_admin_staging` / `partner_connector_staging`, or supply your own convention.
7. **If the dry-run contradicts F-B** (Partner migrations pending) — confirm whether to apply, given the governance record says they are already applied.

---

## 12. Exact resume point
**Resume at step 1** once decision 1 is answered. Steps 1–3 are read-only and can run immediately on access; step 4 (role creation) is the first mutating action and needs decisions 2–6 settled first.
