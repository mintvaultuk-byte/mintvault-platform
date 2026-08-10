# Task ledger — partner-full-pilot

## Stage 0 — continuation baseline (2026-08-10)

- Repository: `/Users/cornelius/mintvault-final-integration`
- Branch: `codex/mintvault-final-product-integration`
- Start commit: `f51f0a4c122bd91a49c4df557fc6c7e9a97d8db4`
- Worktree: clean before this bounded repair; `server/grader.ts` was restored unchanged after a protected-regression guard rejected a direct query edit.
- Active task: owner-authorised staging pilot continuation. Production is explicitly out of scope.
- Owner authorisation: the attached 2026-08-10 staging rollout directive authorises staging-only defect repair, commit, push, CI, redeploy, and retest; it forbids production mutation, force-push, journal rewriting, and skipped failed preflights.
- Protected systems: the MVGS engine remains byte-identical. The repair only moves a read-only Partner assignment projection out of `server/grader.ts`; no scoring, centering, state transition, Stripe, authentication, migration, or R2 signing code changes.

## Stages

| Stage | Status | Evidence |
| --- | --- | --- |
| 0 — Baseline | complete | branch/head/status reconciled; staging pilot state recovered from the active session |
| 1–3 — Verify findings | complete | staging `GET /api/admin/submissions/327/certs` returned 500; connector detail marked the valid two-card reservation set inconsistent; final HQ approval exposed PFP-03: destination remained `draft`, so the database rejected `draft → ready_to_return` and no credits moved. |
| 4 — Change manifest | complete | `change-manifest.md` |
| 5 — Implementation | complete | Partner-owned lookup adapter; cardinality-safe connector projection; no protected-engine diff |
| 6 — Regression | complete locally | typecheck; 49 focused; 323 protected; 15 runtime; 21 pilot; 56 corrected importer/lifecycle/scale proofs; lint; production build. |
| 7 — Staging activation | in progress | PFP-01/02 deployed and live-proven; PFP-03 requires a bounded importer-state repair, exact-SHA CI, staging redeploy, audited test-item transition/re-drive, then resume the live pilot. |

## Reviewers

No reviewer agents were used. This is a single-session, bounded staging repair; the Lead directly reproduced and verified each finding.
