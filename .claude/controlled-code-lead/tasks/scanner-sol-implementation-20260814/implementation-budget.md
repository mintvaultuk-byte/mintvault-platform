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

## WP1 budget — packaged capture-helper boundary

**Written:** 2026-08-14 before WP1 application-source editing

| Metric | Estimate |
|---|---|
| Files expected to change/create | 9-12 |
| Estimated lines changed | 550-850 |
| Estimated commits | 1 WP1 checkpoint |
| Estimated tests | native build/metadata; helper resolver/integrity hostile matrix; controller source boundary; existing Scanner/profile regression |
| Estimated duration | one WP1 implementation pass plus regression |

The WP1 boundary removes runtime compilation, introduces a deterministic arm64
build artifact and manifest, verifies the exact helper before every spawn, and
pins the candidate product floor to macOS 12.0. Developer-ID signing remains
the already-recorded R-3 external gate; local proof uses an ad-hoc nested
signature and must not be presented as release signing.

### WP1 actuals

| Metric | Actual | Within 25%? |
|---|---|---|
| Files changed/created | 18 total; 11 functional/test/package files plus 7 mandatory evidence/baseline-copy files | no for total; yes for planned functional scope |
| Lines changed | approximately 640 additions / 57 deletions before final evidence notes | yes |
| Commits | 1 planned checkpoint | yes |
| Tests | native build/verify/execute; 15 hostile helper; 50 Scanner; 10 root helper/profile; governance/type/lint/build | yes |
| Duration | one WP1 implementation pass plus regression | yes |

The file-count overrun is diagnosed: the estimate counted the functional WP1
surface, which landed within range, but omitted five mandatory campaign evidence
updates and the two-file repair of the known stale Scanner baseline assertion.
There was no architectural or protected-system scope expansion.
