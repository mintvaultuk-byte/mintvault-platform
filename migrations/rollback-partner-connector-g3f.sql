-- ROLLBACK for the Trusted Intake Connector — Phase G3F (migration
-- 0012_partner_connector_import_attempts.sql).
-- NOT a forward migration (no NNNN_ prefix -> the runner ignores it). Removes ONLY the G3F objects:
-- the append-only partner_connector_import_attempts table (and its indexes/grants, dropped with it).
-- Does NOT touch any G1/G2/G3/G3E/Phase 1/2 object.
--
-- CRITICAL: never deletes or modifies any row in submissions/submission_items/users, and never
-- touches partner_connector_imports/_records/_events/_validation_runs data — only the new
-- append-only evidence table is removed. Rolling back G3F returns the audit model to the G3E state
-- (mapping-fingerprint-only, with the documented resume ambiguity) — a safe, known prior state.
-- Imported MintVault destinations survive untouched.
--
-- Idempotent (IF EXISTS everywhere). Owner-approved protected action only; rehearse on a disposable
-- DB first.

BEGIN;

DROP TABLE IF EXISTS partner_connector_import_attempts CASCADE;

DELETE FROM schema_migrations WHERE filename = '0012_partner_connector_import_attempts.sql';

COMMIT;
