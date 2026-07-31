-- rollback-0035-partner-certificate-origin.sql
--
-- Removes the certificate grading-origin snapshot installed by 0035.
--
-- REFUSES TO RUN if any certificate actually carries an origin snapshot (origin_type IS NOT NULL).
--
-- WHY IT REFUSES: dropping these columns DESTROYS PROVENANCE. The snapshot exists precisely
-- because it cannot be reconstructed — the whole point is that partner_organisations /
-- partner_profiles may have been renamed, moved, suspended, revoked or deleted since. There is no
-- second copy of "who graded this card and where" anywhere in the estate. Dropping the columns
-- would permanently and silently turn partner-graded certificates back into
-- "Graded by MintVault Headquarters", which is a false public statement about a physical product
-- already in a customer's hands. That is strictly worse than leaving unread columns in place, so
-- this script fails loudly and early instead. Same fail-closed house style as rollback-0033 and
-- rollback-0034.
--
-- WHEN THIS IS ACTUALLY SAFE: only where no certificate has ever been stamped — a disposable test
-- database, or an environment where 0035 was applied but the partner origin code never ran. That
-- is the case this script is written for.
--
-- IF YOU NEED TO STOP RENDERING PARTNER ORIGIN IN A HURRY: revert the application code. The
-- columns are additive and inert; nothing reads them unless the renderer does. Never reach for
-- this script to fix a display problem.
--
-- IF A SINGLE CERTIFICATE WAS MIS-ATTRIBUTED: that is a correction, not a rollback. Write a new
-- numbered migration that corrects exactly that row, with its evidence recorded. Note that the
-- immutability trigger blocks such an UPDATE by design; a correction migration must state its
-- justification and disable/re-enable the trigger explicitly, which is the visible, reviewable
-- act it should be.
--
-- ORDER OF OPERATIONS: trigger, then function, then constraints, then index, then columns. Each
-- step is IF EXISTS so a partial rollback can be re-run safely.

BEGIN;

DO $$
DECLARE
  stamped bigint;
BEGIN
  IF to_regclass('public.certificates') IS NULL THEN
    RAISE NOTICE 'rollback-0035: certificates table absent; nothing to do.';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'certificates' AND column_name = 'origin_type')
  THEN
    RAISE NOTICE 'rollback-0035: origin columns absent; nothing to do.';
    RETURN;
  END IF;

  -- Refuse on PARTNER PROVENANCE, not merely on "any origin_type is set".
  --
  -- Two reasons this predicate is what it is:
  --   1) DATA LOSS. A row can carry a full partner snapshot while origin_type is NULL.
  --      That shape is no longer creatable — constraint 2c is now NULL-safe — but this guard
  --      must still catch it, because it is the shape a pre-fix estate could already contain
  --      and because a guard that trusts a sibling constraint to have always held is not a
  --      guard. Keying only on origin_type would let the rollback drop real partner
  --      provenance and silently re-attribute those certificates to MintVault Headquarters.
  --   2) USABILITY. Every certificate created after 0035 gets a well-formed HQ snapshot,
  --      so keying on `origin_type IS NOT NULL` made the rollback unusable the moment the
  --      first certificate was graded. An HQ snapshot records only "graded at HQ, at T,
  --      snapshot v1" and is re-derivable; partner provenance is not. So a pure-HQ estate
  --      stays rollback-able, and anything carrying partner evidence is refused.
  EXECUTE $q$
    SELECT count(*) FROM certificates
     WHERE origin_type IS NOT DISTINCT FROM 'PARTNER'
        OR origin_partner_id IS NOT NULL
        OR origin_partner_public_ref IS NOT NULL
        OR origin_partner_legal_name IS NOT NULL
        OR origin_partner_trading_name IS NOT NULL
        OR origin_location_id IS NOT NULL
        OR origin_location_public_ref IS NOT NULL
        OR origin_location_name IS NOT NULL
        OR origin_location_address IS NOT NULL
  $q$ INTO stamped;

  IF stamped > 0 THEN
    RAISE EXCEPTION
      'rollback-0035 refuses to run: % certificate(s) carry PARTNER grading provenance. '
      'Dropping these columns would permanently destroy provenance that exists nowhere else and '
      'would silently re-attribute partner-graded certificates to MintVault Headquarters. '
      'To stop rendering partner origin, revert the application code instead.', stamped;
  END IF;
END$$;

DROP TRIGGER IF EXISTS trg_certificates_origin_immutable ON certificates;
DROP FUNCTION IF EXISTS certificates_origin_is_immutable();

ALTER TABLE IF EXISTS certificates DROP CONSTRAINT IF EXISTS chk_certificates_origin_type;
ALTER TABLE IF EXISTS certificates DROP CONSTRAINT IF EXISTS chk_certificates_origin_partner_complete;
ALTER TABLE IF EXISTS certificates DROP CONSTRAINT IF EXISTS chk_certificates_origin_non_partner_clean;
ALTER TABLE IF EXISTS certificates DROP CONSTRAINT IF EXISTS chk_certificates_origin_capture_pairing;
ALTER TABLE IF EXISTS certificates DROP CONSTRAINT IF EXISTS chk_certificates_origin_snapshot_version;

DROP INDEX IF EXISTS idx_certificates_origin_partner;

ALTER TABLE IF EXISTS certificates DROP COLUMN IF EXISTS origin_type;
ALTER TABLE IF EXISTS certificates DROP COLUMN IF EXISTS origin_partner_id;
ALTER TABLE IF EXISTS certificates DROP COLUMN IF EXISTS origin_partner_public_ref;
ALTER TABLE IF EXISTS certificates DROP COLUMN IF EXISTS origin_partner_legal_name;
ALTER TABLE IF EXISTS certificates DROP COLUMN IF EXISTS origin_partner_trading_name;
ALTER TABLE IF EXISTS certificates DROP COLUMN IF EXISTS origin_location_id;
ALTER TABLE IF EXISTS certificates DROP COLUMN IF EXISTS origin_location_public_ref;
ALTER TABLE IF EXISTS certificates DROP COLUMN IF EXISTS origin_location_name;
ALTER TABLE IF EXISTS certificates DROP COLUMN IF EXISTS origin_location_address;
ALTER TABLE IF EXISTS certificates DROP COLUMN IF EXISTS origin_captured_at;
ALTER TABLE IF EXISTS certificates DROP COLUMN IF EXISTS origin_snapshot_version;

-- The journal row must go too, otherwise the runner considers 0035 applied and will never
-- re-apply it. Guarded because the journal does not exist in every disposable fixture.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM schema_migrations WHERE filename = '0035_partner_certificate_origin.sql';
  END IF;
END$$;

COMMIT;
