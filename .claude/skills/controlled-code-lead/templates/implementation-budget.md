<!--
Template: Implementation budget (governance v1.1).
Written by the Lead at Stage 4, in or alongside the change manifest, BEFORE
Stage 5 editing begins. The point is drift detection, not planning theatre:
a budget blown by >~25% usually means the diagnosis was wrong or scope is
creeping — both are stop-and-explain events, not push-through events.
-->

# Implementation budget — <task name>

**Written:** <YYYY-MM-DD, at Stage 4, before any edit>

## Estimate

| Metric | Estimate |
|---|---|
| Files expected to change | <N, list if small> |
| Estimated lines changed | <±N> |
| Estimated commits | <N> |
| Estimated tests (new/updated regression checks) | <N, or "manual: <which checks>"> |
| Estimated duration | <e.g. "one session", "2-3 hours"> |

## Basis for the estimate
<one or two lines — what makes you believe these numbers; which finding(s)
this covers>

## The 25% rule

If actuals exceed any estimate by more than ~25%, **stop editing** and
report before continuing:

- what was underestimated and why
- whether the root-cause diagnosis still holds
- whether new scope crept in (if so, it needs its own manifest, not a
  silent extension of this one)
- revised budget, for explicit owner/Lead re-authorisation

## Actuals (fill at Stage 6/7)

| Metric | Actual | Within 25%? |
|---|---|---|
| Files changed | | |
| Lines changed (`git diff --stat`) | | |
| Commits | | |
| Tests | | |
| Duration | | |

**Overrun explanation (if any):** <required when any row is "no">
