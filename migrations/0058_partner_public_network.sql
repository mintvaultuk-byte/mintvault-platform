-- 0058 — MintVault Public Partner Network: public listings, quality-rating snapshots, overrides.
--
-- WHAT THIS IS FOR
-- ---------------------------------------------------------------------------
-- The MintVault website needs a "FIND A GRADING SHOP" surface: search by postcode/town/county/name,
-- optionally sort by distance, open a public shop profile, and see a MintVault Quality Rating.
-- Nothing in the estate can serve that today. This migration builds the data foundation.
--
-- THREE TABLES, AND WHY NOT FEWER
-- ---------------------------------------------------------------------------
--   partner_public_listings          the approved PUBLIC IDENTITY of one partner location
--   partner_public_rating_snapshots  a computed rating, persisted so public reads never recompute
--   partner_public_rating_overrides  Super Admin exceptional override, kept OUT of the listing
--
-- The override lives in its own table rather than as columns on the listing for a specific reason:
-- the listing is the table with a PUBLIC READ POLICY (see section 6). An override carries a written
-- rationale by a named Super Admin — internal reasoning that must never be one careless
-- `SELECT *` away from a public DTO. Physical separation makes the leak impossible rather than
-- merely unlikely. Same argument for keeping computed rating history in its own table.
--
-- WHY partner_locations IS NOT TOUCHED
-- ---------------------------------------------------------------------------
-- OWNER DECISION, and it is also the correct one. partner_locations.address is the OPERATIONAL
-- address: where cards are physically handled, what the connector reads, and what 0035 snapshots
-- onto certificates as immutable provenance. The public address is a different fact with a
-- different lifecycle — it is approved by a Super Admin, it may lag the operational address, and
-- it MUST be changeable without rewriting history. Overloading one column with both meanings is
-- exactly how a shop's 2027 move would silently rewrite what its 2026 certificates claim.
--
-- The load-bearing consequence, stated so no future reviewer "simplifies" it away:
--
--   CURRENT PUBLIC PROFILE  reads partner_public_listings  -> the shop's address TODAY
--   HISTORICAL CERTIFICATE  reads certificates.origin_*    -> the address AT GRADING TIME
--
-- Those two are allowed to disagree, permanently. That disagreement is the feature.
--
-- ADDITIVE ONLY. No existing table is altered, no column is dropped/renamed/retyped, no existing
-- row is read or modified. partner_locations, certificates and every origin_* column are untouched.
--
-- TRANSACTION: intentionally NO BEGIN/COMMIT. scripts/db/migrate.ts wraps each file in one
-- transaction together with its journal row (migrate.ts:806-828). A nested COMMIT would commit the
-- runner's transaction early and split this migration from its journal entry — the 0033 defect,
-- pinned by tests/partner-rbac-migration.test.ts:292-293. Siblings 0035/0049/0052/0056/0057 follow
-- the same rule. Rollback files are the opposite: they carry their own transaction.
--
-- IDEMPOTENT: every statement is IF NOT EXISTS or guarded by a pg_constraint/pg_policies lookup,
-- so re-application is a no-op. This matters because tests/partner-rollback-integrity.test.ts
-- applies -> rolls back -> lets the runner re-apply this file unprompted, and asserts the probe
-- returns to its applied reading.
--
-- DESTRUCTIVE-LINTER SAFE: every DROP POLICY sits inside a DO $$ ... EXECUTE format(...) block.
-- scripts/db/lint-destructive-sql.ts:82-84 blocks on /\b(DROP|TRUNCATE)\b[\s\S]{0,200}?\bCASCADE\b/i
-- — a proximity regex, not a parser — so a TOP-LEVEL `DROP POLICY` within 200 characters of any
-- `ON DELETE CASCADE` would block the migrate run. stripSqlNoise() removes dollar-quoted bodies,
-- so the DO-block form is structurally immune. This is why the policies below look more verbose
-- than 0049's; it is not style.
--
-- FAIL-CLOSED: section 8 asserts every table, column, constraint, index, policy, RLS flag and
-- grant this file claims to install. If anything is missing the migration RAISES and the runner
-- rolls the whole file back, rather than journalling "applied" over a half-built public surface
-- that would serve wrong data. Same bar as 0035/0049/0052/0056.
--
-- ROLLBACK: migrations/rollback-0058-partner-public-network.sql.

-- ---------------------------------------------------------------------------
-- 0) Pre-flight. Refuse loudly rather than build something that cannot work.
--
--    The RLS policies below are meaningless unless partner_current_tenant() exists and
--    partner_runtime is genuinely RLS-bound. 0047:60-96 established this check after a policy was
--    added that bound nobody; every RLS migration since repeats it.
-- ---------------------------------------------------------------------------
-- The "fresh install" flag is recorded BEFORE any DDL runs, so the no-backfill assertion at the
-- end can tell a first application (where the tables must be empty) from a legitimate re-run on an
-- estate where Super Admins have since created real listings. ON COMMIT DROP: nothing outlives the
-- runner's transaction. Same device as 0035's _origin_0035_state.
CREATE TEMP TABLE _public_network_0058_state (fresh boolean NOT NULL) ON COMMIT DROP;

DO $$
DECLARE
  is_super  boolean;
  is_bypass boolean;
