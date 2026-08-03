# PARTNER SHOP PILOT — STAGING READINESS & ACTIVATION PLAN

**Status:** PREPARED — NOT EXECUTED. No infrastructure, secret, migration, flag, deploy or email action has been taken.
**Prepared:** 2026-07-30 · Programme Director
**Target commit:** `7630bf19ff4574e8e75dd73a6aff9a46e9f4e48d` (origin/main, Wave 1 + 1.5 merged)
**Executing session must:** re-verify Phase 1 before every phase; stop at any STOP condition; never proceed on a guess.

---

## 1. Executive readiness summary

Gates 1–3 are on main and **dormant**: no Partner database exists in any environment, all Partner flags are OFF (no rows exist at all), and every Partner route fails closed. Staging currently runs `6b30136f` (pre-Wave-1), so the Partner surface is not merely disabled there — it is absent.

Bringing staging up is therefore a **provisioning exercise, not a repair**. The critical path is: isolated Partner database → roles → migrations → secrets (flags still OFF) → deploy → prove fail-closed → then a narrow flag ladder.

**The three things most likely to go wrong**, in order:
1. **APP_URL** — if it does not point at the staging origin, the first password reset emails a real person a production link. Phase 5 gates every email path behind proving this.
2. **Database isolation** — the Partner runtime pool is separate from the core pool, but if the Partner DB shares production compute, unauthenticated `/api/partner` traffic competes with grading for CPU. Phase 2 forbids this.
3. **Connector runtime on boot** — this is the only place Wave 1 touches the main app lifecycle. It is fire-and-forget and no-ops without config, but it is the first thing to watch on deploy.

**Recommendation: proceed to staging in the order below, but do NOT enable `partner_grading_enabled` or `partner_payments_enabled` at any point.** Gate 4 (credits) is unbuilt; enabling either would expose a grading path with no credit accounting.

---

## 2. Verified current state (Phase 1 — completed read-only, 2026-07-30)

| Item | Verified value |
|---|---|
| origin/main | `7630bf19` ✓ |
| Staging app | `mintvault-v2` (identified by its `STAGING_ONLY` secret) |
| Staging deployed commit | **`6b30136f`** — pre-Wave-1; Partner surface absent (`/api/partner/session` → 404) |
| Production app | `mintvault` |
| Production deployed commit | **`6f182624`** — untouched throughout the programme |
| Partner secrets, staging | **ZERO** `PARTNER_*` secrets |
| Partner secrets, production | **ZERO** `PARTNER_*` secrets |
| `APP_URL` | PRESENT on both apps; **value not read** — staging-correctness UNVERIFIED |
| `RESEND_API_KEY` / `RESEND_DOMAIN_VERIFIED` | PRESENT on both apps |
| Feature-flag state | No Partner DB exists ⇒ no `partner_feature_flags` table ⇒ every flag resolves **false** (fail-closed) |
| Migration journals | Partner migrations **not applicable** to a database that does not exist; MintVault journals untouched by this programme (0 migrations added) |
| Partner DB objects | **None anywhere** |
| Staging machines | **1 running** (`lhr`), `min_machines_running = 1`, `auto_stop_machines = "off"` |

**Connector-runtime lifecycle implication of the machine count:** with 1 machine there is exactly 1 poller and the in-process rate-limit store is effectively global. Both assumptions break if staging is scaled — see Open Findings.

No secret values were read, printed, copied or stored at any point.

---

## 3. Required infrastructure

1. A Neon Postgres **17** database for the Partner runtime, on compute isolated from production MintVault.
2. Three database roles (runtime, admin/migrator, connector) — see Phase 3.
3. Four to six Fly secrets on `mintvault-v2` only — see Phase 4.
4. No new Fly app, no new machine, no DNS, no CDN change.
5. No production change of any kind.

---

## 4. Database topology (Phase 2 — design only, DO NOT PROVISION)

**Hard requirement: the Partner database must not share production MintVault compute.**

