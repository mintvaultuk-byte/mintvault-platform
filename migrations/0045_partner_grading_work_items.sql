-- 0045_partner_grading_work_items.sql
-- Partner grading bridge: durable per-card source-unit provenance.
--
-- 0010 records submission-level import provenance and 0035 records immutable
-- certificate-origin display provenance. This table fills the narrower gap between them:
-- every destination submission_item imported from a Partner card unit gets one durable source link.
--
-- Additive only. It edits no applied migration and touches no existing MintVault rows.

CREATE TABLE IF NOT EXISTS partner_grading_work_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  partner_organisation_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  partner_location_id uuid NOT NULL REFERENCES partner_locations(id) ON DELETE RESTRICT,
  partner_submission_id uuid NOT NULL REFERENCES partner_submissions(id) ON DELETE RESTRICT,
  partner_submission_card_id uuid NOT NULL REFERENCES partner_submission_cards(id) ON DELETE RESTRICT,
  partner_handoff_id uuid NOT NULL REFERENCES partner_submission_handoffs(id) ON DELETE RESTRICT,
  connector_import_id uuid NOT NULL REFERENCES partner_connector_imports(id) ON DELETE RESTRICT,
  connector_record_id uuid NOT NULL REFERENCES partner_connector_records(id) ON DELETE RESTRICT,
  validation_run_id uuid NOT NULL REFERENCES partner_connector_validation_runs(id) ON DELETE RESTRICT,
  destination_submission_id integer NOT NULL REFERENCES submissions(id) ON DELETE RESTRICT,
  submission_item_id integer NOT NULL REFERENCES submission_items(id) ON DELETE RESTRICT,
  card_ordinal integer NOT NULL,
  status text NOT NULL DEFAULT 'ready_for_assignment',
  assigned_partner_grader_id uuid REFERENCES partner_users(id) ON DELETE RESTRICT,
  assigned_at timestamptz,
  front_image_key text NOT NULL,
  back_image_key text NOT NULL,
  source_fingerprint text,
  source_fingerprint_version integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  certificate_id integer REFERENCES certificates(id) ON DELETE RESTRICT,
  certificate_linked_at timestamptz,
  CONSTRAINT chk_partner_grading_work_items_tenant_pair CHECK (tenant_id = partner_organisation_id),
  CONSTRAINT chk_partner_grading_work_items_ordinal CHECK (card_ordinal >= 1),
  CONSTRAINT chk_partner_grading_work_items_status CHECK (
    status IN ('ready_for_assignment','assigned','pending_review','returned_for_change','approved','completed','void')
  ),
  CONSTRAINT chk_partner_grading_work_items_assignment_pair CHECK (
    (assigned_partner_grader_id IS NULL AND assigned_at IS NULL)
    OR (assigned_partner_grader_id IS NOT NULL AND assigned_at IS NOT NULL)
  ),
  CONSTRAINT chk_partner_grading_work_items_certificate_pair CHECK (
    (certificate_id IS NULL AND certificate_linked_at IS NULL)
    OR (certificate_id IS NOT NULL AND certificate_linked_at IS NOT NULL)
  ),
  CONSTRAINT chk_partner_grading_work_items_front_key CHECK (
    front_image_key LIKE ('partner-submissions/' || tenant_id::text || '/' || partner_submission_id::text || '/' || partner_submission_card_id::text || '/front-%')
  ),
  CONSTRAINT chk_partner_grading_work_items_back_key CHECK (
    back_image_key LIKE ('partner-submissions/' || tenant_id::text || '/' || partner_submission_id::text || '/' || partner_submission_card_id::text || '/back-%')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_grading_work_items_tenant_location
  ON partner_locations(tenant_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_grading_work_items_tenant_submission
  ON partner_submissions(tenant_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_grading_work_items_submission_card
  ON partner_submission_cards(submission_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_grading_work_items_tenant_submission_card
  ON partner_submission_cards(tenant_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_grading_work_items_handoff_scope
  ON partner_submission_handoffs(tenant_id, submission_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_grading_work_items_connector_record_scope
  ON partner_connector_records(tenant_id, partner_submission_id, handoff_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_grading_work_items_validation_scope
  ON partner_connector_validation_runs(connector_record_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_grading_work_items_import_scope
  ON partner_connector_imports(
    partner_organisation_id,
    partner_submission_id,
    partner_handoff_id,
    connector_record_id,
    validation_run_id,
    id
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_grading_work_items_import_destination
  ON partner_connector_imports(id, destination_submission_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_grading_work_items_submission_item_destination
  ON submission_items(submission_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_grading_work_items_certificate_scope
  ON certificates(id, submission_id, submission_item_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.partner_grading_work_items'::regclass
       AND conname = 'fk_partner_grading_work_items_location_tenant'
  ) THEN
    ALTER TABLE partner_grading_work_items
      ADD CONSTRAINT fk_partner_grading_work_items_location_tenant
      FOREIGN KEY (tenant_id, partner_location_id) REFERENCES partner_locations(tenant_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.partner_grading_work_items'::regclass
       AND conname = 'fk_partner_grading_work_items_submission_tenant'
  ) THEN
    ALTER TABLE partner_grading_work_items
      ADD CONSTRAINT fk_partner_grading_work_items_submission_tenant
      FOREIGN KEY (tenant_id, partner_submission_id) REFERENCES partner_submissions(tenant_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.partner_grading_work_items'::regclass
       AND conname = 'fk_partner_grading_work_items_card_tenant'
  ) THEN
    ALTER TABLE partner_grading_work_items
      ADD CONSTRAINT fk_partner_grading_work_items_card_tenant
      FOREIGN KEY (tenant_id, partner_submission_card_id) REFERENCES partner_submission_cards(tenant_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.partner_grading_work_items'::regclass
       AND conname = 'fk_partner_grading_work_items_card_submission'
  ) THEN
    ALTER TABLE partner_grading_work_items
      ADD CONSTRAINT fk_partner_grading_work_items_card_submission
      FOREIGN KEY (partner_submission_id, partner_submission_card_id) REFERENCES partner_submission_cards(submission_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.partner_grading_work_items'::regclass
       AND conname = 'fk_partner_grading_work_items_handoff_scope'
  ) THEN
    ALTER TABLE partner_grading_work_items
      ADD CONSTRAINT fk_partner_grading_work_items_handoff_scope
      FOREIGN KEY (tenant_id, partner_submission_id, partner_handoff_id)
      REFERENCES partner_submission_handoffs(tenant_id, submission_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.partner_grading_work_items'::regclass
       AND conname = 'fk_partner_grading_work_items_connector_record_scope'
  ) THEN
    ALTER TABLE partner_grading_work_items
      ADD CONSTRAINT fk_partner_grading_work_items_connector_record_scope
      FOREIGN KEY (tenant_id, partner_submission_id, partner_handoff_id, connector_record_id)
      REFERENCES partner_connector_records(tenant_id, partner_submission_id, handoff_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.partner_grading_work_items'::regclass
       AND conname = 'fk_partner_grading_work_items_validation_scope'
  ) THEN
    ALTER TABLE partner_grading_work_items
      ADD CONSTRAINT fk_partner_grading_work_items_validation_scope
      FOREIGN KEY (connector_record_id, validation_run_id)
      REFERENCES partner_connector_validation_runs(connector_record_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.partner_grading_work_items'::regclass
       AND conname = 'fk_partner_grading_work_items_import_scope'
  ) THEN
    ALTER TABLE partner_grading_work_items
      ADD CONSTRAINT fk_partner_grading_work_items_import_scope
      FOREIGN KEY (
        tenant_id,
        partner_submission_id,
        partner_handoff_id,
        connector_record_id,
        validation_run_id,
        connector_import_id
      )
      REFERENCES partner_connector_imports(
        partner_organisation_id,
        partner_submission_id,
        partner_handoff_id,
        connector_record_id,
        validation_run_id,
        id
      ) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.partner_grading_work_items'::regclass
       AND conname = 'fk_partner_grading_work_items_import_destination'
  ) THEN
    ALTER TABLE partner_grading_work_items
      ADD CONSTRAINT fk_partner_grading_work_items_import_destination
      FOREIGN KEY (connector_import_id, destination_submission_id)
      REFERENCES partner_connector_imports(id, destination_submission_id)
      ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.partner_grading_work_items'::regclass
       AND conname = 'fk_partner_grading_work_items_submission_item_destination'
  ) THEN
    ALTER TABLE partner_grading_work_items
      ADD CONSTRAINT fk_partner_grading_work_items_submission_item_destination
      FOREIGN KEY (destination_submission_id, submission_item_id)
      REFERENCES submission_items(submission_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.partner_grading_work_items'::regclass
       AND conname = 'fk_partner_grading_work_items_certificate_scope'
  ) THEN
    ALTER TABLE partner_grading_work_items
      ADD CONSTRAINT fk_partner_grading_work_items_certificate_scope
      FOREIGN KEY (certificate_id, destination_submission_id, submission_item_id)
      REFERENCES certificates(id, submission_id, submission_item_id) ON DELETE RESTRICT
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_grading_work_items_submission_item
  ON partner_grading_work_items(submission_item_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_grading_work_items_source_unit
  ON partner_grading_work_items(partner_submission_card_id, card_ordinal);

CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_grading_work_items_certificate
  ON partner_grading_work_items(certificate_id) WHERE certificate_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_partner_grading_work_items_destination
  ON partner_grading_work_items(partner_organisation_id, destination_submission_id);

CREATE INDEX IF NOT EXISTS idx_partner_grading_work_items_partner_submission
  ON partner_grading_work_items(tenant_id, partner_submission_id);

CREATE INDEX IF NOT EXISTS idx_partner_grading_work_items_assigned
  ON partner_grading_work_items(tenant_id, assigned_partner_grader_id, status);

ALTER TABLE partner_grading_work_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_grading_work_items FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS partner_grading_work_items_tenant_isolation ON partner_grading_work_items;
CREATE POLICY partner_grading_work_items_tenant_isolation ON partner_grading_work_items
  USING (tenant_id = partner_current_tenant())
  WITH CHECK (tenant_id = partner_current_tenant());

REVOKE ALL PRIVILEGES ON partner_grading_work_items FROM PUBLIC;
REVOKE ALL PRIVILEGES ON partner_grading_work_items FROM partner_runtime;
REVOKE ALL PRIVILEGES ON partner_grading_work_items FROM partner_connector_runtime;

GRANT SELECT ON partner_grading_work_items TO partner_connector_runtime;
GRANT INSERT (
  tenant_id,
  partner_organisation_id,
  partner_location_id,
  partner_submission_id,
  partner_submission_card_id,
  partner_handoff_id,
  connector_import_id,
  connector_record_id,
  validation_run_id,
  destination_submission_id,
  submission_item_id,
  card_ordinal,
  status,
  front_image_key,
  back_image_key,
  source_fingerprint,
  source_fingerprint_version,
  certificate_id,
  certificate_linked_at
) ON partner_grading_work_items TO partner_connector_runtime;

GRANT SELECT ON partner_grading_work_items TO partner_runtime;
REVOKE ALL PRIVILEGES ON certificates FROM partner_connector_runtime;
GRANT INSERT (
  certificate_number,
  submission_id,
  submission_item_id,
  status,
  label_type,
  grade_type,
  language,
  card_game,
  set_name,
  card_name,
  card_number_display,
  year_text,
  variant,
  front_image_path,
  back_image_path,
  grading_front_original,
  grading_back_original,
  created_by,
  issued_at,
  updated_at,
  reference_number,
  logbook_version,
  logbook_last_issued_at,
  integrity_hash,
  print_state,
  grader_status,
  origin_type,
  origin_partner_id,
  origin_partner_public_ref,
  origin_partner_legal_name,
  origin_partner_trading_name,
  origin_location_id,
  origin_location_public_ref,
  origin_location_name,
  origin_location_address,
  origin_captured_at,
  origin_snapshot_version
) ON certificates TO partner_connector_runtime;
GRANT SELECT (
  id,
  certificate_number,
  submission_id,
  submission_item_id
) ON certificates TO partner_connector_runtime;
DO $$
BEGIN
  IF to_regclass('public.cert_counter') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE ON cert_counter TO partner_connector_runtime;
  END IF;
  IF to_regclass('public.certificates_id_seq') IS NOT NULL THEN
    GRANT USAGE, SELECT ON SEQUENCE certificates_id_seq TO partner_connector_runtime;
  END IF;
END$$;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_credit_lifecycle_definer') THEN
    GRANT SELECT ON partner_grading_work_items TO partner_credit_lifecycle_definer;
  END IF;
END$$;

DO $$
DECLARE
  missing text[];
BEGIN
  SELECT array_agg(name ORDER BY name) INTO missing
  FROM (
    VALUES
      ('tenant_id'),
      ('partner_organisation_id'),
      ('partner_location_id'),
      ('partner_submission_id'),
      ('partner_submission_card_id'),
      ('destination_submission_id'),
      ('submission_item_id'),
      ('status'),
      ('assigned_partner_grader_id'),
      ('certificate_id'),
      ('front_image_key'),
      ('back_image_key')
  ) AS required(name)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'partner_grading_work_items'
       AND column_name = required.name
  );

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0045 partner_grading_work_items missing required column(s): %', missing;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
     WHERE c.oid = 'public.partner_grading_work_items'::regclass
       AND c.relrowsecurity
       AND c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION '0045 partner_grading_work_items must have ENABLE and FORCE ROW LEVEL SECURITY';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_policy
     WHERE polrelid = 'public.partner_grading_work_items'::regclass
       AND polname = 'partner_grading_work_items_tenant_isolation'
  ) THEN
    RAISE EXCEPTION '0045 partner_grading_work_items tenant isolation policy missing';
  END IF;
END$$;
