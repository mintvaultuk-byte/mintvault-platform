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
| 7 — Staging activation | complete | `6f4e2652` deployed only through the safe staging path after all five required checks passed. `/api/version` and `/api/health` are green; PFP-01/02/03 are live-proven, including exactly-once two-credit settlement through audited normal status transitions. |
| 8 — Post-settlement software proof | complete | Both certificates are approved; both label render endpoints return 200; a one-card print selection is refused, while the complete two-card batch renders and reaches `printing` with two events. Public Finder stays fail-closed with its flag off; public Needs Attention is empty. |
| 9 — External pilot gates | blocked externally | No physical printer, scanner/V850, or NFC writer is available. Staging Stripe is in test mode but has no `STRIPE_WEBHOOK_SECRET`, so signed Supply Order webhook/replay proof cannot be run or safely fabricated. Browser interaction is unavailable in this execution environment. |

## Reviewers

No reviewer agents were used. This is a single-session, bounded staging repair; the Lead directly reproduced and verified each finding.