| Property | Specification |
|---|---|
| Project | **A distinct Neon project** (preferred) — e.g. `mintvault-partner-staging`. Rationale: a separate project guarantees separate compute and separate quota; a same-project branch may share an endpoint and cannot demonstrate resource separation. |
| Branch | `main` within that project (staging is the only consumer) |
| Endpoint/compute | Its own endpoint. Record the endpoint id; it MUST differ from prod's `ep-wispy-morning-*` and from staging core's `ep-purple-voice-*`. |
| Region | `eu-west-2` / London — match the Fly `lhr` machine to minimise latency |
| PostgreSQL version | **17** (CI proves the suites on 17.10; the partner migrations assume 17 semantics) |
| Database name | `mintvault_partner_staging` |
| Runtime role | `partner_runtime` — **NOBYPASSRLS, NOSUPERUSER**, tenant-scoped access only |
| Admin/migrator role | `partner_admin` — **BYPASSRLS required** (the admin capability probe fails closed without it); used by super-admin reads and the connector sweep |
| Connector role | `partner_connector_runtime` — **NOBYPASSRLS**, distinct from `partner_runtime`; asserted NOBYPASSRLS by migration 0008 |
| Definer role | `partner_definer` — **NOLOGIN, BYPASSRLS**; owns the three SECURITY DEFINER pre-auth functions (migration 0006). The portal 503s if ownership is wrong. |
| Ownership model | Migrations run as the migrator; tables owned by the migrator; runtime/connector receive explicit GRANTs only |
| FORCE RLS | Every tenant-keyed table is `ENABLE` + `FORCE ROW LEVEL SECURITY` keyed on `partner_current_tenant()`. FORCE means the table owner is also subject — so the migrator must not be the runtime role. |
| Pool limits | `PARTNER_DB_POOL_MAX` default 8. Keep 8 for staging. Neon endpoint max connections must exceed pool_max × machines × pools (runtime + admin + connector) — budget ≥ 30. |
| SSL | `sslmode=require` (Neon default). Use the **non-pooler** endpoint for the migrator (see the recorded pooler-leak incident); the runtime may use the pooler. |
| Backup/restore | Neon PITR on the new project. Staging holds only synthetic data, so restore = recreate. Capture a branch snapshot before applying migrations so a failed run can be discarded rather than repaired. |
| Naming | `mintvault-partner-staging` / `mintvault_partner_staging` / roles as above |
| Staging-only safeguards | Set a `STAGING_ONLY`-style marker; never grant this role access to the production project; never copy production data in. |

**STOP condition:** if the only available option shares production compute, **stop and report** — do not proceed with a shared endpoint.

---

## 5. Roles and privileges (Phase 3 — verification design, DO NOT APPLY)

### Required capability matrix
| Role | BYPASSRLS | LOGIN | Purpose | Fails how if wrong |
|---|---|---|---|---|
| `partner_admin` | **YES** | yes | super-admin reads, connector sweep, flag writes | capability probe → 503 `PARTNER_ADMIN_CAPABILITY_UNAVAILABLE`; connector parks |
| `partner_runtime` | **NO** | yes | all portal queries under `app.tenant_id` | if it had BYPASSRLS the probe **fails closed deliberately** |
| `partner_connector_runtime` | **NO** | yes | connector claim/import | migration 0008 asserts NOBYPASSRLS |
| `partner_definer` | YES | **NO** | owns 3 SECURITY DEFINER pre-auth fns | definer-health gate → whole portal 503 |

### Preflight (read-only, run BEFORE anything)
```
-- capability matrix
SELECT rolname, rolbypassrls, rolsuper, rolcanlogin
FROM pg_roles WHERE rolname LIKE 'partner_%' ORDER BY rolname;
-- expect: partner_admin t/f/t · partner_runtime f/f/t · partner_connector_runtime f/f/t · partner_definer t/f/f

-- server identity (never trust the hostname alone)
SELECT inet_server_addr(), inet_server_port(), current_database(), version();

-- journal state
SELECT filename, applied_at FROM schema_migrations ORDER BY filename;
-- expect: relation does not exist (fresh DB) OR an empty set
```

### Dry-run sequence
```
npm run db:migrate -- --dry-run        # confirm the runner supports it; else inspect planMigrations output
```
Expected: a plan listing partner migrations `0001`–`0017`, `0031`, `0032` as pending, 0 applied, 0 checksum mismatches, 0 inconsistent.

**Which migrations apply here:** only the Partner set. The MintVault core migrations (0018–0030 etc.) belong to the core database and MUST NOT be run against the Partner database. Confirm the runner's file selection before applying — **if it would apply core migrations to the Partner DB, STOP.**

