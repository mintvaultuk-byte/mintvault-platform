# Change manifest — partner-master-dashboard

Stage 4. Written BEFORE any edit. Baseline `6f182624`.

## Files to ADD
| File | Why | Class |
|---|---|---|
| `shared/partner-dashboard.ts` | Response types + sort/filter allowlists + status constants, shared by client & server (CLAUDE.md: types live in `shared/`) | A |
| `server/partner/dashboard-service.ts` | Read-only cross-tenant queries via existing `partnerAdminQuery`; reuses G5/G6 services where they exist | A |
| `server/partner/dashboard-routes.ts` | Router at `/api/super-admin/partner-dashboard`, `requireSuperAdmin` + read rate limiter + UUID validation + audit-on-read | A |
| `client/src/pages/admin/partner-dashboard-helpers.ts` | Pure, unit-testable helpers (query keys, querystring, badge mapping, alert severity, error normaliser) | A |
| `client/src/pages/admin/partner-dashboard.tsx` | The page. Renders `<AdminShell>` (required by the repo-wide shell guard) | A |
| `tests/partner-dashboard-service.test.ts` | Pure-logic + allowlist/pagination tests | A |
| `tests/partner-dashboard-auth.test.ts` | Auth boundary matrix (unauth/partner cookie/forged header/graderProxy/admin-not-super/super) | A |
| `tests/partner-dashboard-admin-ui.test.ts` | Helper units + source assertions + route ordering + nav registration | A |

## Files to MODIFY (minimal, surgical)
| File | Exact change | Why | Class |
|---|---|---|---|
| `server/routes.ts` | +1 import, +1 `registerPartnerDashboardRoutes(app)` in the existing domain-route block | Mount the router the same way the other three partner routers are mounted | A |
| `server/index.ts` | Add the dashboard prefix to a body-logging exemption in the existing request logger | **Ship-gate.** Logger stringifies every `/api` response; redactor does not cover email/phone/address. Prevents bulk partner PII in Fly logs | A |
| `client/src/App.tsx` | +1 `lazy()` import, +1 `<Route>` above the catch-all | Register `/admin/partners/dashboard` | A |
| `client/src/components/admin/admin-shell.tsx` | +1 NAV entry `{ href: "/admin/partners/dashboard", label: "Partner Dashboard", icon: … }` | Nav discoverability; additive, existing order preserved | A |

## Explicitly NOT changing
- MVGS grading logic, `server/labels.ts`, `server/certificate-document.ts`, cert numbering
- Stripe / payment / webhook code
- Auth logic itself (I *use* `requireSuperAdmin`, I do not modify it)
- The three existing partner routers, their guards, or their queries
- Credit-ledger semantics — **no write surface added**
- No migration authored, none applied. No new dependency.

## Deliberate scope decisions
1. **Read-only v1.** No manual credit-adjustment control. `addCredits`/`removeCredits` are hardened
   but have never been exposed over HTTP; making this the first write path over the credit ledger
   warrants its own hostile review. Deferred with unblock criteria in the final report.
2. **Sections F (Quality) and G (Devices) render explicit "no data source" states.** The underlying
   data does not exist (verified). Building them would mean fabricating metrics.
3. **Guard is `requireSuperAdmin`,** stricter than the `requireAdmin` used by the three existing
   partner routers. Also immune to the `__graderProxy` early-return in `requireAdmin`.

## Rollback
Delete the 8 added files; revert the 4 modified files (each change is a small additive block).
No DB change, no deploy, so rollback is `git revert` of a single local commit.
