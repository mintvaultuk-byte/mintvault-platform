# G4 Implementation Plan

Base `origin/main = e0973251`. Branch `feat/partner-network-g4-operations-admin`. Backend-first, each increment locally verified on disposable PostgreSQL before the next.

## Increment order
1. **Migration 0014** `partner_connector_admin_actions` (append-only) + rollback + add to test migration lists. Prove: apply/idempotent/preflight/grants/append-only/rollback (Group A).
2. **`connector-admin-service.ts`** — orchestration + audit wrapper over G3F services (read aggregators + the mutation delegators from the action matrix). Pure error-code map (`connector-admin-errors.ts`). No new connector logic.
3. **`connector-admin-routes.ts`** — `requireAdmin` router at `/api/super-admin/connector-ops`, explicit rate-limiter, manual body validation, stable error envelope. Register in `server/routes.ts` (one line).
4. **Tests** — Groups A–I + K on disposable PG (real-HTTP integration mirroring the existing shell integration test).
5. **UI** (Phase 8-9) — 8 pages + nav + source-assertion/integration tests (Group J).
6. **Reviews (7 panels) → gates → forward commits → controlled merge review.**

## Estimate (implementation budget)
- Migration + rollback + test: ~2 files + 1 test, ~250 lines.
- Service + errors: ~2 files, ~500 lines.
- Routes: ~1 file, ~300 lines.
- API tests: ~3 files, ~800 lines.
- UI: ~8 files, ~1500 lines + tests.
- Total estimate: ~17 files, ~3400 lines, ~10 commits. If actuals exceed ~25%, STOP and re-manifest.

## Proof discipline
Nothing is called "done"/"working" above its evidenced level (Design Only → Local Proof → Integration Proof → Staging → Production). This pass targets Local/Integration Proof on disposable PG only. No deploy, no live migration, no flag flip.

## Checkpoint policy
If the full program cannot reach Integration Proof in one pass, stop at the last fully-verified increment, report exactly which increments are verified vs designed-only, and carry the rest forward — never overclaim.
