# Task ledger — mintvault-public-shop-map

**Started:** 2026-08-10
**Baseline:** `c2af48db`
**Branch:** `codex/mintvault-final-product-integration`
**State:** Stage 7 — local proof complete.

## Owner-authorised objective

Complete master Phase 24 on top of the already-proven public shop finder and profile: a friendly,
selectable map/list experience using only approved Partner coordinates and Google Maps links.

## Reconciliation

- Phase 23 finder, Phase 25 profile, and Phase 26 five-field Partner self-service are already
  represented by `FI-011` as locally proven. They will not be rebuilt.
- The public contract already exposes approved latitude/longitude and Super Admin already owns
  coordinate changes. The gap is only the client map/list presentation.
- No external map SDK, geocoding request, customer-location persistence, authentication, payment,
  migration, or live provider operation is in scope.

## Stage log

| Stage                       | State    | Evidence                                                                                                                                                           |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0 — baseline/reconciliation | complete | `FI-011`, public finder/profile API, public service, and existing browser proof were read.                                                                         |
| 1 — architecture            | complete | `architecture-before.md`; a coordinate plot uses only returned approved coordinates and keeps no customer location.                                                |
| 2 — implementation plan     | complete | `change-manifest.md` and `implementation-budget.md`; Lead-only pass, no reviewers authorised.                                                                      |
| 3 — lead verification       | complete | Existing finder has text results/directions but no map pin component; profile has no map panel.                                                                    |
| 4 — authorisation           | complete | The owner's master prompt explicitly authorises Phase 24 product completion with no paid Google dependency.                                                        |
| 5 — implementation          | complete | Added a provider-free approved-coordinate map/list, profile map panel, Google Maps hand-offs, deterministic local public listings, and the public-rating fallback. |
| 6 — regression              | complete | Focused map/public-network/rating tests, type-check, lint, build and real local public browser journeys.                                                           |
| 7 — local proof             | complete | Coordinate pin selection, list-only coordinate fallback, profile map/fallback and no-overflow browser evidence recorded in `definition-of-proof.md`.               |

## Next authorised action

Continue to the next unproven master phase. No local Phase 24 BLOCKER/HIGH remains.
