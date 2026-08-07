-- rollback-0048-partner-location-snapshot-search-path.sql
--
-- ⚠️  THIS ROLLBACK RE-OPENS A HIGH-SEVERITY PROVENANCE HOLE (A8-F2). It restores
-- partner_submissions_capture_location_snapshot() to 0044's body — no search_path pin, unqualified
-- partner_locations read — so any role that can CREATE TEMP TABLE can forge
-- partner_submissions.location_name_snapshot again. Run it only to unblock an incident, and
-- re-apply 0048 immediately afterwards.
--
-- Journal guard: refuse while any migration numbered above 48 is journalled. The threshold is
-- always this file's OWN number; if this file is ever renumbered, the integer moves with it.

BEGIN;

DO $$
DECLARE
  later_migrations bigint := 0;
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE $q$SELECT count(*) FROM schema_migrations
                WHERE filename ~ '^[0-9]{4}_' AND left(filename,4)::integer > 48$q$
      INTO later_migrations;
    IF later_migrations > 0 THEN
      RAISE EXCEPTION 'rollback-0048 refused: % later migration journal row(s) exist. Resolve newer migrations first.',
        later_migrations;
    END IF;
  END IF;

  IF to_regclass('public.partner_submissions') IS NULL THEN
    RAISE NOTICE 'rollback-0048: partner_submissions absent; nothing to do.';
    RETURN;
  END IF;
END$$;

-- Verbatim 0044:131-157 body. Restored by CREATE OR REPLACE so the trigger is never dropped.
CREATE OR REPLACE FUNCTION partner_submissions_capture_location_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  location_name text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.location_name_snapshot IS NULL THEN
      SELECT l.name INTO location_name
        FROM partner_locations l
       WHERE l.id = NEW.location_id
         AND l.tenant_id = NEW.tenant_id;
      IF location_name IS NULL THEN
        RAISE EXCEPTION 'partner_submissions.location_name_snapshot could not resolve location % for tenant %',
          NEW.location_id, NEW.tenant_id;
      END IF;
      NEW.location_name_snapshot := location_name;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.location_name_snapshot IS DISTINCT FROM NEW.location_name_snapshot THEN
    RAISE EXCEPTION 'partner_submissions.location_name_snapshot is immutable after insert';
  END IF;
  RETURN NEW;
END$$;

-- ALTER ... RESET ALL is required: CREATE OR REPLACE FUNCTION does NOT clear a proconfig entry set
-- by a previous definition, so without this the search_path pin would silently survive the rollback
-- and the rollback would not actually be a rollback.
ALTER FUNCTION partner_submissions_capture_location_snapshot() RESET ALL;

DO $$
DECLARE
  cfg  text[];
  ntrg integer;
BEGIN
  SELECT p.proconfig INTO cfg
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'partner_submissions_capture_location_snapshot';
  IF cfg IS NOT NULL THEN
    RAISE EXCEPTION 'rollback-0048: proconfig survives (%); the search_path pin was not reset', cfg;
  END IF;

  SELECT count(*) INTO ntrg
    FROM pg_trigger
   WHERE NOT tgisinternal
     AND tgname = 'trg_partner_submissions_location_snapshot'
     AND tgrelid = 'public.partner_submissions'::regclass;
  IF ntrg <> 1 THEN
    RAISE EXCEPTION 'rollback-0048: expected the snapshot trigger to survive, found %', ntrg;
  END IF;
END$$;

COMMIT;