BEGIN
  INSERT INTO _public_network_0058_state (fresh)
  SELECT to_regclass('public.partner_public_listings') IS NULL;

  IF to_regclass('public.partner_organisations') IS NULL THEN
    RAISE EXCEPTION '0058 requires partner_organisations; 0001 must be applied first.';
  END IF;
  IF to_regclass('public.partner_locations') IS NULL THEN
    RAISE EXCEPTION '0058 requires partner_locations; 0001 must be applied first.';
  END IF;
  IF to_regprocedure('public.partner_current_tenant()') IS NULL THEN
    RAISE EXCEPTION '0058: partner_current_tenant() is missing; every policy below would be invalid.';
  END IF;

  SELECT rolsuper, rolbypassrls INTO is_super, is_bypass FROM pg_roles WHERE rolname = 'partner_runtime';
  IF is_super IS NULL THEN
    RAISE EXCEPTION '0058: role partner_runtime does not exist; 0001 must be applied first.';
  END IF;
  IF is_super THEN
    RAISE EXCEPTION '0058: partner_runtime is SUPERUSER, so no policy below would constrain it.';
  END IF;
  IF is_bypass THEN
    RAISE EXCEPTION '0058: partner_runtime is BYPASSRLS, so no policy below would constrain it.';
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- 1) partner_public_listings — the approved public identity of ONE partner location.
--
-- SNAPSHOT, NOT A LIVE VIEW. Every public_* value is an APPROVED COPY, not a join to the
-- operational record. A partner renaming its location, or an admin editing the operational
-- address, must not silently change what the public website advertises. Publication is an act
-- with an approver and a timestamp, and these columns record its result.
--
-- ONE LISTING PER LOCATION (uq_partner_public_listings_location below). A location is a physical
-- shop; two competing public identities for one shop is not a state worth representing.
--
-- COLUMN NOTES (only the non-obvious ones):
--
--   public_ref              Non-sequential external id, matching the 0001 convention on
--                           partner_organisations/partner_locations/partner_users. Not used in
--                           URLs (slug is), but support and the partner quote it to each other.
--
--   slug                    The stable public URL segment. See section 3 for the stability rule.
--
--   public_display_name     What the finder and profile show. Deliberately NOT
--                           partner_locations.name — the operational name may be internal
--                           ("Unit 4 Rear"), and HQ approves the customer-facing one.
--
--   trading_name_snapshot   partner_profiles.trading_name as it stood at approval. Held so the
--                           listing can be reconciled against the certificate origin snapshots
--                           (0035 origin_partner_trading_name) without a live join that would
--                           re-resolve and thus lie about the past.
--
--   address_line_1..country The STRUCTURED public address. partner_locations.address is a single
--                           free-text column and cannot be searched by town or county; that is a
--                           second, independent reason this cannot be a view over it.
--
--   postcode_normalised     Canonical UK postcode with all whitespace removed and upper-cased, so
--                           'ME2 2NG', 'me22ng' and 'ME2-2NG' all match. GENERATED ALWAYS, not
--                           application-maintained: a normaliser that lives in TypeScript is one
--                           forgotten call site away from an unsearchable listing, and the finder
--                           would fail silently (empty result, HTTP 200). Generating it in the
--                           database makes "stored form is canonical" a structural fact.
--                           The expression is IMMUTABLE-safe (upper + regexp_replace only).
--
--   postcode_outward        Leading outward-code segment ('ME2' from 'ME22NG'), for area search.
--                           Also GENERATED, same argument. UK outward codes are 2-4 characters:
--                           one or two letters, one or two digits, optional trailing letter.
--
--   latitude / longitude    Entered and approved by a Super Admin for the pilot. NO GEOCODER —
--                           owner decision, and automatic postcode geocoding is deferred. NULLABLE
--                           and paired: a listing with only one of the two is a bug, not a
--                           half-located shop, so chk_..._coordinate_pair forbids it. NULL
--                           coordinates are a first-class state — such a listing is findable by
--                           text and is excluded from distance sorting. It is NEVER given a
--                           fabricated position.
--
--   listing_status          DRAFT | PENDING_REVIEW | ACTIVE | PAUSED | SUSPENDED | REMOVED.
--                           ONLY 'ACTIVE' is publicly visible (section 6). See section 2.
--
--   verified_at             HQ verification of the shop's identity. Distinct from approved_at:
--                           approval publishes the listing, verification asserts we checked who
--                           they are. A listing can be ACTIVE and unverified.
--
--   public_since            When this shop first became publicly listed. Set once, on first
--                           activation, and never moved by later pause/resume cycles — otherwise a
--                           shop that paused for a fortnight would advertise itself as new.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS partner_public_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_ref text NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL REFERENCES partner_locations(id) ON DELETE RESTRICT,

  slug text NOT NULL,

  public_display_name text NOT NULL,
  trading_name_snapshot text,

  address_line_1 text,
  address_line_2 text,
  town_city text,
  county text,
  postcode text,
  country text NOT NULL DEFAULT 'GB',

  postcode_normalised text GENERATED ALWAYS AS (
    nullif(upper(regexp_replace(coalesce(postcode, ''), '[^A-Za-z0-9]', '', 'g')), '')
  ) STORED,
  -- Outward code ('ME2' from 'ME2 2NG'), for area search.
  --
  -- DERIVED POSITIONALLY, NOT BY PATTERN. Every UK postcode's INWARD code is exactly three
  -- characters (digit + two letters), without exception, so the outward code is simply
  -- "everything except the last three". A leading-anchored pattern is NOT equivalent and is the
  -- version this file originally shipped: '^[A-Z]{1,2}[0-9][0-9A-Z]?' is greedy, so 'ME22NG'
  -- matched 'ME22' — the area, the district AND the first digit of the inward code. That silently
  -- puts every Strood listing in a district that does not exist, and an outward-code search for
  -- 'ME2' would return nothing while still returning HTTP 200. Caught by applying this migration
  -- to a real PostgreSQL 17 and asserting the value, which is why that proof exists.
  --
  -- Length gate: valid UK postcodes normalise to 5-7 characters (M11AE .. EC1A1BB). Anything
  -- outside that is malformed, and a malformed value yields NULL rather than a plausible-looking
  -- fragment — an unsearchable listing is recoverable, a wrongly-placed one is not.
  postcode_outward text GENERATED ALWAYS AS (
    CASE
      WHEN length(nullif(upper(regexp_replace(coalesce(postcode, ''), '[^A-Za-z0-9]', '', 'g')), '')) BETWEEN 5 AND 7
      THEN left(
             nullif(upper(regexp_replace(coalesce(postcode, ''), '[^A-Za-z0-9]', '', 'g')), ''),
             length(nullif(upper(regexp_replace(coalesce(postcode, ''), '[^A-Za-z0-9]', '', 'g')), '')) - 3
           )
      ELSE NULL
    END
  ) STORED,

  latitude  double precision,
  longitude double precision,

  public_phone text,
  public_email text,
  public_website text,
  public_opening_info text,
  public_description text,

  -- CURRENT EFFECTIVE RATING, denormalised onto the listing.
  --
  -- WHY THIS IS NOT A JOIN TO partner_public_rating_snapshots. Two independent reasons, both
  -- load-bearing:
  --
  --  1. THE FINDER IS ANONYMOUS. partner_public_rating_snapshots carries only a tenant-scoped read
  --     policy, so an anonymous reader (no app.tenant_id) gets ZERO rows from it — silently, behind
  --     an HTTP 200. A public join to snapshots would render every shop as unrated, forever, with
  --     no error anywhere. Giving snapshots their own public policy was the alternative and was
  --     rejected: it would need a correlated subquery back to the listing's status in the USING
  --     clause, evaluated per row on an unauthenticated hot path.
  --
  --  2. SORTING. The finder sorts by quality. A denormalised column can carry a partial index
  --     (idx_..._active_rating below); "latest snapshot per listing" cannot be indexed for an
  --     ORDER BY without a lateral join per row.
  --
  -- These are the EFFECTIVE values — computed, then override applied if one is active. The
  -- computed figure is never destroyed; it stays in the snapshot history, and
  -- current_rating_is_override tells a reader which they are looking at.
  --
  -- The internal 0-100 score is deliberately NOT here. It is HQ's working number, and this row is
  -- publicly readable; only the values a visitor is meant to see live on it.
  --
  -- WRITTEN BY THE ADMIN POOL ONLY. None of these columns is in the partner UPDATE grant
  -- (section 7), so a partner cannot set its own rating, label, or sample size — that is COUNT1
  -- and RATING1 closed at the grant layer rather than in a route handler.
  current_rating_version text,
  current_public_rating numeric(3,2),
  current_rating_label text,
  current_rating_available boolean NOT NULL DEFAULT false,
  current_sample_size integer NOT NULL DEFAULT 0,
  current_minimum_sample integer NOT NULL DEFAULT 0,
  current_rating_is_override boolean NOT NULL DEFAULT false,
  current_rating_calculated_at timestamptz,
  current_rating_snapshot_id uuid,

  listing_status text NOT NULL DEFAULT 'DRAFT',

  verified_at timestamptz,
  verified_by text,
  approved_at timestamptz,
  approved_by text,
  paused_at timestamptz,
  suspended_at timestamptz,
  removed_at timestamptz,
  public_since timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Closed vocabulary. A status outside this set would be invisible to the finder's ACTIVE filter
  -- AND invisible to the admin queue's PENDING_REVIEW filter — a listing lost in both directions.
  CONSTRAINT chk_partner_public_listings_status CHECK (
    listing_status IN ('DRAFT','PENDING_REVIEW','ACTIVE','PAUSED','SUSPENDED','REMOVED')
  ),

  -- A listing may only be publicly visible if a named approver actually approved it. Without this,
  -- an UPDATE that set listing_status='ACTIVE' and nothing else would publish a shop with no
  -- approval record — and the audit trail would be the only thing standing between us and an
  -- unreviewed public identity. Make it structural.
  CONSTRAINT chk_partner_public_listings_active_requires_approval CHECK (
    listing_status <> 'ACTIVE'
    OR (approved_at IS NOT NULL AND approved_by IS NOT NULL AND public_since IS NOT NULL)
  ),

  -- Coordinates are both-or-neither. A latitude with no longitude cannot be placed on a map, and
  -- silently treating the missing half as 0 would drop the shop in the Gulf of Guinea.
  CONSTRAINT chk_partner_public_listings_coordinate_pair CHECK (
    (latitude IS NULL AND longitude IS NULL) OR (latitude IS NOT NULL AND longitude IS NOT NULL)
  ),
  CONSTRAINT chk_partner_public_listings_latitude_range CHECK (
    latitude IS NULL OR (latitude >= -90 AND latitude <= 90)
  ),
  CONSTRAINT chk_partner_public_listings_longitude_range CHECK (
    longitude IS NULL OR (longitude >= -180 AND longitude <= 180)
  ),

  -- Slug is the public URL segment: lowercase alphanumerics and single hyphens, no leading or
  -- trailing hyphen. Enforced here and not only in TypeScript, because a slug that round-trips
  -- through an admin edit is one careless value away from breaking every link to the profile.
  CONSTRAINT chk_partner_public_listings_slug_shape CHECK (
    slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) BETWEEN 3 AND 120
  ),

  -- ISO 3166-1 alpha-2, upper case. The pilot is GB-only; the column exists so that is a value
  -- rather than an assumption baked into the query layer.
  CONSTRAINT chk_partner_public_listings_country CHECK (country ~ '^[A-Z]{2}$'),

  -- Display name must carry a real glyph. The trim set is spelled out rather than using
  -- [[:space:]], which is LOCALE DEPENDENT (it follows pg_database.datctype) — under C.UTF-8,
  -- NBSP/U+2007/U+202F/U+3000 are NOT classified as space, so a name made of them would pass here
  -- while JS .trim() reduced it to empty and the finder rendered a blank card. This list is
  -- exactly ECMAScript String.prototype.trim's set, so the database and the renderer agree in
  -- every locale. Identical reasoning and identical list to 0035's origin-name constraint.
  -- THE SAME ANTI-FABRICATION RULE AS THE SNAPSHOT TABLE, applied to the denormalised copy.
  -- Without it the two could disagree: a snapshot could honestly say "rating building" while the
  -- publicly-read listing row carried a number. An available rating must carry a value, a label,
  -- a version and enough sample; an unavailable one must carry no number at all. RATING2
  -- (missing evidence scored as perfect) and RATING3 (minimum sample removed) therefore have to
  -- defeat a CHECK constraint here as well as in the snapshot history.
  CONSTRAINT chk_partner_public_listings_current_rating CHECK (
    (current_rating_available = true
       AND current_public_rating IS NOT NULL
       AND current_rating_label IS NOT NULL
       AND current_rating_version IS NOT NULL
       AND current_sample_size >= current_minimum_sample)
    OR
    (current_rating_available = false
       AND current_public_rating IS NULL)
  ),
  CONSTRAINT chk_partner_public_listings_current_rating_range CHECK (
    current_public_rating IS NULL OR (current_public_rating >= 0 AND current_public_rating <= 5)
  ),
  CONSTRAINT chk_partner_public_listings_current_sample CHECK (
    current_sample_size >= 0 AND current_minimum_sample >= 0
  ),

  CONSTRAINT chk_partner_public_listings_display_name_present CHECK (
    btrim(public_display_name, E'\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF') <> ''
  )
);

