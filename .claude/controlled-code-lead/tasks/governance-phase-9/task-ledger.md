# Task ledger — governance-phase-9

Program: Governance Stabilisation, Enforcement & Durable Recovery.
This task governs the governance framework itself. It MUST NOT use an inline-only ledger.

## Stage 0 — Baseline (recorded 2026-07-11T08:33Z)
- Repo root: `/Users/cornelius/mintvault-platform`
- Branch: `governance-phase-9` (created off `main` @ `6439350`, to isolate governance from the VQ branches)
- Commit at start: `6439350` (Phase 7E; main tip). VQ Phase-8A commit `32f3f2b` lives only on `vq-phase8-staging-integration`.
- `git status`: `M CLAUDE.md` (the 55-line governance section added at session start — to be committed in 9A) + ~41 untracked governance files under `.claude/`.
- Governance snapshot (lock set): combined hash `0e91bb652dae00a7b6f0f96f0aed29149672b49374e0364fea11062cc299836d` — see `governance-snapshot.json`.
- Governance files under `.claude/` (excl. `settings.local.json`): **48 total, only 7 tracked** before this task.
- `settings.local.json`: gitignored (confirmed) — must never be tracked; holds local secrets (count-only in issue-register).
- Test/lint/build scripts (confirmed present in package.json): `check: tsc`, `test: vitest run`, `lint: eslint .`, `format: prettier`, `build: tsx script/build.ts`, `db:push` (protected). 21 test files incl. MVGS regression (`mvgs-scoring.test.ts`, `pristine.test.ts`, `centering.test.ts`).
- Explicit scope: Phase 9A only this session (stabilisation + version control). No app/business logic.
- Explicit PROHIBITED this session: push, deploy, migrations, staging/prod mutation, credential rotation/display, paid providers, DNS, storage deletion, grading/cert/payment/auth/submission edits, using unrestricted agents as reviewers, running 9B/9C before a restart proves reviewer isolation.

## Reviewer safety determination (Stage 0)
- `controlled-reviewer` + 10 specialist reviewers appeared AVAILABLE mid-session (via harness notifications) — but per Phase-9 restriction, mid-session registration is NOT trusted. 9A is Lead-only (no reviewer spawned). Reviewer isolation proof is DEFERRED to post-restart 9B. See `reviewer-status.md`.

## Stage progress
| Stage | Status | Notes |
|---|---|---|
| 0 — Baseline + durable task dir | done | this file + 7 siblings created |
| 9A.1 — one source of truth | done | `.agents/skills` + `AGENTS.md` = unused divergent duplicate → removed (untracked); `.claude/skills` authoritative |
| 9A.2 — governance under git | done | framework git-added (not settings.local.json); commit below |
| 9A.3 — test/lint correction | done | CLAUDE.md + SKILL.md corrected; Stage 6/DoD require real gates |
| 9A.4 — authority model | done | SKILL.md roles/protected-actions clarified |
| 9A.5 — session recovery | done | SKILL.md Session Recovery section added |
| 9A.6 — durable transitions | done | SKILL.md updated |
| 9A.7 — proof vocabulary | done | SKILL.md proof-state vocabulary added |
| Restart checkpoint | PASSED | resumed; recovery verified; snapshot MATCH `eab189ef` |
| 9B — enforcement & permissions | done | reviewer isolation PROVEN; secret rules removed; ask/deny; hook hardened+tested; approvals dir; protected-systems expanded |
| 9C — durable program + scale | done | program layer, cross-task index, template + multi-repo/parallel + memory + self-tests |

## NEXT AUTHORISED ACTION (read this first on resume)
1. Restart Claude Code (new process) so `.claude/agents/*` + hook registration loads from disk.
2. Resume this Phase-9 task: read this ledger, `issue-register.md`, `reviewer-status.md`, `governance-snapshot.json`, `change-manifest.md`.
3. Recompute the governance snapshot; compare to the post-9A value recorded in `governance-snapshot.json` (a `post9A` block will be added at commit). STOP if it differs unexpectedly.
4. Begin 9B ONLY after proving a spawned `controlled-reviewer` is denied Edit/Write/mutation (9B.1).
- Protected actions NOT authorised: everything in the PROHIBITED list above.

## Links
issue-register.md · change-manifest.md · evidence-index.md · rollout.md · rollback.md · governance-snapshot.json · reviewer-status.md