### Transaction/rollback behaviour
- The runner takes a session advisory lock on a **direct (non-pooler)** endpoint and refuses to run concurrently.
- Each migration is one transaction; a failure rolls that file back and halts the run.
- Rollback scripts exist for the partner set (`rollback-partner-*.sql`) but each refuses if a later migration is journalled. **On a fresh staging DB the correct recovery is to drop and recreate the database, not to unwind.**

### STOP conditions
- Any role's capability differs from the matrix.
- `schema_migrations` is non-empty on a supposedly fresh database.
- The runner's plan includes any non-partner migration.
- The migrator connects via a `-pooler` host.

---

## 6. Environment matrix (Phase 4 — redacted, DO NOT SET)

Target: `mintvault-v2` (staging) **only**.

| Variable | Purpose | Used by | Mandatory | Format | Validation | Failure behaviour | Rotation | Rollback effect |
|---|---|---|---|---|---|---|---|---|
| `PARTNER_DATABASE_URL` | Tenant-scoped runtime pool | portal routes, flag resolution | **Yes** — portal cannot mount without it | `postgresql://partner_runtime:…@…/mintvault_partner_staging?sslmode=require` | `partnerPortalEnvStatus()`; probe asserts NOBYPASSRLS | Absent ⇒ portal 503 (fail-closed), main app unaffected | Update secret, redeploy | Unset ⇒ Partner surface fully off |
| `PARTNER_ADMIN_DATABASE_URL` | Privileged reads, flag writes, connector sweep | super-admin routes, connector runtime | **Yes** | as above, role `partner_admin` | BYPASSRLS probe | Absent ⇒ super-admin partner routes 503; **connector parks `admin_url_not_pinned`** (it deliberately refuses the `MINTVAULT_DATABASE_URL` fallback) | Update, redeploy | Unset ⇒ connector never runs |
| `PARTNER_CONNECTOR_DATABASE_URL` | Connector claim/import pool | connector runtime only | Only if activating the connector | as above, role `partner_connector_runtime` | migration 0008 asserts NOBYPASSRLS | Absent ⇒ runtime reports `not_configured`, no-ops | Update, redeploy | Unset ⇒ connector off, portal unaffected |
| `PARTNER_MFA_ENC_KEY` | AES-256-GCM key for TOTP secrets at rest | MFA enrol/confirm/login | **Yes if `PARTNER_DATABASE_URL` is set** | 64 hex chars (32 bytes) | `partnerPortalEnvStatus()` coherence check | Set DB URL without this ⇒ **portal 503 + one loud log** (deliberately not a boot crash) | Rotating invalidates every stored TOTP secret — all users must re-enrol | Unset ⇒ portal 503 |
| `APP_URL` | Base for reset/invite links **and** canonical-host redirect | email link building, redirect | **Yes — already present, value UNVERIFIED** | `https://<staging-origin>` | **Phase 5 gate** | Wrong ⇒ reset emails link to production | Update, redeploy | Wrong value is the single highest-consequence misconfiguration |
| `RESEND_API_KEY` | Email transport | invite + reset delivery | Already present | provider key | `resetDeliveryConfigured()` returns true on presence alone | Present ⇒ **delivery is live**; this is why Phase 5 must gate it | Provider console | Unsetting returns reset to fail-closed with no code change |
| `RESEND_DOMAIN_VERIFIED` / sender identity | From-address selection | email | Already present | — | existing | Falls back to the default sender | — | — |
| `PARTNER_DB_POOL_MAX` | Runtime pool size | partner pool | No (default 8) | integer | — | — | — | — |
| `PARTNER_CONNECTOR_POLL_INTERVAL_MS` / `_SWEEP_LIMIT` / `_PROCESS_LIMIT` / `_REQUEUE_LIMIT` / `_WORKERS` / `_LEASE_SECONDS` / `_BACKOFF_BASE_MS` / `_BACKOFF_MAX_MS` / `_MAX_FAILURES` | Connector timing/bounds | connector runtime | No — defaults are sane (15s poll) | integers | `intEnv` rejects NaN/negative | Bad value rejected at parse | — | Defaults restore on unset |

