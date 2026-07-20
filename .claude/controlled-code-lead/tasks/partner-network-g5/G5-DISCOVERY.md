# G5 Discovery — Partner Management

Synthesis of four read-only discovery reviews (schema/tenancy; admin auth/API; admin UI/nav; migration/testing/protected) against `origin/main = 4d0c370f` (G1–G4). Lead-verified the load-bearing facts directly (partner_organisations DDL, RLS idiom, migration-count assertion, migration list).

## Schema (verified)
- `partner_organisations` = exactly the 0001 shape (no later ALTERs): `id, public_ref, legal_name, status (default 'PENDING'; comment-enum PENDING|ACTIVE|SUSPENDED|REVOKED, NO CHECK), accreditation_level, health, created_at, created_by, updated_at, tenant_id (GENERATED ALWAYS AS (id) STORED)`. Mirrored in `shared/partner-schema.ts` under a PARITY TEST (`tests/partner-schema-parity.test.ts`) → any org column addition must land in both. **Decision: do NOT ALTER the org table** — put all new metadata in an additive 1:1 `partner_profiles` table.
- No contacts table (partner_users = auth identities; partner_customers = the partner's OWN end-customers — wrong entity). No branding table/columns. No notes table. No parent_org_id. All net-new + additive.
- Activity sources: `partner_audit_events` (tenant_id NOT NULL, indexed), `partner_security_events` (tenant_id, indexed) are the SAFE cheap feed. `partner_connector_events` has NO tenant_id (join via records). `partner_connector_admin_actions.partner_organisation_id` is unindexed. No unified read-model.
- Statistics: safe tenant-indexed counts = partner_locations, partner_users, partner_submissions (idx (tenant_id,status)), partner_connector_records (by state). **UNAVAILABLE:** MintVault submissions/cards/certificates have NO tenant column and Phase-1 forbids adding one → per-partner cert/grade counts impossible → LABEL unavailable, never fake.

## Tenancy (verified)
- RLS: `partner_current_tenant()` reads `app.tenant_id` GUC, fail-closed NULL. Per-table `ENABLE`+`FORCE ROW LEVEL SECURITY` + `%I_tenant_isolation` policy `USING/WITH CHECK (tenant_id = partner_current_tenant())` (0001 DO-FOREACH idiom).
- Roles: `partner_runtime` (NOBYPASSRLS, SELECT-only on org), `partner_connector_runtime` (internal, NOBYPASSRLS), `pn_migrator` (owner, out-of-band), `partner_definer` (BYPASSRLS, 3 pre-auth funcs only).
- **G5 uses `partnerAdminQuery`** (privileged, NO RLS context) like the existing shell → every G5 query MUST filter `WHERE tenant_id=$1` explicitly. New tables still get FORCE RLS as defense-in-depth for the runtime pool.
- RLS proof harness: `tests/partner-rls-isolation.test.ts` `asPartner(tenant, fn)` = `SET ROLE partner_runtime` + `set_config('app.tenant_id', tenant, false)`.

## Admin auth/API patterns to reuse (from G4)
- `requireAdmin` (single top tier; actor = `req.session.authUserId`/`adminEmail`, server-derived). Register `express.Router()` + `r.use(requireAdmin)` + `registerPartnerManagementRoutes(app)` at `/api/super-admin/partner-management`, near `server/routes.ts:1417-1418`.
- Mirror the G4 modules: errors (`toG4Error`/`G4RequestError`/`g4StatusFor`/`clampPagination`/`requireReason`/`requireVersion`), routes (`actorOf`/`sendError`/`mutationResponse`, own mutation rate-limiter with the documented in-process caveat), service (`loadPartner`, `recordAttempt`/`recordTerminal`/`priorSuccess`/`withAudit`, `partnerAdminQuery` reads with explicit projections + positional-param filter builder).
- Global `csrfOriginCheck` already covers `/api/super-admin/*`. No zod on this surface — manual pure-helper validation. Envelope: resource-named list keys (`{partners,…,total,totalPages}`), error `{error:{code,message,operatorAction}}`, `requestId` threaded (prefix `g5-`). Idempotency: `priorSuccess` + partial-unique + `23505→alreadyCompleted`.
- GOTCHA: `/api/super-admin/*` is outside the `/api/admin` rate-limit + IP-allowlist prefixes → G5 brings its own limiter (matches G4).

## Admin UI patterns to reuse (from G4)
- Nav is 2-level only (no nested sub-items) and owner-frozen. **Keep `/admin/partner-network` = the G4 ops page unchanged**; add ONE additive `NavLink` ("Partners") + routes `/admin/partner-network/partners` and `/partners/:partnerId` (flat siblings, most-specific-first). IA (Overview/Partners/Connector-Ops/Audit) via in-page tabs + links, not sidebar structure.
- Clone the G4 page skeleton: `/api/admin/session` self-gate + redirect, `AdminShell`, `enabled`-gated `useQuery` + `apiRequest` + prefix `invalidateQueries`, reason-modal + typed-confirm + a11y (aria-labelledby, `<label htmlFor>`, Escape, autofocus). Detail page = in-page `useState<TabKey>` tabs. Pure helpers for testability.
- Guards: every versioned-entity edit carries `expectedVersion` (VERSION_CONFLICT — closes the stale-form-clobber class); always supply an explicit `queryFn` when a key holds an object.
- No DOM harness → tests = pure-helper units + source-assertion + **negative-scope asserts** (no wallet/credits/slots/billing/devices/pricing/marketplace/portal controls).

## Migration/testing recipe (verified)
- Next = 0015 (single additive file). Recipe: idempotent CREATE TABLE/INDEX IF NOT EXISTS, uuid PK (no sequence grant), CHECK not enum, GRANT to restricted role never PUBLIC, partner_-prefix auto-classifies, per-file BEGIN/COMMIT, linter-clean. Companion `rollback-partner-management.sql` (no NNNN_ prefix): BEGIN/COMMIT, refuse-if-later-dependent (`^001[6-9]_ OR ^00[2-9][0-9]_`), DROP TABLE CASCADE ×5, DELETE journal row, idempotent.
- Test wiring: add `PARTNER_MIGRATIONS_WITH_G5` to tests/helpers/partner-realistic-db.ts; **bump `toHaveLength(14)`→15** (+ title) in tests/partner-connector-migration.test.ts. Integration test needs an SSL disposable cluster (server/db.ts forces ssl) + full users DDL + partner_runtime/partner_connector_runtime login roles + TEST-ONLY admin-login fixture.

## Protected — G5 touches NONE
MVGS grading (shared/mvgs-*.ts, client/src/components/grading/*, server/grader.ts, server/labels.ts), cert_counter/numbering, Stripe/payment, R2 signing, Vault Quest, auth-logic. G5 = additive `partner_*` tables + a new requireAdmin admin surface + admin UI only. Never `db:push` — apply via the numbered runner (owner-gated; disposable-PG only this pass).
