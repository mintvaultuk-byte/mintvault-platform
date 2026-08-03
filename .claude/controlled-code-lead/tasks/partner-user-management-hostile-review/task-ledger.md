# Task ledger — Partner User Management hostile review

| Field | Value |
|---|---|
| Task ID | `partner-user-management-hostile-review` |
| Type | Read-only hostile review (no fixes authorised) |
| Date | 2026-07-29 |
| Repo | `git@github.com:mintvaultuk-byte/mintvault-platform.git` |
| Branch under review | `codex/partner-user-management` @ `ad7ab91c` (local == remote) |
| Commits | `37fdaed7` (invitations + owner login), `ad7ab91c` (portal team management) — exactly 2, no third |
| Merge base | `6f182624` (PR #265 merge) — confirmed ancestor of both branch and main |
| `origin/main` | `7f4f12e7` (Docker build-context hotfix) — 21 commits ahead of the base |
| Force-push | None. `origin/codex/partner-user-management` reflog shows two sequential pushes only. |
| Governance version | 1.1 |

## Stage state

| Stage | Status |
|---|---|
| 0 — Baseline | complete |
| 1 — Review plan | complete (4 read-only specialist reviewers, non-overlapping scopes) |
| 2 — Reviewer investigation | complete (security ×2, backend, frontend) |
| 3 — Lead verification | complete — every accepted HIGH/CRITICAL independently re-verified by the Lead |
| 4 — Implementation authorisation | **NOT STARTED — no fixes authorised** |
| 5 — Implementation | not started |
| 6 — Regression | test reproduction only (no code changed) |
| 7 — Final report | delivered |

## Protected actions taken

**None.** No push, no deploy, no migration applied to any shared environment, no secret read or written,
no staging/production write, no paid-provider call, no dependency change, no commit, no amend, no rebase,
no merge (the integration merge was a throwaway worktree, aborted and removed).

## Environment used for proof

- PostgreSQL **17.10** (Homebrew `postgresql@17`) started on port 5433 against a disposable data dir in
  the session scratchpad. Requires `LC_ALL=C LANG=C` or the postmaster dies with
  "became multithreaded during startup".
- Disposable databases only: `pum_t1..t4`, `pum_rls`, `pum_owner`, `t_pum_mig`, `t_pm_rt`, `t_prt`.
- Migrations applied as the **non-superuser `pn_migrator`** role (the realistic role model), not as
  `postgres` — the branch's own migration test applies 0031 as superuser.
- Two throwaway worktrees: `wt-pum` (branch tip) and `wt-main` (origin/main), both read-only.

## Verdict

**NEEDS MORE WORK.** 1 Critical, 5 High. See the Stage 7 report.

## Next authorised action

Await owner decision on the remediation set. **Not authorised:** merge, rebase, push, deploy,
migration application, amending `37fdaed7` or `ad7ab91c`.
