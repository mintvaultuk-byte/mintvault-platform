# Task ledger — Growth / Partner canonical reconciliation

## Stage 0 — baseline (2026-08-21)

- Worktree: `/private/tmp/mintvault-growth-partner-canonical-reconcile`.
- Branch: `codex/growth-partner-canonical-reconciliation`.
- Canonical baseline: `origin/main` = `718f60e750128251fd78774616354bf7c3ebafe7`.
- Live release lineage: `/api/version` reports `337776e6`; that commit is not an ancestor of canonical main.
- The shared merge base is `2d776db900e66f5bb0552ea2159a6d1586226a53`.
- The owner authorises a semantic, non-rewriting reconciliation only. Deployment, migrations, provider configuration, infrastructure, payments, Partner authority changes, and Scanner authority changes are prohibited.

## Stage progress

| Stage | Status | Evidence |
| --- | --- | --- |
| 0 — Baseline | complete | Exact refs and live version recorded above; clean isolated worktree. |
| 1 — Review plan | complete | Preserve both ancestors through a non-fast-forward semantic merge; review every conflict. |
| 2 — Investigation | complete | The normal merge had no textual conflicts; exact migration identity, live/public route composition and source preservation were inspected. |
| 3 — Lead verification | complete | Growth source/test bytes remain canonical; `0102`/`0103` match live exactly; behavioral and migration suites passed. |
| 4 — Implementation authorisation | complete | Owner's final reconciliation instruction authorises the bounded candidate, push, PR and exact-SHA verification. |
| 5 — Implementation | complete pending security-repair commit | The semantic merge was clean. GitHub CodeQL then identified two real preserved-live security defects, repaired minimally without authority or layout change. |
| 6 — Regression | local proof complete; new exact-SHA CI pending | 339 initial focused tests plus 35 security-repair assertions, 25 migration/schema tests, check/lint/build/Graphify/governance passed. |
| 7 — Final report | pending | No deployment in this task. |

## Links

- Issue register: `issue-register.md`
- Change manifest: `change-manifest.md`
- Implementation budget: `implementation-budget.md`
- Proof map: `proof-map.md`
- Rollback and deployment boundary: `rollback.md`
