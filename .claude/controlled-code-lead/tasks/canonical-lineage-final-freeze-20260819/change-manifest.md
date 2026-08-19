# Change manifest — canonical lineage final freeze

**Date:** 2026-08-19
**Lead session:** `codex/mintvault-final-engineering-os-reconciliation` / baseline `d11579f1`

## Findings this manifest addresses

- P5-TAX-001 — require declared VAT-inclusive Stripe Price behavior — classification F.
- P5-EXC-001 — preserve server-owned purchase attribution for refund/dispute exception audit — classification F.
- LIN-001 — reconcile current production's location-form behavior without wholesale-merging the active line — classification C.

## Files changed

| File group | Change | Why | Classification |
|---|---|---|---|
| `server/partner/routes.ts`, `server/partner/credit-purchase-service.ts`, `server/webhookHandlers.ts` | Server-authoritative Checkout/PaymentIntent attribution, strict inclusive-tax guard, dispute Charge retrieval. | P5-TAX-001, P5-EXC-001 | F |
| `tests/partner-credit-purchase.test.ts` | Regression/mutation contracts for declared inclusive tax and refund/dispute attribution. | P5-TAX-001, P5-EXC-001 | F |
| `migrations/0098_*`, migration rehearsal/parity tests | Semantically replay active Scanner credit-view authority and prove the 41-row production journal plan. | Canonical inventory | E |
| Partner location page/helper/tests | Replay current active-line location form without discarding B1/GB-03/canonical work. | LIN-001 | C |
| `engineering/**`, this task directory | Record ownership, proof, rollback, release freeze, and live-lineage provenance. | Governance | G |

## Files explicitly NOT touched

- Growth GB-04 source (`d3d02dc6`) — frozen by the owner brief.
- Fly configuration, secrets, Stripe Dashboard configuration, production/staging DBs, migration journal, and deployment tooling behavior — protected external surfaces, not authorised.
- MVGS grading logic, certificate data, R2 signing, and authentication logic — outside scope.

## Protected actions required

- [x] No external protected action in this pass. The user authorised local canonical reconciliation.
- [ ] Future production migration/deploy — owner approval required separately; not granted by this manifest.

## Regression gates required

- [x] Targeted Partner credit, migration rehearsal/parity, Scanner, B1 and GB-03 suites
- [x] `npm run check`, `npm run lint`, `npm run build`, `git diff --check`
- [x] Payment mutation and hostile re-review
- [ ] Final clean-tree `engineering postflight . --run`

**Approved to proceed to Stage 5:** owner’s explicit canonical reconciliation/freeze brief — local source only; no provider, database, migration, or deployment operation authorised.
