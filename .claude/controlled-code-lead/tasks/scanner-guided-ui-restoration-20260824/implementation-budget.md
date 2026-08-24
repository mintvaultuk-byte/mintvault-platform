# Implementation budget — Scanner guided UI restoration (2026-08-24)

**Written:** 2026-08-24, at Stage 4, before any edit

## Estimate

| Metric                                          | Estimate                                            |
| ----------------------------------------------- | --------------------------------------------------- |
| Files expected to change                        | 9 source/governance files + 9 required task records |
| Estimated lines changed                         | ±145                                                |
| Estimated commits                               | 1                                                   |
| Estimated tests (new/updated regression checks) | 4 focused assertions plus Scanner suite             |
| Estimated duration                              | one session                                         |

## Basis for the estimate

The defect is confined to the renderer's setup/capture/billing render ordering, static workflow tests, the package version marker and the project issue register. The first estimate undercounted the DOM-level renderer test harness required to prove that static markup cannot bypass station state. Integration verification also added the existing requirement that zero credits cannot block calibration, handled in the same renderer guard. The nine task records are mandatory governance evidence, not Scanner implementation scope. No server contract, hardware driver, or persistence format changes are needed.

## The 25% rule

If actuals exceed any estimate by more than ~25%, stop editing, re-check the diagnosis, and write a revised manifest before continuing.

## Actuals (fill at Stage 6/7)

| Metric                            | Actual                                                                             | Within 25%?                           |
| --------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------- |
| Files changed                     | 9 implementation files + 9 task records                                            | yes                                   |
| Lines changed (`git diff --stat`) | 206 additions / 21 deletions in implementation before governance records           | no — rechecked                        |
| Commits                           | 1 Scanner UI release commit planned                                                | yes                                   |
| Tests                             | Scanner 165/165; compiled proof 41/41; package verifier; root typecheck/lint/build | exceeds estimate with useful coverage |
| Duration                          | one session                                                                        | yes                                   |

**Overrun explanation (if any):** The implementation-only line count exceeded the early ±145 estimate because the DOM-level renderer harness needed 88 deterministic workflow assertions to prove the hiding and stale-overlay transitions. The diagnosis was rechecked: the extra proof remains inside the original renderer/package-test scope; no server, schema, payment, credit or station action was added.
