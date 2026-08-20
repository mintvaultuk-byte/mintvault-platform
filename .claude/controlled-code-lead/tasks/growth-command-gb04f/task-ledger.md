# Task ledger — GB-04F latency diagnosis and premium gauge redesign

## Stage 0 — Baseline (recorded 2026-08-20 19:50 UTC)

- Governed repository/worktree: `/Users/cornelius/mintvault-growth-command-gb04f`.
- Branch / commit: `codex/growth-command-gb04f` at `d67e3472ef43a5e1bc27e6bab778dc613f495f7e`.
- Worktree: clean before governance records; isolated from the dirty owner worktree and other active worktrees.
- Canonical `origin/main`: `d67e3472ef43a5e1bc27e6bab778dc613f495f7e`.
- Production: `/api/version` reports deployed GB-04E candidate `1e868cc7`; Fly v1114, image `deployment-01M0G52W5NQV0XWV0ECK5BP8AN`; machines `683720eb5127d8` and `83d479c745d0d8` are LHR/started/1 of 1 checks passing.
- Governance: v1.2, combined instruction hash `a87b4b87340c986446937dce6ec4d37cd5471ff182d08569e1075b9746139ce4`.
- Engineering OS: risk `CRITICAL`, execution mode `HOSTILE`; graph rebuilt for this source commit (13,079 nodes / 29,095 edges).
- Open BLOCKER/HIGH: none accepted at baseline. Existing observed Fly p95 requires attribution before classification.
- Protected systems in play: production Fly release; Super Admin Growth authentication and aggregation route; production database read readiness; provider and telemetry secrets; payment, Partner, Scanner and AI programme boundaries.
- Approved scope: diagnose latency; implement bounded server-side route/dependency/machine aggregation; correct capacity attribution; redesign authenticated Growth gauges; exact-SHA CI and controlled release when gates pass.
- Explicit prohibitions: infrastructure scaling, CPU/RAM/machine changes, automatic scaling, provider credentials/configuration, migrations, payment/Partner/Scanner changes, AI programme mutation, secrets exposure, PII/request-log retention and unapproved spend.
- Current authorised action: read-only route, telemetry, production and AI-workload attribution.

## Stage progress

| Stage | Status | Date | Notes |
|---|---|---|---|
| 0 — Baseline | COMPLETE | 2026-08-20 | Canonical, production, fleet, governance and graph reconciled. |
| 1 — Review plan | COMPLETE | 2026-08-20 | Lead-only investigation; no agent fan-out authorised for this session. |
| 2 — Investigation | COMPLETE | 2026-08-20 | Live production proves sparse, machine-max Fly p95 authority with no route/sample/dependency attribution; source is bounded process-local request telemetry. |
| 3 — Lead verification | COMPLETE | 2026-08-20 | No resource, database or observed-5xx correlation; route attribution is required before any latency diagnosis. |
| 4 — Implementation authorisation | COMPLETE | 2026-08-20 | Change manifest, budget, architecture, rollback and rollout are frozen; no protected-system mutation is required. |
| 5 — Implementation | COMPLETE | 2026-08-20 | Bounded route/class/dependency telemetry, customer-first latency authority, machine request counts and premium presentation implemented without protected-system mutation. |
| 6 — Regression | IN PROGRESS | 2026-08-20 | Focused contracts, typecheck, changed-file lint and production build pass; full remote CI remains required. |
| 7 — Final report | PENDING | | |

## Reviewer assignments (Stage 1)

No subagents assigned: session policy prohibits unrequested delegation. Independent hostile review will be performed through the approved exact-SHA release workflow.

## Links

- Issue register: `issue-register.md`
- Change manifest: `change-manifest.md` (pending Stage 4)
- Rollout: `rollout.md` (pending Stage 4)
- Rollback: `rollback.md`
- Deployment state: `deployment-state.md`
