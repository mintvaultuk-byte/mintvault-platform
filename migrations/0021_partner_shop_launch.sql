-- 0021_partner_shop_launch.sql
-- Partner Network — minimum Shop Launch layer.
--
-- Branch migration order is currently 0018 -> 0020 -> 0021 because G6D's expected 0019 is not
-- landed. Before release this branch must be rebased and revalidated as:
--   0018 -> 0019_partner_submission_credit_lifecycle.sql -> 0020 -> 0021
--
-- Additive only. This migration does not edit G6D, does not create Stripe objects, does not seed
-- production flags/packages, and does not mutate existing submissions/certificates.

CREATE TABLE IF NOT EXISTS partner_credit_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  credits integer NOT NULL,
  price_pence integer NOT NULL,
  currency char(3) NOT NULL DEFAULT 'GBP',
  stripe_price_id text,
  stripe_product_id text,
  status text NOT NULL DEFAULT 'inactive',
  effective_from timestamptz,
  effective_until timestamptz,
  display_order integer NOT NULL DEFAULT 100,
  created_by_user_id text,
  updated_by_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_partner_credit_packages_credits CHECK (credits > 0 AND credits <= 1000000),
  CONSTRAINT chk_partner_credit_packages_price CHECK (price_pence >= 0),
  CONSTRAINT chk_partner_credit_packages_currency CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT chk_partner_credit_packages_status CHECK (status IN ('active','inactive','archived')),
  CONSTRAINT chk_partner_credit_packages_dates CHECK (effective_until IS NULL OR effective_from IS NULL OR effective_until > effective_from)
);
CREATE INDEX IF NOT EXISTS idx_partner_credit_packages_active
  ON partner_credit_packages(status, display_order, id);

CREATE TABLE IF NOT EXISTS partner_credit_package_eligibility (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  package_id uuid NOT NULL REFERENCES partner_credit_packages(id) ON DELETE RESTRICT,
  eligible boolean NOT NULL DEFAULT true,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, package_id)
);
CREATE INDEX IF NOT EXISTS idx_partner_package_eligibility_tenant
  ON partner_credit_package_eligibility(tenant_id, eligible);

