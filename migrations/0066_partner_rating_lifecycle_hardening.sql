-- 0066_partner_rating_lifecycle_hardening.sql
-- Make the rating reconciler's concurrency, retry and freshness model REAL rather than described.
--
-- 0062 gave the rating a durable obligation. Hostile review then found five ways the mechanism
-- around that obligation does not do what its own comments claim. This migration supplies the
-- state each repair needs; the behaviour lives in server/partner/public-network-rating-lifecycle.ts
-- and every claim below is pinned by a mutation test named in brackets.
--
-- ============================================================================================
-- H2 · LOST UPDATE IN markRatingClean            [mutation RATING-CAS1]
-- ============================================================================================
-- markRatingClean is an unconditional `SET rating_dirty = false`. The refresh sequence is:
--
--     read evidence  ──►  compute  ──►  write snapshot  ──►  mark clean
--                    ▲
--                    └── an HQ approval that lands ANYWHERE in here is marked dirty, and then
--                        marked clean again by a calculation that never saw it.
--
-- The window is the whole of recalculateRating — an aggregate over `certificates` plus a
-- transaction — so this is not a narrow race. The listing then sits clean and stale until the
-- next unrelated review, and the reconciler cannot help because nothing says it is owed.
--
-- A boolean cannot express "clean AS OF a version of the evidence". Two monotonic counters can:
--
--     rating_dirty_generation   bumped by EVERY dirty mark, including a mark on an already-dirty
--                               listing (which is why markRatingDirty's `AND rating_dirty = false`
--                               guard had to go — it silently swallowed the bump)
--     rating_clean_generation   set to the generation OBSERVED BEFORE the calculation started
--
-- markRatingClean becomes a compare-and-swap: it clears the flag only while
-- `rating_dirty_generation` still equals the value captured at the start. A dirty mark that
-- arrives mid-calculation moves the generation, the CAS matches zero rows, and the listing stays
-- dirty for the reconciler. The stale snapshot is still written — it is history, and it was
-- correct as of the evidence it saw — but it is not allowed to claim freshness.
--
-- bigint, not integer: monotonic per dirty mark, never reset. int4 would wrap in ~2.1bn marks,
-- which is not reachable but is also not a risk worth carrying for four bytes.
--
-- ============================================================================================
-- H3 · "FOR UPDATE SKIP LOCKED" IN AUTOCOMMIT PROTECTS NOTHING
-- ============================================================================================
-- The reconciler's candidate query is run through partnerAdminQuery — a single `pool.query` with
-- no surrounding transaction. PostgreSQL wraps it in an IMPLICIT transaction that commits when
-- the statement ends, so every row lock SKIP LOCKED took is released before the first row is
-- processed. The file's own comment claims "two reconcilers on two Fly machines take disjoint
-- work"; in fact two runners select the SAME rows and recalculate them in parallel.
--
-- Today the advisory lock in server/index.ts (`withAdvisoryLock(pool, "partner-rating-reconciler")`)
-- hides this for the SCHEDULED path only. runRatingReconciler is exported and called directly by
-- tests and by any future operator route, and an advisory lock held by a dead machine's session
-- is not a claim on a row.
--
--   rating_claimed_until   a DURABLE lease. A worker claims candidates by writing a future
--                          timestamp in the SAME STATEMENT as the SKIP LOCKED select, so the lock
--                          and the claim commit together. Expiry is the crash-recovery path: a
--                          worker that dies mid-item releases its claim by the clock, with no
--                          liveness protocol and nothing to reap.
--   rating_claimed_by      the actor, for operator diagnosis only. Never a correctness input —
--                          a claim is honoured because it is unexpired, never because of who
--                          holds it.
--
-- ============================================================================================
-- H4 · HEAD-OF-LINE STARVATION                   [mutation RATING-HOL1]
-- ============================================================================================
-- The reconciler orders by `rating_dirty_since ASC` and a permanently failing listing keeps the
-- OLDEST dirty timestamp forever, because failure re-marks it dirty without moving that column
-- (deliberately — that monotonicity is what stops a busy shop starving a quiet one). So a single
-- poisoned row is first in every batch, for every tick, permanently. With RATING_RECONCILER_BATCH
-- listings poisoned, no healthy listing is ever reached again.
--
--   rating_next_attempt_at   retry eligibility. Set on failure to a DETERMINISTIC exponential
--                            backoff of the failure count, capped. A poisoned row drops out of
--                            the candidate set until its backoff elapses and healthy rows behind
--                            it are processed. It is never abandoned — it keeps retrying, just
--                            not at the expense of everything else — and Needs Attention still
--                            surfaces it at the existing failure threshold.
--
-- Deterministic, not jittered: two runners must walk the queue the same way, and the lease above
-- is what prevents them colliding. Jitter here would buy nothing and make the order untestable.
--
-- ============================================================================================
-- H5 · NEW LISTINGS ARE BORN CLEAN               [mutation RATING-NEW1]
-- ============================================================================================
-- 0062 defaulted rating_dirty to FALSE. A newly approved shop therefore asserts a freshness that
-- has never been established: it has no snapshot, no computed score, and nothing owes it one. It
-- shows no rating at all until a human presses Recalculate — the exact manual dependency 0062
-- exists to remove, reintroduced at the one moment it is most visible (a shop's first day live).
--
-- The DEFAULT is flipped, AND a BEFORE INSERT trigger forces it. A default alone is not enough:
-- `INSERT ... (rating_dirty) VALUES (false)` overrides a default and would silently recreate the
-- defect, which is precisely what the mutation test does. The trigger makes that unrepresentable.
--
-- ============================================================================================
-- H6 · A ROLLING WINDOW DECAYS BY CLOCK, AND NOTHING WATCHES THE CLOCK  [mutation RECENCY-CLOCK1]
-- ============================================================================================
-- Every dirty mark is caused by a WRITE — an approval, a return. But a 180-day rolling rating
-- changes with no write at all: the day a shop's oldest bounced card crosses the window boundary
-- its first-pass rate improves, and the day its tenth-newest card crosses out, the sample gate can
-- close and the rating should disappear. A shop that stops trading keeps publishing a rating
-- computed from evidence that is no longer inside its own window.
--
-- Recalculating every listing on every request is not an option and neither is a nightly sweep of
-- the estate. The cheap correct thing is to compute, at the moment of a successful calculation,
-- the EARLIEST future instant at which the answer could differ:
--
--     rating_next_recalc_at = (oldest evidence timestamp inside the window) + 180 days
--
-- Before that instant the same units are in the window and the result is provably unchanged;
-- at it, exactly one unit leaves. A listing with no evidence at all gets a bounded fallback
-- sweep instead of NULL, so "no cards yet" cannot mean "never looked at again".
--
-- The reconciler's candidate set is widened to include due-for-recalculation listings even when
-- they are clean. That is the only place time enters the mechanism.
--
-- ============================================================================================
-- LOCKS
-- ============================================================================================
-- Every ALTER here is on `partner_public_listings`, a partner table with no HQ traffic and — on
-- staging and production — ZERO ROWS, because 0058 has not been applied. All columns are nullable
-- or NOT NULL with a constant default (PostgreSQL 11+ stores those in the catalog, no rewrite).
-- The trigger takes ShareRowExclusive on the same table. Nothing here touches `certificates`,
-- `cert_counter`, `submissions` or any other hot table, so there is no quiet window to schedule.
--
-- Additive only. Drops nothing, rewrites no applied migration.

-- --------------------------------------------------------------------------------------------
-- 1. Columns
-- --------------------------------------------------------------------------------------------
ALTER TABLE partner_public_listings
  ADD COLUMN IF NOT EXISTS rating_dirty_generation bigint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS rating_clean_generation bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rating_next_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS rating_next_recalc_at timestamptz,
  ADD COLUMN IF NOT EXISTS rating_claimed_until timestamptz,
  ADD COLUMN IF NOT EXISTS rating_claimed_by text;

COMMENT ON COLUMN partner_public_listings.rating_dirty_generation IS
  'Monotonic counter bumped by every dirty mark. Compared against rating_clean_generation to make mark-clean a compare-and-swap, so a quality event that lands DURING a calculation is not erased by it.';
COMMENT ON COLUMN partner_public_listings.rating_clean_generation IS
  'The generation a successful calculation was computed FROM. Equal to rating_dirty_generation means fresh; behind it means work is owed.';
COMMENT ON COLUMN partner_public_listings.rating_next_attempt_at IS
  'Retry eligibility after a failure (deterministic capped exponential backoff). Stops one permanently-failing listing occupying every bounded reconciler batch forever.';
COMMENT ON COLUMN partner_public_listings.rating_next_recalc_at IS
  'The earliest instant the 180-day rolling window could change this rating with no workflow write at all: oldest included evidence + the window. The only clock-driven input to the reconciler.';
COMMENT ON COLUMN partner_public_listings.rating_claimed_until IS
  'Durable reconciler lease. Written in the SAME statement as the SKIP LOCKED claim, so two workers cannot process one listing. Expiry is the crash-recovery path — a dead worker releases by the clock.';

-- --------------------------------------------------------------------------------------------
-- 2. Existing rows
-- --------------------------------------------------------------------------------------------
-- 0062 already marked every pre-existing listing dirty. The generations must AGREE with that flag
-- or the two mechanisms would disagree on the first tick: a listing whose flag says dirty but
-- whose generations say fresh would be recalculated and then immediately CAS-cleaned against a
-- generation nobody had bumped.
UPDATE partner_public_listings
   SET rating_dirty_generation = GREATEST(rating_dirty_generation, rating_clean_generation + 1)
 WHERE rating_dirty = true
   AND rating_dirty_generation <= rating_clean_generation;

UPDATE partner_public_listings
   SET rating_clean_generation = rating_dirty_generation
 WHERE rating_dirty = false
   AND rating_clean_generation <> rating_dirty_generation;

-- --------------------------------------------------------------------------------------------
-- 3. Born dirty
-- --------------------------------------------------------------------------------------------
ALTER TABLE partner_public_listings
  ALTER COLUMN rating_dirty SET DEFAULT true;

-- The DEFAULT covers the ordinary INSERT. The trigger covers the one that names the column, which
-- is what a regression would actually look like. SECURITY INVOKER (the PostgreSQL default) is
-- correct: it changes no privilege, it only refuses to record a freshness claim nothing earned.
-- search_path is pinned with pg_temp LAST, per the 0006 convention and the 0044 defect that
-- convention exists to prevent.
CREATE OR REPLACE FUNCTION partner_public_listings_born_dirty()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- A listing that has never been calculated cannot be clean, whatever the INSERT says.
  NEW.rating_dirty := true;
  NEW.rating_dirty_since := COALESCE(NEW.rating_dirty_since, now());
  IF NEW.rating_clean_generation >= NEW.rating_dirty_generation THEN
    NEW.rating_dirty_generation := NEW.rating_clean_generation + 1;
  END IF;
  -- Eligible for the very next reconciler tick. A first rating should appear within minutes of
  -- approval, not at whatever cadence a sweep happens to run.
  NEW.rating_next_attempt_at := NULL;
  RETURN NEW;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.partner_public_listings'::regclass
       AND tgname = 'trg_partner_public_listings_born_dirty'
  ) THEN
    CREATE TRIGGER trg_partner_public_listings_born_dirty
      BEFORE INSERT ON partner_public_listings
      FOR EACH ROW EXECUTE FUNCTION partner_public_listings_born_dirty();
  END IF;
