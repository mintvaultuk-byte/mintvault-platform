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

---

# Remediation pass (post hostile review)

Hostile review verdict on `b2a3bdf1` was **NEEDS MORE WORK**: architecture and the Super Admin
security boundary passed; three blocking correctness defects and five non-blockers were raised.

## Files ADDED
| File | Purpose | Class |
|---|---|---|
| `server/partner/dashboard-visibility.ts` | Catalogue-based cross-tenant READ precondition; fail-closed typed reasons | A |
| `tests/partner-dashboard-integration.test.ts` | Real-Postgres HTTP suite: D1/D2/D3/N1/N3 + positive Super Admin path | A |
| `tests/partner-dashboard-risk-equivalence.test.ts` | Proves `RISK_LEVEL_SQL` ≡ `deriveRisk` over 336 signal combinations | A |
| `tests/partner-dashboard-ui-render.test.ts` | REAL component rendering (loading/error/empty/unavailable/lazy drill-down) | A |

## Files MODIFIED
| File | Change | Finding |
|---|---|---|
| `server/partner/dashboard-service.ts` | Risk ladder moved into SQL (`RISK_LEVEL_SQL`); partner list rebuilt on pre-aggregated CTEs with filtering before pagination and a window-function total; consumed credits derived from consumed reservations; audit ORDER BY made total; alert queries bounded and ordered in SQL; wallet reads gated on schema visibility | D2, D3, N1, N2, N6 |
| `server/partner/dashboard-routes.ts` | Router-level visibility gate (503 + typed code); `scalar()` rejects repeated params with 400; rate-limit key uses `req.ip` | D1, N3, N5 |
| `shared/partner-dashboard.ts` | `RISK_LEVELS`/`RISK_RANK`/`isRiskLevel`; `DashboardAlert.detectedAt` now nullable with deterministic sort | D2, N7 |
| `client/src/pages/admin/partner-dashboard.tsx` | `VisibilityUnavailable` panel replaces the whole surface on a visibility failure; alert timestamps use honest labels; presentational components + `PartnerDrilldown` exported for render tests | D1, N7, N8 |
| `client/src/pages/admin/partner-dashboard-helpers.ts` | `isVisibilityError`/`visibilityErrorCode`, `alertDetectedLabel`/`alertDetectedTitle` | D1, N7 |

## Database changes
**None.** No migration was added. The performance fix (N2) removed the per-partner correlated scan
by restructuring the query, so no index was required — and per the migration rules an index is not
added merely because it looks useful. Measured at 5,003 partners / 200,120 connector records:
worst-case sort 206 ms → 33 ms, sort-to-sort spread 37.5× → 1.1×, `loops=5003` occurrences 0.

## Deferred (unchanged scope)
- **N4 — `/api/super-admin/*` IP allowlist.** NOT changed here. `adminIpAllowlist` is mounted only
  on `/api/admin` (`server/index.ts:156`) and is opt-in via `ADMIN_IP_ALLOWLIST`. Extending it to
  `/api/super-admin/*` would silently lock out legitimate Super Admin access wherever that env var
  is already set, and would change the posture of three pre-existing routers that share the
  prefix. Tracked as a separate security decision.
- Manual credit adjustment remains out of scope — still no HTTP write path over the ledger.
