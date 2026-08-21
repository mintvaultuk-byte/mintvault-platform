# Task ledger — Partner supplies ordering

## Stage 0 — Baseline (recorded 2026-08-20 Europe/London)

- Governed repository: `/private/tmp/mintvault-partner-supplies-staging.20260820`; the shared checkout is dirty and excluded.
- Candidate branch: `codex/partner-supplies-staging-20260820`, initially a fresh worktree from `origin/main` (`2d776db9`) carrying only Supplies. During final guarded-release preflight, staging's live `aab526ea` was proven a divergent ancestor requirement, so the final candidate is a normal merge of that live full-resolution-evidence release with the Supplies branch; only its Partner-nav conflict is manually reconciled to retain the five primary items and add Supplies/My Orders under More.
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
| 6 — Regression | in progress | 2026-08-21 | Live Supplies readiness investigation found zero canonical contacts for the exact active staging tenant and no contact audit event. SP-14 narrows the existing delivery query to the explicitly required active primary operations contact; the requested real-PostgreSQL matrix is being run before a guarded staging redeploy. |
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
