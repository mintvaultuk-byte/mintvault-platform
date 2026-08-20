# Task ledger — GB-04E live provider activation

## Stage 0 — Baseline (recorded 2026-08-20 16:51 UTC)

- Governed repository/worktree: `/Users/cornelius/mintvault-growth-command-gb04d`.
- Branch: `codex/growth-command-gb04e`.
- Commit: `da9c4406e4249c35dcb54fd3f3f3171d1f7e9a9d`.
- Worktree: clean at branch creation; ignored dependency/worktree support files excluded.
- Canonical `origin/main`: `da9c4406e4249c35dcb54fd3f3f3171d1f7e9a9d`.
- Production: `da9c4406` from `/api/version`; Fly v1113; machines `683720eb5127d8` and `83d479c745d0d8`, both LHR/started/1 of 1 checks passing.
- Governance: version 1.2; combined governance hash `a87b4b87340c986446937dce6ec4d37cd5471ff182d08569e1075b9746139ce4`.
- Engineering OS: preflight risk `CRITICAL`; required mode `HOSTILE`; graph requires rebuild for this source commit.
- Open BLOCKER/HIGH: none accepted at baseline.
- Protected systems: production provider credentials/configuration, Super Admin Growth auth, production database read authority, Resend, external MCP auth, Fly production release, payment/Partner/Scanner boundaries.
- Approved scope: provider-scoped read-only activation; necessary server-side secret/config updates; canonical existing review destination/sender activation only if unambiguous; exact-SHA CI and guarded release if required.
- Prohibited: CPU/RAM/machine-count or Neon-compute changes; autoscaling; new paid plans/accounts or arbitrary spend; migrations; payment/Partner/Scanner authority changes; secret exposure; weaker auth; fake review sends; destructive operations.
- Current authorised action: read-only provider authority discovery and source/runtime contract verification.

## Stage progress

| Stage                            | Status      | Notes                                                                                                                       |
| -------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------- |
| 0 — Baseline                     | COMPLETE    | Exact main/production/Fly/governance/worktree reconciled.                                                                   |
| 1 — Review plan                  | COMPLETE    | Provider lanes frozen; exact candidate receives independent hostile review after local gates.                               |
| 2 — Investigation                | COMPLETE    | Production secret-name inventory, provider APIs, existing adapters, server/UI contracts and owner-only boundaries verified. |
| 3 — Lead verification            | COMPLETE    | Fly gap reproduced in production and source; all other provider gaps classified as owner-action boundaries.                 |
| 4 — Implementation authorisation | COMPLETE    | Owner's durable GB-04E approval applies; exact manifest, budget and proposed architecture frozen before product edits.      |
| 5 — Implementation               | COMPLETE    | Server-only Fly read adapter and narrow intelligence integration; no provider config/runtime mutation yet.                  |
| 6 — Regression                   | IN PROGRESS | Focused/full/typecheck/build/lint/live-read green; candidate hostile/exact-SHA remote/security/live deployment pending.     |
| 7 — Final report                 | PENDING     | Owner-required 15-section activation result.                                                                                |

## Verified provider disposition before implementation

- Fly: `GB04E-FLY-001` accepted for repair. The runtime has no provider client even though a documented read-only authority and real production metrics are available.
- Neon: application database availability, latency and pool pressure remain real; compute/storage/PITR require a new dedicated Neon Viewer identity/API key and are owner action only.
- Search Console: the least-privilege adapter already exists; a dedicated service account must be added to the canonical property and configured by the owner.
- Reviews: the neutral lifecycle already exists, but no canonical destination is unambiguous. Outbound activation is owner action only; no test customer message will be sent.
- MCP: the aggregate read-only server already exists, but external client installation and secure bearer handoff require an owner-controlled ChatGPT connection step.
- Costs/budget/manual scaling: no approved billing/FX/budget authority exists and no mutation surface is permitted. These remain truthful UNKNOWN/recommendation-only.

## Implementation evidence before candidate freeze

- Live read-only Fly probe: two LHR/started/passing machines; sanitized per-machine CPU, memory, request rate, p95, 5xx, deployment tag and baseline SHA parsed successfully.
- Capacity: real GREEN under the observed five-minute window; request rate remains context-only; automatic scaling false.
- Focused: 4 test files / 35 tests passed.
- Full CI-equivalent: 395 files / 6,381 passed / 2 intentional skips / 0 failed on clean disposable PostgreSQL services at 55432/55433.
- Typecheck, lint and production build: passed. Changed files: Prettier-clean. Repository-wide format gate: pre-existing unrelated baseline failure.
- Runtime/provider mutations: none. No token created; no production secret changed; no deployment performed.
