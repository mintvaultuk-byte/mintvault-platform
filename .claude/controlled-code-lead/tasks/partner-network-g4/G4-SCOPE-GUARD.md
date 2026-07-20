# G4 Scope Guard

## In scope (this program)
Internal Super-Admin operations layer for Partner connectors: read inspection APIs, safe mutation APIs that DELEGATE to existing G3F services (retry / reconcile / resolve-reconciliation / manual-review / release-expired-claim), an append-only admin-action audit (migration 0014), and a Super-Admin UI inside the existing admin app.

## Hard boundaries (owner, non-negotiable — asserted by tests + reviews)
- No public Partner Portal mount; `createPartnerApp` stays test-only.
- No `partner_portal_enabled` write; no `partner_connector_enabled=true` write (production enablement).
- No public/partner-facing connector routes; all G4 routes are `requireAdmin`-gated under `/api/super-admin/*`.
- No deploy; no live migration application (disposable PG only); no G5.
- No grading/grade/certificate/cert-number/label/print-batch/payment/Stripe/email/notification/webhook/Vault-Quest creation or mutation.
- No bypass of G3F exactly-once; no direct write to `partner_connector_imports`/`_attempts`/`_records` state — all state changes go through G3F services.
- No mutation of append-only history (`partner_connector_import_attempts`, `partner_connector_events`, and the new admin-actions table are SELECT/INSERT only).
- No arbitrary SQL / unrestricted operational commands; every action is a named, allow-listed operation.
- No tenant data leakage; no exposure of provider secrets/tokens/passwords/connection strings (response allow-list + redaction).
- No silent retry of permanent failures; no unconfirmed destructive bulk action.

## Deferred this pass (documented limitations — require owner approval + dedicated increment)
- **Global connector stop / emergency-stop WRITE** (G4-DISC-01): no existing write path to the global `partner_feature_flags(tenant_id IS NULL)` row; net-new flag-write bordering the "don't enable connector in prod" boundary. G4 shows this state READ-ONLY only.
- **Per-connector pause / disable**: no per-record state exists; adding it mutates the exactly-once state machine (schema + transition change). Not built.
- **Batch retry**: implemented only AFTER single-record retry is proven; bounded, explicit IDs, no "all matching". If not reached this pass, deferred.
- **Force-release of a LIVE claim**: no safe service; only expired-lease reclaim is exposed.

## Files expected to change (allow-list for drift checks)
- `migrations/0014_partner_connector_admin_actions.sql`, `migrations/rollback-partner-connector-admin-actions.sql`
- `server/partner/connector-admin-service.ts` (NEW — orchestration + audit wrapper over G3F services)
- `server/partner/connector-admin-routes.ts` (NEW — `requireAdmin` router)
- `server/partner/connector-admin-errors.ts` (NEW — stable G4 error-code map) [or fold into service]
- `server/routes.ts` (ONE registration line)
- `tests/partner-connector-admin-*.test.ts` (NEW)
- `tests/helpers/partner-realistic-db.ts` (add 0014 to migration lists)
- `client/src/pages/admin/partner-network*.tsx` (NEW, if UI reached), `client/src/App.tsx` (routes), `client/src/components/admin/admin-shell.tsx` (one NavLink) — UI phase
- `.claude/controlled-code-lead/tasks/partner-network-g4/*` (docs)

Any file outside this list appearing in `git diff --stat` = STOP and explain.
