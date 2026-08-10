-- 0071 — bind a review decision to the exact grade and immutable-evidence state.
--
-- The immutable evidence ledger (0067) deliberately retains every scanner capture.  That is
-- necessary, but is not by itself sufficient: an approver must never publish a grade they
-- reviewed against an earlier evidence lineage.  These counters are certificate-local compare
-- and-swap facts.  They do not alter the append-only ledger, scoring rules or historical grades.

DO $$
BEGIN
  IF to_regclass('public.certificates') IS NULL
     OR to_regclass('public.certificate_image_masters') IS NULL THEN
    RAISE EXCEPTION '0071 requires certificates and 0067 immutable evidence ledger.';
  END IF;
END$$;

ALTER TABLE certificates
  ADD COLUMN IF NOT EXISTS grading_revision integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS evidence_revision integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS review_grading_revision integer,
  ADD COLUMN IF NOT EXISTS review_evidence_revision integer,
  ADD COLUMN IF NOT EXISTS approved_grading_revision integer,
  ADD COLUMN IF NOT EXISTS approved_evidence_revision integer;

-- A legacy row gets a stable baseline from the ledger that already exists.  Subsequent captures
-- increment this counter in the same transaction that appends the new master.  COUNT(*) is used
-- rather than a per-side revision because a review must bind to the complete card evidence set.
UPDATE certificates cert
   SET evidence_revision = evidence.count::integer
  FROM (
    SELECT certificate_id, count(*)::integer AS count
      FROM certificate_image_masters
     GROUP BY certificate_id
  ) evidence
 WHERE cert.id = evidence.certificate_id
   AND cert.evidence_revision = 0;

ALTER TABLE certificates
  DROP CONSTRAINT IF EXISTS chk_certificates_review_revision_binding,
  ADD CONSTRAINT chk_certificates_review_revision_binding CHECK (
    grading_revision > 0
    AND evidence_revision >= 0
    AND (review_grading_revision IS NULL OR review_grading_revision > 0)
    AND (review_evidence_revision IS NULL OR review_evidence_revision >= 0)
    AND (approved_grading_revision IS NULL OR approved_grading_revision > 0)
    AND (approved_evidence_revision IS NULL OR approved_evidence_revision >= 0)
    AND ((review_grading_revision IS NULL) = (review_evidence_revision IS NULL))
    AND ((approved_grading_revision IS NULL) = (approved_evidence_revision IS NULL))
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='certificates' AND column_name='approved_evidence_revision'
  ) THEN
    RAISE EXCEPTION '0071 incomplete: review/evidence revision columns are missing.';
  END IF;
END$$;