CREATE TABLE IF NOT EXISTS partner_credit_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  package_id uuid NOT NULL REFERENCES partner_credit_packages(id) ON DELETE RESTRICT,
  created_by_user_id uuid REFERENCES partner_users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending_payment',
  credits integer NOT NULL,
  amount_pence integer NOT NULL,
  currency char(3) NOT NULL,
  stripe_checkout_session_id text,
  stripe_payment_intent_id text,
  stripe_customer_id text,
  idempotency_key text NOT NULL,
  fulfilment_idempotency_key text,
  fulfilled_ledger_entry_id uuid REFERENCES partner_credit_ledger(id) ON DELETE RESTRICT,
  fulfilled_at timestamptz,
  reconciliation_required boolean NOT NULL DEFAULT false,
  reconciliation_reason text,
  cancelled_at timestamptz,
  failed_at timestamptz,
  refunded_at timestamptz,
  disputed_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_partner_credit_purchases_status CHECK (status IN (
    'pending_payment','checkout_created','paid','fulfilled','failed','cancelled',
    'refunded','partially_refunded','disputed','reconciliation_required'
  )),
  CONSTRAINT chk_partner_credit_purchases_credits CHECK (credits > 0 AND credits <= 1000000),
  CONSTRAINT chk_partner_credit_purchases_amount CHECK (amount_pence >= 0),
  CONSTRAINT chk_partner_credit_purchases_currency CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT chk_partner_credit_purchases_fulfilment CHECK (
    (fulfilled_at IS NULL AND fulfilled_ledger_entry_id IS NULL) OR
    (fulfilled_at IS NOT NULL AND fulfilled_ledger_entry_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_credit_purchases_idem
  ON partner_credit_purchases(tenant_id, idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_credit_purchases_session
  ON partner_credit_purchases(stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_credit_purchases_pi
  ON partner_credit_purchases(stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_partner_credit_purchases_tenant_status
  ON partner_credit_purchases(tenant_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS partner_stripe_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id text NOT NULL UNIQUE,
  event_type text NOT NULL,
  purchase_id uuid REFERENCES partner_credit_purchases(id) ON DELETE RESTRICT,
  tenant_id uuid REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  processing_status text NOT NULL DEFAULT 'received',
  safe_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_partner_stripe_events_status CHECK (processing_status IN ('received','processed','ignored','failed','reconciliation_required'))
);
CREATE INDEX IF NOT EXISTS idx_partner_stripe_events_purchase
  ON partner_stripe_events(purchase_id, created_at DESC);

CREATE TABLE IF NOT EXISTS partner_payment_reconciliation_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  purchase_id uuid REFERENCES partner_credit_purchases(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'open',
  case_type text NOT NULL,
  severity text NOT NULL DEFAULT 'medium',
  reason text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  opened_by text NOT NULL DEFAULT 'system',
  resolved_by_user_id text,
  resolution_reason text,
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT chk_partner_reconciliation_status CHECK (status IN ('open','investigating','resolved','dismissed')),
  CONSTRAINT chk_partner_reconciliation_severity CHECK (severity IN ('low','medium','high','critical')),
  CONSTRAINT chk_partner_reconciliation_resolution CHECK (
    (resolved_at IS NULL AND resolved_by_user_id IS NULL) OR
    (resolved_at IS NOT NULL AND resolved_by_user_id IS NOT NULL AND length(btrim(COALESCE(resolution_reason,''))) > 0)
  )
);
CREATE INDEX IF NOT EXISTS idx_partner_reconciliation_open
  ON partner_payment_reconciliation_cases(status, severity, opened_at DESC);

CREATE TABLE IF NOT EXISTS partner_grading_origin_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  certificate_id integer,
  certificate_number text NOT NULL,
  origin_type text NOT NULL,
  tenant_id uuid REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  partner_display_name text,
  location_id uuid REFERENCES partner_locations(id) ON DELETE RESTRICT,
  location_display_name text,
  grading_address jsonb NOT NULL DEFAULT '{}'::jsonb,
  grader_user_id uuid REFERENCES partner_users(id) ON DELETE SET NULL,
  completed_at timestamptz NOT NULL,
  snapshot_version integer NOT NULL DEFAULT 1,
  source_submission_id uuid,
  source_card_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_partner_origin_type CHECK (origin_type IN ('partner','mintvault_hq')),
  CONSTRAINT chk_partner_origin_partner_fields CHECK (
    (origin_type='mintvault_hq' AND tenant_id IS NULL AND location_id IS NULL) OR
    (origin_type='partner' AND tenant_id IS NOT NULL AND partner_display_name IS NOT NULL)
  ),
  UNIQUE (certificate_number)
);
CREATE INDEX IF NOT EXISTS idx_partner_origin_tenant
  ON partner_grading_origin_snapshots(tenant_id, completed_at DESC);

CREATE TABLE IF NOT EXISTS partner_correction_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  certificate_number text NOT NULL,
  origin_snapshot_id uuid REFERENCES partner_grading_origin_snapshots(id) ON DELETE RESTRICT,
  tenant_id uuid REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  location_id uuid REFERENCES partner_locations(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'open',
  customer_email_hash text,
  customer_reference text,
  request_reason text NOT NULL,
  partner_response text,
  escalation_reason text,
  assigned_to text NOT NULL DEFAULT 'origin',
  takeover_by_user_id text,
  takeover_reason text,
  due_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_partner_correction_status CHECK (status IN ('open','partner_responded','escalated','hq_takeover','resolved','closed')),
  CONSTRAINT chk_partner_correction_assigned CHECK (assigned_to IN ('origin','mintvault_hq')),
  CONSTRAINT chk_partner_correction_hash CHECK (customer_email_hash IS NULL OR customer_email_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS idx_partner_corrections_tenant_status
  ON partner_correction_requests(tenant_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS partner_correction_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  correction_id uuid NOT NULL REFERENCES partner_correction_requests(id) ON DELETE RESTRICT,
  tenant_id uuid REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  actor_type text NOT NULL,
  actor_user_id text,
  event_type text NOT NULL,
  reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_partner_correction_event_actor CHECK (actor_type IN ('customer','partner_user','super_admin','system'))
);
CREATE INDEX IF NOT EXISTS idx_partner_correction_events_correction
  ON partner_correction_events(correction_id, created_at);

CREATE TABLE IF NOT EXISTS partner_readiness_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  location_id uuid REFERENCES partner_locations(id) ON DELETE RESTRICT,
  check_key text NOT NULL,
  status text NOT NULL DEFAULT 'missing',
  evidence_type text NOT NULL DEFAULT 'manual',
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  confirmed_by_user_id text,
  reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_partner_readiness_status CHECK (status IN ('missing','passed','failed','waived','blocked')),
  CONSTRAINT chk_partner_readiness_evidence CHECK (evidence_type IN ('manual','automatic')),
  UNIQUE (tenant_id, location_id, check_key)
);
CREATE INDEX IF NOT EXISTS idx_partner_readiness_tenant
  ON partner_readiness_checks(tenant_id, location_id, status);

CREATE TABLE IF NOT EXISTS partner_pilot_authorisations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  location_id uuid REFERENCES partner_locations(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'not_authorised',
  authorised_by_user_id text,
  reason text NOT NULL,
  blockers jsonb NOT NULL DEFAULT '[]'::jsonb,
  authorised_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_partner_pilot_status CHECK (status IN ('not_authorised','authorised','suspended','revoked')),
  CONSTRAINT chk_partner_pilot_authorised CHECK (
    (status <> 'authorised') OR (authorised_at IS NOT NULL AND authorised_by_user_id IS NOT NULL)
  ),
  UNIQUE (tenant_id, location_id)
);
CREATE INDEX IF NOT EXISTS idx_partner_pilot_authorisations_status
  ON partner_pilot_authorisations(status, tenant_id);

CREATE TABLE IF NOT EXISTS partner_launch_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  actor_type text NOT NULL,
  actor_user_id text,
  actor_email text,
  target_type text NOT NULL,
  target_id text,
  action text NOT NULL,
  reason text,
  correlation_id text,
  before_value jsonb,
  after_value jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_partner_launch_audit_actor CHECK (actor_type IN ('partner_user','super_admin','stripe','system'))
);
CREATE INDEX IF NOT EXISTS idx_partner_launch_audit_tenant
  ON partner_launch_audit_events(tenant_id, created_at DESC);

CREATE OR REPLACE FUNCTION partner_shop_launch_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'partner shop-launch history is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'partner_grading_origin_snapshots',
    'partner_correction_events',
    'partner_launch_audit_events'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_no_row_mutate ON %I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%I_no_row_mutate BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION partner_shop_launch_append_only()', t, t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_no_truncate ON %I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%I_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION partner_shop_launch_append_only()', t, t);
  END LOOP;
END$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'partner_credit_package_eligibility',
    'partner_credit_purchases',
    'partner_payment_reconciliation_cases',
    'partner_correction_requests',
    'partner_correction_events',
    'partner_readiness_checks',
    'partner_pilot_authorisations',
    'partner_launch_audit_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation ON %I USING (tenant_id = partner_current_tenant()) WITH CHECK (tenant_id = partner_current_tenant())',
      t, t
    );
  END LOOP;
END$$;

ALTER TABLE partner_grading_origin_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_grading_origin_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS partner_grading_origin_snapshots_tenant_isolation ON partner_grading_origin_snapshots;
CREATE POLICY partner_grading_origin_snapshots_tenant_isolation ON partner_grading_origin_snapshots
  USING (origin_type = 'mintvault_hq' OR tenant_id = partner_current_tenant())
  WITH CHECK (origin_type = 'mintvault_hq' OR tenant_id = partner_current_tenant());

-- Packages are global Super Admin managed configuration. Runtime may read active packages only;
-- eligibility and purchase rows remain tenant-scoped by RLS.
GRANT SELECT ON partner_credit_packages TO partner_runtime;
GRANT SELECT ON partner_credit_package_eligibility TO partner_runtime;
GRANT SELECT, INSERT, UPDATE ON partner_credit_purchases TO partner_runtime;
GRANT SELECT ON partner_grading_origin_snapshots TO partner_runtime;
GRANT SELECT, INSERT, UPDATE ON partner_correction_requests TO partner_runtime;
GRANT SELECT, INSERT ON partner_correction_events TO partner_runtime;
GRANT SELECT ON partner_readiness_checks, partner_pilot_authorisations TO partner_runtime;
GRANT SELECT, INSERT ON partner_launch_audit_events TO partner_runtime;

REVOKE ALL ON partner_stripe_events FROM partner_runtime;
REVOKE ALL ON partner_payment_reconciliation_cases FROM partner_runtime;
