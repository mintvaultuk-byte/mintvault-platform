# Task ledger — Scanner guided UI restoration (2026-08-24)

## Stage 0 — Baseline (recorded 2026-08-24)

- Branch: `codex/partner-scanner-onboarding-20260824`
- Commit: `8b117946c411a544f38cf551a091bfb949cb8f43`
- `git status`: clean
- Production commit: `01d5e4da` / release `1123`, read-only evidence from the preceding acceptance audit.
- Staging commit: `8b117946` / release `589`, read-only evidence from the preceding acceptance audit.
- Build/test status: prior Scanner package and focused tests were green; this pass will re-run Scanner tests plus project gates.
- Protected systems in play: Scanner station workflow only. No protected auth, payment, schema, migration, credit, card-evidence, or MVGS changes are in scope.
- Explicit scope: restore fail-closed Scanner presentation so non-ACTIVE stations show only the guided station state; remove zero-credit/capture-workflow obstruction until the station is ACTIVE; package and visually inspect the local macOS Scanner artifact.
- Explicit prohibited actions: station approval; station creation/enrolment; card scan/arming; credits or wallet mutation; production access/mutation/deploy; staging database mutation/migration; auth/payment logic; source changes outside Scanner UI/runtime/package tests.

## Stage progress

| Stage                            | Status | Date       | Notes                                                                                                                                                                           |
| -------------------------------- | ------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — Baseline                     | done   | 2026-08-24 | Isolated worktree is clean; root worktree is unrelated and dirty.                                                                                                               |
| 1 — Review plan                  | done   | 2026-08-24 | Single narrow UI/runtime defect; direct source trace and independent physical screenshots are the two evidence lanes. No reviewer delegated by current collaboration policy.    |
| 2 — Investigation                | done   | 2026-08-24 | `renderState` renders capture/billing without station-stage gating; billing modal z-index `120` exceeds station modal `100`.                                                    |
| 3 — Lead verification            | done   | 2026-08-24 | Renderer and CSS source verify the reproducible ordering; live Computer Use read is externally blocked by missing macOS accessibility permission.                               |
| 4 — Implementation authorisation | done   | 2026-08-24 | Local Scanner UI/package repair only; no protected action required.                                                                                                             |
| 5 — Implementation               | done   | 2026-08-24 | Operational markup is hidden by default; card work/billing requires authoritative `ACTIVE` setup plus `VALID` calibration; stale billing closes on non-operational transitions. |
| 6 — Regression                   | done   | 2026-08-24 | Scanner 165/165; compiled proof 41/41; fresh 1.5.4 arm64 package/verifier; root typecheck, lint and build all passed.                                                           |
| 7 — Final report                 | done   | 2026-08-24 | Exact 1.5.4 package foreground-observed the guided calibration state, then the package and all helpers exited cleanly. This task does not deploy Fly or mutate staging.         |

## Reviewer assignments (Stage 1)

| Reviewer                        | Scope                                                                   | Report                                                         |
| ------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------- |
| Lead direct source verification | Renderer station state, capture workflow, billing overlay, CSS stacking | Evidence in task issue register; no delegated agent permitted. |

## Links

- Issue register: `issue-register.md`
- Change manifest: `change-manifest.md`
- Rollout: `rollout.md`
- Rollback: `rollback.md`
- Deployment state: `deployment-state.md`
- Definition of proof: `definition-of-proof.md`
- Implementation budget: `implementation-budget.md`
- Confidence scoring: `confidence-scoring.md`
