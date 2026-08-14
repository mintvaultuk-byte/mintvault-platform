# Issue register — Canonical compact grading workstation density

| ID | Summary | Reviewer/Source | Severity | Confidence | File:Line | Class | Lead-verified | Proof level | Impl commit | Staging | Prod | Activation | Status | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CWD-01 | The canonical workstation must remove normal operator filter controls and use the recovered vertical space for the card while retaining Front/Back, zoom/pan and inspection state. | Owner acceptance request | high | confirmed | `image-viewer.tsx`, shared rail/preview components | A | yes | Runtime + focused tests | pending | n/a | pending | not-activated | fixed locally | Filter controls are absent; image derivative contract remains, card area and state evidence are recorded. |
| CWD-02 | The shared left rail and Card Details/Grade/Review right workspace need a measurable density pass without reducing required information or protected grading authority. | Owner acceptance request | high | confirmed | canonical shell, workflow bar, Grade components | A | yes | Runtime + focused tests | pending | n/a | pending | not-activated | fixed locally | 35/65 rail, compact headers/actions/Grade/MVGS/centering, scanner/station presence, and five-role geometry parity are recorded. |

## Rejected findings (with reason)

- CWD-01 and CWD-02 are locally fixed; protected exact-head CI, merge, and live verification remain the release gate.

## Deferred findings (with unblock condition)

- None. Any behavioural grading, MVGS, database, or production migration finding is outside this presentation-only pass and requires separate owner scope.

## Fixed findings (with evidence)

- None yet.