-- One public identity per physical shop.
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_public_listings_location
  ON partner_public_listings(location_id);

-- SLUG UNIQUENESS IS GLOBAL, not per-tenant. The slug is a public URL segment shared across all
-- tenants, so a per-tenant unique index would let tenant B claim tenant A's live URL — the
-- SLUG1 hijack. Global uniqueness makes that a constraint violation rather than a race.
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_public_listings_slug
  ON partner_public_listings(slug);

-- Composite-FK targets, so the child columns cannot be crossed between tenants. Same two-step
-- idiom as 0049:56-66 — a UNIQUE INDEX on the parent providing the (tenant_id, id) target, then
-- the composite FK below. The index is named for the migration that needs it, per 0049.
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_public_listings_tenant_location
  ON partner_locations(tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_public_listings_tenant_id
  ON partner_public_listings(tenant_id, id);

DO $$
BEGIN
  -- TENANT-CROSSING IS IMPOSSIBLE, not merely checked in the service layer. Without this, tenant A
  -- could create a public listing pointing at tenant B's location and publish B's shop under A's
  -- control. ALTER TABLE ... ADD CONSTRAINT has no IF NOT EXISTS, hence the pg_constraint guard —
  -- a bare ADD CONSTRAINT would make this file non-re-appliable and break the round-trip suite.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.partner_public_listings'::regclass
       AND conname = 'fk_partner_public_listings_location_tenant'
  ) THEN
    ALTER TABLE partner_public_listings
      ADD CONSTRAINT fk_partner_public_listings_location_tenant
      FOREIGN KEY (tenant_id, location_id) REFERENCES partner_locations(tenant_id, id) ON DELETE RESTRICT;
  END IF;
END$$;

-- Finder query paths. Every predicate and sort key the public finder uses is indexed at creation
-- time, because server/partner/db.ts:96-124 gives the runtime pool max:8 and query_timeout:3000 —
-- an unindexed scan on a public endpoint is a 3-second hard failure under load, not a slow page.
--
-- The three text-search indexes are PARTIAL on ACTIVE. The finder never reads any other status, so
-- indexing them would grow the index without ever serving a row.
CREATE INDEX IF NOT EXISTS idx_partner_public_listings_status
  ON partner_public_listings(listing_status);
