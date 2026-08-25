# Implementation budget — Staff Admin grading inspection viewport

**Written:** 2026-08-25, before Stage 5.

| Metric | Estimate |
|---|---|
| Files expected to change | up to 28, including 10 governance/proof records, 7 runtime files and up to 11 regression files |
| Estimated lines changed | approximately 1,500 added/removed lines |
| Estimated commits | 1 local candidate commit |
| Estimated tests | at least 45 focused viewer/layout assertions plus full repository suite and browser matrix |
| Estimated duration | one sustained implementation/proof session |

The existing viewer contains roughly 600 lines of intertwined rail-fit and separate MARK geometry; replacing it safely requires meaningful deletion plus pure geometry and browser-proof coverage. Stop and re-manifest if actual files or lines exceed this estimate by more than about 25%.

## Reforecast — 2026-08-25 05:04Z

The first regression pass showed that four earlier source-contract suites encoded
the retired adaptive-width / visual-viewport ratchet itself, and eight canonical
shell suites encoded the former `md` breakpoint literal. Preserving those tests
would require retaining the production defect. They are being replaced with
stronger pure-geometry, no-feedback, coordinate-plane and 540px-boundary
contracts. This is test replacement, not runtime scope expansion.

| Metric | Revised ceiling |
|---|---|
| Files expected to change | up to 42, including 12 governance/index records, 11 runtime/harness files and up to 19 regression files |
| Lines changed | up to 3,200 added plus removed lines; the majority is deletion of obsolete source-contract tests and retired viewer sizing code |
| Commits | unchanged: 1 local candidate commit |
| Runtime scope | unchanged: presentation/layout only; no API, schema, grading, crop, auth, issuance or Partner-semantic changes |

This reforecast was written before proceeding to full-suite/browser proof.

## Actuals

| Metric | Actual |
|---|---|
| Files changed | 40: 9 existing runtime/harness files plus 1 new geometry module; 17 existing regression files plus 1 new geometry test; index plus 11 task records |
| Lines changed | 1,450 additions / 1,575 deletions in the frozen commit; most deletions retire the adaptive/visual-viewport feedback implementation and tests that pinned it |
| Commits | 1 rejected local candidate plus 1 replacement repair commit planned; no push/merge/deploy |
| Exact final focused proof | 30 test files / 778 assertions; typecheck, lint 0 errors, production build and diff whitespace green |
| Broad proof | near-final revision: 429 files / 6,860 tests passed / 6 skipped; final monolithic retry rejected as authoritative when the repository's documented shared-Partner-env race produced skips/failures |
| Browser proof | supported in-app rendered geometry/anchoring executed and exposed two HIGHs; Chrome page-zoom proof remains blocked because the required extension is absent |

The revised ceiling was not exceeded and runtime scope did not expand.