**Session/cookie:** the Partner cookie is `mv.partner.sid`, distinct from admin `mv.sid`; `Secure` in production, `HttpOnly`, `SameSite=Lax`, 12h absolute / 30min idle. **No configuration required** — do not add any.

**Logging/redaction:** `/api/partner` response bodies are suppressed from the request log by `BODY_LOG_SUPPRESSED_PREFIXES`. No configuration required; Phase 8 verifies it behaviourally.

**Secret handling rule for the executing session:** set secrets via `fly secrets set` with values supplied by the owner out of band. Never echo, never log, never commit, never paste into a report.

---

## 7. APP_URL and email safety gate (Phase 5) — **BLOCKING**

**No email may leave the system until this gate passes.**

### Gate procedure (in order)
1. **Before setting any Partner secret**, verify `APP_URL` on `mintvault-v2` resolves to the staging origin. Approved read-only method: deploy-free inspection by the owner in the Fly dashboard, **or** a code-path probe that prints only the *host* of `APP_BASE_URL` (never the token, never a full reset URL).
2. If `APP_URL` is absent or points at production: **STOP.** Record the required correction. Do not proceed to any email-capable step.
3. **Prove the reset URL before enabling delivery.** Preferred method matching the existing architecture: the code exposes `setResetDeliveryAdapter()`, and `resetDeliveryConfigured()` returns true on `RESEND_API_KEY` presence alone. Therefore the safe sequence is:
   - Temporarily **unset `RESEND_API_KEY`** on staging, or register a capture adapter, so real delivery is impossible.
   - Trigger a reset for a **synthetic** partner user.
   - Assert the captured URL is exactly `https://<staging-origin>/partner/reset?token=<token>` — staging host, correct path, token URL-encoded.
4. Only after the captured URL is proven correct may `RESEND_API_KEY` be restored.

### Non-negotiable requirements
- **No real Partner recipient.** Synthetic `@example.test` addresses only.
- **No production URL** in any generated link.
- **No token in application logs** — verify by grepping the captured staging log for the token string; expect zero hits (`/api/partner` bodies are suppressed and the reset route takes the token in a POST body, not a query string).
- **No token in audit logs** — inspect the `partner_audit_events` row for the reset request; it must record the event without the token.
- **Anti-enumeration preserved** — unknown and known addresses must return byte-identical `200 {"ok":true}`.
- **One-use and expiry proven** — consume once (success), replay (400); age `expires_at` past 30 minutes and confirm rejection.

---

## 8. Deployment sequence (Phase 6) — DO NOT EXECUTE

| # | Step | Success criterion | STOP if |
|---|---|---|---|
| 1 | Record rollback point: staging release id + commit `6b30136f` | Both recorded | — |
| 2 | Provision isolated Partner Neon project/DB (Phase 2) | Endpoint id differs from prod and staging-core | Shares production compute |
| 3 | Create roles; run the Phase 3 preflight | Capability matrix matches exactly | Any mismatch |
| 4 | Dry-run migrations | Plan = partner set only, 0 applied, 0 mismatches | Plan includes a core migration |
| 5 | Apply partner migrations `0001`–`0017`, `0031`, `0032` | Runner exits 0; journal lists exactly those | Any failure → drop DB, restart from 2 |
| 6 | Verify journal + RLS topology | FORCE RLS on tenant tables; definer fns owned by `partner_definer` | Any table missing FORCE RLS |
| 7 | Set secrets (Phase 4) — **flags remain OFF; no flag rows created** | Secrets present by name | `APP_URL` gate (Phase 5) not yet passed |
| 8 | Deploy `7630bf19` to staging via `scripts/safe-deploy.sh staging` | `/api/version` reports `7630bf19` | Version mismatch → rollback to step 1 point |
| 9 | Verify **main app** health first (Phase 8 §A) | Grading, certs, admin all normal | Any core regression → immediate rollback |
| 10 | Verify Partner routes still fail closed | `/api/partner/session` → **503** (not 404, not 200) | 200 anywhere |
| 11 | Verify connector runtime parks/no-ops visibly | `/worker/runtime` shows `not_configured` or `stopped` with a reason | Hot loop or crash |
| 12 | Run readiness tests (Phase 8) | All green | Any failure |
| 13 | **Phase 5 APP_URL gate** | Captured URL is staging | Anything else |
| 14 | Enable the minimum flag for the next test (Phase 7 ladder) | Only the intended surface opens | Unexpected surface opens |
| 15 | Controlled synthetic E2E (Phase 9) | All scenarios pass | Any failure |
| 16 | Emergency-stop drill + rollback rehearsal | Surface closes within one cycle | Kill switch ineffective |
| 17 | Return all flags to the owner-approved state (default: **all OFF**) | Zero enabled flags, verified | — |

