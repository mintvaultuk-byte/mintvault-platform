-- Rollback 0071. Apply only through the reviewed migration rollback runner.
--
-- Review and approval bindings are audit evidence.  Never discard them after a review, approval
-- or evidence recapture has used the new model.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE later_migrations integer;
DECLARE bound_rows integer;
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE $q$SELECT count(*) FROM schema_migrations
                WHERE filename ~ '^[0-9]{4}_' AND left(filename,4)::integer > 71$q$
      INTO later_migrations;
    IF later_migrations > 0 THEN
      RAISE EXCEPTION 'rollback-0071 refused: % later migration journal row(s) exist. Resolve newer migrations first.', later_migrations;
    END IF;
  END IF;

  SELECT count(*) INTO bound_rows
    FROM certificates
   WHERE grading_revision <> 1
      OR evidence_revision <> 0
      OR review_grading_revision IS NOT NULL
      OR review_evidence_revision IS NOT NULL
      OR approved_grading_revision IS NOT NULL
      OR approved_evidence_revision IS NOT NULL;
  IF bound_rows > 0 THEN
    RAISE EXCEPTION 'rollback-0071 refused: % certificate review/evidence binding row(s) exist; retain audit evidence instead of dropping it.', bound_rows;
  END IF;
END$$;

ALTER TABLE certificates
  DROP CONSTRAINT IF EXISTS chk_certificates_review_revision_binding,
  DROP COLUMN IF EXISTS approved_evidence_revision,
  DROP COLUMN IF EXISTS approved_grading_revision,
  DROP COLUMN IF EXISTS review_evidence_revision,
  DROP COLUMN IF EXISTS review_grading_revision,
  DROP COLUMN IF EXISTS evidence_revision,
  DROP COLUMN IF EXISTS grading_revision;

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM schema_migrations WHERE filename = '0071_certificate_review_revision_binding.sql';
  END IF;
END$$;
COMMIT;
