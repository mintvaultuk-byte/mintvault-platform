# Task ledger — Partner supplies ordering

## Stage 0 — Baseline (recorded 2026-08-20 Europe/London)

- Governed repository: `/private/tmp/mintvault-partner-supplies-staging.20260820`; the shared checkout is dirty and excluded.
- Candidate branch / commit: `codex/partner-supplies-staging-20260820` at `3e5d9bd1d60a609c35561d3558163dc86bbb64a3`, a fresh worktree from `origin/main` (`2d776db9`), with only the Supplies commit reconciled; isolated worktree is clean.
- Existing release state: staging remains Fly release `v546`; its guarded replacement is not deployed because this Mac cannot resolve the staging hostname. Production is Fly release `v1114` and prohibited.
- Protected systems in play: Partner tenant/location scope, shared schema/migrations, Super Admin RBAC, existing Resend provider integration, staging deploy and a staging test-order data mutation. MVGS, Scanner, Stripe, Partner authentication and production are excluded.
- Explicit scope: durable Partner supplies orders for plastic graded slabs, print paper/label stock and NFC tags; address snapshotting; idempotent Resend notification/retry; Partner and Super Admin views and status workflow; hard tests and staging-only release/E2E.
- Explicit prohibitions: no production deploy/migration/data mutation; no Stripe/payment; no grading/Scanner redesign; no authentication, R2 signing or MVGS changes; no real stock dispatch.

## Stage progress

| Stage | Status | Date | Notes |
|---|---|---|---|
| 0 — Baseline | done | 2026-08-20 | Clean isolated candidate and live release controls reconciled. |
| 1 — Review plan | done | 2026-08-20 | Three read-only hostile review lanes completed; no reviewer mutated code, data, mail, or release state. |
| 2 — Investigation | done | 2026-08-20 | Lead verified the existing session, RLS, migration, audit, Resend, outbox, shell and admin authorities. |
| 3 — Lead verification | done | 2026-08-20 | Findings SP-01 through SP-07 are evidence-backed and accepted below. |
| 4 — Implementation authorisation | done | 2026-08-20 | Owner authorised staging-only implementation and one eventual staging test order. |
| 5 — Implementation | done | 2026-08-20 | Durable order/outbox, scoped Partner/Super Admin surfaces, cache policy, retry/reconciliation safety and all requested three products are implemented. |
| 6 — Regression | in progress | 2026-08-20 | Fresh-candidate graph and scoped real-Postgres/source/UI/RBAC/cache suite are green (142 passed; explicitly environment-gated legacy skips); full suite, typecheck, SQL/lint/build and guarded deploy/browser/E2E remain pending. |
| 7 — Final report | pending | | |

## Reviewer assignments (Stage 1)

| Reviewer | Scope | Report |
|---|---|---|
| Persistence/RBAC hostile reviewer | Existing Partner address/order schema and server RBAC path; no edits. | complete — SP-01…SP-05 |
| Provider/retry hostile reviewer | Existing Resend transport, outbox/idempotency/audit patterns; no edits. | complete — SP-06 |
| UX hostile reviewer | Existing Partner secondary navigation and Super Admin order interfaces; no edits. | complete — SP-07 |

## Links

- Issue register: `issue-register.md`
- Change manifest: `change-manifest.md`
- Rollout: `rollout.md`
- Rollback: `rollback.md`
- Deployment state: `deployment-state.md`
- Definition of proof: `definition-of-proof.md`
