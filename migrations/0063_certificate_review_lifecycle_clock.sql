-- 0063_certificate_review_lifecycle_clock.sql
-- A durable quality-review clock on `certificates`, and the two schema facts the rating engine
-- was relying on without a migration behind them.
--
-- ============================================================================================
-- THE DEFECT THIS CLOSES (BLOCKER B1 — the 180-day window reopens the L1 gaming hole)
-- ============================================================================================
-- PARTNER_QUALITY_V2 fixed the DENOMINATOR: a unit that entered review stays in the population
-- whether or not it was ever approved, so abandoning your worst work no longer raises your score.
-- It did not fix the CLOCK. The rolling 180-day window positions each unit in time with
--
--     COALESCE(grade_approved_at, graded_at, status_updated_at, issued_at)
--
-- and for the exact unit V2 exists to keep — reviewed, returned, abandoned — every one of the
-- first three is NULL:
--
--   * grade_approved_at   NULL by definition; the unit was never approved.
--   * graded_at           server/grader.ts:1129 sets `graded_at = NULL` in the rejection CAS.
--                         Returning a card DELETES the only grading timestamp it had.
--   * status_updated_at   written by exactly one route (the shipping/status endpoint), never by
--                         the grading lifecycle, and — see below — not created by any migration.
--
-- So `ev` falls through to `issued_at`: the moment the certificate row was CREATED at connector
-- import. That is an INTAKE date, not a review date, and the gap between them is entirely under
-- the partner's control. A shop that imports a batch, sits on it, grades it badly six months
-- later and abandons the bounced units has evidence that is already outside the window on the
-- day it is created. The bad work is invisible from birth.
--
-- Reproduced end to end against real PostgreSQL 17 before this migration was written:
-- tests/partner-review-clock.test.ts, case "abandoned unit reviewed today, imported 200 days ago".
--
-- ============================================================================================
-- THE FIX, AND WHY IT IS ONE COLUMN AND NOT AN EVENT STORE
-- ============================================================================================
-- `review_entered_at` records the LATEST moment a physical unit entered or re-entered MintVault
-- quality review. It is written by exactly two places, both of which are the events that put a
-- unit into the V2 population in the first place:
--
--   * submit-for-review        server/partner/grading-routes.ts — the unit arrives at HQ review
--   * HQ return-for-change     server/grader.ts rejection CAS   — the unit's review outcome is
--                              recorded, and `redo_count` (the V2 population predicate) moves in
--                              the SAME statement, so the clock cannot disagree with the evidence
--
-- Approval needs no writer: `grade_approved_at` already IS the review date for an approved unit,
-- and the engine takes GREATEST(grade_approved_at, review_entered_at) so the two are comparable
-- rather than competing.
--
-- LATEST, not first, and that direction is deliberate. Under "latest", continuing to rework a
-- unit keeps its evidence INSIDE the window — the direction that costs the shop. Under "first",
-- a unit could be bounced repeatedly and still age out 180 days after its first bounce, which is
-- the same hole in a different place.
--
-- An event table was considered and rejected: nothing in the rating needs the history, only the
-- position in time, and a second store is a second thing that can disagree with `certificates`.
--
-- WHAT THIS IS NOT. It is not grading data. It does not participate in any score, weight,
-- threshold, deduction, centering or Pristine decision. It positions an already-computed piece
-- of evidence on a calendar. The MVGS engine is untouched by this migration and by the code
-- change that writes the column.
--
-- ============================================================================================
-- ALSO CLOSED HERE (HIGH H9 — certificates.status_updated_at exists only via boot-time DDL)
-- ============================================================================================
-- `status_updated_at` is read by the rating engine and WRITTEN by the certificate status route
-- (server/routes.ts), but no migration creates it. It exists on staging and production only
-- because server/routes.ts runs an `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` at boot. A fresh
-- database built from the migration chain therefore does NOT have it, and the test estate had to
-- invent it in a fixture — which is how a column nobody owns became load-bearing.
--
-- Two things are done about that, and both are needed:
--   1. it is created HERE, so a fresh database from migrations matches the real estate;
--   2. the rating engine stops reading it (see server/partner/public-network-service.ts) — the
--      review clock above supersedes it and is actually written by the review lifecycle.
-- The boot-time DDL is left alone: removing it is a separate change to a 12,000-line route file
-- and this migration makes it redundant rather than unsafe.
--
-- ============================================================================================
-- LOCKS AND QUIET WINDOW — READ THIS BEFORE APPLYING
-- ============================================================================================
-- ⚠️ THIS FILE TAKES **ACCESS EXCLUSIVE** ON `certificates`, WHICH BLOCKS READS AS WELL AS WRITES.
-- That is STRONGER than anything else in the 0047+ series: 0058's plain CREATE INDEX takes
-- ShareLock (writes blocked, the public certificate-lookup trust surface stays up) and 0054 takes
-- ShareRowExclusive on cert_counter (issuance blocked, reads fine). ADD COLUMN is the first
-- statement in this series that can 404 the public verification page, so the window is kept as
-- small as it is possible to make it:
--
--   * Both ALTERs are CATALOG-ONLY — nullable, no DEFAULT — so PostgreSQL rewrites no heap pages.
--     The work itself is microseconds; the cost is acquiring the lock, not holding it.
--   * NO INDEX IS BUILT IN THIS FILE. It was moved to 0065, which builds it CONCURRENTLY and
--     takes no blocking lock at all. This matters because scripts/db/migrate.ts:190 wraps each
--     transaction-safe file in ONE BEGIN..COMMIT, so a lock taken by statement 1 is held until
--     the file COMMITs. An index build inside this transaction would have held ACCESS EXCLUSIVE
--     — i.e. blocked every public certificate lookup — for the whole build. That is exactly the
--     shape of accident this note exists to prevent a future editor from reintroducing:
--     DO NOT ADD A CREATE INDEX, A LONG BACKFILL, OR ANY SLOW STATEMENT TO THIS FILE.
--   * The backfill is scoped to units ALREADY in the reviewed-but-unapproved population. On
--     production that is ZERO rows today (no partner-originated certificate has ever been
--     issued); on any estate it is a small fraction of the table and uses no index it lacks.
--   * `SET LOCAL lock_timeout` below tightens the runner's 5s default to 2s for this file. If the
--     lock cannot be had in 2s we abort with 55P03 and roll back cleanly rather than queueing
--     certificate reads behind an unacquirable lock. Retry in a quieter moment.
--
-- MEASURED, not assumed: lock modes for this series were measured statement-by-statement on a
-- disposable PostgreSQL 17.10 cluster (2026-08-09). See docs/partner-public-network-0058.md
-- "Migration quiet windows".
--
-- Additive only. Drops nothing, rewrites no applied migration.