**Order rationale:** database before secrets before deploy, so the app never boots into a half-configured Partner state; main-app health verified before any Partner activation, so a core regression is caught while the Partner surface is still closed.

---

## 9. Flag activation ladder (Phase 7)

Nine canonical flags exist. **Rows are global** (`tenant_id IS NULL AND location_id IS NULL`) and written **only** via `PUT /api/super-admin/partner-flags/:flag` (super-admin, reason required, audited, verified through the runtime read path — a mismatch returns 409, never a false 200). **Never write flag rows by direct SQL.**

| Order | Flag | Default | Depends on | Affects | OFF behaviour | ON behaviour | Rollback | Verify |
|---|---|---|---|---|---|---|---|---|
| — | `partner_emergency_stop` | OFF | none | entire surface | normal | **all Partner routes 503**, connector halts within one cycle | it *is* the rollback | `/api/partner/session` → 503 |
| 1 | `partner_portal_enabled` | OFF | DB + MFA key | master switch, public + authenticated | everything 503 | gates open; routes still need their own flags | set OFF | `/api/partner/session` → 401 not 503 |
| 2 | `partner_onboarding_enabled` | OFF | portal | invitation accept | accept 503 | invited user can set a password | set OFF | accept endpoint |
| 3 | `partner_login_enabled` | OFF | portal | login | login 503 | login works (MFA still required) | set OFF | login endpoint |
| 4 | `partner_connector_enabled` | OFF | connector DB URL | connector worker | worker never claims | sweep→validate→import runs | set OFF — halts within one cycle | `/worker/runtime` |
| — | `partner_evidence_capture_enabled` | OFF | — | reserved, **no consumer in code** | — | — | — | do not enable |
| — | `partner_device_enforcement_enabled` | OFF | — | reserved, **no consumer** | — | — | — | do not enable |
| **NEVER** | `partner_grading_enabled` | OFF | **Gate 4** | grading exposure | — | — | — | **DO NOT ENABLE** |
| **NEVER** | `partner_payments_enabled` | OFF | **Gate 4** | payments | — | — | — | **DO NOT ENABLE** |

### Gate-4 containment proof (required before any E2E)
Credits are **not** wired: wallet/reservation services have no HTTP surface and no caller in the submission or import path. The imported submission is created `payment_status='unpaid'` and does **not** enter the paid grading pipeline. **Before the first E2E, assert:** (a) `partner_grading_enabled` and `partner_payments_enabled` are absent/false; (b) after a synthetic connector import, the destination submission is `status='draft'`, `payment_status='unpaid'`; (c) `partner_credit_ledger` has zero rows. This proves no free-grading path is reachable.

**No flag is enabled merely because a deploy succeeded.** Each requires its verification step to pass first.

---

## 10. Verification matrix (Phase 8)

### A. Main application (must pass BEFORE any Partner activation)
health endpoint 200 · `/api/version` = `7630bf19` · admin login + PIN → session · a grading workstation loads and an existing cert renders · label PNG/PDF generates byte-identical to pre-deploy for a known cert · R2 presigned image loads · existing customer submission flow unaffected · Stripe webhook route still registered before `express.json()`.

### B. Partner runtime
Missing-config fail-closed (unset DB URL ⇒ 503, never 500/200) · admin capability probe (non-BYPASSRLS admin role ⇒ 503 with documented code) · public-route gates (portal OFF ⇒ 503 even with login+onboarding ON) · login rate limiting (one IP rotating emails ⇒ 429 at 30; two IPs independent; forged XFF prefix cannot mint a bucket) · MFA enrolment (secret stored encrypted, `PENDING` until confirmed) · recovery codes shown once, acknowledgement gates continue · session (`mv.partner.sid`, 30-min idle, credential-version invalidation) · password reset **without real delivery** (Phase 5) · super-admin flag update writes a global row and flips the runtime read · **split-brain detection** (admin and runtime URLs pointing at different DBs ⇒ 409, not a false 200).

