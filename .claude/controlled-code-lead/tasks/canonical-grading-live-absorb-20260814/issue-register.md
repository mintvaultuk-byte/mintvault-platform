# Issue register — Canonical grading live absorb (2026-08-14)

| ID | Summary | Reviewer/Source | Severity | Confidence | File:Line | Class | Lead-verified | Proof level | Impl commit | Staging | Prod | Activation | Status | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CG-LA-01 | Production `6f0d59df` and reviewed candidate `90f90625` diverge from merge base `864faded`; direct deployment would omit live fixes. | Owner runbook + Stage 0 git graph | high | confirmed | git ancestry | G | yes | Merge topology proof pending commit | — | n/a | pending | not-activated | fixed locally | Normal isolated merge is resolved; final commit will make live a natural ancestor. |
| CG-LA-02 | The required live absorb has 43 conflict blocks across canonical UI, authority, Partner, scanner and task-record paths. | canonical_diff + lead merge-tree | high | confirmed | merge-tree conflict set | B | yes | Focused + full-suite regression proof | — | n/a | pending | not-activated | fixed locally | Each of the 38 conflicted paths was four-way compared. Candidate/current-main security, canonical composition and live production behaviours are preserved. |
| CG-LA-03 | Open PR #296 is an ancestor of the reviewed candidate and may move main during the campaign. | live_lineage + lead GitHub check | high | confirmed | GitHub PR #296 | G | yes | Designed | — | n/a | pending | not-activated | accepted | Re-fetch main before final commit, PR, merge and deploy; stop if it moves beyond the final candidate. |
| CG-LA-04 | Main has 67 historical CodeQL HIGH alerts. They are baseline debt, not evidence of a candidate-introduced regression; exact final-PR analysis is required. | release_gates + GitHub alert API | high | confirmed | GitHub code scanning | H | yes | Design Only | — | n/a | n/a | not-activated | follow_up | Do not call the historical alert count resolved. Treat a final-PR new alert or a proven release-relevant exploit as an actionable release finding. |
| CG-LA-05 | Candidate has no migration/schema/runner change from current main; no migration should be created or applied for this absorb. | release_gates + source hashes | none | confirmed | migrations/0074-0078, scripts/db/migrate.ts | C | yes | Integration proof pending | — | n/a | pending | not-activated | proven | Production journal/schema will be re-read before release; no history replay. |

## Rejected findings (with reason)
- None yet.

## Deferred findings (with unblock condition)
- CG-LA-04 — deferred — historic CodeQL backlog is tracked separately; final release must have no new CodeQL regression and no independently proven in-scope blocker/high.

## Fixed findings (with evidence)
- CG-LA-01 — local normal merge has both parent lineages; pre-commit ancestry assertion remains required.
- CG-LA-02 — conflict-marker scan clean; 25 focused files: 425 passed / 61 skipped; exact real-PostgreSQL review/CAS proof: 18 passed; full isolated-DB suite: 280 files passed / 29 skipped, 4,554 passed / 771 skipped.
