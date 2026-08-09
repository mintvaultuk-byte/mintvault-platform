-- 0061_partner_public_reader.sql
-- A deliberately least-privileged identity for anonymous Shop Finder / public shop profile traffic.
--
-- THE DEFECT THIS CLOSES (HIGH A).
-- Two queries reachable from an unauthenticated GET /api/shops/:slug — the recent-cards list and the
-- public card count — run on `partnerAdminQuery`, because `certificates` is not readable by
-- partner_runtime. That pool is BYPASSRLS and owner-privileged, and it falls back to
-- MINTVAULT_DATABASE_URL when its own URL is unset. So anonymous traffic executes on the broadest
-- connection in the system, and what limits the blast radius is two hand-written SQL strings.
-- Anonymous load also consumes privileged capacity, which is how a public traffic spike becomes a
-- Super Admin outage.
--
-- The remaining public reads run on partner_runtime — RLS-bound, but a role that still HOLDS
-- INSERT/UPDATE/DELETE on partner_users, partner_sessions, partner_customers and partner_submissions.
-- RLS gates which ROWS are visible; it does not remove the privilege.
--
-- THE SHAPE.
-- One NOLOGIN group role plus two RESTRICTED VIEWS, and NO grant on any base table. The reader
-- cannot reach `certificates`, `partner_public_listings` or anything else directly — only the two
-- projections below, which carry the publication gates in their own definitions.
--
-- WHY NOT security_invoker VIEWS HERE.
-- security_invoker would check the READER's privileges on the base tables, so it would require
-- granting SELECT on `certificates` and on `partner_public_listings` — table-wide, including every
-- private column. That is the thing this migration exists to avoid. These views are therefore
-- owner-checked (PostgreSQL's default), which makes the VIEW DEFINITION the boundary rather than a
-- table grant. That is only safe because the gates are IN the definition and asserted below; a view
-- like this without its WHERE clause would hand anonymous traffic the whole table.
--
-- The existing partner_runtime path and its RLS policies are untouched.

-- ---------------------------------------------------------------------------
-- 1. The role
-- ---------------------------------------------------------------------------
-- NOLOGIN GROUP role, per the house convention (0008:17-18): a real login role is GRANTed
-- membership out of band by infra, never created by a migration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_public_reader') THEN
    CREATE ROLE partner_public_reader
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END$$;

-- Defensive, and stricter than the attribute list above: however this role got here, it must not be
-- able to log in directly, must not be superuser, and must not bypass RLS. A public-facing reader
-- that can do any of those is exactly the risk being removed.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles
     WHERE rolname = 'partner_public_reader' AND (rolsuper OR rolbypassrls OR rolcanlogin)
  ) THEN
    RAISE EXCEPTION 'partner_public_reader must be NOLOGIN, NOSUPERUSER and NOBYPASSRLS.';
  END IF;
END$$;

GRANT USAGE ON SCHEMA public TO partner_public_reader;