CREATE INDEX IF NOT EXISTS idx_partner_public_listings_tenant
  ON partner_public_listings(tenant_id);
CREATE INDEX IF NOT EXISTS idx_partner_public_listings_active_postcode
  ON partner_public_listings(postcode_normalised)
  WHERE listing_status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_partner_public_listings_active_outward
  ON partner_public_listings(postcode_outward)
  WHERE listing_status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_partner_public_listings_active_town
  ON partner_public_listings(lower(town_city))
  WHERE listing_status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_partner_public_listings_active_county
  ON partner_public_listings(lower(county))
  WHERE listing_status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_partner_public_listings_active_name
  ON partner_public_listings(lower(public_display_name))
  WHERE listing_status = 'ACTIVE';
-- Bounding-box pre-filter for distance search. Haversine itself is not indexable, so the query
-- narrows by a lat/lng box first and computes exact distance on the survivors.
CREATE INDEX IF NOT EXISTS idx_partner_public_listings_active_coords
  ON partner_public_listings(latitude, longitude)
  WHERE listing_status = 'ACTIVE' AND latitude IS NOT NULL AND longitude IS NOT NULL;
-- Quality sort. Partial on ACTIVE + actually-rated, so shops still building a rating never occupy
-- index space and never appear ahead of a rated shop by accident.
CREATE INDEX IF NOT EXISTS idx_partner_public_listings_active_rating
  ON partner_public_listings(current_public_rating DESC)
  WHERE listing_status = 'ACTIVE' AND current_rating_available = true;

-- RECENT PUBLIC CARDS, on the certificates table.
--
-- The shop profile lists "cards recently graded by this shop", attributed through the IMMUTABLE
-- 0035 origin snapshot (origin_location_id), never through the shop's current address. 0035's own
-- index is on origin_partner_id with no time component, which does not serve
-- "WHERE origin_location_id = $1 ORDER BY grade_approved_at DESC LIMIT n" — that would seq-scan
-- certificates on every public profile view.
--
-- ADDITIVE AND PARTIAL: index-only, no column touched, and restricted to rows that can actually
-- appear (partner-originated AND approved), so it stays small against a table that is
-- overwhelmingly HQ-originated. Created here rather than in 0035 because 0035 predates the public
-- profile and its checksum is frozen.
CREATE INDEX IF NOT EXISTS idx_certificates_origin_location_recent
  ON certificates (origin_location_id, grade_approved_at DESC)
  WHERE origin_location_id IS NOT NULL AND grade_approved_at IS NOT NULL;

COMMENT ON TABLE partner_public_listings IS
  'Approved PUBLIC identity of one partner location. Snapshot, not a view over partner_locations. Only listing_status=ACTIVE is publicly readable.';
COMMENT ON COLUMN partner_public_listings.postcode_normalised IS
  'GENERATED canonical postcode (upper, alphanumerics only). Generated in-database so a missed application call site cannot silently make a listing unsearchable.';
COMMENT ON COLUMN partner_public_listings.latitude IS
  'Super Admin entered. No geocoder. NULL is a first-class state: the listing is text-searchable and excluded from distance sorting. Never fabricate a position.';
COMMENT ON COLUMN partner_public_listings.slug IS
  'Public URL segment. GLOBALLY unique so one tenant can never claim another tenant''s live URL. Stable after first activation.';

-- ---------------------------------------------------------------------------
-- 2) Listing state transitions, enforced by trigger.
--
-- ALLOWED:
--   DRAFT          -> PENDING_REVIEW, REMOVED
--   PENDING_REVIEW -> ACTIVE, DRAFT, REMOVED
--   ACTIVE         -> PAUSED, SUSPENDED, REMOVED
--   PAUSED         -> ACTIVE, SUSPENDED, REMOVED
--   SUSPENDED      -> ACTIVE, REMOVED
--   REMOVED        -> (terminal)
--
-- WHY A TRIGGER AND NOT SERVICE-LAYER VALIDATION: the same argument 0035 makes for origin
-- immutability. Any writer that spreads a whole record into an UPDATE ... SET can move a listing
-- from SUSPENDED straight back to ACTIVE without an approval step. The database is the only place
-- this can be made true for every writer, including a future one nobody has written yet.
--
-- REMOVED IS TERMINAL, deliberately. Un-removing a listing would resurrect a public URL that may
-- have been retired for a legal or trust reason; the correct recovery is a new listing with a new
-- slug and a fresh approval, which leaves a record.
--
-- public_since IS SET-ONCE. The trigger refuses to move it once set, so a resumed shop cannot be
-- re-advertised as newly joined.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION partner_public_listing_transition_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF NEW.listing_status IS DISTINCT FROM OLD.listing_status THEN
    IF NOT (
      (OLD.listing_status = 'DRAFT'          AND NEW.listing_status IN ('PENDING_REVIEW','REMOVED'))
      OR (OLD.listing_status = 'PENDING_REVIEW' AND NEW.listing_status IN ('ACTIVE','DRAFT','REMOVED'))
      OR (OLD.listing_status = 'ACTIVE'      AND NEW.listing_status IN ('PAUSED','SUSPENDED','REMOVED'))
      OR (OLD.listing_status = 'PAUSED'      AND NEW.listing_status IN ('ACTIVE','SUSPENDED','REMOVED'))
      OR (OLD.listing_status = 'SUSPENDED'   AND NEW.listing_status IN ('ACTIVE','REMOVED'))
    ) THEN
      RAISE EXCEPTION
        'partner_public_listings: illegal listing_status transition % -> % (listing %)',
        OLD.listing_status, NEW.listing_status, OLD.id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- public_since records when the shop FIRST went public. Never movable.
  IF OLD.public_since IS NOT NULL AND NEW.public_since IS DISTINCT FROM OLD.public_since THEN
    RAISE EXCEPTION
      'partner_public_listings: public_since is set-once and cannot be changed (listing %)', OLD.id
      USING ERRCODE = '23514';
  END IF;

  -- The slug is the public URL. Once the listing has been published it must not move, or every
  -- external link, QR code and search-engine result pointing at this shop breaks. Before first
  -- activation it is still free to change.
  IF OLD.public_since IS NOT NULL AND NEW.slug IS DISTINCT FROM OLD.slug THEN
    RAISE EXCEPTION
      'partner_public_listings: slug is immutable once the listing has been published (listing %)', OLD.id
      USING ERRCODE = '23514';
  END IF;

  -- A listing may never be re-pointed at a different location or tenant. Re-pointing would carry a
  -- shop's accumulated public identity, slug and rating history onto a different physical shop.
  IF NEW.location_id IS DISTINCT FROM OLD.location_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION
      'partner_public_listings: tenant_id/location_id are immutable (listing %)', OLD.id
      USING ERRCODE = '23514';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_partner_public_listing_transition ON partner_public_listings;
