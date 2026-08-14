# Task ledger — Canonical grading live absorb (2026-08-14)

## Stage 0 — Baseline (recorded 2026-08-14 09:20 BST)
- Branch: `codex/unified-grading-live-absorb-20260814`
- Commit: `90f906259992de8b326422fdece2f593d3a3b4e0` (reviewed candidate)
- `git status`: clean in this isolated worktree. The shared root remains dirty on `psp/partner-rbac-hybrid` and is out of scope.
- Production commit: `6f0d59df`, verified by `https://mintvault.fly.dev/api/version`; Fly release `v1078`; both machines started with `1/1` checks.
- Build/test status: hostile-review local evidence exists for the candidate; release gates will be re-run after the live absorb.
- Protected systems in play: canonical grading workstation/UI state, protected MVGS math and approval authority, scanner/station evidence, Partner tenant/MFA controls, migration identity, CI and Fly production release.
- Explicit scope: merge the actual live lineage into the reviewed candidate, retain the canonical workstation and current-main hardening, prove the requested gates, open and merge a protected PR, and deploy the exact merged SHA only when every stated release condition is satisfied.
- Explicit prohibited actions: no MVGS maths/threshold/centering/Pristine changes; no auth/payment/secret changes; no schema migration or production data mutation unless independently required and authorised; no edits in the shared root or reviewed-candidate worktrees; no force push or direct candidate deployment.

## Stage progress
| Stage | Status | Date | Notes |
|---|---|---|---|
| 0 — Baseline | done | 2026-08-14 | Production, main, candidate and dirty-root state recorded. |
| 1 — Review plan | done | 2026-08-14 | Three non-overlapping read-only reviewers assigned. |
| 2 — Investigation | done | 2026-08-14 | All three reports received and recorded in `reviewer-status.md`. |
| 3 — Lead verification | done | 2026-08-14 | Accepted findings CG-LA-01..05 after lead rechecks; no speculative finding accepted. |
| 4 — Implementation authorisation | done | 2026-08-14 | `change-manifest.md`, rollback, rollout, before/after snapshots and budget written. |
| 5 — Implementation | done | 2026-08-14 | Normal no-commit merge of live `6f0d59df` resolved in the isolated worktree after four-way comparison; resulting runtime tree is the reviewed candidate plus the live parent in merge topology. |
| 6 — Regression | done | 2026-08-14 | Local and full disposable-DB suites passed. Final pre-commit fetch still has `origin/main=9cd9804d`; production remains `v1078/6f0d59df`, healthy on both machines. |
| 7 — Final report | pending | | |

## Reviewer assignments (Stage 1)
| Reviewer | Scope | Report |
|---|---|---|
| `/root/live_lineage` | Live release, branch ancestry, worktrees and open PRs | received |
| `/root/canonical_diff` | Canonical workstation/scanner/MVGS preservation and merge-risk files | received |
| `/root/release_gates` | CI, CodeQL and migration/release gating | received |

## Links
- Issue register: `issue-register.md`
- Change manifest: `change-manifest.md` (Stage 4)
- Rollout: `rollout.md`
- Rollback: `rollback.md`
- Deployment state: `deployment-state.md`
- Architecture before/after: `architecture-before.md`, `architecture-after.md`
- Definition of proof: `definition-of-proof.md`
- Reviewer evidence: `reviewer-status.md`
