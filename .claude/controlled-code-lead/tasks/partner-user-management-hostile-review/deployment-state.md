# Deployment state — Partner User Management

**Date:** 2026-07-29 · **Phase:** controlled integration complete through Phase 10 (staging, flags OFF)

## Git

| Item | Value |
|---|---|
| Merge commit on `main` | `6b30136f9ac4507bfacf13ff8743417278d73e61` (PR #270, merge commit — audit trail preserved) |
| Previous `main` | `7f4f12e7dd763141157b8ef99c5bc1f46760de54` |
| Branch head merged | `a168ae57e85012c179faec2e76afa98f570fa800` |
| Final hostile-reviewed commit | `8b0752e3da28dad8813ff5d5d539d969ac09cc01` |
| History | Nothing amended, squashed or rebased. All 15 commits are ancestors of `main`. |

## CodeQL

Alert **#173** (`js/missing-rate-limiting`, `server/partner/public-routes.ts:41`) dismissed as **false
positive** under founder authorisation (Option A). The route is rate-limited by `partnerLoginLimiter`
(`server/partner/rate-limit.ts:47`) — store-backed, 10/15min, keyed `email|ip`, fail-closed. CodeQL
only recognises known libraries. No code changed; no second limiter added; no inline suppression;
`partnerLoginLimiter` untouched. Rationale: `codeql-decision.md`.

## Staging database (`ep-purple-voice-abfez796`, Neon, PostgreSQL 17.10)

Migrations applied **2026-07-29 21:33:59Z → 21:34:00Z** via `npx tsx scripts/db/migrate.ts --apply`
(the approved runner), against the **direct** endpoint, not the pooler.

| | |
|---|---|
| Before | 24 journalled, latest `0030_project_control.sql`; 0031/0032 pending exactly once; 0 inconsistent; 0 checksum-mismatch |
| Applied | `0031_partner_user_management.sql`, `0032_partner_final_owner_invariant.sql` by `neondb_owner` |
| After | 26 journalled, both `applied` |
| 0031 objects | `partner_invitations` present; RLS enabled **and FORCED**; `partner_runtime` = SELECT/INSERT/UPDATE (no DELETE); no PUBLIC grant; `first_name`/`last_name` added |
| 0032 objects | 3 constraint triggers on `partner_users`, `partner_user_roles`, `partner_organisations` — all `deferrable=t initdeferred=t constraint=t`; function owned by `neondb_owner`, not SECURITY DEFINER, `search_path=public, pg_temp`; `uq_partner_invitations_one_live_per_user` present |
| Backfill | 0 marker rows — correct: staging has 0 partner users, so no tenant has ever had an active owner |
| FORCE RLS | intact on all tenant-scoped partner tables after the NO FORCE/FORCE round-trip in the backfill fix |

Role capabilities verified before applying:

| Role | BYPASSRLS | Required |
|---|---|---|
| `neondb_owner` (admin pool, via documented `MINTVAULT_DATABASE_URL` fallback) | **yes** | yes ✓ |
| `partner_runtime` | no | must not ✓ |
| `partner_definer` | yes | yes ✓ |
| `partner_connector_runtime` | no | must not ✓ |

## Staging application (`mintvault-v2`)

Deployed via `scripts/safe-deploy.sh staging --yes`. Release **v436**. Live commit verified against
the running server (`/api/version` → `6b30136f`), not the deploy log.

`GET /api/super-admin/partner-management/readiness` → **HTTP 200**
`{"checked":true,"ready":true,"capability":"partner_admin_bypassrls","failureCode":null}`

## Flags — ALL OFF

`partner_feature_flags` contains **zero rows**. `partner_login_enabled` and
`partner_onboarding_enabled` were **not** inserted. Observed behaviour:

- `POST /api/partner/invitations/accept` → 503 `partner onboarding unavailable`
- `POST /api/partner/auth/login` → 503 `partner login unavailable`
- `POST /api/partner/auth/password-reset/consume` → 400 `{"ok":false}`
- Authenticated portal (`/api/partner/session|users|auth/mfa`) → 404 (router unmounted)
- Super Admin partner-management → 200; legacy grading-partners shell → 200

Zero `partner_invitations` rows, zero partner users, zero partner organisations — **no invitation
email can have been issued to anyone.**

## Production

**Untouched.** `mintvault` still on release v1065 (Jul 28), commit `6f182624`. Not deployed.

## Rollback

1. Flags are already off; nothing partner-facing is reachable.
2. Fastest kill: insert global `partner_emergency_stop` = true → the whole public router 503s.
3. App: `fly deploy` the prior image, or redeploy `7f4f12e7`.
4. Schema: `rollback-0032-…` then `rollback-0031-…` through the approved runner (both verified on
   PostgreSQL 17 with realistic activity; 0032 leaves zero residue).

## Next authorised action

None without founder approval. Specifically NOT authorised: production deploy, and inserting or
enabling `partner_login_enabled` / `partner_onboarding_enabled`.