CREATE TRIGGER trg_partner_public_listing_transition
  BEFORE UPDATE ON partner_public_listings
  FOR EACH ROW
  EXECUTE FUNCTION partner_public_listing_transition_guard();

-- ENABLE ALWAYS (pg_trigger.tgenabled='A'), not the default 'O'. A default trigger fires only when
-- session_replication_role is 'origin'/'local', so any session able to set 'replica' could move a
-- SUSPENDED shop back to ACTIVE silently. Same reasoning, and the same honest limit, as 0035:
-- this closes the replication-role path, not a deliberate owner-level DISABLE TRIGGER.
ALTER TABLE partner_public_listings ENABLE ALWAYS TRIGGER trg_partner_public_listing_transition;

-- ---------------------------------------------------------------------------
-- 3) partner_public_rating_snapshots — persisted, versioned, explainable ratings.
--
-- WHY PERSISTED: the public finder sorts by rating. Recomputing every listing's rating on every
-- anonymous request would put an aggregate over `certificates` on the hot path of an
-- unauthenticated endpoint, on a pool with max:8 and a 3s query timeout. Ratings change when
-- grading work completes, not when a visitor loads a page.
--
-- WHY VERSIONED: rating_version records WHICH formula produced a score. When the methodology
-- changes, old snapshots remain explainable rather than becoming uninterpretable numbers. This is
-- what lets us answer "why was my shop 4.2 in August?" a year later.
--
-- WHY component_scores AND evidence_availability ARE BOTH STORED:
--   component_scores      the per-component 0..1 values that produced internal_score
--   evidence_availability which metrics were actually derivable at calculation time
-- The second is the anti-fabrication record. It is the difference between "this shop had zero
-- missed defects" and "we cannot measure missed defects" — and storing it means a later reader
-- cannot mistake the one for the other. Rule: a metric that is unavailable is recorded as
-- unavailable and EXCLUDED from the score. It is NEVER scored as perfect.
--
-- rating_available / public_rating NULL is the LOW-SAMPLE state ("Rating building"). The
-- internal_score is still stored when computable, because HQ may want to see a provisional figure
-- — but a NULL public_rating is what the public API serves, and no code path may substitute the
-- provisional value for it.
--
-- APPEND-ONLY BY CONVENTION AND BY GRANT: partner_runtime gets SELECT only (section 7), and the
-- admin pool inserts. Nothing updates a snapshot in place; a recalculation writes a new row.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS partner_public_rating_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  listing_id uuid NOT NULL REFERENCES partner_public_listings(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL REFERENCES partner_locations(id) ON DELETE RESTRICT,

  rating_version text NOT NULL,

  internal_score numeric(6,3),
  public_rating numeric(3,2),
  rating_label text,
  rating_available boolean NOT NULL DEFAULT false,

  sample_size integer NOT NULL,
  minimum_sample integer NOT NULL,

  component_scores jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_availability jsonb NOT NULL DEFAULT '{}'::jsonb,

  calculated_at timestamptz NOT NULL DEFAULT now(),
  calculated_by text,

  CONSTRAINT chk_partner_public_rating_snapshots_sample CHECK (sample_size >= 0 AND minimum_sample >= 0),
  CONSTRAINT chk_partner_public_rating_snapshots_internal_range CHECK (
    internal_score IS NULL OR (internal_score >= 0 AND internal_score <= 100)
  ),
  CONSTRAINT chk_partner_public_rating_snapshots_public_range CHECK (
    public_rating IS NULL OR (public_rating >= 0 AND public_rating <= 5)
  ),
  -- THE ANTI-FABRICATION CONSTRAINT. An available rating must actually carry a number, a label and
  -- enough sample to justify publishing it; an unavailable one must carry NO number at all. This
  -- is what makes "1 completed card -> 5.0 stars" and "missing evidence -> perfect score"
  -- unrepresentable rather than merely discouraged. RATING3 (remove the minimum sample) and
  -- RATING2 (treat missing evidence as perfect) both have to defeat a CHECK constraint, not just
  -- a code review.
  CONSTRAINT chk_partner_public_rating_snapshots_availability CHECK (
    (rating_available = true
       AND public_rating IS NOT NULL
       AND internal_score IS NOT NULL
       AND rating_label IS NOT NULL
       AND sample_size >= minimum_sample)
    OR
    (rating_available = false
       AND public_rating IS NULL)
  ),
  CONSTRAINT chk_partner_public_rating_snapshots_component_object CHECK (
    jsonb_typeof(component_scores) = 'object' AND jsonb_typeof(evidence_availability) = 'object'
  )
);

CREATE INDEX IF NOT EXISTS idx_partner_public_rating_snapshots_tenant
  ON partner_public_rating_snapshots(tenant_id);
-- Latest-snapshot lookup. The finder and the profile both need "the current rating for this
-- listing", which is ORDER BY calculated_at DESC LIMIT 1 per listing; this index makes that a
-- backwards index scan rather than a sort over the listing's whole history.
CREATE INDEX IF NOT EXISTS idx_partner_public_rating_snapshots_latest
  ON partner_public_rating_snapshots(listing_id, calculated_at DESC);
CREATE INDEX IF NOT EXISTS idx_partner_public_rating_snapshots_location
  ON partner_public_rating_snapshots(location_id, calculated_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.partner_public_rating_snapshots'::regclass
       AND conname = 'fk_partner_public_rating_snapshots_listing_tenant'
  ) THEN
    ALTER TABLE partner_public_rating_snapshots
      ADD CONSTRAINT fk_partner_public_rating_snapshots_listing_tenant
      FOREIGN KEY (tenant_id, listing_id) REFERENCES partner_public_listings(tenant_id, id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.partner_public_rating_snapshots'::regclass
       AND conname = 'fk_partner_public_rating_snapshots_location_tenant'
  ) THEN
    ALTER TABLE partner_public_rating_snapshots
      ADD CONSTRAINT fk_partner_public_rating_snapshots_location_tenant
      FOREIGN KEY (tenant_id, location_id) REFERENCES partner_locations(tenant_id, id) ON DELETE RESTRICT;
  END IF;
END$$;

COMMENT ON TABLE partner_public_rating_snapshots IS
  'Persisted, versioned MintVault Operational Quality Rating per listing. Append-only; a recalculation writes a new row. Public reads never recompute.';
COMMENT ON COLUMN partner_public_rating_snapshots.evidence_availability IS
  'Which metrics were genuinely derivable at calculation time. An unavailable metric is EXCLUDED from the score, never scored as perfect.';

