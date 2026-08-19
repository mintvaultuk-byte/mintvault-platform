# Issue register — canonical lineage final freeze (2026-08-19)

| ID | Summary | Reviewer/Source | Severity | Confidence | File:Line | Class | Lead-verified | Proof level | Impl commit | Staging | Prod | Activation | Status | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| P5-TAX-001 | Stripe Price `tax_behavior='unspecified'` was accepted despite the locked VAT-inclusive price. | `pricing_hostile_review`; mutation reproduction | high | confirmed | `server/partner/credit-purchase-service.ts` | F | yes | Local Proof | `12c9a641` | not run | not run | not activated | proven | Both pre-check and fulfilment now require explicit `inclusive`; mutation made the real credit suite red. |
| P5-EXC-001 | Refund/dispute exception attribution could be absent because Checkout metadata is not copied to Charge and disputes are not Charge event objects. | `pricing_hostile_review`; Stripe event/model trace | high | confirmed | `server/partner/routes.ts`, `server/webhookHandlers.ts` | F | yes | Local Proof | `12c9a641` | not run | not run | not activated | proven | Server-created attribution is copied to the PaymentIntent; dispute path retrieves its referenced Charge before auditing. |
| LIN-001 | Production advanced during the freeze from `8359e902` to `158dbf53`; a non-ancestral candidate could lose the location-form repair. | Read-only `/api/version`, git comparison | high | confirmed | Partner management detail/helper and tests | C | yes | Local Proof | `a3616f8c` | n/a | semantic comparison only | not activated | proven | Candidate already carried the active semantic replay. Comparison found only additive candidate UI/test hardening. Future release must acknowledge `--reconciled-from 158dbf53`. |

## Rejected findings (with reason)

- None. Every accepted HIGH had a concrete reproduction and was repaired in this pass.

## Deferred findings (with unblock condition)

- Production activation of the reconciled migrations and Stripe packs — deferred because it is a protected owner action. It requires an approved maintenance/release window, the production migration identity capability check, matching Stripe Price configuration, and a human checkout verification.

## Fixed findings (with evidence)

- P5-TAX-001 — locally proven by `tests/partner-credit-purchase.test.ts`; a controlled strict-tax mutation failed, then restoration passed.
- P5-EXC-001 — locally proven by the same suite; removing PaymentIntent metadata or dispute Charge retrieval failed the regression tests, then restoration passed.
- LIN-001 — source/test comparison of production commit `158dbf53` against the candidate retained all location-creation behavior.
