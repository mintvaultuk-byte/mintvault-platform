# Task ledger — GB-04D Growth Command full live activation

## Stage 0 — Baseline (recorded 2026-08-20 11:21 UTC)

- Governed repository/worktree: `/Users/cornelius/mintvault-growth-command-gb04d`.
- Branch: `codex/growth-command-gb04d`.
- Commit: `ee7fbe43e995b623b488bb9875ca37d261c2dfc4`.
- `git status`: clean at task creation; ignored `node_modules` symlink uses the launch workspace dependency tree.
- Canonical `origin/main`: `e057a67d116162e65f0898c02f52d9a249c25069` after fetch. The baseline descends from it and carries the reviewed/deployed Command Centre lineage.
- Production commit: `ee7fbe43` via `https://mintvault.fly.dev/api/version`; Fly release `v1112`; two LHR machines started with 1/1 checks.
- Prior release registers: Growth Completion Night and Command Centre V1 assurance report zero open BLOCKER/HIGH; this task uses a new authoritative issue register.
- Governance: version 1.2; combined baseline governance hash `a87b4b87340c986446937dce6ec4d37cd5471ff182d08569e1075b9746139ce4`.
- Engineering OS: preflight `CRITICAL` / `HOSTILE`; graph `REBUILD_REQUIRED` because metadata is absent in the new worktree.
- Build/test status: baseline gates pending.
- Protected systems in play: server-side provider credentials, Super Admin authorization boundary, payment-event reads, Resend/R2 aggregate health, Partner/Scanner isolation, production database read authority, infrastructure controls, staging/production release.
- Explicit scope: connect technically available read-only telemetry; implement truthful bounded health/capacity/traffic/conversion/review/SEO/cost views; add safe owner-facing Fly control only if existing authority and security contracts permit; preserve GBP, MCP read-only scope, existing Growth and Command Centre systems; prove desktop/mobile and release safely.
- Explicit prohibited actions: no invented data; no secret values in code/client/logs; no auth/login/session semantic change without a new owner gate; no Stripe/webhook/payment-flow change without a new owner gate; no migration or DB mutation without a new owner gate; no infrastructure capacity/spend mutation merely for proof; no Neon autoscaling; no MCP writes; no force push or destructive action.
- Owner approval record: `owner-approval-record.md`. It authorizes only the exact GB-04D production activation deploy after all gates pass; it does not authorize secrets, migration, data, spend, capacity, or Git-push mutations.
- Current authorized action: read-only parallel investigation and Lead verification. Product edits remain unauthorized until the exact Stage 4 manifest/budget exists.

## Stage progress

| Stage                            | Status      | Date       | Notes                                                                                                                                                                                               |
| -------------------------------- | ----------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — Baseline                     | COMPLETE    | 2026-08-20 | Deployed SHA/main/worktrees/Fly fleet/secret names/governance reconciled.                                                                                                                           |
| 1 — Review plan                  | COMPLETE    | 2026-08-20 | Three non-overlapping read-only lanes assigned; Lead owns production/schema/runtime verification.                                                                                                   |
| 2 — Investigation                | COMPLETE    | 2026-08-20 | Three independent read-only reports reconciled; browser/provider/config authority also inspected.                                                                                                   |
| 3 — Lead verification            | COMPLETE    | 2026-08-20 | Accepted findings reproduced in source/tests/runtime; external authority gaps separately proven.                                                                                                    |
| 4 — Implementation authorisation | COMPLETE    | 2026-08-20 | Exact manifest, protected exclusions and budget frozen.                                                                                                                                             |
| 5 — Implementation               | COMPLETE    | 2026-08-20 | Lead-owned product/tests/handover; no protected mutation.                                                                                                                                           |
| 6 — Regression                   | IN PROGRESS | 2026-08-20 | CI-repair focused/type/lint/build/governance/graph and full disposable-URL suite green locally; resulting-SHA hostile and remote exact-SHA checks pending.                                                     |
| 7 — Final report                 | PENDING     |            | Required 23-section owner format.                                                                                                                                                                   |

## PR #322 CI-repair continuation — 2026-08-20

- Old candidate: `699d084f7ab112ed4b0fd2f9df359082bdaf861b`.
- Remote CI/security completed at that exact SHA: security green; CI and
  governance red only for GB04D-CI-001/002.
- Owner authorised a narrow repair of those two baseline contracts, one new
  branch push and exact-SHA verification. Merge/deploy and every production or
  provider mutation remain prohibited.
- Lead verification established that GB04D-CI-001 is a stale source assertion
  superseded by the stronger full-resolution working-evidence admission rule.
- The authorised five-file functional repair changes no product-runtime source.
  Focused proof is green at 58/58 on the workflow's existing PostgreSQL 17
  service at port 55433 and 15/15 against an unconfigured ephemeral local
  PostgreSQL 17 instance. `npm run check`, lint, build, repository governance,
  graph-current proof and the full suite are green; the full suite reports 394
  files, 5,598 passed and 779 environment-gated skips (6,377 tests total).
- Current authorised action: freeze the repair commit, run exact-SHA hostile
  review, push the existing PR branch and observe every required remote check.

## Reviewer assignments (Stage 1)

| Reviewer               | Scope                                                                                                                                | Report                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| Fly/control reviewer   | Fly telemetry authority, machine/cost APIs, capacity/control security and rollback; read-only                                        | complete; worktree clean |
| Provider/data reviewer | Neon, Resend, R2, Search Console, review authority, aggregate application/business health; read-only                                 | complete; worktree clean |
| Growth/UI/MCP reviewer | Existing Growth routes/UI/tests, traffic/conversion, GBP, gauges, incident/readiness, zero-dead controls and MCP boundary; read-only | complete; worktree clean |

## Links

- Issue register: `issue-register.md`
- Reviewer status: `reviewer-status.md`
- Change manifest: `change-manifest.md`
- Architecture before/after: `architecture-before.md`, `architecture-after.md`
- Implementation budget: `implementation-budget.md`
- Definition of proof: `definition-of-proof.md`
- Rollout: `rollout.md`
- Rollback: `rollback.md`
- Deployment state: `deployment-state.md`
- Approval record: `owner-approval-record.md`
