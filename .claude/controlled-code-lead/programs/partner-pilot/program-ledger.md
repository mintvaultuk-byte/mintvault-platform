# Program ledger — Partner Pilot

## Owner objective

One real Partner card can move through controlled credit, target-bound capture,
server-authoritative grading, 100% Super Admin QA, server-enforced print, and
completed Partner history on the canonical MintVault platform.

## Current phase

Pass 2 — reconciliation and completion. This program record begins from the
current production/main lineage; it does not claim activation of code from any
other worktree.

## Ground-truth baseline — 2026-08-12

- Production `/api/version`: build `MV-P5-20260225-nohalf`, commit `b0de0880`.
- Production `/health`: `200 {"status":"ok"}`.
- Production Partner probes: `/api/partner/me` and
  `/api/partner/stations/enrolment-locations` both returned `503`.
- `origin/main`: `864fadeda88e06e083bfa483a7fe33520a4570e2`, one descendant
  commit after live `b0de0880`.
- Pass 1 source: `7368b07e695b64ceaa9e7c449ce844c2ef00afc3`, exactly one
  commit ahead of `origin/main`; it has not been integrated into this branch.

## Non-negotiable constraints

- Protected MVGS mathematics, labels, auth, Stripe/webhook, R2 signing,
  certificate allocation, secrets, migration application and deployment retain
  their owner-approval gates.
- Partner runtime must fail closed and must never fall back to a privileged DB
  connection.
- Pilot 1 is 100% Super Admin QA. Adaptive QA is not a Pass 2 prerequisite.
- A production deployment, runtime secret/configuration change, database role
  creation, migration, paid Stripe call, or physical card/print action requires
  a specific owner approval or owner interaction.

## Phase task

- `tasks/partner-pilot-pass2/` — active reconciliation/integration task.
