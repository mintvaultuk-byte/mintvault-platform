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
- Stage 1-3 discovery: COMPLETE. 4 reviewers returned; synthesized G4-DISCOVERY.md; Lead verified the three architecture-blocking findings (no global-flag write path; no per-connector pause state; live-claim force-release unsafe) and set the deferral decisions.
- Phase 3 design: COMPLETE. 11 docs authored.
- Phase 5 audit migration 0014: COMPLETE + LOCALLY VERIFIED. `partner_connector_admin_actions` append-only table + rollback + migration test; 8/8 on fresh disposable PG; existing migration test 13->14 green (14/14). Commits 1551b9ca (docs), 43c02e01 (migration).

## CHECKPOINT (proof levels)
- Phases 1,2,3,5: COMPLETE — design docs (Design) + migration 0014 (Local Proof on disposable PG). No live migration applied.
- Phase 4 (authz model): DESIGNED (matrix) — not implemented (no routes yet).
- Phases 6-7 (operations API/service/routes): DESIGNED (API contract + action matrix) — NOT implemented.
- Phases 8-9 (Super Admin UI): DESIGNED (UI spec) — NOT implemented.
- Phase 14 (test matrix): Group A (migration) done; B-K NOT implemented.
- Phases 15-18 (reviews, gates, commits-for-code, controlled merge): NOT started (no code to review/merge beyond the migration).

## Next authorised action (carry-forward)
Implement `connector-admin-service.ts` (audit wrapper over the verified G3F service signatures) → `connector-admin-routes.ts` (requireAdmin, /api/super-admin/connector-ops) → wire one line in server/routes.ts → integration tests (Groups B-K) on disposable PG → UI (Phases 8-9) → 7 review panels → gates → controlled merge review. NO deploy, NO live migration, NO flag flip, NO portal mount — all remain owner-gated.
