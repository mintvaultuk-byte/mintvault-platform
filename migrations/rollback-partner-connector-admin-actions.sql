-- ROLLBACK for the Trusted Intake Connector — Phase G4
-- (migration 0014_partner_connector_admin_actions.sql).
-- NOT a forward migration (no NNNN_ prefix -> the runner ignores it). Removes ONLY the G4 object:
-- the append-only partner_connector_admin_actions table (0014). Does NOT touch any G1/G2/G3/G3E/G3F/
-- Phase 1/2 data object.
--
-- CRITICAL: never deletes or modifies any row in submissions/submission_items/users, and never touches
-- partner_connector_imports/_records/_events/_validation_runs/_import_attempts DATA. The admin-actions
-- table is purely additive and is read by no connector service, so dropping it returns the system to
-- the exact G3F state with no functional loss beyond the admin operations ledger itself. Imported
-- MintVault destinations survive untouched.
--
-- Idempotent (IF EXISTS everywhere). Owner-approved protected action only; rehearse on a disposable DB
-- first. Refuses to run if a later dependent migration (0015+) that references this table is present.

BEGIN;

-- Refuse if a later migration depending on this table has been applied (mirrors the G1..G3E rollback
-- refusal pattern). No 0015+ exists at authoring time; this is a forward-safety guard.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE filename ~ '^001[5-9]_' OR filename ~ '^00[2-9][0-9]_') THEN
    RAISE EXCEPTION 'refusing G4 rollback: a later migration (0015+) is applied; roll it back first';
  END IF;
END$$;

DROP TABLE IF EXISTS partner_connector_admin_actions CASCADE;

DELETE FROM schema_migrations WHERE filename = '0014_partner_connector_admin_actions.sql';

COMMIT;
