-- 0059_partner_public_eligibility_propagation.sql
-- Public eligibility: an organisation or location that loses its standing must disappear from the
-- public network by itself, without a second manual action on the listing.
--
-- THE DEFECT THIS CLOSES (HIGH C).
-- 0058 made partner_public_listings a deliberate SNAPSHOT of a location rather than a view over it,
-- and nothing carried the tenant's or the location's CURRENT standing onto it. The only public gate
-- was `listing_status = 'ACTIVE'`, in the application predicate and in the RLS policy alike. A Super
-- Admin moving an organisation to SUSPENDED or REVOKED therefore left its shop advertised, rated and
-- flagged "verified" on the public finder until somebody remembered to suspend the listing too.
--
-- WHY DENORMALISE INSTEAD OF JOINING AT READ TIME.
-- The public finder and profile run on `partner_runtime` with NO tenant GUC. partner_organisations
-- and partner_locations are both ENABLE + FORCE ROW LEVEL SECURITY with a tenant-isolation policy
-- and no public branch (0001). An EXISTS join against them from the anonymous connection matches
-- ZERO rows, so it would not hide suspended shops — it would hide EVERY shop, silently, behind an
-- HTTP 200. Granting those tables a public RLS branch to make the join work would expose the whole
-- tenant graph to anonymous traffic, which is a far worse trade than two snapshot columns.
--
-- WHY A TRIGGER RATHER THAN APPLICATION PROPAGATION.
-- "Suspend the org, then also suspend the listing" is exactly the second manual action this is meant
-- to remove, and an application-side propagation can be skipped by any writer that does not know to
-- call it — including a Super Admin running manual SQL during an incident. ENABLE ALWAYS triggers
-- fire for every writer, superuser and replica included, so the snapshot cannot silently drift from
-- the standing it claims to represent.
--
-- The stored values are the REAL status vocabulary, not invented booleans:
--   partner_organisations.status  PENDING | ACTIVE | SUSPENDED | REVOKED   (0001:50)
--   partner_locations.status      PENDING | ACTIVE | SUSPENDED            (0001:68)
-- Eligibility is `= 'ACTIVE'` on both. PENDING is deliberately NOT eligible: a listing may only go
-- ACTIVE through an explicit HQ approval, and a shop whose organisation has not itself been
-- activated has no business on a public map.
--
-- Additive only. Edits no applied migration and drops nothing.

ALTER TABLE partner_public_listings
  ADD COLUMN IF NOT EXISTS org_status text,
  ADD COLUMN IF NOT EXISTS location_status text;

-- Backfill from the live source of truth before anything depends on these being populated.
UPDATE partner_public_listings l
   SET org_status = o.status
  FROM partner_organisations o
 WHERE o.id = l.tenant_id
   AND l.org_status IS DISTINCT FROM o.status;

UPDATE partner_public_listings l
   SET location_status = loc.status
  FROM partner_locations loc
 WHERE loc.id = l.location_id
   AND l.location_status IS DISTINCT FROM loc.status;

-- Fail CLOSED for any row the backfill could not resolve. A listing whose source row is missing is
-- not evidence of eligibility; 'PENDING' keeps it off the public network until a real status lands.
UPDATE partner_public_listings SET org_status = 'PENDING' WHERE org_status IS NULL;
UPDATE partner_public_listings SET location_status = 'PENDING' WHERE location_status IS NULL;

ALTER TABLE partner_public_listings
  ALTER COLUMN org_status SET DEFAULT 'PENDING',
  ALTER COLUMN location_status SET DEFAULT 'PENDING';

ALTER TABLE partner_public_listings
  ALTER COLUMN org_status SET NOT NULL,
  ALTER COLUMN location_status SET NOT NULL;

-- ---------------------------------------------------------------------------
-- Propagation
-- ---------------------------------------------------------------------------

-- Stamp a NEW listing with the current standing of its organisation and location. Without this an
-- insert would take the fail-closed 'PENDING' default and the shop would never appear, which is the
-- safe direction but not the correct one.
CREATE OR REPLACE FUNCTION partner_public_listing_stamp_eligibility()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  SELECT o.status INTO NEW.org_status FROM public.partner_organisations o WHERE o.id = NEW.tenant_id;
  SELECT loc.status INTO NEW.location_status FROM public.partner_locations loc WHERE loc.id = NEW.location_id;
  NEW.org_status := COALESCE(NEW.org_status, 'PENDING');
  NEW.location_status := COALESCE(NEW.location_status, 'PENDING');
  RETURN NEW;
END$$;

CREATE OR REPLACE FUNCTION partner_public_propagate_org_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  UPDATE public.partner_public_listings
     SET org_status = NEW.status, updated_at = now()
   WHERE tenant_id = NEW.id
     AND org_status IS DISTINCT FROM NEW.status;
  RETURN NULL;
END$$;

CREATE OR REPLACE FUNCTION partner_public_propagate_location_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  UPDATE public.partner_public_listings
     SET location_status = NEW.status, updated_at = now()
   WHERE location_id = NEW.id
     AND location_status IS DISTINCT FROM NEW.status;
  RETURN NULL;
END$$;

