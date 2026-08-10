# Task ledger — mintvault-super-admin-public-listings

**Started:** 2026-08-10  
**Baseline:** `7c64ad36`  
**Branch:** `codex/mintvault-final-product-integration`  
**State:** Stage 7 — local proof complete.

## Owner-authorised objective

Complete the remaining Phase 28 public-listing/rating operations surface using the existing audited
Super Admin routes, without rebuilding completed scanner/evidence or commerce work.

## Reconciliation

- The real browser navigation has no public-listing screen; the dashboard provides related partner
  facts but not lifecycle, public details or rating governance.
- `partnerNetworkAdminRouter` already provides exactly the needed authority. A thin client surface
  is the missing product work.
- Supply fulfilment/refund already lives in `/admin/supplies`; wallet/credit, staff, submissions,
  corrections, devices-as-unavailable and audit already live in Partner Dashboard.

## Stage log

| Stage                       | State    | Evidence                                                                                                                                                                                                                          |
| --------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — baseline/reconciliation | complete | Real authenticated Phase 27 browser, AdminShell, Partner Dashboard, supply page and listing routes reviewed.                                                                                                                      |
| 1 — architecture            | complete | `architecture-before.md` and `architecture-after.md`.                                                                                                                                                                             |
| 2 — implementation plan     | complete | `change-manifest.md` and `implementation-budget.md`; no reviewer was authorised.                                                                                                                                                  |
| 3 — lead verification       | complete | PL-001 reproduced: server routes exist, no client route/nav page exists.                                                                                                                                                          |
| 4 — authorisation           | complete | Owner’s master continuation explicitly requires Phase 28 completion.                                                                                                                                                              |
| 5 — implementation          | complete | Added the server-derived active/unlisted location read and the narrow Super Admin listing queue/detail wrapper.                                                                                                                   |
| 6 — regression              | complete | `npx vitest run` focused suite: 131 passed; `npm run lint -- --quiet`, `npm run check`, `npm run build`, and `git diff --check` pass.                                                                                             |
| 7 — local proof             | complete | Disposable authenticated Super Admin created and reviewed a draft, saved address/coordinates, verified it, recalculated rating, created and retired an override; seven local audit rows and snapshot readback confirm the result. |

## Next authorised action

Continue the owner-authorised final master integration reconciliation.