-- ---------------------------------------------------------------------------
-- 2. The shop projection
-- ---------------------------------------------------------------------------
-- Carries BOTH public gates in its own definition:
--   * eligibility (0059) — listing ACTIVE and organisation and location both ACTIVE;
--   * override expiry (0060) — the effective rating falls back to the computed one the moment the
--     override lapses, by comparison at read time.
-- Column list is explicit and closed. tenant_id, location_id, created_by, verified_by, approved_by,
-- current_rating_snapshot_id and public_ref are all deliberately absent: internal identifiers and
-- staff identities that a visitor has no use for and that would leak the tenant graph.
CREATE OR REPLACE VIEW partner_public_shop_projection AS
SELECT
  slug,
  public_display_name,
  trading_name_snapshot,
  address_line_1,
  address_line_2,
  town_city,
  county,
  postcode,
  -- The two GENERATED columns the finder's postcode search filters on. Derived solely from
  -- `postcode`, which is already published, so exposing them widens nothing — and omitting them
  -- silently broke every postcode search with a 42703 the moment the reads moved onto this view.
  postcode_normalised,
  postcode_outward,
  country,
  latitude,
  longitude,
  public_phone,
  public_email,
  public_website,
  public_opening_info,
  public_description,
  listing_status,
  verified_at,
  public_since,
  current_sample_size,
  current_minimum_sample,
  current_rating_calculated_at,
  CASE WHEN current_rating_is_override = true
        AND (current_override_expires_at IS NULL OR current_override_expires_at > now())
       THEN current_rating_version ELSE current_computed_rating_version END
    AS current_rating_version,
  CASE WHEN current_rating_is_override = true
        AND (current_override_expires_at IS NULL OR current_override_expires_at > now())
       THEN current_public_rating
       WHEN current_computed_rating_available THEN current_computed_public_rating
       ELSE NULL END
    AS current_public_rating,
  CASE WHEN current_rating_is_override = true
        AND (current_override_expires_at IS NULL OR current_override_expires_at > now())
       THEN current_rating_label
       ELSE COALESCE(current_computed_rating_label, 'Rating building') END
    AS current_rating_label,
  CASE WHEN current_rating_is_override = true
        AND (current_override_expires_at IS NULL OR current_override_expires_at > now())
       THEN current_rating_available
       ELSE current_computed_rating_available END
    AS current_rating_available,
  (current_rating_is_override = true
   AND (current_override_expires_at IS NULL OR current_override_expires_at > now()))
    AS current_rating_is_override,
  -- Exposed so the profile can resolve its own cards without the reader ever seeing location_id on
  -- a listing row it did not ask for. It is the join key the card projection is filtered by.
  location_id
FROM partner_public_listings
WHERE listing_status = 'ACTIVE'
  AND org_status = 'ACTIVE'
  AND location_status = 'ACTIVE';

-- ---------------------------------------------------------------------------
-- 3. The card projection
-- ---------------------------------------------------------------------------
-- The publication gate lives HERE, in the database, not only in the application predicate that
-- happens to call it. A future query that forgot a conjunct cannot widen what this view returns.
-- Only publication-eligible, partner-originated cards, and only the columns a public slab card
-- shows. No private_notes, no auth_status, no stolen_status, no ownership_status, no internal
-- grading evidence, no submission linkage, no customer reference.
CREATE OR REPLACE VIEW partner_public_card_projection AS
SELECT
  certificate_number,
  card_name,
  set_name,
  year_text,
  card_number_display,
  grade,
  grade_approved_at,
  origin_location_id
FROM certificates
WHERE deleted_at IS NULL
  AND status = 'active'
  AND grade IS NOT NULL
  AND grade_approved_at IS NOT NULL
  AND origin_type = 'PARTNER'
  AND origin_location_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Privileges — the views, and nothing else
-- ---------------------------------------------------------------------------
REVOKE ALL PRIVILEGES ON partner_public_shop_projection FROM PUBLIC;
REVOKE ALL PRIVILEGES ON partner_public_card_projection FROM PUBLIC;
REVOKE ALL PRIVILEGES ON partner_public_shop_projection FROM partner_public_reader;
REVOKE ALL PRIVILEGES ON partner_public_card_projection FROM partner_public_reader;

GRANT SELECT ON partner_public_shop_projection TO partner_public_reader;
GRANT SELECT ON partner_public_card_projection TO partner_public_reader;

-- ---------------------------------------------------------------------------
-- 5. Completeness assertions
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  -- Relations the public reader must NEVER reach. Absence is asserted explicitly rather than left
  -- to the fact that no GRANT was written — "we didn't grant it" stops being true the day somebody
  -- writes GRANT SELECT ON ALL TABLES IN SCHEMA public.
  forbidden text[] := ARRAY[
    'certificates',
    'partner_public_listings',
    'partner_public_rating_snapshots',
    'partner_public_rating_overrides',
    'partner_users',
    'partner_sessions',
    'partner_customers',
    'partner_submissions',
    'partner_submission_cards',
    'partner_wallets',
    'partner_credit_ledger',
    'partner_organisations',
    'partner_locations',
    'partner_audit_events',
    'partner_security_events',
    'partner_feature_flags',
    'partner_grading_work_items'
  ];
  rel text;
  leaked text;
  gate text;