-- ---------------------------------------------------------------------------
-- 4) partner_public_rating_overrides — Super Admin exceptional override.
--
-- SEPARATE TABLE, NOT COLUMNS ON THE LISTING. The override carries `reason` — a Super Admin's
-- written internal rationale for departing from the computed figure. That text must never be
-- reachable from the publicly-readable listing row. Physical separation, plus the absence of any
-- public read policy on this table (section 6), makes the leak structurally impossible.
--
-- THE COMPUTED SCORE IS NEVER MUTATED. An override sits ON TOP of the snapshot history; the
-- computed value remains visible to HQ forever. That is what makes an override auditable rather
-- than a way to quietly rewrite the record.
--
-- AT MOST ONE ACTIVE OVERRIDE PER LISTING at a time (uq_..._active below, a partial unique index
-- on removed_at IS NULL). Two simultaneous overrides would make "the effective rating" ambiguous.
--
-- expires_at is OPTIONAL and advisory: the service treats an expired override as inactive. It is
-- not enforced by a constraint because expiry is a read-time judgement, and a trigger that
-- retired rows on a clock would mutate history.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS partner_public_rating_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  listing_id uuid NOT NULL REFERENCES partner_public_listings(id) ON DELETE RESTRICT,

  -- What the engine computed at the moment of override, copied in. Held so the override can always
  -- be explained against what it replaced, even after later recalculations move the computed value.
  computed_internal_score numeric(6,3),
  computed_public_rating numeric(3,2),
  computed_rating_label text,

  override_public_rating numeric(3,2),
  override_rating_label text,

  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  expires_at timestamptz,

  removed_at timestamptz,
  removed_by text,
  removal_reason text,

  CONSTRAINT chk_partner_public_rating_overrides_public_range CHECK (
    override_public_rating IS NULL OR (override_public_rating >= 0 AND override_public_rating <= 5)
  ),
  -- An override must actually override something: a rating, a label, or both. An override that
  -- changes nothing is an audit entry pretending to be a decision.
  CONSTRAINT chk_partner_public_rating_overrides_has_effect CHECK (
    override_public_rating IS NOT NULL OR override_rating_label IS NOT NULL
  ),
  -- Removal is all-or-nothing: who and why, or not removed. A removed_at with no actor is an
  -- unattributable reversal of a Super Admin decision.
  CONSTRAINT chk_partner_public_rating_overrides_removal_pair CHECK (
    (removed_at IS NULL AND removed_by IS NULL AND removal_reason IS NULL)
    OR (removed_at IS NOT NULL AND removed_by IS NOT NULL AND removal_reason IS NOT NULL)
  ),
  CONSTRAINT chk_partner_public_rating_overrides_reason_present CHECK (
    btrim(reason, E'\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF') <> ''
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_public_rating_overrides_active
  ON partner_public_rating_overrides(listing_id)
  WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_partner_public_rating_overrides_tenant
  ON partner_public_rating_overrides(tenant_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.partner_public_rating_overrides'::regclass
       AND conname = 'fk_partner_public_rating_overrides_listing_tenant'
  ) THEN
    ALTER TABLE partner_public_rating_overrides
      ADD CONSTRAINT fk_partner_public_rating_overrides_listing_tenant
      FOREIGN KEY (tenant_id, listing_id) REFERENCES partner_public_listings(tenant_id, id) ON DELETE RESTRICT;
  END IF;
END$$;

COMMENT ON TABLE partner_public_rating_overrides IS
  'Super Admin exceptional rating override. Deliberately NOT columns on partner_public_listings: `reason` is internal rationale and this table has NO public read policy.';

-- ---------------------------------------------------------------------------
-- 5) updated_at maintenance for the two tables without a transition trigger.
--    (partner_public_listings sets NEW.updated_at in its own guard, section 2.)
--    Snapshots and overrides are append-only, so neither needs one — stated here so the absence
--    reads as a decision rather than an oversight.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 6) ROW LEVEL SECURITY.
--
-- THE PROBLEM THIS SOLVES, stated plainly because it is the least obvious thing in this file:
--
-- The shop finder is ANONYMOUS. It has no partner session and therefore no app.tenant_id GUC.
-- partner_current_tenant() (0001:200-207) returns NULL when the GUC is unset, and
-- `tenant_id = NULL` is NULL, never true. So a listing table carrying ONLY the standard
-- `USING (tenant_id = partner_current_tenant())` policy would return ZERO ROWS to every public
-- request — silently, with HTTP 200 and an empty array. Verified against server/partner/db.ts:173-177,
-- which states this fail-closed behaviour as the intended design of partnerRuntimeQuery.
--
-- So partner_public_listings carries an EXPLICIT public read branch:
--
--   ..._public_read   FOR SELECT USING (listing_status = 'ACTIVE')
--   ..._tenant_read   FOR SELECT USING (tenant_id = partner_current_tenant())
--   ..._tenant_write  FOR UPDATE USING/WITH CHECK (tenant_id = partner_current_tenant())
--
-- CONFINED TO SELECT, DELIBERATELY. 0052:59-61 records the rule that forced this shape:
-- PostgreSQL governs DELETE by USING ALONE — WITH CHECK is never consulted for a row being
-- removed. A permissive non-tenant branch on FOR ALL would therefore be a permissive DELETE
-- branch over every ACTIVE listing in the estate. The public branch is FOR SELECT and nothing else.
--
-- WHAT THE PUBLIC BRANCH DOES *NOT* DO: it does not make private columns safe. It exposes whole
-- ACTIVE rows to any RLS-bound reader. The application DTO allowlist is the second layer, and the
-- reason no internal rationale, wallet, credit or user column exists on this table at all is the
-- third. Overrides and snapshots get NO public branch, so `reason` is unreachable this way.
--
-- WRITE PATH: partner_runtime gets UPDATE on an EXPLICIT COLUMN LIST only (section 7). That is
-- what stops a partner writing its own listing_status, rating, slug, coordinates or address —
-- structurally, at the grant layer, not in a route handler. No INSERT and no DELETE grant exists
-- for partner_runtime on any of these tables; listings are created and approved by the admin pool.
--
-- Snapshots and overrides are tenant-read-only for partner_runtime: a partner may see its own
-- rating history but can never write a rating (RATING1) or an override (OVERRIDE1).
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'partner_public_listings',
    'partner_public_rating_snapshots',
    'partner_public_rating_overrides'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END$$;

