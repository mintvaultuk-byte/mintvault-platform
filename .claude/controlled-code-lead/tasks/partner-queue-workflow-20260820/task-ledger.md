# Task ledger — Partner queue evidence and shop-floor workflow

## Stage 0 — Baseline (recorded 2026-08-20 Europe/London)

- Governed repository: `/Users/cornelius/mintvault-platform`; isolated worktree: `/tmp/mintvault-partner-queue-staging.20260820`.
- Branch / commit: `codex/partner-queue-workflow-staging-20260820` at `e057a67d116162e65f0898c02f52d9a249c25069` (`origin/main`).
- `git status`: clean in the isolated worktree. The shared checkout is dirty and excluded.
- Production: `ee7fbe43`, release `v1112`, confirmed via `https://mintvault.fly.dev/api/version` on 2026-08-20.
- Staging: `ee7fbe43`, release `v545`, confirmed via `https://mintvault-v2.fly.dev/api/version` on 2026-08-20.
- Protected systems in play: grading workstation evidence admission; Partner tenant/location scope; R2 signed evidence URLs. MVGS mathematics, card-tool geometry, payments, auth and capture authority are out of scope.
- Explicit scope: recover the already owner-authorised full-resolution working-evidence admission contract onto current main; show server-derived per-side evidence status and safe thumbnails in Partner grading; simplify Partner navigation/dashboard without deleting records or capabilities; audit the named staging records read-only.
- Explicit prohibitions: no production changes, deploy, migration, destructive data action, credit/reservation mutation, Stripe/auth/scanner/MVGS-maths change, or customer-data deletion.

## Stage progress

| Stage | Status | Date | Notes |
|---|---|---|---|
| 0 — Baseline | done | 2026-08-20 | Current main and live artifacts reconciled. |
| 1 — Review plan | done | 2026-08-20 | Lead-only review; no delegated agents. |
| 2 — Investigation | done | 2026-08-20 | Source, live artifact, route/capability and staging read-only evidence ledger inspected. |
| 3 — Lead verification | done | 2026-08-20 | PQW-F1–3 reproduced; no schema/migration or data mutation is required. |
| 4 — Implementation authorisation | done | 2026-08-20 | The owner request authorises local non-maths changes in `change-manifest.md`; deploy remains excluded. |
| 5 — Implementation | done | 2026-08-20 | PQW-F4–6 repaired without a migration, data mutation, Scanner, payment, auth or MVGS change. |
| 6 — Regression | done | 2026-08-20 | Focused evidence/workstation/lease checks, protected grading regression, production build, changed-file lint, and the 70-suite/1,313-assertion governed Partner matrix all passed. Final hostile re-review is clear. |
| 7 — Final report | pending | | The owner deploy approval names `030ecb34`; the repaired candidate will require a fresh exact-SHA approval before guarded staging release. |

## Reviewer assignments (Stage 1)

| Reviewer | Scope | Report |
|---|---|---|
| Lead | Queue, evidence, Partner route/capability and dashboard authority | This ledger and issue register |

## Links

- Issue register: `issue-register.md`
- Change manifest: `change-manifest.md`
- Rollout: `rollout.md`
- Rollback: `rollback.md`
- Deployment state: `deployment-state.md`
