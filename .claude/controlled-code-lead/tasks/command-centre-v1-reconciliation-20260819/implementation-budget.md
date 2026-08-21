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
| Files changed | 53 (50 implementation/governance files plus 3 required evidence files) | yes — 23.3% above 43 |
| Lines changed (`git diff --stat`) | 3,615 insertions, 29 deletions; 3,644 total changed lines | yes — within the 3,300–4,900 line budget |
| Commits | 4 local commits (implementation, manifest hygiene, initial evidence, postflight reconciliation evidence) | yes |
| Tests | 122 focused/rebase + 508 protected matrix + 152 Scanner; runtime enabled/disabled; staging control audit | yes |
| Duration | one reconciliation pass plus staging acceptance | yes |

**Overrun explanation (if any):** none. The actual file count remains within the 25% rule; the evidence-file count is exactly the three originally budgeted.
