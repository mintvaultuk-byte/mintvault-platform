-- 0060_partner_public_rating_override_expiry.sql
-- Make a rating override stop applying the moment it expires, without a human or a job.
--
-- THE DEFECT THIS CLOSES (HIGH B).
-- `expires_at` is evaluated in exactly one place: the SELECT inside recalculateRating's transaction
-- (public-network-service.ts). Every public read consumes the DENORMALISED current_* columns that
-- transaction wrote. Nothing recalculates on a schedule — the code says so itself: "ADVISORY ONLY.
-- Nothing recalculates on a schedule, so an expiry cannot fire by itself." So an override with
-- expires_at in the past kept being published verbatim, indefinitely, until a Super Admin happened
-- to press Recalculate. A time-boxed exception that never actually ends is not time-boxed.
--
-- WHY THE LISTING NEEDS MORE COLUMNS.
-- The listing stores only the EFFECTIVE rating — the override value, once one is active. There is
-- therefore nothing to fall back TO at read time: the computed rating it replaced is not on the row.
-- Falling back requires the computed rating to be denormalised alongside the effective one, plus the
-- expiry instant itself, so the public read can decide with column arithmetic and no join.
--
-- WHY NOT JOIN partner_public_rating_overrides AT READ TIME.
-- partner_runtime holds NO privilege on that table, by grant and by policy (0058 asserts all four
-- of SELECT/INSERT/UPDATE/DELETE are absent) — it is entirely HQ-owned, and the `reason` column is
-- internal governance text. Granting the public path access to it to read one timestamp would hand
-- anonymous traffic the Super Admin's written justification for every override in the estate.
--
-- WHY NOT EXPIRE BY TRIGGER OR CRON.
-- 0058 already rejected that, for a reason that still holds: "a trigger that retired rows on a clock
-- would mutate history behind the operator's back." Nothing here retires, deletes or rewrites an
-- override row. The record — value, reason, actor, created_at, expires_at — survives untouched and
-- stays auditable. Only its EFFECT lapses, and it lapses by comparison at read time.
--
-- Additive only. Edits no applied migration and drops nothing.

ALTER TABLE partner_public_listings
  -- The expiry instant of the override currently reflected in current_*. NULL means either no
  -- override, or an override with no expiry — both of which mean "does not lapse".
  ADD COLUMN IF NOT EXISTS current_override_expires_at timestamptz,
  -- The COMPUTED rating, kept beside the effective one so an expiry has something honest to fall
  -- back to. When no override is active these mirror the current_* values.
  ADD COLUMN IF NOT EXISTS current_computed_public_rating numeric(3,2),
  ADD COLUMN IF NOT EXISTS current_computed_rating_label text,
  ADD COLUMN IF NOT EXISTS current_computed_rating_available boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS current_computed_rating_version text;

-- Backfill 1: rows with no active override. The effective rating IS the computed rating.
UPDATE partner_public_listings
   SET current_computed_public_rating   = current_public_rating,
       current_computed_rating_label    = current_rating_label,
       current_computed_rating_available = current_rating_available,
       current_computed_rating_version  = current_rating_version
 WHERE current_rating_is_override IS NOT TRUE;

-- Backfill 2: rows currently showing an override. The computed rating it replaced was copied onto
-- the override row at the moment of override, precisely so it could always be explained against
-- what it displaced — so the honest fallback already exists and does not have to be recomputed.
UPDATE partner_public_listings l
   SET current_override_expires_at       = o.expires_at,
       current_computed_public_rating    = o.computed_public_rating,
       current_computed_rating_label     = COALESCE(o.computed_rating_label, 'Rating building'),
       current_computed_rating_available = (o.computed_public_rating IS NOT NULL),
       current_computed_rating_version   = l.current_rating_version
  FROM partner_public_rating_overrides o
 WHERE o.listing_id = l.id
   AND o.removed_at IS NULL
   AND l.current_rating_is_override IS TRUE;

-- Fail CLOSED for any override row whose computed fallback could not be resolved: no rating at all
-- beats republishing a number nobody can account for.
UPDATE partner_public_listings
   SET current_computed_rating_label = COALESCE(current_computed_rating_label, 'Rating building'),
       current_computed_rating_available = false,
       current_computed_public_rating = NULL
 WHERE current_computed_rating_available IS TRUE
   AND current_computed_public_rating IS NULL;

-- Supports the reconciler/admin sweep that wants to find listings whose override has lapsed. The
-- PUBLIC read does not need this index — it filters by slug or by the eligibility predicate first —
-- but a sweep over "which overrides have quietly stopped applying" would otherwise be a seq scan.
CREATE INDEX IF NOT EXISTS idx_partner_public_listings_override_expiry
  ON partner_public_listings (current_override_expires_at)
  WHERE current_rating_is_override = true AND current_override_expires_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Privileges — every new column is HQ/system state, readable but never partner-writable
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  new_cols text[] := ARRAY[
    'current_override_expires_at',
    'current_computed_public_rating',
    'current_computed_rating_label',
    'current_computed_rating_available',
    'current_computed_rating_version'
  ];
  c text;
  leaked text;
  unreadable text;
BEGIN
  IF to_regclass('public.partner_public_listings') IS NULL THEN
    RAISE EXCEPTION '0060: partner_public_listings is missing';
  END IF;

  FOREACH c IN ARRAY new_cols LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='partner_public_listings' AND column_name=c
    ) THEN
      RAISE EXCEPTION '0060: column % was not created', c;
    END IF;
  END LOOP;

  -- A partner must never be able to write its own rating, its own override, or the expiry that
  -- governs it. 0058's grant is column-scoped so these are excluded automatically — asserted here
  -- rather than assumed, because "excluded automatically" stops being true the day somebody writes
  -- GRANT UPDATE without a column list.
  SELECT string_agg(c2, ', ' ORDER BY c2) INTO leaked
    FROM unnest(new_cols) AS c2
   WHERE has_column_privilege('partner_runtime', 'public.partner_public_listings', c2, 'UPDATE');
  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION
      '0060 completeness assertion failed: partner_runtime can UPDATE rating-governing column(s): %. A partner could extend or remove its own rating override.', leaked;
  END IF;

  -- They must remain READABLE: the effective-rating selection is evaluated on the public read path.
  SELECT string_agg(c2, ', ' ORDER BY c2) INTO unreadable
    FROM unnest(new_cols) AS c2
   WHERE NOT has_column_privilege('partner_runtime', 'public.partner_public_listings', c2, 'SELECT');
  IF unreadable IS NOT NULL THEN
    RAISE EXCEPTION
      '0060 completeness assertion failed: partner_runtime cannot SELECT column(s) the public read needs: %', unreadable;
  END IF;

  -- The override table stays entirely HQ-owned. This migration must not have loosened it.
  IF has_table_privilege('partner_runtime', 'public.partner_public_rating_overrides', 'SELECT') THEN
    RAISE EXCEPTION
      '0060 completeness assertion failed: partner_runtime can SELECT partner_public_rating_overrides, which carries the internal reason text for every override.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname='public' AND indexname='idx_partner_public_listings_override_expiry'
  ) THEN
    RAISE EXCEPTION '0060: override-expiry index missing';
  END IF;

  -- No row may claim an available computed rating without a value to show.
  IF EXISTS (
    SELECT 1 FROM partner_public_listings
     WHERE current_computed_rating_available IS TRUE AND current_computed_public_rating IS NULL
  ) THEN
    RAISE EXCEPTION '0060: a listing claims an available computed rating with no value';
  END IF;
END$$;
