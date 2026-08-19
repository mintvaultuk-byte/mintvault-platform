# Implementation budget — MintVault Command Centre V1 final reconciliation

**Written:** 2026-08-19, before Stage 5

## Estimate

| Metric | Estimate |
|---|---|
| Files expected to change | 43 (29 application/test, 6 UI/integration, 3 evidence, 5 governance) |
| Estimated lines changed | 4,100 ± 800 |
| Estimated commits | 2 local commits (candidate, final evidence) |
| Estimated tests | 16 existing focused Command Centre files plus targeted cross-domain matrix, full suite and runtime harness |
| Estimated duration | one reconciliation pass plus staging acceptance |

## Basis for the estimate

The prior implementation is 4,677 lines over 83 files, but 18 foreign Scanner/finance/migration files are excluded. The remaining Command Centre source, test and evidence surface is copied selectively, then three bounded repairs are added.

## The 25% rule

If actuals exceed an estimate by more than about 25%, stop implementation, record the cause, re-check scope and re-manifest rather than silently expanding the release.

## Actuals (fill at Stage 6/7)

| Metric | Actual | Within 25%? |
|---|---|---|
| Files changed | pending | pending |
| Lines changed (`git diff --stat`) | pending | pending |
| Commits | pending | pending |
| Tests | pending | pending |
| Duration | pending | pending |

**Overrun explanation (if any):** pending.
