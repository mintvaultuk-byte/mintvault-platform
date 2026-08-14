# Implementation budget — WP0

**Written:** 2026-08-14 during WP0, before application-source editing

| Metric | Estimate |
|---|---|
| Files expected to change/create | 25-35 governance/control files from OS enrollment plus task artifacts |
| Estimated lines changed | 900-1,600 |
| Estimated commits | 1 WP0 checkpoint |
| Estimated tests | OS self-test, graph freshness check, governance snapshot, `git diff --check`, source assertions |
| Estimated duration | one WP0 session |

The OS enrollment plan accounts for most file count; task artifacts contain the
owner-mandated issue/invariant/contracts state. Application implementation gets
separate WP budgets before its Stage 5 edits.

## Actuals

| Metric | Actual | Within 25%? |
|---|---|---|
| Files changed | 36 | yes (one file over range, <3%) |
| Lines changed | 782 additions before final evidence notes | yes |
| Commits | 1 planned local checkpoint | yes |
| Tests | Governance 4/4; typecheck/lint/build; targeted protected + Scanner/Partner matrices; full baseline classification | yes |
| Duration | one WP0 session | yes |

No diagnosis or scope overrun occurred.
