<!--
Template: issue register. Living document per task — reviewers' findings
(from templates/reviewer-report.md) get consolidated here by the Lead after
Stage 3 verification. Only the Lead edits this file.
-->

# Issue register — <task name>

| ID | Summary | Reviewer/Source | Severity | Confidence | File:Line | Class | Lead-verified | Proof level | Impl commit | Staging | Prod | Activation | Status | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| F1 | <one line> | <which reviewer raised it> | crit/high/med/low | confirmed/plausible | `path:L123` | A-H | yes/no | Designed…Production-verified | `<sha>` | n/a·pending·verified | n/a·pending·verified | not-activated·activated | accepted/rejected/deferred/fixed | <why> |

Provenance + proof are mandatory: never mark `fixed` without a Proof level AND an
`Impl commit`/evidence reference. A row at proof level `Implemented`/`Locally verified`
is NOT an active production fix (see `definition-of-proof.md`).

## Rejected findings (with reason)
- F2 — rejected — <e.g. "speculation, no repro provided" / "duplicate of F1">

## Deferred findings (with unblock condition)
- F3 — deferred — <e.g. "class E, needs owner approval for migration first">

## Fixed findings (with evidence)
- F1 — fixed — <commit/file, regression check that proves it>