END$$;

-- --------------------------------------------------------------------------------------------
-- 4. Constraints
-- --------------------------------------------------------------------------------------------
DO $$
BEGIN
  -- The generations define dirtiness; the boolean is the queue's index key. They must not be able
  -- to disagree, or the reconciler and the CAS would each be right about a different listing.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_partner_public_listings_rating_generations'
  ) THEN
    ALTER TABLE partner_public_listings
      ADD CONSTRAINT chk_partner_public_listings_rating_generations
      CHECK (
        rating_dirty_generation >= 0
        AND rating_clean_generation >= 0
        AND rating_clean_generation <= rating_dirty_generation
        AND (rating_dirty = (rating_clean_generation < rating_dirty_generation))
      );
  END IF;
END$$;

-- --------------------------------------------------------------------------------------------
-- 5. The reconciler's candidate index
-- --------------------------------------------------------------------------------------------
-- 0062's index is partial on `rating_dirty = true` and orders by rating_dirty_since. The
-- candidate set now also contains CLEAN listings that are due by the clock (H6), which that index
-- cannot serve. This one is partial on "has any future obligation at all", which in a healthy
-- estate is still almost nothing.
CREATE INDEX IF NOT EXISTS idx_partner_public_listings_rating_due
  ON partner_public_listings (rating_next_recalc_at)
  WHERE rating_next_recalc_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_partner_public_listings_rating_retry
  ON partner_public_listings (rating_next_attempt_at, rating_dirty_since, id)
  WHERE rating_dirty = true;

