-- 0095 — GB-03 public Partner acquisition leads
--
-- Isolated from all `partner_*` operational tables on purpose: an application
-- is a prospective business lead, never a Partner tenant, user, wallet, station
-- or onboarding record. This migration is additive and must only be applied
-- after owner approval of the public privacy notice and production migration.

CREATE TABLE IF NOT EXISTS partner_applications (
  id uuid PRIMARY KEY,
  business_name text NOT NULL,
  contact_name text NOT NULL,
  email text NOT NULL,
  city text NOT NULL,
  postcode text NOT NULL,
  business_type text NOT NULL,
  web_presence text NOT NULL,
  interest_reason text NOT NULL,
  phone text,
  physical_retail boolean,
  categories text[] NOT NULL DEFAULT '{}',
  demand_band text,
  existing_grading_submissions text,
  privacy_acknowledged_at timestamptz NOT NULL,
  privacy_notice_version text NOT NULL,
  source text NOT NULL DEFAULT 'partners_page',
  attribution jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'NEW',
  dedupe_key text NOT NULL,
  notification_attempted_at timestamptz,
  notification_sent_at timestamptz,
  notification_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  retention_review_at timestamptz NOT NULL DEFAULT (now() + interval '24 months'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT chk_partner_application_status CHECK (status IN ('NEW', 'CONTACTED', 'QUALIFIED', 'NOT_A_FIT', 'ONBOARDING')),
  CONSTRAINT chk_partner_application_business_type CHECK (business_type IN ('tcg_card_shop', 'collectibles_retailer', 'hobby_store', 'online_retailer', 'other')),
  CONSTRAINT chk_partner_application_demand_band CHECK (demand_band IS NULL OR demand_band IN ('exploring', 'under_25', '25_50', '51_100', '101_250', '250_plus')),
  CONSTRAINT chk_partner_application_existing_submissions CHECK (existing_grading_submissions IS NULL OR existing_grading_submissions IN ('yes', 'no', 'not_currently'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_applications_active_dedupe
  ON partner_applications (dedupe_key)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_partner_applications_active_received
  ON partner_applications (status, created_at DESC)
  WHERE deleted_at IS NULL;
