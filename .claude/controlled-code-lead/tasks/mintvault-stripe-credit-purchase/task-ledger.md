# Task ledger — mintvault-stripe-credit-purchase

**Started:** 2026-08-10  
**Baseline:** `aaf1bfa0`  
**Branch:** `codex/mintvault-final-product-integration`  
**State:** Stage 7 — local proof complete; provider TEST proof external.

## Owner-authorised objective

Complete the Phase 30 credit-purchase proof without replacing the existing package, Checkout,
webhook or ledger authority.

## Reconciliation

- `shared/partner-credit-packages.ts` locks packages at £10 per credit in integer pence.
- Partner Checkout reads only package id and authenticated tenant; success redirect grants nothing.
- `fulfilPartnerCreditPurchase` re-derives credit quantity, writes an immutable `stripe` purchase
  entry and uses the globally unique Stripe event idempotency key.
- The actual Postgres success/replay behavior was the remaining proof gap; no code authority gap
  was found.

## Stage log

| Stage                       | State    | Evidence                                                                                                                                                  |
| --------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — baseline/reconciliation | complete | Catalog, Partner route, webhook branch, fulfilment service, ledger constraint and existing security tests inspected.                                      |
| 1 — architecture            | complete | `architecture-before.md` and `architecture-after.md`.                                                                                                     |
| 2 — implementation plan     | complete | `change-manifest.md` and `implementation-budget.md`; no reviewer was authorised.                                                                          |
| 3 — lead verification       | complete | CP-001 reproduced as a missing real-Postgres proof boundary.                                                                                              |
| 4 — authorisation           | complete | Owner’s master continuation explicitly requires Phase 30.                                                                                                 |
| 5 — implementation          | complete | Extended the established real PostgreSQL wallet fixture with successful fulfilment, forged metadata, duplicate/concurrent, cross-tenant and retry cases.  |
| 6 — regression              | complete | Credit/wallet/package/portal/RBAC suite: 63 passed; type/lint/build and diff checks pass.                                                                 |
| 7 — local proof             | complete | PostgreSQL 17 fixture proves the immutable one-row purchase result and all hostile replay cases. Real provider TEST delivery remains explicitly external. |

## Next authorised action

Continue the owner-authorised final master integration reconciliation without waiting for external
Stripe TEST credentials.
