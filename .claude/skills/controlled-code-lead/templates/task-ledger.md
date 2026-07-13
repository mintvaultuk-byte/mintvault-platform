<!--
Template: task ledger. The Stage 0 baseline record, updated as the task moves
through stages. Only the Lead updates this file.
-->

# Task ledger — <task name>

## Stage 0 — Baseline (recorded <date/time>)
- Branch: `<branch>`
- Commit: `<sha>`
- `git status`: <clean / N files uncommitted — listed below if not clean>
- Production commit (if deploy-adjacent): `<sha>` via `<how confirmed — /api/version, fly releases>`
- Build/test status: `<npm run check output summary>`
- Protected systems in play: <list, or "none">
- Explicit scope: <what this task covers>
- Explicit prohibited actions: <what this task must NOT do>

## Stage progress
| Stage | Status | Date | Notes |
|---|---|---|---|
| 0 — Baseline | done | | |
| 1 — Review plan | | | reviewer scopes assigned |
| 2 — Investigation | | | reports linked |
| 3 — Lead verification | | | |
| 4 — Implementation authorisation | | | change-manifest.md written |
| 5 — Implementation | | | |
| 6 — Regression | | | |
| 7 — Final report | | | |

## Reviewer assignments (Stage 1)
| Reviewer | Scope | Report |
|---|---|---|

## Links
- Issue register: `issue-register.md`
- Change manifest: `change-manifest.md`
- Rollout: `rollout.md`
- Rollback: `rollback.md`
- Deployment state: `deployment-state.md`
