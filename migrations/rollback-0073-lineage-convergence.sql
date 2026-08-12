-- rollback-0073-lineage-convergence.sql
--
-- Reverses 0073. NOT a forward migration (no NNNN_ prefix -> the numbered runner
-- ignores it). Owner-approved protected action only; rehearse on a disposable
-- database first.
--
-- ROLL BACK THE APPLICATION CODE FIRST. THIS IS NOT OPTIONAL.
-- ===========================================================================
-- The application HARD-REQUIRES the column:
--   * server/grader.ts and server/routes.ts both end their grading UPDATE with
--     `RETURNING grading_revision` and throw "Saved certificate has an invalid
--     grading revision" on anything that is not a positive safe integer;
--   * both approval paths CAS on `AND grading_revision = <expected>`;
--   * shared/schema.ts declares gradingRevision, so every Drizzle SELECT of
--     `certificates` names the column explicitly.
-- Dropping the column under a running deployment therefore turns every
-- certificate read and every grading save into a 500. Deploy the pre-0073
-- application image, confirm it is serving, and only then run this file.
--
-- WHY IT REFUSES WHILE REVIEWS ARE IN FLIGHT
-- ===========================================================================
-- Removing the trigger removes the ONLY server-authoritative signal that a
-- prepared review has gone stale. A reviewer holding a preview taken before a
-- grade change could then approve a grade they never inspected, and the
-- certificate is a permanent public record and a physical product. Any
-- certificate sitting in grader_status = 'pending_review' is exactly such a
-- prepared review, so this script names them and refuses rather than silently
-- widening that window. Resolving them is a BUSINESS decision, not a mechanical
-- one; do it deliberately, then re-run.
--
-- WHAT IS LOST, AND WHAT IS NOT
-- ===========================================================================
-- The revision numbers are a concurrency token, not history: nothing is
-- reconstructed from them and no customer-facing fact depends on them. Losing
-- them is recoverable — re-applying 0073 restarts every row at 1.
--
-- IT DOES NOT DROP auth_status. 0073 adds `auth_status` idempotently, but on
-- every real MintVault database that column PREDATES 0073 (created by boot DDL
-- in server/routes.ts) and holds live authenticity outcomes that decide NO/AA.
-- Dropping it would destroy grading data 0073 never created. Do not "complete"
-- this rollback by adding a drop for it.
--
-- IF YOU ONLY NEED TO STOP THE TRIGGER IN A HURRY: run just the two DROP
-- statements in section 2 and STOP. The column is additive and inert; leaving it
-- keeps every existing reader and writer working, and re-applying 0073
-- afterwards converges it correctly (0073 section 3 is self-repairing).
--
-- Every step is IF EXISTS so a partial rollback can be re-run safely.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1) Refuse while prepared reviews are in flight.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  blocking bigint;
BEGIN
  IF to_regclass('public.certificates') IS NULL THEN
    RAISE NOTICE 'rollback-0073: certificates table absent; nothing to do.';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'certificates'
       AND column_name = 'grading_revision')
  THEN
    RAISE NOTICE 'rollback-0073: grading_revision absent; nothing to do.';
    RETURN;
  END IF;

  -- grader_status is queried dynamically because it is a real column that
  -- shared/schema.ts does not declare, and this script must still parse on a
  -- database where it is absent (a disposable fixture).
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'certificates'
       AND column_name = 'grader_status')
  THEN
    EXECUTE $q$ SELECT count(*) FROM certificates WHERE grader_status = 'pending_review' $q$
      INTO blocking;

    IF blocking > 0 THEN
      RAISE EXCEPTION
        'rollback-0073 refuses to run: % certificate(s) are in pending_review. Removing the revision trigger removes the only protection against a stale reviewer approving a grade they never inspected. Approve or reject those reviews first, then re-run.',
        blocking;
    END IF;
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- 2) Remove the trigger, then the function it depends on.
--    (Stop here for a trigger-only rollback — see the header.)
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_certificates_advance_grading_revision ON certificates;
DROP FUNCTION IF EXISTS certificates_advance_grading_revision();

-- ---------------------------------------------------------------------------
-- 3) Remove the token column. Everything that reads it must already be gone.
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS certificates DROP COLUMN IF EXISTS grading_revision;

-- ---------------------------------------------------------------------------
-- 4) The journal row must go too, otherwise the runner considers 0073 applied
--    and will never re-apply it.
--
--    This file was renamed rollback-0048-grading-review-revision.sql ->
--    rollback-0073-lineage-convergence.sql in commit c788fa68 (R100, content
--    unchanged) when the forward migration was renumbered 0048 -> 0073. The
--    DELETE below was NOT updated with it and still named
--    '0048_grading_review_revision.sql' — a filename that was withdrawn and
--    never applied on any host, so the statement matched ZERO rows.
--
--    The consequence was silent and one-way: this rollback reversed the DDL
--    (trigger dropped, function dropped, grading_revision dropped) while
--    leaving the '0073_lineage_convergence.sql' journal row in place with a
--    matching checksum. planMigrations() files a journalled+checksum-matching
--    file under alreadyApplied (scripts/db/migrate.ts:385), so the runner
--    would never re-apply 0073 — and recovering would require hand-editing
--    the journal, which this project's whole migration design forbids.
--
--    The journal is keyed on FILENAME (scripts/db/migrate.ts:304-316), so the
--    name here must match the forward migration EXACTLY.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  removed integer;
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM schema_migrations WHERE filename = '0073_lineage_convergence.sql';
    GET DIAGNOSTICS removed = ROW_COUNT;
    -- Report what actually happened rather than trusting the statement ran.
    -- 0 is legitimate (0073 was never applied on this host); it must not be
    -- silent, because 0 was ALSO the symptom of the stale-filename defect.
    RAISE NOTICE 'rollback-0073: removed % journal row(s) for 0073_lineage_convergence.sql', removed;
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- 5) Assertion: prove the reversal actually happened, rather than reporting
--    success because every statement was a guarded no-op.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger
              WHERE tgname = 'trg_certificates_advance_grading_revision'
                AND tgrelid = 'public.certificates'::regclass) THEN
    RAISE EXCEPTION 'rollback-0073 assertion failed: the revision trigger is still present.';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE p.proname = 'certificates_advance_grading_revision' AND n.nspname = 'public') THEN
    RAISE EXCEPTION 'rollback-0073 assertion failed: certificates_advance_grading_revision() is still present.';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'certificates'
                AND column_name = 'grading_revision') THEN
    RAISE EXCEPTION 'rollback-0073 assertion failed: certificates.grading_revision is still present.';
  END IF;

  -- 0048 also adds auth_status idempotently and this rollback deliberately
  -- leaves it. Asserted so a future edit that "completes" the rollback by
  -- dropping it is caught here rather than in a customer-facing incident.
  IF to_regclass('public.certificates') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = 'public' AND table_name = 'certificates'
                        AND column_name = 'auth_status') THEN
    RAISE EXCEPTION
      'rollback-0073 assertion failed: certificates.auth_status was removed. This rollback must NEVER drop it — it predates 0048 and holds live authenticity outcomes.';
  END IF;

  RAISE NOTICE 'rollback-0073: review-revision token removed. auth_status deliberately retained.';
END$$;

COMMIT;