BEGIN
  -- Role attributes.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_public_reader') THEN
    RAISE EXCEPTION '0061: partner_public_reader was not created';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles
     WHERE rolname = 'partner_public_reader' AND (rolsuper OR rolbypassrls OR rolcanlogin OR rolcreaterole OR rolcreatedb)
  ) THEN
    RAISE EXCEPTION '0061: partner_public_reader holds a forbidden role attribute';
  END IF;

  -- It can read exactly the two projections.
  IF NOT has_table_privilege('partner_public_reader', 'public.partner_public_shop_projection', 'SELECT') THEN
    RAISE EXCEPTION '0061: partner_public_reader cannot SELECT the shop projection';
  END IF;
  IF NOT has_table_privilege('partner_public_reader', 'public.partner_public_card_projection', 'SELECT') THEN
    RAISE EXCEPTION '0061: partner_public_reader cannot SELECT the card projection';
  END IF;

  -- And nothing else. Any privilege at all on a forbidden relation is a failure, not just SELECT.
  leaked := NULL;
  FOREACH rel IN ARRAY forbidden LOOP
    IF to_regclass('public.' || rel) IS NOT NULL THEN
      IF has_table_privilege('partner_public_reader', 'public.' || rel, 'SELECT')
         OR has_table_privilege('partner_public_reader', 'public.' || rel, 'INSERT')
         OR has_table_privilege('partner_public_reader', 'public.' || rel, 'UPDATE')
         OR has_table_privilege('partner_public_reader', 'public.' || rel, 'DELETE') THEN
        leaked := coalesce(leaked || ', ', '') || rel;
      END IF;
    END IF;
  END LOOP;
  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION
      '0061 completeness assertion failed: partner_public_reader holds a privilege on private relation(s): %. Anonymous traffic would be able to read them directly.', leaked;
  END IF;

  -- The views must be OWNER-checked, not security_invoker: a security_invoker view here would need
  -- base-table grants, which is precisely what the forbidden list above refuses.
  IF EXISTS (
    SELECT 1 FROM pg_class
     WHERE relname IN ('partner_public_shop_projection','partner_public_card_projection')
       AND relnamespace = 'public'::regnamespace
       AND reloptions IS NOT NULL
       AND array_to_string(reloptions, ',') LIKE '%security_invoker=true%'
  ) THEN
    RAISE EXCEPTION '0061: the public projections must not be security_invoker (they would need base-table grants)';
  END IF;

  -- THE GATES ARE IN THE VIEW. Without these the views are a table dump with extra steps, and the
  -- reader would see suspended shops and unapproved cards while every application test stayed green.
  SELECT pg_get_viewdef('public.partner_public_shop_projection'::regclass, true) INTO gate;
  IF gate NOT LIKE '%listing_status%' OR gate NOT LIKE '%org_status%' OR gate NOT LIKE '%location_status%' THEN
    RAISE EXCEPTION '0061: the shop projection does not carry the eligibility gate';
  END IF;
  IF gate NOT LIKE '%current_override_expires_at%' THEN
    RAISE EXCEPTION '0061: the shop projection does not carry the override-expiry comparison';
  END IF;

  SELECT pg_get_viewdef('public.partner_public_card_projection'::regclass, true) INTO gate;
  IF gate NOT LIKE '%grade_approved_at%' OR gate NOT LIKE '%deleted_at%'
     OR gate NOT LIKE '%status%' OR gate NOT LIKE '%origin_type%' THEN
    RAISE EXCEPTION '0061: the card projection does not carry the publication gate';
  END IF;
  -- Columns that must never appear in a public card payload.
  IF gate LIKE '%private_notes%' OR gate LIKE '%auth_status%' OR gate LIKE '%stolen_status%'
     OR gate LIKE '%ownership_status%' OR gate LIKE '%submission_item_id%' THEN
    RAISE EXCEPTION '0061: the card projection exposes a private column';
  END IF;
END$$;
