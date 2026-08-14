# Implementation budget — Canonical grading left-rail refinement

**Written:** 2026-08-14, Stage 4, before runtime edits.

| Metric | Estimate |
|---|---|
| Files expected to change | 14: one component, one development-only measurement helper, three test files, index and nine task records |
| Estimated lines changed | ±300 |
| Estimated commits | 1 implementation commit, then normal GitHub merge commit if approved gates pass |
| Estimated tests | 2 directly updated/added assertions plus the existing focused, architecture, full-suite and browser checks |
| Estimated duration | One controlled release pass plus CI/deploy observation |

The component has one mount site and the aside already assigns its other child `flex-1`; a visual-only edit should stay within this small budget. Any increase over 25% requires a re-manifest.

## Actuals (Stage 6/7)

| Metric | Actual | Within 25%? |
|---|---|---|
| Files changed | 16 (six tracked source/test/index files plus ten task records) | yes — 14% over the stated 14-file estimate; no re-manifest required |
| Lines changed | 361 (145 changed tracked lines plus 216 new governance-record lines) | yes — 20% over the 300-line estimate, below the 25% re-manifest threshold |
| Commits | 0 before review | yes |
| Tests | 141 scoped assertions; serial full run 4,554 passed / 771 CI-variable-gated skipped; five-role browser measurements at two viewports; two CI-shaped isolated suites (107 assertions) | yes |
| Duration | one controlled pass, pending CI/deploy observation | yes |
