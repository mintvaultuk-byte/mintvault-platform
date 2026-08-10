# Task ledger — mintvault-supplies-orders

**Started:** 2026-08-10
**Baseline:** `4fa849a7fa61ce7f3f00e5d8e9341f8af57ac039`
**Branch:** `codex/mintvault-final-product-integration`
**State:** Stages 0–7 complete for the owner-authorised local build; external Stripe-provider proof remains separately unavailable.

## Owner-authorised objective

Build the Partner supplies/orders product using the locked commercial rules of 2026-08-10, with server-derived pricing/tax/totals, Stripe-webhook-authoritative payment state, immutable checkout snapshots, Super Admin fulfilment/refund controls, and local-disposable proof only.

## Scope boundary

- Add an isolated Partner supply catalogue, order, item, payment/refund, tax-snapshot and audit model.
- Mount authenticated Partner product/order routes and Super Admin order operations.
- Add Partner and Super Admin browser surfaces using those server contracts.
- Add additive/reversible migration `0069` and focused tests/proofs.

Out of scope: live Stripe charges/refunds, staging/production databases, customer addresses, wallet credit adjustments, grading authority, and deployed state.

## Stage log

| Stage                          | State            | Evidence                                                                                                                                                     |
| ------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0 — discovery/scope            | complete         | Existing Partner RLS/audit/RBAC, Stripe Checkout/webhook and location tables inspected. Owner rules are explicit; no unresolved commercial decision remains. |
| 1 — architecture               | complete         | `architecture-before.md`; order/payment snapshots are new tables rather than changes to historical Partner/customer data.                                    |
| 2 — approval/safety            | complete         | Owner explicitly authorised schema/payment/webhook/UI implementation and local-only mutations.                                                               |
| 3 — implementation             | complete         | Additive `0069` commerce schema, server-authoritative checkout/webhook/refund/fulfilment services, Partner/Admin routes and responsive surfaces delivered.   |
| 4 — verification               | complete         | Real PostgreSQL migration/RLS/refund/replay tests, real MinIO R2 proof, real Partner HTTP/pilot tests, and 1280×800/1024×768 browser journeys all executed.  |
| 5 — targeted hostile re-review | complete         | Reproduced migration-index preflight, runtime-grant, audit-rollback, malformed-price, retry and post-dispatch exception failures; each was fixed and rerun.  |
| 6 — release evidence           | complete         | `definition-of-proof.md`, `architecture-after.md`, issue register and local-only deployment state updated.                                                   |
| 7 — release gate               | complete (local) | No actionable local BLOCKER/HIGH remains. No deployment or provider credential was used.                                                                     |

## Completion rule

No actionable in-scope BLOCKER/HIGH remains. A real Stripe provider interaction is separately recorded as unavailable without a dedicated Stripe TEST credential; deterministic local Stripe contract/webhook proof is complete.