DO $$
BEGIN
  EXECUTE 'DROP TRIGGER IF EXISTS trg_partner_public_listing_stamp_eligibility ON partner_public_listings';
  EXECUTE 'CREATE TRIGGER trg_partner_public_listing_stamp_eligibility '
       || 'BEFORE INSERT ON partner_public_listings '
       || 'FOR EACH ROW EXECUTE FUNCTION partner_public_listing_stamp_eligibility()';
  EXECUTE 'ALTER TABLE partner_public_listings ENABLE ALWAYS TRIGGER trg_partner_public_listing_stamp_eligibility';

  EXECUTE 'DROP TRIGGER IF EXISTS trg_partner_public_propagate_org_status ON partner_organisations';
  EXECUTE 'CREATE TRIGGER trg_partner_public_propagate_org_status '
       || 'AFTER UPDATE OF status ON partner_organisations '
       || 'FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) '
       || 'EXECUTE FUNCTION partner_public_propagate_org_status()';
  EXECUTE 'ALTER TABLE partner_organisations ENABLE ALWAYS TRIGGER trg_partner_public_propagate_org_status';

  EXECUTE 'DROP TRIGGER IF EXISTS trg_partner_public_propagate_location_status ON partner_locations';
  EXECUTE 'CREATE TRIGGER trg_partner_public_propagate_location_status '
       || 'AFTER UPDATE OF status ON partner_locations '
       || 'FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) '
       || 'EXECUTE FUNCTION partner_public_propagate_location_status()';
  EXECUTE 'ALTER TABLE partner_locations ENABLE ALWAYS TRIGGER trg_partner_public_propagate_location_status';
END$$;

-- ---------------------------------------------------------------------------
-- RLS — the second layer, kept in step with the application predicate
-- ---------------------------------------------------------------------------
-- The application gate and the RLS policy must say the same thing. If only the application were
-- tightened, a future query that forgot the extra conjuncts would quietly serve suspended shops.
DO $$
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS partner_public_listings_public_read ON partner_public_listings';
  EXECUTE 'CREATE POLICY partner_public_listings_public_read ON partner_public_listings '
       || 'FOR SELECT USING (listing_status = ''ACTIVE'' '
       || 'AND org_status = ''ACTIVE'' AND location_status = ''ACTIVE'')';
END$$;

-- Supports the tightened public predicate without a second index: the existing partial indexes are
-- keyed on listing_status='ACTIVE', and these two conjuncts filter the small ACTIVE set further.
CREATE INDEX IF NOT EXISTS idx_partner_public_listings_public_eligible
  ON partner_public_listings (listing_status, org_status, location_status)
  WHERE listing_status = 'ACTIVE';

-- ---------------------------------------------------------------------------
-- Privileges — the new columns are HQ/system state, never partner-writable
-- ---------------------------------------------------------------------------
-- 0058's UPDATE grant is column-scoped, so new columns are excluded automatically. This is asserted
-- below rather than assumed, because "excluded automatically" is exactly the kind of claim that
-- stops being true the day somebody writes GRANT UPDATE ON … without a column list.

DO $$
DECLARE
  forbidden_update_cols text[] := ARRAY['org_status','location_status'];
  c text;
  pol_qual text;
BEGIN
  IF to_regclass('public.partner_public_listings') IS NULL THEN
    RAISE EXCEPTION '0059: partner_public_listings is missing';
  END IF;

  FOREACH c IN ARRAY forbidden_update_cols LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='partner_public_listings' AND column_name=c
    ) THEN
      RAISE EXCEPTION '0059: column % was not created', c;
    END IF;
    IF has_column_privilege('partner_runtime', 'public.partner_public_listings', c, 'UPDATE') THEN
      RAISE EXCEPTION '0059: partner_runtime must NOT be able to UPDATE %', c;
    END IF;
    -- It must still be READABLE: the public gate is evaluated on the runtime connection.
    IF NOT has_column_privilege('partner_runtime', 'public.partner_public_listings', c, 'SELECT') THEN
      RAISE EXCEPTION '0059: partner_runtime must be able to SELECT %', c;
    END IF;
  END LOOP;

  -- The public policy really carries all three conjuncts.
  SELECT pg_get_expr(polqual, polrelid) INTO pol_qual
    FROM pg_policy
   WHERE polrelid = 'public.partner_public_listings'::regclass
     AND polname = 'partner_public_listings_public_read';
  IF pol_qual IS NULL THEN
    RAISE EXCEPTION '0059: partner_public_listings_public_read policy is missing';
  END IF;
  IF pol_qual NOT LIKE '%org_status%' OR pol_qual NOT LIKE '%location_status%' THEN
    RAISE EXCEPTION '0059: public read policy does not gate on eligibility: %', pol_qual;
  END IF;

  -- All three triggers exist and fire ALWAYS (not just for the origin session).
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'trg_partner_public_listing_stamp_eligibility' AND tgenabled = 'A'
  ) THEN
    RAISE EXCEPTION '0059: stamp trigger missing or not ENABLE ALWAYS';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'trg_partner_public_propagate_org_status' AND tgenabled = 'A'
  ) THEN
    RAISE EXCEPTION '0059: org propagation trigger missing or not ENABLE ALWAYS';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'trg_partner_public_propagate_location_status' AND tgenabled = 'A'
  ) THEN
    RAISE EXCEPTION '0059: location propagation trigger missing or not ENABLE ALWAYS';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname='public' AND indexname='idx_partner_public_listings_public_eligible'
  ) THEN
    RAISE EXCEPTION '0059: eligibility index missing';
  END IF;

  -- No listing may be left with an unknown standing.
  IF EXISTS (SELECT 1 FROM partner_public_listings WHERE org_status IS NULL OR location_status IS NULL) THEN
    RAISE EXCEPTION '0059: a listing was left with a NULL eligibility snapshot';
  END IF;
END$$;