### C. Connector
Boot does not crash or delay the main app · `/worker/runtime` reports status, last cycle, backlog incl. `failed`/`retryableFailed` · flag flip observed within one cycle without restart · emergency stop halts within one cycle · exactly-once import (retry returns the same destination; one `partner_connector_imports` row) · crash mid-import + restart ⇒ exactly one submission · failed-record retry when `next_retry_at` elapses · two-driver concurrency ⇒ N handoffs produce exactly N submissions · tenant isolation (cross-tenant join returns 0; a forged tenant/handoff pair fails `handoff_not_found`) · graceful shutdown drains with no leaked lease.

### D. CI and evidence
All 16 connector suites execute (268 tests, 0 skipped) and the assertion script exits 0 · expected counts asserted · no suite silently skips (fail-closed guards fire when env vars are removed) · seam tests green (10/10) · **logs contain no MFA secret, recovery code or reset token** — grep the staging log for the known synthetic values and expect zero hits.

---

## 11. Synthetic E2E scenarios (Phase 9)

All identities synthetic (`@example.test`), all cards fictional. **No real Partner shop, no real customer, no real card.**

| # | Scenario | Proves |
|---|---|---|
| A | Create synthetic org via super-admin → invite user → accept → set password | Onboarding path end-to-end |
| B | MFA enrol (QR/secret) → confirm → recovery codes acknowledged → sign out → sign in with TOTP → sign in with a recovery code | First-login is possible; recovery works |
| C | Password reset via capture adapter (Phase 5) — request, capture URL, consume, replay rejected, expiry rejected | Reset works without touching a real inbox |
| D | Super-admin flag OFF → ON → OFF on `partner_portal_enabled`, each with a reason | Flag control plane + audit trail |
| E | Portal submission → handoff → connector record → validated → imported → real MintVault submission with `MV-SUB-` ref and resolved owner | The pilot's core value path |
| F | Re-run the sweep (no duplicate); kill mid-import and restart (exactly one submission) | Exactly-once under duplication and restart |
| G | Emergency-stop drill: set stop → confirm portal 503 and connector halts within one cycle → clear → confirm recovery | The kill switch actually works |
| H | Suspend the synthetic partner; attempt login/actions; then remove the admin role's BYPASSRLS and confirm 503 with the documented code | Suspension + capability failure behave |
| I | Re-run the main-app checks (§A) after the connector has been running | No core regression from the boot hook |

**Gate-4 containment assertion in E and F:** destination submission is `draft`/`unpaid`; `partner_credit_ledger` row count is zero.

---

## 12. Rollback plan (Phase 10)

**Priority order, always:** ① flags OFF → ② connector stopped → ③ Partner surface unavailable → ④ main MintVault healthy → ⑤ app version rollback if needed → ⑥ database preserved for investigation.

| Trigger | Immediate action | Evidence to capture first (if safe) |
|---|---|---|
| App boot degradation | Roll back to the step-1 release | boot log, `/api/version`, machine status |
| DB connection saturation | `partner_portal_enabled` OFF; if needed unset `PARTNER_DATABASE_URL` and redeploy | `pg_stat_activity` counts, pool errors |
| Capability-probe failure | Leave fail-closed (already 503); fix the role | probe output, `pg_roles` matrix |
| Migration failure | Halt; **drop and recreate** the staging Partner DB rather than unwinding | runner output, journal state |
| RLS leakage | **`partner_emergency_stop` ON immediately**; treat as an incident | the offending query + row evidence, then stop |
| Connector duplication | `partner_connector_enabled` OFF | duplicate rows, `partner_connector_imports`, attempt ledger |
| Stalled connector drain | `partner_connector_enabled` OFF; restart machine | `/worker/runtime` snapshot, lease rows |
| Email URL misconfiguration | Unset `RESEND_API_KEY` (reset returns to fail-closed, no code change) | the captured URL, recipient list (expect synthetic only) |
| Sensitive material in logs | Emergency stop; rotate `PARTNER_MFA_ENC_KEY`; purge logs per policy | the exact log line, redacted |
| Grading/certificate regression | **Full app rollback to `6b30136f`** — this outranks all Partner concerns | failing request/response, cert id, label diff |

