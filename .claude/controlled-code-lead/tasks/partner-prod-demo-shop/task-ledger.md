# Task: partner-prod-demo-shop

**Objective (owner brief, 2026-08-02):** expose the real Partner Shop Dashboard on
PRODUCTION via one controlled temporary demo tenant, then suspend + archive it.

**Stage reached:** Stage 0 (read-only production preflight) — COMPLETE.
**Verdict:** BLOCKED. No write, no deploy, no migration, no tenant created.

## Stage 0 baseline

| Item | Value |
|---|---|
| Repo | /Users/cornelius/mintvault-platform |
| Branch | `psp/partner-rbac-hybrid` @ `0e1840c8` (0 commits ahead of origin/main; 24 behind) |
| origin/main | `372a98f3` — "merge(partner): land Wave 1 — Partner certificate origin, MFA/lockout hardening, CI role repairs" (2026-07-31) |
| Production commit | `6f182624` (build MV-P5-20260225-nohalf), Fly release **v1065**, 2 machines lhr, both healthy |
| prod → main gap | **102 commits**, of which **21 are non-Partner** |
| Dirty state | untracked governance dirs only; no source changes |
| Authorised this pass | READ-ONLY preflight only |

## Production database facts (read-only, via `fly ssh console -a mintvault`, `SELECT` only)

- Journal table `schema_migrations`: **23 rows applied**, watermark `0026_catalogue_abbreviation_unique.sql`.
- Applied: 0001–0019, 0022, 0023, 0024, 0026.
- **Pending on prod:** 0030 (project_control), 0031, 0032, 0033, 0034 (rbac seed), 0035 (certificate origin).
- **No pending migration numbered below the 0026 watermark** — Phase 0 item 7 PASSES.
- 41 `partner_*` tables already exist on production.
- DB roles present: `partner_runtime`, `partner_definer`, `partner_connector_runtime`.
- `partner_feature_flags`: **0 rows** → every partner flag fails closed today.
- `partner_users`, `partner_sessions`, `partner_wallets`, `partner_credit_ledger`,
  `partner_submissions`, `partner_locations`, `partner_audit_events`,
  `partner_customers`: **all 0 rows**.
- `partner_organisations`: **2 rows** —
  - `52a0e127…` "sophie pokemon", ACTIVE, created 2026-07-29T14:34:50Z
  - `7093971a…` "pokemon kings", PENDING, created **2026-08-02T19:43:18Z** (same day as this preflight)

## Runtime surface on production (commit `6f182624`)

- `registerPartnerManagementRoutes(app)` IS mounted (`server/routes.ts:2786`, admin-gated).
  This is how the two orgs above were created.
- `server/partner/app.ts` exists in the tree but is **NOT mounted** in `server/index.ts`.
- `GET https://mintvaultuk.com/api/partner/me` → **404**. Tenant-facing Partner Portal absent from prod.

## Blocking findings

| ID | Sev | Class | Finding |
|---|---|---|---|
| PD-F1 | CRITICAL | E | No demo/test/internal classification exists. `partner_organisations` has no `is_test`/`is_demo`/`is_internal` and no `slug`/`key` column (only free-text `legal_name` + uuid `public_ref`). Grep across every numbered migration on `origin/main` returns zero matches. The brief's own STOP condition. Made concrete by the 2 existing free-text-named prod orgs. |
| PD-F2 | CRITICAL | D | Releasing `origin/main` to prod is a 102-commit deploy carrying 21 unrelated unreleased commits: Project Control dashboard (+ migration 0030), print-grade safeguards, the landing rework (PR #269), and the migration-runner advisory-lock rewrite. Violates "do not bundle unrelated unreleased branches". |
| PD-F3 | HIGH | E | 6 pending migrations, incl. 0030 (wholly unrelated to Partner) and 0034 (seeds the RBAC security catalogue). Cannot apply Partner-only migrations without also applying 0030 under the sequential runner. |
| PD-F4 | HIGH | D | `partner_portal_enabled` is resolved by `resolveGlobalFlag()` (`server/partner/flags.ts`) against `tenant_id IS NULL` rows only. Portal enablement is **global**, not tenant-targetable. Brief step 13 cannot be satisfied as written. |
| PD-F5 | MEDIUM | E | `migrations/rollback-0035-*.sql` does not exist; 0030–0034 all have rollback files. |
| PD-F6 | MEDIUM | G | Prod partner-management surface was written to **today at 19:43Z** ("pokemon kings"). Live concurrent activity on the exact system this task would mutate — must be reconciled with the owner first. |
| PD-F7 | BLOCKER | G | The owner-approved demo owner email was to be "supplied separately" and has not been supplied. Brief step 10 cannot start. |

## Not verified this pass (moot given the above)

- Phase 0 item 8: tenant-isolation + Super Admin authorization suites not executed against this commit.
- Backup procedure for the six pending migrations not exercised.

## Next authorised action

None. Awaiting owner decision on the unblock path. No protected action is authorised.
