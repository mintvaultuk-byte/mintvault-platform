# Task ledger — mintvault-supply-operations

**Started:** 2026-08-10
**Baseline:** `82dd38e6`
**Branch:** `codex/mintvault-final-product-integration`
**State:** Stage 7 local release evidence complete.

## Owner-authorised objective

Deliver Phase 22's practical Partner supply operations indicators: paid ordered units, cards completed, and a shop's explicitly recorded current stock. Do not infer consumption or build an ERP.

## Scope and safety boundary

- Add one tenant/location-isolated current stock-count table with a reversible, evidence-preserving migration.
- Read paid order units from immutable supply order items and completed cards from the existing grading work-item ledger.
- Let existing Owner/Manager purchase authority record a count; Finance Viewer remains read-only.
- Keep the current count distinct from historical order/payment/refund evidence and all grading authority.

## Stage log

| Stage              | State            | Evidence                                                                                                                                                                                                        |
| ------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — scope          | complete         | Master prompt Phase 22 defines the three indicators and explicitly rejects an ERP.                                                                                                                              |
| 1 — architecture   | complete         | `architecture-before.md`; no consumption formula, new workflow or price/tax mutation.                                                                                                                           |
| 2 — implementation | complete         | Additive `0070`, location-bound RLS/column grants, Partner/Admin read routes and an audited count writer.                                                                                                       |
| 3 — repair         | complete         | Updated the 0069 standalone rollback expectation after real PostgreSQL correctly refused it beneath the new 0070 journal entry. Browser bootstrap role creation is now idempotent across fresh local databases. |
| 4 — verification   | complete         | Real PostgreSQL migration/RLS/order-delta/audit test; browser Owner, Finance Viewer and Super Admin routes.                                                                                                     |
| 5 — release gate   | complete (local) | No actionable local BLOCKER/HIGH remains. No deployed or provider resource changed.                                                                                                                             |

## Completion rule

The only stock value presented as stock is one explicitly recorded by the shop. All other values are ledger-derived indicators with their source stated in the UI.
