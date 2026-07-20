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

DELETE FROM schema_migrations WHERE filename = '0015_partner_management.sql';

COMMIT;