-- Tighter than the runner's 5s default, because this file holds ACCESS EXCLUSIVE on the public
-- trust surface. SET LOCAL, so it reverts at COMMIT and cannot leak to the next migration.
SET LOCAL lock_timeout = '2s';

-- --------------------------------------------------------------------------------------------
-- 1. The columns
-- --------------------------------------------------------------------------------------------
-- CONDITIONAL, because 0063 DOES NOT OWN `certificates`. Several partner suites apply the full
-- migration chain against a minimal certificates stub. The same discipline 0058 uses for its
-- index applies here: a migration that reaches into a table it does not own must tolerate that
-- table being absent, and the completeness assertion at the bottom is scoped identically so this
-- cannot silently degrade into "asserted nothing" on a real database.
DO $$
BEGIN
  IF to_regclass('public.certificates') IS NULL THEN
    RAISE NOTICE '0063: certificates is absent (partner-only fixture) — review clock not installed';
    RETURN;
  END IF;

  EXECUTE 'ALTER TABLE certificates
             ADD COLUMN IF NOT EXISTS review_entered_at timestamptz';

  -- H9. Present on staging and production through boot-time DDL only; created here so a fresh
  -- database from the migration chain has the same shape. TIMESTAMP (not timestamptz) to match
  -- the boot-time DDL exactly — a migration that disagreed with the live column would produce two
  -- different types for one name depending on how the database was built.
  EXECUTE 'ALTER TABLE certificates
             ADD COLUMN IF NOT EXISTS status_updated_at timestamp';
END$$;

COMMENT ON COLUMN certificates.review_entered_at IS
  'Latest moment this physical unit entered or re-entered MintVault quality review (submit-for-review, or an HQ return-for-change). The rolling-window clock for the partner quality rating. NOT grading data: it participates in no score, weight, threshold or grade decision.';

