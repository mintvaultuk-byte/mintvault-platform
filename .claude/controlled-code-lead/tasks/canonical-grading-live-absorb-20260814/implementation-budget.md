# Implementation budget — Canonical grading live absorb

**Written:** 2026-08-14, at Stage 4, before the live merge

## Estimate

| Metric | Estimate |
|---|---|
| Files expected to change | 100 maximum: 88 live-lineage paths, 38 conflict paths within that set, plus 9 task-evidence files |
| Estimated lines changed | ±3,000 (the merge incorporates seven live commits; no discretionary redesign) |
| Estimated commits | 1 local absorb merge commit, then normal GitHub merge commit if approved gates pass |
| Estimated tests | Existing focused suites, full suite, two negative mutations, local and release smoke proof; no test weakening |
| Estimated duration | One controlled release pass plus CI/deploy wait time |

## Basis for the estimate
The live line changes 88 paths after `864faded`; all overlap candidate changes and merge-tree identifies 43 conflict blocks. The result must retain both histories rather than shrink either scope.

## The 25% rule

If actual files, lines, commits or tests exceed this estimate by more than ~25%, stop, explain the new scope, re-manifest it, and do not silently broaden the release.

## Actuals (fill at Stage 6/7)

| Metric | Actual | Within 25%? |
|---|---|---|
| Files changed | pending | pending |
| Lines changed (`git diff --stat`) | pending | pending |
| Commits | pending | pending |
| Tests | pending | pending |
| Duration | pending | pending |

**Overrun explanation (if any):** pending.
