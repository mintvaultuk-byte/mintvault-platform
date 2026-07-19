# G4 — Partner Connector Operations API & Super Admin UI — Task Ledger

## Stage 0 — Baseline (recorded)
- Authoritative base: `origin/main = e0973251` (== the G3F merge; no advance since publication).
- G3F verified on origin/main: append-only provenance, exactly-once import, reconciliation/recovery, bounded worker, PostgreSQL concurrency protection.
- Shared checkout (`/Users/cornelius/mintvault-platform`) is on `feat/partner-network-phase-1-runtime` with unrelated uncommitted work — NOT used for G4 implementation.
- G4 branch: `feat/partner-network-g4-operations-admin`.
- G4 worktree: `/Users/cornelius/mintvault-worktrees/partner-network-g4-operations-admin` (created from e0973251, clean; node_modules symlinked, lockfile identical).

## Scope (owner-authorised)
Internal Super-Admin operations layer for Partner connectors: read inspection, safe state/retry/reconciliation/manual-review/worker-control actions, immutable admin-action audit, all via existing G3F services.

## Prohibited (owner, non-negotiable)
No public Partner Portal mount; no `partner_portal_enabled`; no `partner_connector_enabled` in production; no public connector routes; no deploy; no live migrations; no G5; no grading/cert/cert-number/label/print-batch/payment/Stripe/email/notification/webhook/Vault-Quest side effects; no bypass of G3F exactly-once; no mutation of append-only attempt history; no arbitrary SQL; no tenant leakage; no secret exposure; no silent retry of permanent failures; no unconfirmed destructive bulk actions.

## Protected actions (require owner approval each time)
push, deploy, migration APPLICATION (authored migration is fine locally on disposable PG only), secret/env changes, auth-logic edits, payment/Stripe edits, protected-system edits.

## Stage log
- Stage 0 baseline: COMPLETE.
- Stage 1 review plan (discovery): 4 read-only specialist reviewers dispatched (admin auth/API; DB/audit/flags/migrations; admin UI shell; G3F service entry points).
- Next authorised action: receive + verify discovery reports → write G4-DISCOVERY.md → Phase 3 design docs. No code, no migration application, no protected action.
