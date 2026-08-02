-- ROLLBACK for Partner Network — Phase G5 (migration 0015_partner_management.sql).
-- NOT a forward migration (no NNNN_ prefix -> the runner ignores it). Removes ONLY the five G5
-- tables. Does NOT touch any G1/G2/G3/G3E/G3F/G4/Phase-1 object, and never touches any MintVault-
-- internal table (submissions/cards/certificates/cert_counter). partner_organisations is NOT altered
-- by 0015, so nothing there to revert. Additive-only forward migration -> a clean CASCADE drop.
--
-- Idempotent (IF EXISTS everywhere). Owner-approved protected action only; rehearse on a disposable DB
-- first. Refuses to run if a later dependent migration (0016+) is present.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE filename ~ '^001[6-9]_' OR filename ~ '^00[2-9][0-9]_') THEN
    RAISE EXCEPTION 'refusing G5 rollback: a later migration (0016+) is applied; roll it back first';
  END IF;
END$$;

-- Drop in FK-safe order (partner_internal_notes self-references; management_audit/contacts/branding/
-- profiles reference only partner_organisations). CASCADE removes their own indexes/policies.
DROP TABLE IF EXISTS partner_management_audit CASCADE;
DROP TABLE IF EXISTS partner_internal_notes CASCADE;
DROP TABLE IF EXISTS partner_branding CASCADE;
DROP TABLE IF EXISTS partner_contacts CASCADE;
DROP TABLE IF EXISTS partner_profiles CASCADE;

-- ROLLBACK LEDGER — mint the reapply marker BEFORE retracting the journal row.
--
-- The numbered runner refuses a pending migration numbered below the highest applied, because that
-- is how a stale branch lands a schema change underneath later ones. A deliberate rollback creates
-- the same shape, so without this the runner cannot tell "the operator just backed this out" from
-- "a stale branch turned up", and re-applying what was just removed is impossible.
--
-- The checksum is copied FROM the journal row — what was genuinely applied to THIS database — never
-- hashed from disk, so a migration edited at any point after it was applied fails the comparison.
-- watermark_at_rollback pins the journal as it stands right now: the marker dies the moment any
-- other migration is applied, which keeps this an "undo, then immediately redo" window rather than
-- a standing licence.
--
-- Guarded on the ledger existing so this script still runs against a database built by an older
-- runner. A hand-deleted schema_migrations row mints nothing and stays refused.
DO $ledger$
BEGIN
  IF to_regclass('public.schema_migration_rollbacks') IS NOT NULL THEN
    INSERT INTO schema_migration_rollbacks (filename, checksum, watermark_at_rollback, batch)
    SELECT m.filename, m.checksum, COALESCE((SELECT MAX((regexp_match(filename,'^([0-9]{4,})_'))[1]::int) FROM schema_migrations),0), 'rollback-partner-management.sql'
      FROM schema_migrations m
     WHERE filename = '0015_partner_management.sql'
    ON CONFLICT DO NOTHING;
  END IF;
END $ledger$;

DELETE FROM schema_migrations WHERE filename = '0015_partner_management.sql';

COMMIT;
