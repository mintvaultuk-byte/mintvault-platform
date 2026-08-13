# Task ledger — Partner Pilot final-scale completion

## Stage 0 — Baseline (recorded 2026-08-12 15:55 BST)

- Governed worktree: `/Users/cornelius/mintvault-partner-pilot-pass2`.
- Branch: `codex/partner-pilot-pass2`.
- Commit: `f3e90e63617f3395e29401c9aebfc2186ecddf20`; clean before these governance records.
- Production: `b0de088032f82c67564de4337e915649a4306019` (`MV-P5-20260225-nohalf`) from `https://mintvaultuk.com/api/version` at 2026-08-12 14:50 UTC. `/health` was 200; Partner probes were 503 fail-closed.
- Mainline: `origin/main` is `864fadeda88e06e083bfa483a7fe33520a4570e2`; the candidate contains it and has five local commits. No newer production integration branch is an authority over `origin/main`.
- Protected systems: Partner restricted runtime/RLS/MFA, credits, global certificate allocator/cert counter, scanner evidence/R2, migrations, MVGS authority, printing, deployment, physical Canon device.
- Scope: reconcile actual release state; repair accepted local workflow/scale defects; prove local/integration safety; prepare but do not execute protected production actions.
- Explicitly prohibited until a specific owner approval record exists: secret or role change, schema/migration application, production/staging mutation, deploy/push, live Stripe/R2 operation, physical capture/print.

## Stage progress

| Stage                            | Status                          | Date       | Notes                                                                                                      |
| -------------------------------- | ------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------- |
| 0 — Baseline                     | complete                        | 2026-08-12 | Candidate, mainline, live safe refusal, protected areas and lock recorded.                                 |
| 1 — Review plan                  | complete                        | 2026-08-12 | Three non-overlapping read-only reviewer scopes assigned.                                                  |
| 2 — Investigation                | complete                        | 2026-08-12 | All three read-only reports received; no reviewer mutated a system.                                        |
| 3 — Lead verification            | complete                        | 2026-08-12 | F1–F6 accepted from current source/live proof; duplicate reports consolidated.                             |
| 4 — Implementation authorisation | complete for local packages A–D | 2026-08-12 | Bounded manifest, architecture snapshot, budget and rollback are recorded.                                 |
| 5 — Implementation               | in progress                     | 2026-08-12 | Packages A (signed version recovery) and B (evidence-derived Ready queue) implemented and locally checked. |
| 6 — Regression                   | pending                         |            |                                                                                                            |
| 7 — Final report                 | pending                         |            |                                                                                                            |

## Reviewer assignments

| Reviewer            | Non-overlapping scope                                                            | State                 |
| ------------------- | -------------------------------------------------------------------------------- | --------------------- |
| `workflow_security` | Credit-to-capture-to-grade-to-QA-to-print reachability and adversarial authority | received and verified |
| `scanner_scale`     | Native Scanner product, version recovery, device/fleet/scale constraints         | received and verified |
| `runtime_migration` | Live release, restricted runtime, RLS and exact migration-journal gate           | received and verified |

## Links

- Issue register: `issue-register.md`
- Deployment state: `deployment-state.md`
- Architecture before: `architecture-before.md`
- Architecture after: `architecture-after.md`
- Change manifest: `change-manifest.md` (pending Stage 4)
- Implementation budget: `implementation-budget.md`
- Rollout: `rollout.md`
- Rollback: `rollback.md`