**Never** roll back by deleting the Partner database while an incident is unexplained — flags OFF achieves containment and preserves evidence.

---

## 13. Observability and evidence (Phase 11)

**Watch:** app boot log (one connector line expected); `[partner-connector-runtime]` events; `[partner-reset]` failure signal (constant text, no token); 503/429/409 rates on `/api/partner`; rate-limit events; `partner_audit_events` and `partner_security_events`; `partner_management_audit` for flag writes; `/api/super-admin/connector-ops/worker/runtime` for status, last-cycle stats and backlog (`queued`, `ready_for_import`, `importing`, `failed`, `retryableFailed`, `pending_handoffs`, `expired_claims`); `pg_stat_activity` connection counts per role.

**Capture for sign-off:** release id + `/api/version` output; `pg_roles` capability matrix; `schema_migrations` listing; RLS topology query; the fail-closed 503 probes; the captured reset URL (token redacted); flag-write audit rows; connector E2E row evidence (`partner_connector_imports`, destination `submissions`); emergency-stop before/after; the log-grep proving zero secret/token hits; final flag state.

**Redaction rule:** every artefact is reviewed for tokens, secrets, connection strings and real email addresses before it is stored or shared.

---

## 14. Open findings and go/no-go (Phase 12)

| Finding | Severity | Blocks staging deploy? | Blocks flag activation? | Blocks synthetic E2E? | Blocks first real-shop pilot? | Blocks wider rollout? |
|---|---|---|---|---|---|---|
| IPv6 /48 residual on rate-limit key | Medium | No | No | No | No | **Yes — revisit** |
| Per-machine rate-limit store | Medium | No (1 machine today) | No | No | **Yes if >1 machine** | **Yes** |
| Shared-NAT login trade-off | Medium | No | No | No | **Yes — a shop office IP can self-throttle**; recommend skip-on-success first | Yes |
| Shadowed duplicate login route | Low | No | No | No | No | Yes — delete it |
| `acct` helper raw-IP key | Low | No | No | No | No | Yes |
| Two thin migration suites | Low | No | No | No | No | No — coverage debt |
| Four remaining Low findings | Low | No | No | No | No | No |
| CodeQL alert #5 (pre-existing) | High (pre-existing) | No | No | No | No | Should be resolved on its own merits |
| `printable-grade-safety` 5s timeout flake | CI reliability | No | No | No | No | No — **do not modify (protected)**; re-run in isolation when it fails |

**Nothing in this list blocks staging deployment or synthetic E2E.** Three items should be resolved before a **real shop** is onboarded: the per-machine store (if staging/prod scales beyond one machine), the shared-NAT trade-off, and deletion of the duplicate route.

---

## 15. Owner decisions required

1. **Neon topology** — approve a distinct Neon project (recommended) vs an isolated endpoint in an existing project, and confirm who provisions it.
2. **`APP_URL` on staging** — confirm its value points at the staging origin, or authorise correcting it. *(Blocking for anything email-related.)*
3. **Email-safety method** — approve unsetting `RESEND_API_KEY` during the URL-proof step (simplest, no code change) vs registering a capture adapter.
4. **Skip-on-success for the login IP limiter** — recommended before a real shop; approve as a small follow-up package or defer.
5. **Flag ladder ceiling** — confirm the plan stops at `partner_connector_enabled` and that `partner_grading_enabled`/`partner_payments_enabled` stay OFF until Gate 4.
6. **Who executes** — this plan is written for another authorised session; confirm whether that is me in a later turn, and under what standing authorisation.

---

## 16. Exact recommended next action

**Answer decision 2 first — confirm staging `APP_URL`.** It is the only item that is both blocking and cheap, and it is the single misconfiguration in this whole programme that could reach a real person. Everything else in Phase 1 is already verified.

Then, in order: approve the Neon topology (decision 1), have the Partner database provisioned, and authorise a session to execute Phases 3–8 up to and including step 12 (readiness tests) — stopping before any flag is enabled, so the first activation decision is a separate, deliberate one.

**Do not execute any part of this plan until explicitly authorised.**