DO $$
BEGIN
  -- --- partner_public_listings -------------------------------------------------------------
  EXECUTE 'DROP POLICY IF EXISTS partner_public_listings_public_read ON partner_public_listings';
  EXECUTE 'CREATE POLICY partner_public_listings_public_read ON partner_public_listings '
       || 'FOR SELECT USING (listing_status = ''ACTIVE'')';

  EXECUTE 'DROP POLICY IF EXISTS partner_public_listings_tenant_read ON partner_public_listings';
  EXECUTE 'CREATE POLICY partner_public_listings_tenant_read ON partner_public_listings '
       || 'FOR SELECT USING (tenant_id = partner_current_tenant())';

  EXECUTE 'DROP POLICY IF EXISTS partner_public_listings_tenant_write ON partner_public_listings';
  EXECUTE 'CREATE POLICY partner_public_listings_tenant_write ON partner_public_listings '
       || 'FOR UPDATE USING (tenant_id = partner_current_tenant()) '
       || 'WITH CHECK (tenant_id = partner_current_tenant())';

  -- --- partner_public_rating_snapshots -----------------------------------------------------
  -- No public branch. The public API reads a rating through the LISTING it has already been
  -- authorised to see, via the admin/service read path; a partner sees only its own history.
  EXECUTE 'DROP POLICY IF EXISTS partner_public_rating_snapshots_tenant_read ON partner_public_rating_snapshots';
  EXECUTE 'CREATE POLICY partner_public_rating_snapshots_tenant_read ON partner_public_rating_snapshots '
       || 'FOR SELECT USING (tenant_id = partner_current_tenant())';

  -- Explicit write floor. partner_runtime holds no INSERT/UPDATE/DELETE grant here, but the policy
  -- states the intent so a future blanket GRANT cannot silently open a write path — the same
  -- reasoning 0056:39-42 gives for policy-floors over revocation.
  EXECUTE 'DROP POLICY IF EXISTS partner_public_rating_snapshots_no_tenant_write ON partner_public_rating_snapshots';
  EXECUTE 'CREATE POLICY partner_public_rating_snapshots_no_tenant_write ON partner_public_rating_snapshots '
       || 'FOR INSERT WITH CHECK (false)';
  EXECUTE 'DROP POLICY IF EXISTS partner_public_rating_snapshots_no_tenant_update ON partner_public_rating_snapshots';
  EXECUTE 'CREATE POLICY partner_public_rating_snapshots_no_tenant_update ON partner_public_rating_snapshots '
       || 'FOR UPDATE USING (false) WITH CHECK (false)';
  EXECUTE 'DROP POLICY IF EXISTS partner_public_rating_snapshots_no_tenant_delete ON partner_public_rating_snapshots';
  EXECUTE 'CREATE POLICY partner_public_rating_snapshots_no_tenant_delete ON partner_public_rating_snapshots '
       || 'FOR DELETE USING (false)';

  -- --- partner_public_rating_overrides -----------------------------------------------------
  -- NO public branch and NO tenant read branch carrying `reason`. A partner has no business
  -- reading the Super Admin's internal rationale for overriding its rating, so this table is
  -- entirely closed to partner_runtime: no policy admits it, and it holds no grant either.
  EXECUTE 'DROP POLICY IF EXISTS partner_public_rating_overrides_no_tenant_access ON partner_public_rating_overrides';
  EXECUTE 'CREATE POLICY partner_public_rating_overrides_no_tenant_access ON partner_public_rating_overrides '
       || 'FOR ALL USING (false) WITH CHECK (false)';
END$$;

-- ---------------------------------------------------------------------------
-- 7) GRANTS. Revoke-then-narrow, per the 0049:248-275 shape.
--
-- THE COLUMN LIST ON THE UPDATE GRANT IS THE ENFORCEMENT POINT FOR PARTNER SELF-SERVICE.
-- Owner decision (Phase 21): a partner may edit low-risk contact fields; identity, address,
-- coordinates, status, verification and rating are HQ-owned. Expressing that as a column-level
-- GRANT means a partner cannot write those columns even through a bug in a route handler, a
-- mass-assignment in a service, or a future endpoint nobody has reviewed. A service-layer
-- allowlist alone would be one refactor away from being bypassed.
--
-- Note what is ABSENT and must stay absent: no INSERT, no DELETE for partner_runtime anywhere
-- here; no grant of any kind on partner_public_rating_overrides.
-- ---------------------------------------------------------------------------
REVOKE ALL PRIVILEGES ON partner_public_listings FROM PUBLIC;
REVOKE ALL PRIVILEGES ON partner_public_rating_snapshots FROM PUBLIC;
REVOKE ALL PRIVILEGES ON partner_public_rating_overrides FROM PUBLIC;
REVOKE ALL PRIVILEGES ON partner_public_listings FROM partner_runtime;
REVOKE ALL PRIVILEGES ON partner_public_rating_snapshots FROM partner_runtime;
REVOKE ALL PRIVILEGES ON partner_public_rating_overrides FROM partner_runtime;

GRANT SELECT ON partner_public_listings TO partner_runtime;
GRANT UPDATE (
  public_phone,
  public_email,
  public_website,
  public_opening_info,
  public_description,
  updated_at
) ON partner_public_listings TO partner_runtime;

GRANT SELECT ON partner_public_rating_snapshots TO partner_runtime;

-- ---------------------------------------------------------------------------
-- 8) Completeness assertion. Fail closed rather than journal a half-built public surface.
--
-- Asserting EXISTENCE alone is what previously let a bypassable trigger pass as installed
-- (0035's post-fix note), so this block checks modes and column lists, not just names.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  expected_tables text[] := ARRAY[
    'partner_public_listings','partner_public_rating_snapshots','partner_public_rating_overrides'
  ];
  expected_cons text[] := ARRAY[
    'chk_partner_public_listings_status',
    'chk_partner_public_listings_active_requires_approval',
    'chk_partner_public_listings_coordinate_pair',
    'chk_partner_public_listings_latitude_range',
    'chk_partner_public_listings_longitude_range',
    'chk_partner_public_listings_slug_shape',
    'chk_partner_public_listings_country',
    'chk_partner_public_listings_display_name_present',
    'chk_partner_public_listings_current_rating',
    'chk_partner_public_listings_current_rating_range',
    'chk_partner_public_listings_current_sample',
    'fk_partner_public_listings_location_tenant',
    'chk_partner_public_rating_snapshots_sample',
    'chk_partner_public_rating_snapshots_internal_range',
    'chk_partner_public_rating_snapshots_public_range',
    'chk_partner_public_rating_snapshots_availability',
    'chk_partner_public_rating_snapshots_component_object',
    'fk_partner_public_rating_snapshots_listing_tenant',
    'fk_partner_public_rating_snapshots_location_tenant',
    'chk_partner_public_rating_overrides_public_range',
    'chk_partner_public_rating_overrides_has_effect',
    'chk_partner_public_rating_overrides_removal_pair',
    'chk_partner_public_rating_overrides_reason_present',
    'fk_partner_public_rating_overrides_listing_tenant'
  ];
  expected_indexes text[] := ARRAY[
    'uq_partner_public_listings_location',
    'uq_partner_public_listings_slug',
    'uq_partner_public_listings_tenant_location',
    'uq_partner_public_listings_tenant_id',
    'idx_partner_public_listings_status',
    'idx_partner_public_listings_tenant',
    'idx_partner_public_listings_active_postcode',
    'idx_partner_public_listings_active_outward',
    'idx_partner_public_listings_active_town',
    'idx_partner_public_listings_active_county',
    'idx_partner_public_listings_active_name',
    'idx_partner_public_listings_active_coords',
    'idx_partner_public_listings_active_rating',
    'idx_certificates_origin_location_recent',
    'idx_partner_public_rating_snapshots_tenant',
    'idx_partner_public_rating_snapshots_latest',
    'idx_partner_public_rating_snapshots_location',
    'uq_partner_public_rating_overrides_active',
    'idx_partner_public_rating_overrides_tenant'
  ];
  expected_policies text[] := ARRAY[
    'partner_public_listings_public_read',
    'partner_public_listings_tenant_read',
    'partner_public_listings_tenant_write',
    'partner_public_rating_snapshots_tenant_read',
    'partner_public_rating_snapshots_no_tenant_write',
    'partner_public_rating_snapshots_no_tenant_update',
    'partner_public_rating_snapshots_no_tenant_delete',
    'partner_public_rating_overrides_no_tenant_access'
  ];
  -- The columns partner_runtime MUST be able to update, and by omission the ones it must not.
  expected_update_cols text[] := ARRAY[
    'public_phone','public_email','public_website','public_opening_info','public_description','updated_at'
  ];
  forbidden_update_cols text[] := ARRAY[
    'listing_status','slug','tenant_id','location_id','latitude','longitude',
    'address_line_1','address_line_2','town_city','county','postcode','country',
    'public_display_name','verified_at','approved_at','approved_by','public_since',
    'current_rating_version','current_public_rating','current_rating_label',
    'current_rating_available','current_sample_size','current_minimum_sample',
    'current_rating_is_override','current_rating_calculated_at','current_rating_snapshot_id'
  ];
  fresh_install boolean;
  seeded bigint;
  missing text;
  unprotected text;
  leaked text;
  ungranted text;
