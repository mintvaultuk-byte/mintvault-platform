# Task: partner-staging-demo

**Objective (owner brief, 2026-08-02):** controlled Partner Shop Dashboard demo on
STAGING (`mintvault-v2`) for owner inspection. Production explicitly out of scope.

**Owner decision (2026-08-02):** reuse existing tenant `MintVault Pilot Partner One Ltd`;
send the real staging invitation email to `mintvaultuk@gmail.com`; do NOT create a second
tenant; do NOT revoke the existing invite; do NOT use a plus-address.

**Stage reached:** Stage 0-3 (preflight + verification) COMPLETE. Stage 5 NOT started.
**Verdict:** BLOCKED on two owner-only actions (see below). Zero writes performed.

## Staging baseline

| Item | Value |
|---|---|
| App | `mintvault-v2` / https://mintvault-v2.fly.dev |
| Release | **v450**, deployed 2026-08-02T16:47Z, 1 machine lhr, health check passing |
| Commit | `c70daae6` |
| Branch | `integration/project-control-landing-20260802` — **61 commits AHEAD of origin/main**, unmerged |
| Contains all of origin/main | YES (`372a98f3` is an ancestor) — Wave 1 Partner work present |
| Extra migrations vs main | `0039`, `0040` (Project Control) applied to staging, absent from main |
| DB | `ep-purple-voice-abfez796-pooler` (staging Neon) |
| Journal | 31 applied: 0001–0019, 0022–0024, 0026, 0030–0035, 0039, 0040 |

## Partner surface — mounted and enabled

- `GET /api/partner/me` → **401** (mounted; prod returns 404)
- `GET /api/partner/session` → **401**
- `GET /partner/login` → **200**, renders "MintVault Partner sign in"
- Flags (all global, `tenant_id IS NULL`, enabled=true): `partner_portal_enabled`,
  `partner_login_enabled`, `partner_onboarding_enabled`
- Staging secrets present: `PARTNER_DATABASE_URL`, `PARTNER_ADMIN_DATABASE_URL`,
  `PARTNER_CONNECTOR_DATABASE_URL`, `PARTNER_MFA_ENC_KEY`, `RESEND_API_KEY`
- RBAC catalogue seeded (migration 0034): 6 roles, 20 permissions, 70 role-permission rows

## Existing staging partner data (nothing modified)

| Table | Rows |
|---|---|
| partner_organisations | 2 |
| partner_users | 1 |
| partner_locations | 2 |
| partner_profiles | 2 |
| sessions / wallets / wallet_balances / credit_ledger / reservations / submissions / submission_cards / customers / audit_events / mfa_methods / reset_tokens / recovery_codes / user_locations / service_tiers | **0** |

Target tenant `5a277964-254d-45a1-a657-0c7449dc3b25` "MintVault Pilot Partner One Ltd":
- status **PENDING**, accreditation PROVISIONAL_PARTNER, health NEEDS_ATTENTION
- profile trading_name "mv test cards strood", Strood ME2 2AA
- 1 location "Main location" (ACTIVE); `partner_user_locations` has **0 rows**
- owner user `dbaa5472…` `mintvaultuk@gmail.com`, "Oliver Test Partner",
  role **PARTNER_OWNER**, status **INVITED**, `password_hash` NULL, never logged in
- `partner_password_reset_tokens` = **0 rows** → the original invitation token no longer
  exists. The invitation cannot be completed as-is; a **resend is required**.

## Verification performed

| Check | Result |
|---|---|
| Tenant isolation — `tests/partner-rls-isolation.test.ts` on disposable local PG16 | **12/12 PASSED** (real DB, not skipped) |
| `tests/partner-final-owner-invariant.test.ts` | PASSED |
| `tests/partner-admin-capability.test.ts` | 1 failure — local-env artefact (CI needs PG17 + `postgres` superuser + BYPASSRLS role shape on :55433). NOT proven either way; not evidenced as a code defect. |
| 6 further partner suites (dashboard-auth, dashboard-integration, management-integration, invitation-redaction, onboarding-matrix) | 89 of 130 tests SKIPPED — gated on CI's PG17 env pairs, not reproduced locally. **Not green; not run.** |
| Login gate | `server/partner/auth.ts:69` requires `org_status === "ACTIVE"` AND `user_status === "ACTIVE"` |
| Partner login page render @ 1440×900 and 390×844 | Renders correctly, no layout break |

## Blockers (owner-only)

- **SD-B1 — no Super Admin authentication available.** `ADMIN_PASSWORD` / `ADMIN_PIN` are Fly
  secrets; local `.env` has both keys **empty**. The real workflow
  (`POST /api/super-admin/partner-management/partners/:id/users/:userId/resend-invitation`,
  `POST .../partners/:id/status`) is behind the two-step admin login. The Lead does not enter
  owner credentials into login forms. Ad-hoc SQL is forbidden by the brief and the workflow is
  not defective — it is simply unauthenticated for this session.
- **SD-B2 — two state changes required before the dashboard can be reached:**
  1. resend the owner invitation (tenant is otherwise un-enterable — token row is gone);
  2. move tenant status **PENDING → ACTIVE** (auth.ts:69 refuses login otherwise).

## Observations (non-blocking)

- `/partner/login` carries no MintVault header, footer, or logo; the browser tab title is still
  the marketing site title. Design-system gap, not a functional defect.
- Staging is running an unmerged 61-commit Project Control integration branch, not `main`.
  Anything observed on staging is evidence for that branch, not for `origin/main`.

## Production audit (read-only, no modification)

Both orgs created by `mintvaultuk@gmail.com` through the real G5 admin route.

| Org | ID | Status | Created | Users/Sessions/Wallets/Credits/Submissions/Customers/Locations |
|---|---|---|---|---|
| sophie pokemon | `52a0e127-0e37-486e-9909-6c66045c8105` | ACTIVE (PENDING→ACTIVE 2026-07-29T14:35:38Z, reason "good") | 2026-07-29T14:34:50Z | all **0** |
| pokemon kings | `7093971a-95a4-4bb2-bfaa-d8f48cd8f922` | PENDING | 2026-08-02T19:43:18Z | all **0** |

- `partner_management_audit`: 6 rows, all actor `mintvaultuk@gmail.com`
  (actor_user_id `e57aab3b-b0b3-44eb-8dc6-a7562b6e62a7`), request_ids `g5-POST-1785335690573`,
  `g5-POST-1785335738236`, `g5-POST-1785699798827`.
- `partner_security_events`: 0 rows. `partner_feature_flags`: 0 rows (all flags fail closed).
- Public exposure: **none** — the tenant-facing portal is not mounted on production
  (`/api/partner/me` → 404).

## Next authorised action

None by the Lead. Awaiting owner execution of SD-B2 steps 1 and 2 in the staging admin UI.
No protected action is authorised. Production untouched.
