# G5 Test Plan

All DB tests on REAL disposable PostgreSQL (loopback, env-gated describe.skip). Integration test needs an SSL-capable disposable cluster (server/db.ts forces ssl). No mocking of RLS/locks/txns/constraints/append-only/idempotency.

## A. Migration (0015) — env PARTNER_MANAGEMENT_MIGRATION_ADMIN
apply+journal; reapply no-op; preflight ok + partnerNetwork; exact index inventory per table; exact grants (no PUBLIC); RLS policy + FORCE present per tenant table; append-only 42501 (internal_notes/management_audit UPDATE/DELETE/TRUNCATE; not-owner; exactly [INSERT,SELECT]); contact primary partial-unique blocks a 2nd active primary; audit idempotency partial-unique blocks a 2nd succeeded key; rollback drops exactly the 5 tables + de-journals + reapplies; full chain 0001–0015 (count 15).

## B. RLS tenancy (extend partner-rls-isolation pattern) — asPartner(tenant)
partner_runtime tenant A reads only A's profiles/contacts/branding; cannot read B's (0 rows); cannot INSERT a B-owned row (WITH CHECK reject); fail-closed on missing/empty/malformed app.tenant_id; partner_runtime has ZERO privilege on internal_notes + management_audit (cannot even SELECT).

## C. Real-HTTP integration (real requireAdmin, SSL cluster) — env PARTNER_MANAGEMENT_RT_ADMIN/_RT_RUNTIME
Auth boundary (unauth 401, forged-header 401, admin 200); partners list (filters/pagination/deterministic/secret-free); partner detail; profile update + VERSION_CONFLICT on stale expectedVersion; status transition valid + INVALID_STATUS_TRANSITION + REASON_REQUIRED; status change writes attempt+terminal audit + NO side effects (org.status changed only; no flags/portal/wallet/slots/users/devices touched); contact create + DUPLICATE_PRIMARY_CONTACT + edit + soft-deactivate (active=false, not deleted); branding upsert; note append + immutability (no edit/delete route; runtime role 42501); audit rows correct (actor server-derived, before/after safe); activity feed union; statistics (available counts correct; cert/graded null+unavailable); idempotency replay (note-add same key → alreadyCompleted, one succeeded row); cross-tenant param cannot widen; secret redaction (seed secret-looking values → absent from JSON + audit); rate-limit present.

## D. Service unit
status transition matrix; validation (pure helpers); audit payload redaction; contact-primary rule; safe-statistics shape; deterministic sorting; error mapping (toG5Error → codes/status).

## E. UI (no DOM harness)
pure-helper units (status→badge, transition validity, reasonValid, requireVersion, query-string, keys); source-assertion (data-testids; AdminShell + /api/admin/session gate; reason + expectedVersion + typed-confirm gating; a11y attrs; unavailable-metric labels present); NEGATIVE-scope asserts (no /wallet|/credits|/slots|/billing|/devices|/pricing|/marketplace, no portal write, no Buy Credits, no wallet balance).

## F. Regression (must stay green)
G4 connector admin integration + migration; connector full-chain migration (count 15); G3F importer; partner-rls-isolation; partner-runtime auth; partner-schema-parity; MVGS (mvgs-scoring/pristine/centering/mvgs-input-builder); tsc; eslint; prettier; build; secret scan.

## Gates (Phase 9)
tsc; eslint 0 errors (touched); prettier; build; A–F; changed-file inventory within allow-list; forbidden-file scan; confirm portal not mounted, flags untouched, migration not applied live, no protected-system edits, no deployment change.
