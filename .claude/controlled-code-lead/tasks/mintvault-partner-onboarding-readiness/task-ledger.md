# Task ledger — mintvault-partner-onboarding-readiness

**Started:** 2026-08-10  
**Baseline:** `031fe2f1`  
**Branch:** `codex/mintvault-final-product-integration`  
**State:** Stage 7 — local proof complete.

## Owner-authorised objective

Complete master Phase 27 onboarding truthfulness using existing Partner identity, wallet/credit and
public-listing systems, without rediscovering or redesigning the completed scanner/evidence work.

## Reconciliation

- The browser reproduction confirms the existing overview has only legacy setup items and calls
  credits unavailable despite active ledger support.
- The current database already contains `partner_mfa_methods`, `partner_credit_availability` and
  `partner_public_listings`; these are the authoritative sources for the added facts.
- Device/station and scanner readiness have no existing registry. This is an honest product
  limitation, not an invitation to fabricate readiness or build a hardware subsystem in this pass.

## Stage log

| Stage                       | State    | Evidence                                                                                                                                                                    |
| --------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — baseline/reconciliation | complete | `031fe2f1`, browser reproduction, Phase 27/28 master requirements, and authoritative schemas read.                                                                          |
| 1 — architecture            | complete | `architecture-before.md` and `architecture-after.md`.                                                                                                                       |
| 2 — implementation plan     | complete | `change-manifest.md` and `implementation-budget.md`; no reviewer was authorised.                                                                                            |
| 3 — lead verification       | complete | Existing detail source and real local Super Admin overview reproduce OR-001.                                                                                                |
| 4 — authorisation           | complete | Owner’s master continuation explicitly requires Phase 27 completion.                                                                                                        |
| 5 — implementation          | complete | Added a read-only tenant-scoped MFA/wallet/listing projection, operational facts, wallet link, and all-migrations local fixture data.                                       |
| 6 — regression              | complete | Focused UI/service assertions (130), real HTTP integration (29), type-check, lint, build and diff check all passed.                                                         |
| 7 — local proof             | complete | Authenticated local Super Admin browser proves MFA, 25 ledger-derived credits, multi-location listing aggregation, device/scanner limitation and existing wallet drilldown. |

## Next authorised action

Commit this Phase 27 repair, then reconcile the remaining master Phase 28 operations surface
against the existing Partner Dashboard and supply-order screens.
