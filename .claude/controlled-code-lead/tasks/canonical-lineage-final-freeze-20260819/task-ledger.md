# Task ledger — canonical lineage final freeze (2026-08-19)

## Stage 0 — Baseline (recorded 2026-08-19)

- Branch: `codex/mintvault-final-engineering-os-reconciliation`
- Commit: `d11579f1df86ee4db5ffe742136a6b22652d33be`
- `git status`: clean before this task's proof-ledger updates; unrelated active worktrees preserved.
- Production commit: began at `8359e902`; read-only `/api/version` later reported
  `158dbf53768187bb4176f3de0e9c23a26cff11fd`.
- Build/test status: inherited candidate gates were green; final postflight is the release-freeze
  gate and is not a deployment.
- Protected systems in play: Partner credit Checkout, Stripe webhooks, Partner RBAC, Scanner
  authority, migrations, production lineage.
- Explicit scope: semantically reconcile valid Partner/Scanner commits onto the canonical base;
  prove pricing/payment and migration safety; create a frozen release candidate.
- Explicit prohibited actions: no deploy, push, production/staging migration, database mutation,
  Stripe call/configuration, secret/environment change, Growth GB-04 edit, new product feature,
  force-push, reset, or wholesale merge of the active line.

## Stage progress

| Stage | Status | Date | Notes |
|---|---|---|---|
| 0 — Baseline | done | 2026-08-19 | Branches, live SHA, journal topology, active-line head, protected surfaces recorded. |
| 1 — Review plan | done | 2026-08-19 | Read-only payment/pricing hostile review; source and migration inventory. |
| 2 — Investigation | done | 2026-08-19 | Reviewer found three reproducible payment defects; migration and live-lineage comparison completed. |
| 3 — Lead verification | done | 2026-08-19 | Lead reproduced, traced callers, and accepted P5-TAX-001 and P5-EXC-001. |
| 4 — Implementation authorisation | done | 2026-08-19 | User's explicit reconciliation brief authorised local source/test reconciliation only; no protected external action was authorised. |
| 5 — Implementation | done | 2026-08-19 | Semantic replay plus contained payment repairs committed through `12c9a641`. |
| 6 — Regression | done | 2026-08-19 | 95 release-scoped Vitest tests and 152 Scanner tests passed; production-shaped PostgreSQL rehearsal, mutation, hostile re-review, check/lint/build, graph and clean-tree postflight validation passed. Broader Vitest ran 5,099 passing tests; five DB-dependent suites could not initialise because the expected disposable local PostgreSQL services are absent. |
| 7 — Final report | done | 2026-08-19 | Final refetch kept `origin/main` at `5a45ff9e`, Partner/Scanner at `72f57963`, and live production at `158dbf53`; the candidate is frozen pending separate owner-authorised CI/migration/release. |

## Reviewer assignments (Stage 1)

| Reviewer | Scope | Report |
|---|---|---|
| `pricing_hostile_review` | Stripe Checkout metadata, taxes, fulfilment/refund/dispute paths and current active Partner/Scanner head | Reproducible findings P5-TAX-001 and P5-EXC-001; targeted re-review clear after repair. |

## Links

- Issue register: `issue-register.md`
- Change manifest: `change-manifest.md`
- Rollout: `rollout.md`
- Rollback: `rollback.md`
- Deployment state: `deployment-state.md`
- Proof definition: `definition-of-proof.md`
