# G5 Migration Plan (0015)

Single additive file `migrations/0015_partner_management.sql` + companion `migrations/rollback-partner-management.sql`. Applied ONLY to disposable PostgreSQL this pass (owner-gated for staging/prod; live-DB inventory pre-check required before any --apply).

## Forward 0015 (idempotent, per-file BEGIN/COMMIT, linter-clean)
Creates 5 tables (partner_profiles, partner_contacts, partner_branding, partner_internal_notes, partner_management_audit) per G5-DATA-MODEL. For each: `CREATE TABLE IF NOT EXISTS` (uuid PK, CHECK constraints, FK org ON DELETE RESTRICT); `CREATE INDEX IF NOT EXISTS` (tenant/org + created_at where read; partial-unique for contact-primary + audit-idempotency); `ENABLE`+`FORCE ROW LEVEL SECURITY` + `%I_tenant_isolation` policy (DO-block idiom, wrapped so the destructive linter passes); GRANTs (profiles/contacts/branding → SELECT to partner_runtime; internal_notes/management_audit → SELECT,INSERT to partner_connector_runtime; NO PUBLIC anywhere). No ALTER of partner_organisations. No pg enums. No sequence grants. No speculative indexes (each index serves a real query path in the service).

## Rollback (no NNNN_ prefix — runner ignores)
`BEGIN; refuse if a later dependent migration is applied (^001[6-9]_ OR ^00[2-9][0-9]_); DROP TABLE IF EXISTS <5 tables> CASCADE; DELETE FROM schema_migrations WHERE filename='0015_partner_management.sql'; COMMIT`. Idempotent; touches no G1–G4/Phase-1 object.

## Test-list wiring
- `tests/helpers/partner-realistic-db.ts`: add `PARTNER_MIGRATIONS_WITH_G5 = [...PARTNER_MIGRATIONS_WITH_G4, "0015_partner_management"]`.
- `tests/partner-connector-migration.test.ts`: bump `toHaveLength(14)`→15 (+ title text).

## Disposable-PG proof (fresh cluster, LC_ALL=C; SSL cluster for the HTTP integration test)
apply-from-zero; apply 0015; reapply no-op; preflight partnerNetwork classification + ok; exact index inventory per table; exact privilege inventory (grantees, no PUBLIC); RLS policy present + FORCE; cross-tenant denial (asPartner A cannot read B's contacts/branding/profile); append-only 42501 (internal_notes/management_audit UPDATE/DELETE/TRUNCATE reject; not-owner; exactly [INSERT,SELECT]); rollback drop+de-journal+reapply; full chain 0001–0015 (count 15). NEVER against staging/prod.
