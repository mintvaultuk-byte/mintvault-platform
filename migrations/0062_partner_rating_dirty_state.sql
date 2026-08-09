-- 0062_partner_rating_dirty_state.sql
-- Durable "this shop's rating needs recomputing" state, so rating refresh stops being a button.
--
-- THE DEFECT THIS CLOSES.
-- recalculateRating has exactly three callers, all Super Admin routes. Nothing recalculates on a
-- schedule and nothing recalculates on a lifecycle event, so a shop's published rating is only ever
-- as fresh as the last time a human remembered to press Recalculate. A quality signal nobody
-- refreshes is not a quality signal.
--
-- WHY DURABLE STATE RATHER THAN A BEST-EFFORT CALL.
-- The obvious shape is "recalculate after the approval commits". That is necessary but not
-- sufficient: the process can die between the commit and the refresh, a Fly machine can restart
-- mid-request, and the refresh itself can fail. Any of those loses the work silently, because
-- nothing recorded that it was owed. Marking dirty INSIDE the transaction that changes the evidence
-- makes the obligation durable — it commits or it doesn't, with the evidence it belongs to — and
-- the reconciler is then a safety net rather than the only mechanism.
--
-- WHAT IS DELIBERATELY NOT STORED.
-- No exception text, no SQLSTATE detail, no query. rating_last_error_code holds a SHORT CLASSIFIED
-- code chosen by the application, because this table is read by the public projection's own table
-- and a raw driver message routinely carries row values and host names. The failure detail belongs
-- in logs, not in a column one careless view change away from being public.
--
-- Additive only. Edits no applied migration and drops nothing.

ALTER TABLE partner_public_listings
  -- The obligation. TRUE means "the evidence moved since the last successful calculation".
  ADD COLUMN IF NOT EXISTS rating_dirty boolean NOT NULL DEFAULT false,
  -- When it FIRST became dirty and has stayed dirty. Used for deterministic oldest-first ordering
  -- so a reconciler under load cannot starve one shop indefinitely. Not overwritten by later marks.
  ADD COLUMN IF NOT EXISTS rating_dirty_since timestamptz,
  -- Attempt vs success are separate on purpose: equal values mean healthy, an attempt far ahead of
  -- the last success is precisely the "repeatedly failing" signal Needs Attention keys on.
  ADD COLUMN IF NOT EXISTS rating_last_attempted_at timestamptz,
  ADD COLUMN IF NOT EXISTS rating_last_success_at timestamptz,
  ADD COLUMN IF NOT EXISTS rating_failure_count integer NOT NULL DEFAULT 0,
  -- A short application-chosen classification only. NEVER driver text.
  ADD COLUMN IF NOT EXISTS rating_last_error_code text;

-- Every existing listing has a rating that predates this mechanism, so none of them is known-fresh.
-- Marking them dirty is the honest starting state: the reconciler will recompute each once, and a
-- listing that genuinely has not changed simply produces the same numbers again (recalculation is
-- idempotent in effect). Starting them clean would assert a freshness nothing has established.
UPDATE partner_public_listings
   SET rating_dirty = true,
       rating_dirty_since = COALESCE(rating_dirty_since, now())
 WHERE rating_dirty = false;

-- PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS, so a bare ADD CONSTRAINT makes the whole
-- migration non-idempotent: a re-apply after a rollback — or a retried deploy — fails with
-- "constraint already exists" and takes every later statement down with it. The house pattern
-- (0049) is a pg_constraint existence check, so re-application is a no-op.
DO $$
BEGIN
  -- A dirty listing must always carry the timestamp the reconciler orders by.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_partner_public_listings_rating_dirty_since'
  ) THEN
    ALTER TABLE partner_public_listings
      ADD CONSTRAINT chk_partner_public_listings_rating_dirty_since
      CHECK (rating_dirty = false OR rating_dirty_since IS NOT NULL);
  END IF;

  -- Failure counts are counts.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_partner_public_listings_rating_failure_count'
  ) THEN
    ALTER TABLE partner_public_listings
      ADD CONSTRAINT chk_partner_public_listings_rating_failure_count
      CHECK (rating_failure_count >= 0);
  END IF;
END$$;

-- THE RECONCILER'S CANDIDATE INDEX. Partial on rating_dirty so it stays small no matter how large
-- the estate grows: in a healthy system almost nothing is dirty, and the index holds only the work.
CREATE INDEX IF NOT EXISTS idx_partner_public_listings_rating_dirty
  ON partner_public_listings (rating_dirty_since, id)
  WHERE rating_dirty = true;

-- ---------------------------------------------------------------------------
-- Privileges and exposure
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  new_cols text[] := ARRAY[
    'rating_dirty','rating_dirty_since','rating_last_attempted_at',
    'rating_last_success_at','rating_failure_count','rating_last_error_code'
  ];
  c text;
  leaked text;
  viewdef text;
BEGIN
  FOREACH c IN ARRAY new_cols LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='partner_public_listings' AND column_name=c
    ) THEN
      RAISE EXCEPTION '0062: column % was not created', c;
    END IF;
  END LOOP;

  -- A partner must not be able to declare its own rating fresh, or bury a failure count.
  SELECT string_agg(c2, ', ' ORDER BY c2) INTO leaked
    FROM unnest(new_cols) AS c2
   WHERE has_column_privilege('partner_runtime', 'public.partner_public_listings', c2, 'UPDATE');
  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION
      '0062 completeness assertion failed: partner_runtime can UPDATE rating lifecycle column(s): %. A partner could mark its own rating clean and freeze a stale score in place.', leaked;
  END IF;

  -- These are INTERNAL operations state. They must never reach the anonymous projection: the
  -- failure count and error code describe our own reliability, not the shop's quality, and
  -- publishing them would invite exactly the wrong reading.
  IF to_regclass('public.partner_public_shop_projection') IS NOT NULL THEN
    SELECT pg_get_viewdef('public.partner_public_shop_projection'::regclass, true) INTO viewdef;
    FOREACH c IN ARRAY new_cols LOOP
      IF viewdef LIKE '%' || c || '%' THEN
        RAISE EXCEPTION '0062: the public shop projection exposes internal rating lifecycle column %', c;
      END IF;
    END LOOP;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname='public' AND indexname='idx_partner_public_listings_rating_dirty'
  ) THEN
    RAISE EXCEPTION '0062: the reconciler candidate index is missing';
  END IF;

  IF EXISTS (
    SELECT 1 FROM partner_public_listings WHERE rating_dirty = true AND rating_dirty_since IS NULL
  ) THEN
    RAISE EXCEPTION '0062: a dirty listing has no rating_dirty_since to order by';
  END IF;
END$$;
