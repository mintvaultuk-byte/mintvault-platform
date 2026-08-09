-- Server-authoritative optimistic-concurrency token for the pending-review
-- approval boundary.  It is deliberately independent of updated_at: storage
-- maintenance, print workflow and image processing must not invalidate a
-- human's prepared certificate review.
ALTER TABLE certificates
  ADD COLUMN IF NOT EXISTS grading_revision INTEGER NOT NULL DEFAULT 1;

-- Existing rows and all future rows have a valid, positive revision.  The
-- DEFAULT covers new rows; the UPDATE makes this idempotent for installations
-- that had a nullable column created by a partial pre-release deployment.
UPDATE certificates
   SET grading_revision = 1
 WHERE grading_revision IS NULL OR grading_revision < 1;

CREATE OR REPLACE FUNCTION certificates_advance_grading_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  field_name text;
  protected_fields constant text[] := ARRAY[
    -- Certificate-facing identity and classification.
    'card_name', 'set_name', 'card_number_display', 'year_text', 'language',
    'variant', 'variant_other', 'rarity', 'rarity_other', 'rarity_code',
    'rarity_label', 'printed_symbol', 'printed_symbol_count',
    'printed_symbol_colour', 'finish_variant', 'promo_type', 'subset_name',
    'region', 'era', 'structured_variant_version', 'label_type',
    -- Authoritative grade, subgrades, authentication and defects.
    'grade', 'grade_type', 'centering_score', 'corners_score', 'edges_score',
    'surface_score', 'centering_front_lr', 'centering_front_tb',
    'centering_back_lr', 'centering_back_tb', 'corner_values', 'edge_values',
    'surface_values', 'defects', 'verified_defects', 'auth_status',
    'dark_border_front', 'dark_border_back', 'eye_appeal_modifier',
    'whitening_lines', 'crease_span_pct', 'crease_lines', 'wrinkle_severity',
    'tear_severity', 'centering_outer_front', 'centering_outer_back',
    'centering_inner_front', 'centering_inner_back', 'centering_method',
    'is_black_label'
  ];
BEGIN
  -- A published certificate cannot be approved through pending review.  Do not
  -- version unrelated post-approval administration/correction writes here.
  IF OLD.grade_approved_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- jsonb field lookup keeps this additive migration safe on older databases
  -- whose optional MVGS/black-label columns were introduced independently.
  FOREACH field_name IN ARRAY protected_fields LOOP
    IF (to_jsonb(OLD) -> field_name) IS DISTINCT FROM (to_jsonb(NEW) -> field_name) THEN
      NEW.grading_revision := GREATEST(COALESCE(OLD.grading_revision, 1), 1) + 1;
      RETURN NEW;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_certificates_advance_grading_revision ON certificates;
CREATE TRIGGER trg_certificates_advance_grading_revision
BEFORE UPDATE ON certificates
FOR EACH ROW
EXECUTE FUNCTION certificates_advance_grading_revision();