BEGIN
  SELECT fresh INTO fresh_install FROM _public_network_0058_state;

  SELECT string_agg(t, ', ' ORDER BY t) INTO missing
    FROM unnest(expected_tables) AS t WHERE to_regclass('public.' || t) IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0058 completeness assertion failed: missing table(s): %', missing;
  END IF;

  SELECT string_agg(c, ', ' ORDER BY c) INTO missing
    FROM unnest(expected_cons) AS c WHERE NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0058 completeness assertion failed: missing constraint(s): %', missing;
  END IF;

  SELECT string_agg(conname, ', ' ORDER BY conname) INTO missing
    FROM pg_constraint WHERE conname = ANY (expected_cons) AND NOT convalidated;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0058 completeness assertion failed: constraint(s) present but NOT VALID: %', missing;
  END IF;

  SELECT string_agg(i, ', ' ORDER BY i) INTO missing
    FROM unnest(expected_indexes) AS i WHERE to_regclass('public.' || i) IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0058 completeness assertion failed: missing index(es): %', missing;
  END IF;

  SELECT string_agg(p, ', ' ORDER BY p) INTO missing
    FROM unnest(expected_policies) AS p
   WHERE NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND policyname = p);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0058 completeness assertion failed: missing policy/policies: %', missing;
  END IF;

  -- RLS must be both ENABLED and FORCED. FORCE is what makes the policies apply to the table
  -- OWNER too; without it a migration-owner session silently sees everything.
  SELECT string_agg(relname, ', ' ORDER BY relname) INTO unprotected
    FROM pg_class
   WHERE relname = ANY (expected_tables)
     AND relnamespace = 'public'::regnamespace
     AND (NOT relrowsecurity OR NOT relforcerowsecurity);
  IF unprotected IS NOT NULL THEN
    RAISE EXCEPTION
      '0058 completeness assertion failed: RLS not ENABLED+FORCED on: %', unprotected;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'trg_partner_public_listing_transition'
       AND tgrelid = 'public.partner_public_listings'::regclass
       AND tgenabled = 'A'
  ) THEN
    RAISE EXCEPTION
      '0058 completeness assertion failed: listing transition trigger missing or not ENABLE ALWAYS (tgenabled=%), so session_replication_role=replica would bypass state-transition control.',
      (SELECT tgenabled FROM pg_trigger WHERE tgname = 'trg_partner_public_listing_transition'
         AND tgrelid = 'public.partner_public_listings'::regclass);
  END IF;

  -- The partner write surface is EXACTLY the safe column list — no more, no less.
  SELECT string_agg(c, ', ' ORDER BY c) INTO ungranted
    FROM unnest(expected_update_cols) AS c
   WHERE NOT has_column_privilege('partner_runtime', 'public.partner_public_listings', c, 'UPDATE');
  IF ungranted IS NOT NULL THEN
    RAISE EXCEPTION
      '0058 completeness assertion failed: partner_runtime cannot UPDATE intended self-service column(s): %', ungranted;
  END IF;

  SELECT string_agg(c, ', ' ORDER BY c) INTO leaked
    FROM unnest(forbidden_update_cols) AS c
   WHERE has_column_privilege('partner_runtime', 'public.partner_public_listings', c, 'UPDATE');
  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION
      '0058 completeness assertion failed: partner_runtime can UPDATE HQ-owned column(s): %. A partner could change its own listing status, address, coordinates or identity.', leaked;
  END IF;

  -- A partner must never write a rating or touch an override, by grant as well as by policy.
  IF has_table_privilege('partner_runtime', 'public.partner_public_rating_snapshots', 'INSERT')
     OR has_table_privilege('partner_runtime', 'public.partner_public_rating_snapshots', 'UPDATE')
     OR has_table_privilege('partner_runtime', 'public.partner_public_rating_snapshots', 'DELETE') THEN
    RAISE EXCEPTION
      '0058 completeness assertion failed: partner_runtime holds a write privilege on partner_public_rating_snapshots.';
  END IF;
  IF has_table_privilege('partner_runtime', 'public.partner_public_rating_overrides', 'SELECT')
     OR has_table_privilege('partner_runtime', 'public.partner_public_rating_overrides', 'INSERT')
     OR has_table_privilege('partner_runtime', 'public.partner_public_rating_overrides', 'UPDATE')
     OR has_table_privilege('partner_runtime', 'public.partner_public_rating_overrides', 'DELETE') THEN
    RAISE EXCEPTION
      '0058 completeness assertion failed: partner_runtime holds a privilege on partner_public_rating_overrides, which must be entirely HQ-owned.';
  END IF;

  -- NO BACKFILL, and it is provable: this migration creates the tables and inserts nothing, so on
  -- a FIRST application every one of them must be empty. A non-zero count would mean something
  -- wrote rows inside this transaction -- i.e. a backfill guessing which shops want to be publicly
  -- listed, which is a claim this file cannot substantiate. Scoped to a fresh install so a
  -- legitimate re-run over a populated estate stays idempotent (same shape as 0035's proof).
  IF fresh_install THEN
    SELECT count(*) INTO seeded FROM partner_public_listings;
    IF seeded > 0 THEN
      RAISE EXCEPTION
        '0058 completeness assertion failed: % public listing(s) exist immediately after a migration that writes no rows.', seeded;
    END IF;
  END IF;

  RAISE NOTICE '0058: public partner network installed (% tables, % constraints, % indexes, % policies). No rows created.',
    array_length(expected_tables, 1), array_length(expected_cons, 1),
    array_length(expected_indexes, 1), array_length(expected_policies, 1);
END$$;
