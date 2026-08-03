# Integration Plan — integration/partner-shop-pilot-r1 (Wave 1)

**Date:** 2026-07-30 · **Director:** Lead session · **Owner pre-authorisation:** GO order (dispatch wave + integration plan + separate integration agent). NOT authorised: merge to main, push, deploy, flags, Gate 4.

## Inputs (all ACCEPTED, boundary-verified, hostile-reviewed, remediated)
| Package | Branch | Final head | Commits |
|---|---|---|---|
| WP-1 Runtime Mount & Flag Control | psp/wp1-runtime-mount | f6b2ef22 | 1327c8e9, f6b2ef22 |
| WP-3 Connector Activation | psp/wp3-connector-driver | 33c4cbe3 | bf9c018b, 33c4cbe3 |
| WP-2 Onboarding Completion | psp/wp2-onboarding-ux | f55e045c | ab7f9a4c, f55e045c |

## Order (reconfirmed against final diffs 2026-07-30)
WP-1 → WP-3 → WP-2. Overlap set verified by comm/merge-tree: only `.github/workflows/ci.yml` and `server/index.ts` intersect (WP-1×WP-3, 2 textual conflict hunks); WP-2 disjoint from both.

## Conflict resolution rules (binding on the integration agent)
1. `.github/workflows/ci.yml` — UNION, additive: keep BOTH packages' env vars (PARTNER_MOUNT_RT_* and PARTNER_CONNECTOR_RUNTIME_*), BOTH databases in the create loop (mintvault_partner_mount, mintvault_connector_runtime), and WP-3's psql preconditions. Nothing from either side dropped.
2. `server/index.ts` — UNION: WP-1's BODY_LOG_SUPPRESSED_PREFIXES entry + comment (~L285 region) AND WP-3's boot hook + drain (~L668+ region) must BOTH survive verbatim. Regions are disjoint; any conflict is contextual only.
3. Any other conflict = STOP and report (should not exist).

## Post-merge verification (all mandatory)
- Greps proving both sides survived: "/api/partner" in BODY_LOG_SUPPRESSED_PREFIXES; startConnectorRuntime() call in index.ts; mountPartnerPortal in routes.ts; both suites' env vars in ci.yml.
- `npm run check`; `npm run lint` (no NEW errors vs baseline); `npm run build`.
- Full `npm test` (LC_ALL=C LANG=C, no DB env) — compare pass/fail/file counts against the recorded baselines (0 test failures; module-load failures must be the pre-existing ~28 env-dependent files only).
- On disposable PG17 (fresh DBs per suite): partner-portal-mount-integration (27), partner-connector-runtime (15), partner-onboarding-ux (20), partner-public-routes-integration (2), partner-runtime-integration (38), plus connector service (49) + import-service (17) + admin-integration (7) as cross-seam spot checks.
- Cross-package seam checks: flag flip via WP-1's PUT /api/super-admin/partner-flags observed by WP-3's runtime within one cycle (single test acceptable, may reuse existing helpers); a request to /api/partner/mfa/enrol produces NO body in the captured request log.

## Rollback
Integration branch is disposable: delete integration/partner-shop-pilot-r1 and re-run. Package branches are never rewritten.

## After integration
Director review of the integration report → Stage 7 wave report to owner → owner decisions: PR to main, staging deploy, env provisioning, Gate 4.