-- --------------------------------------------------------------------------------------------
-- 2. Backfill
-- --------------------------------------------------------------------------------------------
-- Only units that are ALREADY in the reviewed population and have no approval date — precisely
-- the rows whose clock is currently wrong. An approved unit needs nothing: grade_approved_at is
-- its review date and the engine reads it directly.
--
-- The fallback order is best-surviving-evidence first. `updated_at` is preferred over `issued_at`
-- because the rejection CAS touches it, so for exactly these rows it is the closest surviving
-- proxy for "when the review outcome was recorded". `issued_at` is the last resort and only
-- reproduces today's (wrong) behaviour for rows where nothing better survives — it never makes a
-- row look NEWER than the truth, so it cannot manufacture evidence, only fail to rescue it.
DO $$
BEGIN
  IF to_regclass('public.certificates') IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='certificates' AND column_name='redo_count') THEN
    RETURN;
  END IF;

  EXECUTE $q$
    UPDATE certificates
       SET review_entered_at = COALESCE(graded_at, status_updated_at, updated_at, issued_at)
     WHERE review_entered_at IS NULL
       AND grade_approved_at IS NULL
       AND redo_count > 0
  $q$;
END$$;

-- --------------------------------------------------------------------------------------------
-- 3. The reviewed-unit index — DELIBERATELY NOT HERE
-- --------------------------------------------------------------------------------------------
-- H10 (the rating measurement seq-scans `certificates` because 0058's partial index excludes
-- abandoned units) is real and is closed — in 0065, CONCURRENTLY, outside any transaction.
-- See the lock note in this file's header for why building it here would have been an outage.

-- --------------------------------------------------------------------------------------------
-- 4. Privileges
-- --------------------------------------------------------------------------------------------
-- The review clock is HQ-written evidence. A partner that could set it could hold its own bad
-- work inside or outside the window at will, which would defeat the entire point of the column.
-- No GRANT is issued here; the assertion below proves the absence rather than trusting it.

-- --------------------------------------------------------------------------------------------
-- 5. Completeness assertions
-- --------------------------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  IF to_regclass('public.certificates') IS NULL THEN
    RAISE NOTICE '0063: certificates absent — assertions skipped with creation';
    RETURN;
  END IF;

  FOR r IN SELECT unnest(ARRAY['review_entered_at','status_updated_at']) AS c LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='certificates' AND column_name = r.c
    ) THEN
      RAISE EXCEPTION '0063 completeness assertion failed: certificates.% was not created', r.c;
    END IF;
  END LOOP;

  -- A partner must never be able to move its own review clock.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_runtime')
     AND has_column_privilege('partner_runtime', 'public.certificates', 'review_entered_at', 'UPDATE') THEN
    RAISE EXCEPTION
      '0063 completeness assertion failed: partner_runtime can UPDATE certificates.review_entered_at. A shop could hold its own bad evidence outside the rolling window.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_connector_runtime')
     AND has_column_privilege('partner_connector_runtime', 'public.certificates', 'review_entered_at', 'UPDATE') THEN
    RAISE EXCEPTION
      '0063 completeness assertion failed: partner_connector_runtime can UPDATE certificates.review_entered_at.';
  END IF;
  -- And the anonymous reader must never SEE it: it is internal operations evidence, and its value
  -- would let a visitor infer which of a shop's cards were bounced.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_public_reader')
     AND has_column_privilege('partner_public_reader', 'public.certificates', 'review_entered_at', 'SELECT') THEN
    RAISE EXCEPTION
      '0063 completeness assertion failed: partner_public_reader can SELECT certificates.review_entered_at.';
  END IF;

  -- THE LOCK DISCIPLINE IS ASSERTED, NOT JUST DOCUMENTED. This file holds ACCESS EXCLUSIVE on
  -- `certificates` until it commits, so it must never grow a slow statement. An index created
  -- here would be exactly that mistake, and it would be invisible in review once the header
  -- comment had scrolled away.
  IF to_regclass('public.idx_certificates_origin_location_reviewed') IS NOT NULL THEN
    RAISE EXCEPTION '0063: the reviewed-unit index was built inside this file. It holds ACCESS EXCLUSIVE on certificates until COMMIT — build it CONCURRENTLY in 0065 instead.';
  END IF;

  -- The backfill must have left no reviewed-but-unapproved unit without a clock, or the rolling
  -- window would still be reading an intake date for it.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='certificates' AND column_name='redo_count')
     AND EXISTS (
       SELECT 1 FROM certificates
        WHERE grade_approved_at IS NULL AND redo_count > 0 AND review_entered_at IS NULL
     )
  THEN
    RAISE EXCEPTION '0063 completeness assertion failed: a reviewed, unapproved unit has no review_entered_at after backfill.';
  END IF;
END$$;