-- --------------------------------------------------------------------------------------------
-- 6. Privileges and exposure
-- --------------------------------------------------------------------------------------------
DO $$
DECLARE
  new_cols text[] := ARRAY[
    'rating_dirty_generation','rating_clean_generation','rating_next_attempt_at',
    'rating_next_recalc_at','rating_claimed_until','rating_claimed_by'
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
      RAISE EXCEPTION '0066: column % was not created', c;
    END IF;
  END LOOP;

  -- A partner that could write a generation could declare its own rating fresh — the same attack
  -- 0062 closed for the boolean, now available through the counter that supersedes it.
  SELECT string_agg(c2, ', ' ORDER BY c2) INTO leaked
    FROM unnest(new_cols) AS c2
   WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_runtime')
     AND has_column_privilege('partner_runtime', 'public.partner_public_listings', c2, 'UPDATE');
  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION
      '0066 completeness assertion failed: partner_runtime can UPDATE rating lifecycle column(s): %.', leaked;
  END IF;

  -- Internal operations state. A visitor learning that our reconciler is failing on a shop, or
  -- when we next intend to look at it, learns nothing about the shop and something about us.
  IF to_regclass('public.partner_public_shop_projection') IS NOT NULL THEN
    SELECT pg_get_viewdef('public.partner_public_shop_projection'::regclass, true) INTO viewdef;
    FOREACH c IN ARRAY new_cols LOOP
      IF viewdef LIKE '%' || c || '%' THEN
        RAISE EXCEPTION '0066: the public shop projection exposes internal rating lifecycle column %', c;
      END IF;
    END LOOP;
  END IF;

  -- The trigger must be present AND enabled: a disabled trigger is the silent version of this bug.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.partner_public_listings'::regclass
       AND tgname = 'trg_partner_public_listings_born_dirty'
       AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION '0066: the born-dirty trigger is missing or disabled';
  END IF;

  -- The invariant the CHECK states, asserted against the actual rows as well as the constraint.
  IF EXISTS (
    SELECT 1 FROM partner_public_listings
     WHERE rating_dirty <> (rating_clean_generation < rating_dirty_generation)
  ) THEN
    RAISE EXCEPTION '0066: a listing''s rating_dirty flag disagrees with its generations after backfill';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname='public' AND indexname='idx_partner_public_listings_rating_retry') THEN
    RAISE EXCEPTION '0066: the retry-eligibility index is missing';
  END IF;
END$$;
