-- 0044_partner_submission_lifecycle_and_location_snapshot.sql
-- Partner Network: the post-handover submission lifecycle, and an immutable location snapshot.
--
-- UNAPPLIED AND FORWARD-ONLY. Additive; it edits no applied migration. Apply AFTER 0043.
--
-- ===========================================================================================
-- PART 1 — THE SUBMISSION LIFECYCLE DID NOT EXIST PAST HANDOVER
-- ===========================================================================================
-- 0007 constrained the status domain to exactly three values:
--
--     CHECK (status IN ('draft','submitted_to_mintvault','cancelled'))
--
-- so a shop could create a submission and hand it over, and then the workflow TERMINATED. There
-- was no value for "MintVault has it", "it is being graded", "grading is done", "credits are
-- being settled" or "it is finished and on its way back". The Partner dashboard could not compute
-- ready-to-grade / grading-in-progress / awaiting-settlement / completed counts from any column,
-- which is why four workflow tiles were deleted rather than wired
-- (client/src/pages/partner/dashboard.tsx, and dashboard-service.ts:160 states the same thing:
-- "Completed-card counts require the partner-to-certificate link").
--
-- This migration WIDENS the domain. It is strictly additive:
--   * every existing row keeps its current value — the three original states are all retained;
--   * no row is rewritten, no default changes, no NOT NULL changes;
--   * the constraint is replaced rather than altered because PostgreSQL has no
--     ALTER CONSTRAINT for a CHECK expression. DROP + ADD inside one transaction is the only
--     route, and the ADD is validated against existing rows so a bad state cannot slip through.
--
-- The new states, in order:
--   received             MintVault has physical custody; cards are being checked in.
--   grading              At least one card is being assessed.
--   graded               Grading is complete and approved; credits NOT yet settled.
--   awaiting_settlement  Settlement is in flight. Certificates must NOT exist yet.
--   completed            Credits settled, certificates issued, submission returned.
--
-- DELIBERATELY NOT ENFORCED HERE: the legal transition graph. 0007 established the pattern that
-- the DB bounds the VALUE SET while the service layer owns transitions
-- (server/partner/submission-service.ts:13-18) — there is no transition trigger today, and adding
-- one for the new states only would make the machine half-enforced in the database and half in the
-- application, which is worse than either. Transition enforcement stays in the service layer.
--
-- ===========================================================================================
-- PART 2 — LOCATION WAS A FOREIGN KEY, NOT A SNAPSHOT
-- ===========================================================================================
-- partner_submissions.location_id is `uuid NOT NULL REFERENCES partner_locations(id)`. The
-- reference is immutable in practice (editSubmissionDraft never updates it, and ON DELETE RESTRICT
-- prevents removal), but it is a POINTER. Renaming a location silently rewrites the apparent
-- grading origin of every historical submission that ever used it — the record says "wherever that
-- id is called today", not "where this work was actually taken in".
--
-- That matters here specifically because the same shop identity is about to be frozen onto
-- certificates by 0035's ENABLE ALWAYS immutability trigger. A certificate would carry a permanent
-- origin snapshot while the submission it came from carried a mutable pointer, and the two could
-- disagree forever with no way to tell which was right.
--
-- location_name_snapshot is nullable with no default ON PURPOSE:
--   * NULL means "captured before snapshots existed" — legacy, and readers must fall back to the
--     join rather than render a blank. A default of '' would make legacy rows indistinguishable
--     from a genuinely empty name.
--   * The backfill below seeds existing rows from the CURRENT location name. That is the best
--     information available and is explicitly a best-effort reconstruction, not a historical fact:
--     if a location was renamed before today, the backfilled value is the new name. Staging has
--     zero partner_submissions rows, so on staging this backfill is a no-op and the distinction is
--     academic there — it is stated because it will NOT be academic on production later.
--
-- ===========================================================================================
-- WHAT THIS MIGRATION DOES NOT DO
-- ===========================================================================================
-- It adds NO partner-to-certificate link, because one already exists: 0035 added
-- certificates.origin_partner_id (uuid, deliberately no FK) plus the partial index
-- idx_certificates_origin_partner and a set-once immutability trigger. Verified present on staging
-- 2026-08-03. The gap there is that NOTHING WRITES those columns — 262 of 262 staging certificates
-- have origin_type NULL — which is a code defect, not a schema one, and is fixed separately.
--
-- It changes NO grading logic, NO MVGS scoring, NO certificate numbering, and touches no HQ table.

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- PART 1 — widen the status domain
-- ---------------------------------------------------------------------------------------------

-- Fail loudly if an unexpected status already exists, rather than silently widening around it.
DO $$
DECLARE
  stray text;
BEGIN
  SELECT string_agg(DISTINCT status, ', ') INTO stray
    FROM partner_submissions
   WHERE status NOT IN ('draft', 'submitted_to_mintvault', 'cancelled');
  IF stray IS NOT NULL THEN
    RAISE EXCEPTION 'partner_submissions holds unexpected status value(s): %; refusing to widen the constraint blindly', stray;
  END IF;
END$$;

ALTER TABLE partner_submissions DROP CONSTRAINT chk_partner_submissions_status;

ALTER TABLE partner_submissions ADD CONSTRAINT chk_partner_submissions_status
  CHECK (status IN (
    'draft',
    'submitted_to_mintvault',
    'received',
    'grading',
    'graded',
    'awaiting_settlement',
    'completed',
    'cancelled'
  ));

COMMENT ON CONSTRAINT chk_partner_submissions_status ON partner_submissions IS
  'Bounds the status VALUE SET only. Legal transitions are owned by submission-service.ts, matching the pattern 0007 established.';

-- ---------------------------------------------------------------------------------------------
-- PART 2 — immutable location snapshot
-- ---------------------------------------------------------------------------------------------

ALTER TABLE partner_submissions ADD COLUMN IF NOT EXISTS location_name_snapshot text;

COMMENT ON COLUMN partner_submissions.location_name_snapshot IS
  'The location name AS AT submission creation. NULL = created before snapshots existed; readers must fall back to the partner_locations join rather than rendering blank. Never updated after insert.';

-- Best-effort backfill from the current name. See the header: this reconstructs, it does not
-- recover history. No-op on staging (zero rows).
UPDATE partner_submissions s
   SET location_name_snapshot = l.name
  FROM partner_locations l
 WHERE l.id = s.location_id
   AND s.location_name_snapshot IS NULL;

-- ---------------------------------------------------------------------------------------------
-- Fail-closed assertions: prove the migration achieved what it claims, in the same transaction.
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'partner_submissions'::regclass
       AND conname = 'chk_partner_submissions_status'
       AND pg_get_constraintdef(oid) LIKE '%awaiting_settlement%'
  ) THEN
    RAISE EXCEPTION '0044 assertion failed: status constraint was not widened';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'partner_submissions' AND column_name = 'location_name_snapshot'
  ) THEN
    RAISE EXCEPTION '0044 assertion failed: location_name_snapshot column is absent';
  END IF;

  IF EXISTS (
    SELECT 1 FROM partner_submissions WHERE location_name_snapshot IS NULL
  ) THEN
    RAISE EXCEPTION '0044 assertion failed: backfill left rows without a location snapshot';
  END IF;
END$$;

COMMIT;
