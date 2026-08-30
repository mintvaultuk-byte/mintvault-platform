-- 0115 — Runtime schema convergence
--
-- MintVault historically repaired a large part of its schema from application
-- startup (and, for manual centering, from a request handler). That produced two
-- competing authorities: the numbered migration journal and whatever happened
-- to run successfully on each application machine. This forward-only migration
-- converges every schema object formerly created by those reachable runtime
-- paths. Application startup is deliberately DDL-free after this migration.
--
-- The migration is additive and idempotent at the SQL-object level. It does not
-- delete customer rows, rewrite certificate identities, change MVGS output, or
-- contact an external service. Existing duplicate values that would violate a
-- required unique index make the migration fail closed for manual reconciliation.

SET LOCAL lock_timeout = '5s';

DO $prerequisites$
DECLARE
  required_relation text;
BEGIN
  FOREACH required_relation IN ARRAY ARRAY[
    'public.users',
    'public.certificates',
    'public.submissions',
    'public.cards',
    'public.service_tiers',
    'public.transfer_verifications',
    'public.ownership_history',
    'public.submission_items',
    'public.audit_log'
  ]
  LOOP
    IF to_regclass(required_relation) IS NULL THEN
      RAISE EXCEPTION '0115 requires %; apply the core schema before runtime-schema convergence', required_relation;
    END IF;
  END LOOP;
END
$prerequisites$;

-- Account, showroom, Vault Club, staff and seller identity columns.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS password_hash text,
  ADD COLUMN IF NOT EXISTS display_name text,
  ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS email_verified_at timestamp,
  ADD COLUMN IF NOT EXISTS last_login_at timestamp,
  ADD COLUMN IF NOT EXISTS last_login_ip text,
  ADD COLUMN IF NOT EXISTS failed_login_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until timestamp,
  ADD COLUMN IF NOT EXISTS username text,
  ADD COLUMN IF NOT EXISTS showroom_active boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS showroom_bio text,
  ADD COLUMN IF NOT EXISTS showroom_claimed_at timestamp,
  ADD COLUMN IF NOT EXISTS vault_club_tier text,
  ADD COLUMN IF NOT EXISTS vault_club_status text,
  ADD COLUMN IF NOT EXISTS vault_club_started_at timestamp,
  ADD COLUMN IF NOT EXISTS vault_club_renews_at timestamp,
  ADD COLUMN IF NOT EXISTS vault_club_cancels_at timestamp,
  ADD COLUMN IF NOT EXISTS vault_club_billing_interval text,
  ADD COLUMN IF NOT EXISTS vault_club_grace_until timestamp,
  ADD COLUMN IF NOT EXISTS stripe_customer_id text,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text,
  ADD COLUMN IF NOT EXISTS ai_credits_user_balance integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ai_credits_last_refilled_at timestamp,
  ADD COLUMN IF NOT EXISTS member_credits_last_granted_at timestamptz,
  ADD COLUMN IF NOT EXISTS public_name boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pin_hash text,
  ADD COLUMN IF NOT EXISTS pin_set_at timestamptz,
  ADD COLUMN IF NOT EXISTS pin_failed_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pin_locked_until timestamptz,
  ADD COLUMN IF NOT EXISTS review_rate integer NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS can_grade boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS can_scan boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS can_print boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS can_edit_sets boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_connect_account_id text,
  ADD COLUMN IF NOT EXISTS seller_status text DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS seller_onboarded_at timestamptz,
  ADD COLUMN IF NOT EXISTS seller_onboarding_lock_at timestamptz,
  ADD COLUMN IF NOT EXISTS seller_kyc_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS seller_kyc_requirements_json jsonb,
  ADD COLUMN IF NOT EXISTS seller_payouts_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS seller_charges_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS seller_default_from_postcode text,
  ADD COLUMN IF NOT EXISTS seller_display_name text,
  ADD COLUMN IF NOT EXISTS seller_is_business boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS seller_legal_name text,
  ADD COLUMN IF NOT EXISTS seller_business_number text,
  ADD COLUMN IF NOT EXISTS seller_vat_number text,
  ADD COLUMN IF NOT EXISTS seller_date_of_birth date,
  ADD COLUMN IF NOT EXISTS seller_nino_or_tin_encrypted text,
  ADD COLUMN IF NOT EXISTS seller_rating_average numeric(3,2),
  ADD COLUMN IF NOT EXISTS seller_rating_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS seller_total_sales integer NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON public.users (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON public.users (lower(username));
CREATE INDEX IF NOT EXISTS idx_users_seller_status
  ON public.users (seller_status) WHERE seller_status <> 'none';
CREATE INDEX IF NOT EXISTS idx_users_stripe_connect_account_id
  ON public.users (stripe_connect_account_id) WHERE stripe_connect_account_id IS NOT NULL;

-- Rename the legacy credits table only when it is the sole authority. If both
-- names are base tables, fail instead of guessing which ledger is authoritative.
DO $member_credit_lineage$
DECLARE
  old_kind "char";
  new_kind "char";
BEGIN
  SELECT relkind INTO old_kind FROM pg_class WHERE oid = to_regclass('public.reholder_credits');
  SELECT relkind INTO new_kind FROM pg_class WHERE oid = to_regclass('public.member_credits');

  IF new_kind IS NULL AND old_kind IN ('r', 'p') THEN
    ALTER TABLE public.reholder_credits RENAME TO member_credits;
    old_kind := NULL;
    new_kind := 'r';
  ELSIF new_kind IN ('r', 'p') AND old_kind IN ('r', 'p') THEN
    RAISE EXCEPTION '0115 found both reholder_credits and member_credits as base tables; manual ledger reconciliation is required';
  END IF;
END
$member_credit_lineage$;

CREATE TABLE IF NOT EXISTS public.member_credits (
  id serial PRIMARY KEY,
  user_id text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  granted_at timestamp DEFAULT now(),
  expires_at timestamp,
  used_at timestamp,
  used_for_submission_id integer,
  source text NOT NULL
);

ALTER TABLE public.member_credits
  ADD COLUMN IF NOT EXISTS credit_type text NOT NULL DEFAULT 'member',
  ADD COLUMN IF NOT EXISTS reserved_at timestamptz,
  ADD COLUMN IF NOT EXISTS reserved_until timestamptz,
  ADD COLUMN IF NOT EXISTS reserved_for_tracking_number text;
ALTER TABLE public.member_credits ALTER COLUMN credit_type SET DEFAULT 'member';
UPDATE public.member_credits SET credit_type = 'member' WHERE credit_type = 'reholder';

-- A Stripe PaymentIntent can remain payable beyond a local reservation TTL.
-- Never auto-reuse a row merely because reserved_until elapsed: bind every new
-- reservation to one submission and require an explicit cancellation authority
-- before a future migration/service may release it. Historical reserved rows
-- are intentionally left unavailable until reconciled rather than guessed.
CREATE UNIQUE INDEX IF NOT EXISTS uq_member_credits_reserved_tracking
  ON public.member_credits (reserved_for_tracking_number)
  WHERE reserved_for_tracking_number IS NOT NULL;

DO $member_credit_view$
DECLARE old_kind "char";
BEGIN
  SELECT relkind INTO old_kind FROM pg_class WHERE oid = to_regclass('public.reholder_credits');
  IF old_kind IS NULL THEN
    EXECUTE 'CREATE VIEW public.reholder_credits AS SELECT * FROM public.member_credits';
  ELSIF old_kind = 'v' THEN
    EXECUTE 'CREATE OR REPLACE VIEW public.reholder_credits AS SELECT * FROM public.member_credits';
  ELSIF old_kind IN ('r', 'p') THEN
    RAISE EXCEPTION '0115 cannot install the compatibility view because reholder_credits remains a base table';
  END IF;
END
$member_credit_view$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_member_credits_used_for_submission
  ON public.member_credits (used_for_submission_id)
  WHERE used_for_submission_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.vault_club_events (
  id serial PRIMARY KEY,
  user_id text REFERENCES public.users(id) ON DELETE CASCADE,
  stripe_event_id text UNIQUE NOT NULL,
  event_type text NOT NULL,
  tier text,
  status text,
  amount_pence integer,
  raw_payload jsonb,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.password_reset_tokens (
  id serial PRIMARY KEY,
  user_id text NOT NULL,
  token text UNIQUE NOT NULL,
  expires_at timestamp NOT NULL,
  consumed_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.email_verification_tokens (
  id serial PRIMARY KEY,
  user_id text NOT NULL,
  token text UNIQUE NOT NULL,
  expires_at timestamp NOT NULL,
  consumed_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.account_magic_link_tokens (
  id serial PRIMARY KEY,
  user_id text NOT NULL,
  token text UNIQUE NOT NULL,
  expires_at timestamp NOT NULL,
  consumed_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.customer_magic_link_tokens (
  id serial PRIMARY KEY,
  email text NOT NULL,
  token text UNIQUE NOT NULL,
  expires_at timestamp NOT NULL,
  consumed_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_magic_link_tokens_email_created_idx
  ON public.customer_magic_link_tokens (email, created_at DESC);

CREATE TABLE IF NOT EXISTS public.pin_attempts (
  id serial PRIMARY KEY,
  email text NOT NULL,
  success boolean NOT NULL,
  reason text,
  ip_hash text,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pin_attempts_email_attempted_idx
  ON public.pin_attempts (email, attempted_at DESC);

CREATE TABLE IF NOT EXISTS public.pin_reset_tokens (
  id serial PRIMARY KEY,
  email text NOT NULL,
  token text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pin_reset_tokens_email_created_idx
  ON public.pin_reset_tokens (email, created_at DESC);

CREATE TABLE IF NOT EXISTS public.pending_switch_nonces (
  nonce text PRIMARY KEY,
  email_target text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS pending_switch_nonces_issued_at_idx
  ON public.pending_switch_nonces (issued_at);

CREATE TABLE IF NOT EXISTS public.login_attempts (
  id serial PRIMARY KEY,
  email text NOT NULL,
  ip text NOT NULL,
  success boolean NOT NULL,
  user_agent text,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_attempts_email_created_idx
  ON public.login_attempts (email, created_at DESC);
CREATE INDEX IF NOT EXISTS login_attempts_ip_created_idx
  ON public.login_attempts (ip, created_at DESC);

CREATE TABLE IF NOT EXISTS public.waitlist_signups (
  id serial PRIMARY KEY,
  email text NOT NULL,
  source text NOT NULL DEFAULT 'homepage_founding_member',
  ip_address text,
  user_agent text,
  created_at timestamp NOT NULL DEFAULT now(),
  deleted_at timestamp
);
CREATE UNIQUE INDEX IF NOT EXISTS waitlist_signups_email_lower_idx
  ON public.waitlist_signups (lower(email)) WHERE deleted_at IS NULL;

-- Service tiers and value protection. Values are the exact server-authoritative
-- values the prior v213 boot migration enforced.
ALTER TABLE public.service_tiers
  ADD COLUMN IF NOT EXISTS display_name text,
  ADD COLUMN IF NOT EXISTS tagline text,
  ADD COLUMN IF NOT EXISTS most_popular boolean NOT NULL DEFAULT false;

INSERT INTO public.service_tiers
  (service_type, tier_id, name, price_per_card, turnaround_days, turnaround_label, max_value_gbp, is_active, sort_order)
VALUES
  ('grading','standard','VAULT QUEUE',1900,40,'40 working days',500,true,1),
  ('grading','priority','STANDARD',2500,15,'15 working days',1500,true,2),
  ('grading','express','EXPRESS',4500,5,'5 working days',3000,true,3),
  ('grading','gold','BLACK LABEL REVIEW',7500,10,'10 working days',7500,true,4),
  ('reholder','reholder','REHOLDER',1500,15,'15 working days',1000,true,1),
  ('crossover','crossover','CROSSOVER',3500,15,'15 working days',1500,true,1),
  ('authentication','authentication','AUTHENTICATION',1500,15,'15 working days',1000,true,1)
ON CONFLICT DO NOTHING;

UPDATE public.service_tiers AS target
SET name = source.name,
    price_per_card = source.price_per_card,
    turnaround_days = source.turnaround_days,
    turnaround_label = source.turnaround_label,
    max_value_gbp = source.max_value_gbp,
    sort_order = source.sort_order,
    display_name = source.display_name,
    tagline = source.tagline,
    most_popular = source.most_popular,
    updated_at = now()
FROM (VALUES
  ('standard','VAULT QUEUE',1900,40,'40 working days',500,1,'Vault Queue','For patient collectors. Full Vault treatment, longer queue.',false),
  ('priority','STANDARD',2500,15,'15 working days',1500,2,'Standard','Our most popular tier. Professional grading, solid turnaround.',true),
  ('express','EXPRESS',4500,5,'5 working days',3000,3,'Express','Fast-tracked grading for time-sensitive submissions.',false),
  ('gold','BLACK LABEL REVIEW',7500,10,'10 working days',7500,4,'Black Label Review','Premium service for high-value and investment-grade cards.',false),
  ('reholder','REHOLDER',1500,15,'15 working days',1000,1,'Reholder','New MintVault slab with updated NFC and certificate.',false),
  ('crossover','CROSSOVER',3500,15,'15 working days',1500,1,'Crossover','Re-grade a card from PSA, BGS, CGC, or another company.',false),
  ('authentication','AUTHENTICATION',1500,15,'15 working days',1000,1,'Authentication','Verify authenticity and check for alterations.',false)
) AS source(tier_id,name,price_per_card,turnaround_days,turnaround_label,max_value_gbp,sort_order,display_name,tagline,most_popular)
WHERE target.tier_id = source.tier_id;

UPDATE public.service_tiers SET is_active = false, updated_at = now()
WHERE tier_id IN ('gold', 'gold-elite');

CREATE TABLE IF NOT EXISTS public.value_protection_tiers (
  id serial PRIMARY KEY,
  min_value_pence integer NOT NULL,
  max_value_pence integer,
  fee_pence integer NOT NULL,
  requires_photos boolean DEFAULT false,
  display_name text NOT NULL
);
INSERT INTO public.value_protection_tiers
  (min_value_pence,max_value_pence,fee_pence,requires_photos,display_name)
SELECT * FROM (VALUES
  (25000,99900,1000,false,'£250 – £999'),
  (100000,249900,2500,false,'£1,000 – £2,499'),
  (250000,NULL::integer,5000,true,'£2,500+')
) AS seed(min_value_pence,max_value_pence,fee_pence,requires_photos,display_name)
WHERE NOT EXISTS (SELECT 1 FROM public.value_protection_tiers);

-- Submission workflow, tracking and staff assignment columns.
ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS royal_mail_outbound_tracking text,
  ADD COLUMN IF NOT EXISTS royal_mail_return_status text,
  ADD COLUMN IF NOT EXISTS royal_mail_return_status_at timestamp,
  ADD COLUMN IF NOT EXISTS estimated_completion_date timestamp,
  ADD COLUMN IF NOT EXISTS queued_at timestamp,
  ADD COLUMN IF NOT EXISTS grading_started_at timestamp,
  ADD COLUMN IF NOT EXISTS encapsulating_at timestamp,
  ADD COLUMN IF NOT EXISTS delivered_at timestamp,
  ADD COLUMN IF NOT EXISTS on_receipt_photo_urls text,
  ADD COLUMN IF NOT EXISTS status_history jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS reveal_wrap boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS assigned_grader_id varchar,
  ADD COLUMN IF NOT EXISTS grading_status varchar(20) NOT NULL DEFAULT 'unassigned',
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz,
  ADD COLUMN IF NOT EXISTS graded_at timestamptz,
  ADD COLUMN IF NOT EXISTS scan_assigned_to varchar,
  ADD COLUMN IF NOT EXISTS scan_status varchar(20) NOT NULL DEFAULT 'unassigned',
  ADD COLUMN IF NOT EXISTS scan_assigned_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_submissions_assigned_grader ON public.submissions (assigned_grader_id);
CREATE INDEX IF NOT EXISTS idx_submissions_grading_status ON public.submissions (grading_status);
CREATE INDEX IF NOT EXISTS idx_submissions_scan_assigned ON public.submissions (scan_assigned_to);
CREATE INDEX IF NOT EXISTS idx_submissions_scan_status ON public.submissions (scan_status);

UPDATE public.submissions s SET grading_status = 'approved'
WHERE s.grading_status = 'unassigned'
  AND EXISTS (
    SELECT 1 FROM public.cards c
    JOIN public.certificates cert ON cert.card_id = c.id
    WHERE c.submission_id = s.id AND cert.grade_approved_at IS NOT NULL
  );

-- Certificate columns formerly spread across account, marketplace, grading,
-- stolen-card, archive and manual-centering startup/request paths.
ALTER TABLE public.certificates
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'customer_submission',
  ADD COLUMN IF NOT EXISTS crop_geometry jsonb,
  ADD COLUMN IF NOT EXISTS ai_defect_candidates jsonb,
  ADD COLUMN IF NOT EXISTS reference_number text,
  ADD COLUMN IF NOT EXISTS logbook_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS logbook_last_issued_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_to_b2_at timestamp,
  ADD COLUMN IF NOT EXISTS stolen_status text,
  ADD COLUMN IF NOT EXISTS stolen_reported_at timestamp,
  ADD COLUMN IF NOT EXISTS grade_strength_score integer,
  ADD COLUMN IF NOT EXISTS current_listing_id integer,
  ADD COLUMN IF NOT EXISTS centering_points_front jsonb,
  ADD COLUMN IF NOT EXISTS centering_points_back jsonb,
  ADD COLUMN IF NOT EXISTS centering_method text,
  ADD COLUMN IF NOT EXISTS centering_outer_front jsonb,
  ADD COLUMN IF NOT EXISTS centering_inner_front jsonb,
  ADD COLUMN IF NOT EXISTS centering_outer_back jsonb,
  ADD COLUMN IF NOT EXISTS centering_inner_back jsonb,
  ADD COLUMN IF NOT EXISTS external_card_id text,
  ADD COLUMN IF NOT EXISTS ai_analysis jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS ai_draft_grade decimal(3,1),
  ADD COLUMN IF NOT EXISTS centering_front_lr text,
  ADD COLUMN IF NOT EXISTS centering_front_tb text,
  ADD COLUMN IF NOT EXISTS centering_back_lr text,
  ADD COLUMN IF NOT EXISTS centering_back_tb text,
  ADD COLUMN IF NOT EXISTS defects jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS grade_approved_by text,
  ADD COLUMN IF NOT EXISTS grade_approved_at timestamp,
  ADD COLUMN IF NOT EXISTS grading_front_original text,
  ADD COLUMN IF NOT EXISTS grading_front_cropped text,
  ADD COLUMN IF NOT EXISTS grading_front_greyscale text,
  ADD COLUMN IF NOT EXISTS grading_front_highcontrast text,
  ADD COLUMN IF NOT EXISTS grading_front_edgeenhanced text,
  ADD COLUMN IF NOT EXISTS grading_front_inverted text,
  ADD COLUMN IF NOT EXISTS grading_back_original text,
  ADD COLUMN IF NOT EXISTS grading_back_cropped text,
  ADD COLUMN IF NOT EXISTS grading_back_greyscale text,
  ADD COLUMN IF NOT EXISTS grading_back_highcontrast text,
  ADD COLUMN IF NOT EXISTS grading_back_edgeenhanced text,
  ADD COLUMN IF NOT EXISTS grading_back_inverted text,
  ADD COLUMN IF NOT EXISTS grading_angled_original text,
  ADD COLUMN IF NOT EXISTS grading_angled_cropped text,
  ADD COLUMN IF NOT EXISTS grading_closeup_original text,
  ADD COLUMN IF NOT EXISTS grading_closeup_cropped text,
  ADD COLUMN IF NOT EXISTS image_quality_checks jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS grading_card_id text,
  ADD COLUMN IF NOT EXISTS grading_card_source text,
  ADD COLUMN IF NOT EXISTS corner_values jsonb,
  ADD COLUMN IF NOT EXISTS edge_values jsonb,
  ADD COLUMN IF NOT EXISTS surface_values jsonb,
  ADD COLUMN IF NOT EXISTS auth_status text DEFAULT 'genuine',
  ADD COLUMN IF NOT EXISTS auth_notes text,
  ADD COLUMN IF NOT EXISTS grade_explanation text,
  ADD COLUMN IF NOT EXISTS private_notes text,
  ADD COLUMN IF NOT EXISTS grading_status text NOT NULL DEFAULT 'submitted',
  ADD COLUMN IF NOT EXISTS status_updated_at timestamp,
  ADD COLUMN IF NOT EXISTS cert_tracking_number text,
  ADD COLUMN IF NOT EXISTS estimated_value_low decimal(10,2),
  ADD COLUMN IF NOT EXISTS estimated_value_high decimal(10,2),
  ADD COLUMN IF NOT EXISTS market_value_updated_at timestamp,
  ADD COLUMN IF NOT EXISTS ai_defects jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS verified_defects jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS assigned_grader_id varchar,
  ADD COLUMN IF NOT EXISTS grader_status varchar(20) NOT NULL DEFAULT 'unassigned',
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz,
  ADD COLUMN IF NOT EXISTS graded_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejection_reason text,
  ADD COLUMN IF NOT EXISTS redo_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS scanned_by varchar,
  ADD COLUMN IF NOT EXISTS graded_by varchar,
  ADD COLUMN IF NOT EXISTS operator_grade numeric,
  ADD COLUMN IF NOT EXISTS operator_subgrades jsonb,
  ADD COLUMN IF NOT EXISTS review_required boolean;

CREATE UNIQUE INDEX IF NOT EXISTS uq_certificates_reference_number
  ON public.certificates (reference_number) WHERE reference_number IS NOT NULL;

-- One-time replacement for the former every-boot Node backfill. PostgreSQL's
-- cryptographically random v4 UUID supplies 12 independent bytes; each byte is
-- mapped uniformly onto the same 32-character, ambiguity-free alphabet used by
-- server/reference-number.ts (32 divides 256 exactly). The unique index is the
-- collision authority and retries remain inside this migration transaction.
DO $reference_number_backfill$
DECLARE
  certificate record;
  random_bytes bytea;
  raw_reference text;
  formatted_reference text;
  alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  byte_index integer;
  attempts integer;
BEGIN
  FOR certificate IN
    SELECT id FROM public.certificates
    WHERE reference_number IS NULL AND deleted_at IS NULL
    ORDER BY id
  LOOP
    attempts := 0;
    LOOP
      attempts := attempts + 1;
      random_bytes := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
      raw_reference := '';
      FOR byte_index IN 0..11 LOOP
        raw_reference := raw_reference || substr(alphabet, (get_byte(random_bytes, byte_index) % 32) + 1, 1);
      END LOOP;
      formatted_reference := substr(raw_reference,1,4) || '-' || substr(raw_reference,5,4) || '-' || substr(raw_reference,9,4);
      BEGIN
        UPDATE public.certificates
        SET reference_number = formatted_reference
        WHERE id = certificate.id AND reference_number IS NULL;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        IF attempts >= 10 THEN
          RAISE EXCEPTION '0115 could not allocate a unique reference number for certificate id %', certificate.id;
        END IF;
      END;
    END LOOP;
  END LOOP;
END
$reference_number_backfill$;

CREATE INDEX IF NOT EXISTS idx_certificates_archive_candidates
  ON public.certificates (grade_approved_at)
  WHERE archived_to_b2_at IS NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_certificates_current_listing_id
  ON public.certificates (current_listing_id) WHERE current_listing_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_certificates_assigned_grader ON public.certificates (assigned_grader_id);
CREATE INDEX IF NOT EXISTS idx_certificates_grader_status ON public.certificates (grader_status);
CREATE INDEX IF NOT EXISTS idx_certificates_graded_by ON public.certificates (graded_by);
CREATE INDEX IF NOT EXISTS idx_certificates_scanned_by ON public.certificates (scanned_by);
CREATE INDEX IF NOT EXISTS idx_certificates_active_scan
  ON public.certificates (status, issued_at DESC) WHERE deleted_at IS NULL;

UPDATE public.certificates SET grader_status = 'approved'
WHERE grader_status = 'unassigned' AND grade_approved_at IS NOT NULL;

ALTER TABLE public.transfer_verifications
  ADD COLUMN IF NOT EXISTS new_owner_name text,
  ADD COLUMN IF NOT EXISTS new_owner_token_hash text,
  ADD COLUMN IF NOT EXISTS new_owner_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS dispute_deadline timestamptz,
  ADD COLUMN IF NOT EXISTS disputed_at timestamptz,
  ADD COLUMN IF NOT EXISTS dispute_reason text,
  ADD COLUMN IF NOT EXISTS flow_version varchar(4) NOT NULL DEFAULT 'v1',
  ADD COLUMN IF NOT EXISTS transfer_status varchar(30) NOT NULL DEFAULT 'pending_owner',
  ADD COLUMN IF NOT EXISTS reference_number_provided text,
  ADD COLUMN IF NOT EXISTS outgoing_keeper_user_id varchar,
  ADD COLUMN IF NOT EXISTS incoming_keeper_user_id varchar,
  ADD COLUMN IF NOT EXISTS incoming_confirm_deadline timestamptz,
  ADD COLUMN IF NOT EXISTS disputed_by varchar(10),
  ADD COLUMN IF NOT EXISTS finalised_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancellation_reason text;
CREATE INDEX IF NOT EXISTS idx_transfer_v2_status
  ON public.transfer_verifications (transfer_status) WHERE flow_version = 'v2';
ALTER TABLE public.ownership_history ADD COLUMN IF NOT EXISTS public_name boolean DEFAULT false;
ALTER TABLE public.submission_items ADD COLUMN IF NOT EXISTS declared_new boolean DEFAULT false;

CREATE TABLE IF NOT EXISTS public.grading_sessions (
  id serial PRIMARY KEY,
  cert_id text NOT NULL,
  started_at timestamp NOT NULL DEFAULT now(),
  completed_at timestamp,
  grader text,
  model_version text,
  ai_response jsonb,
  final_grade decimal(3,1),
  notes text
);
ALTER TABLE public.grading_sessions
  ADD COLUMN IF NOT EXISTS card_game text,
  ADD COLUMN IF NOT EXISTS card_name text,
  ADD COLUMN IF NOT EXISTS card_set text,
  ADD COLUMN IF NOT EXISTS grading_duration_seconds integer,
  ADD COLUMN IF NOT EXISTS ai_draft_centering decimal(3,1),
  ADD COLUMN IF NOT EXISTS ai_draft_corners decimal(3,1),
  ADD COLUMN IF NOT EXISTS ai_draft_edges decimal(3,1),
  ADD COLUMN IF NOT EXISTS ai_draft_surface decimal(3,1),
  ADD COLUMN IF NOT EXISTS ai_draft_overall decimal(3,1),
  ADD COLUMN IF NOT EXISTS human_centering decimal(3,1),
  ADD COLUMN IF NOT EXISTS human_corners decimal(3,1),
  ADD COLUMN IF NOT EXISTS human_edges decimal(3,1),
  ADD COLUMN IF NOT EXISTS human_surface decimal(3,1),
  ADD COLUMN IF NOT EXISTS human_overall decimal(3,1),
  ADD COLUMN IF NOT EXISTS human_defects jsonb,
  ADD COLUMN IF NOT EXISTS ai_defects jsonb,
  ADD COLUMN IF NOT EXISTS centering_diff decimal(3,1),
  ADD COLUMN IF NOT EXISTS corners_diff decimal(3,1),
  ADD COLUMN IF NOT EXISTS edges_diff decimal(3,1),
  ADD COLUMN IF NOT EXISTS surface_diff decimal(3,1),
  ADD COLUMN IF NOT EXISTS overall_diff decimal(3,1),
  ADD COLUMN IF NOT EXISTS correction_notes text,
  ADD COLUMN IF NOT EXISTS is_holo boolean,
  ADD COLUMN IF NOT EXISTS is_black_label boolean;
UPDATE public.grading_sessions SET model_version = 'claude-sonnet-4-6' WHERE model_version IS NULL;

CREATE TABLE IF NOT EXISTS public.ai_accuracy_log (
  id serial PRIMARY KEY,
  cert_id text NOT NULL,
  ai_grade decimal(3,1),
  human_grade decimal(3,1),
  grade_delta decimal(3,1),
  ai_centering decimal(3,1),
  human_centering decimal(3,1),
  ai_corners decimal(3,1),
  human_corners decimal(3,1),
  ai_edges decimal(3,1),
  human_edges decimal(3,1),
  ai_surface decimal(3,1),
  human_surface decimal(3,1),
  logged_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.ai_grade_corrections (
  id serial PRIMARY KEY,
  cert_id text,
  ai_estimated_grade integer,
  ai_centering text,
  ai_corners text,
  ai_edges text,
  ai_surface text,
  actual_grade integer,
  actual_centering integer,
  actual_corners integer,
  actual_edges integer,
  actual_surface integer,
  graded_by text,
  correction_notes text,
  created_at timestamp DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.ai_override_audit (
  id serial PRIMARY KEY,
  cert_id integer,
  field_path text NOT NULL,
  ai_value jsonb,
  override_value jsonb,
  override_reason text,
  overridden_by text NOT NULL,
  overridden_at timestamptz DEFAULT now(),
  session_id text
);
CREATE INDEX IF NOT EXISTS idx_override_audit_cert ON public.ai_override_audit (cert_id);
CREATE INDEX IF NOT EXISTS idx_override_audit_field ON public.ai_override_audit (field_path);
CREATE INDEX IF NOT EXISTS idx_override_audit_time ON public.ai_override_audit (overridden_at DESC);

CREATE TABLE IF NOT EXISTS public.estimate_credits (
  id serial PRIMARY KEY,
  email text NOT NULL UNIQUE,
  credits_remaining integer NOT NULL DEFAULT 0,
  credits_purchased integer NOT NULL DEFAULT 0,
  credits_used integer NOT NULL DEFAULT 0,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);
ALTER TABLE public.estimate_credits ADD COLUMN IF NOT EXISTS user_id text REFERENCES public.users(id);
CREATE INDEX IF NOT EXISTS estimate_credits_user_id_idx ON public.estimate_credits (user_id);
-- Revoke the legacy boot-seeded "unlimited" owner-email sentinel. Public email
-- text is not authentication and must never confer authority to spend AI calls.
-- Preserve the row and usage history so a later operator reconciliation remains
-- possible; only the artificial unspent grant is removed.
UPDATE public.estimate_credits
   SET credits_remaining = 0,
       credits_purchased = credits_used,
       updated_at = now()
 WHERE lower(email) = 'mintvaultuk@gmail.com'
   AND user_id IS NULL
   AND credits_purchased = 999999;

CREATE TABLE IF NOT EXISTS public.estimate_free_uses (
  ip_hash text PRIMARY KEY,
  last_used_at timestamp NOT NULL,
  count_today integer NOT NULL DEFAULT 0,
  created_at timestamp DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.estimate_credit_reservations (
  id uuid PRIMARY KEY,
  credit_path text NOT NULL CHECK (credit_path IN ('user_balance', 'user_estimate', 'anon_free')),
  session_user_id text,
  estimate_credit_id integer,
  ip_hash text,
  free_use_day date,
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'committed', 'refunded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);
CREATE INDEX IF NOT EXISTS estimate_credit_reservations_status_created_idx
  ON public.estimate_credit_reservations (status, created_at);
CREATE TABLE IF NOT EXISTS public.ebay_price_cache (
  id serial PRIMARY KEY,
  card_key text NOT NULL UNIQUE,
  card_name text NOT NULL,
  card_number text,
  set_name text,
  average_price_pence integer,
  listing_count integer NOT NULL DEFAULT 0,
  listings_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ebay_cache_updated ON public.ebay_price_cache (last_updated_at);

CREATE TABLE IF NOT EXISTS public.tier_capacity (
  id serial PRIMARY KEY,
  tier_slug text UNIQUE NOT NULL,
  max_active integer NOT NULL,
  force_open boolean NOT NULL DEFAULT false,
  updated_at timestamp NOT NULL DEFAULT now()
);
INSERT INTO public.tier_capacity (tier_slug,max_active)
VALUES ('standard',500),('priority',150),('express',40)
ON CONFLICT DO NOTHING;
ALTER TABLE public.tier_capacity
  ADD COLUMN IF NOT EXISTS tier_id text,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS paused_until timestamptz,
  ADD COLUMN IF NOT EXISTS paused_message text,
  ADD COLUMN IF NOT EXISTS max_concurrent integer NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS paused_by text;
UPDATE public.tier_capacity SET tier_id = tier_slug WHERE tier_id IS NULL AND tier_slug IS NOT NULL;
ALTER TABLE public.tier_capacity ALTER COLUMN max_active SET DEFAULT 0;
ALTER TABLE public.tier_capacity ALTER COLUMN force_open SET DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tier_capacity_tier_id
  ON public.tier_capacity (tier_id) WHERE tier_id IS NOT NULL;
INSERT INTO public.tier_capacity
  (tier_id,tier_slug,status,max_concurrent,max_active,force_open,updated_at)
SELECT * FROM (VALUES
  ('standard','standard','open',30,0,false,now()),
  ('priority','priority','open',20,0,false,now()),
  ('express','express','open',15,0,false,now()),
  ('gold','gold','open',10,0,false,now()),
  ('gold-elite','gold-elite','open',5,0,false,now()),
  ('reholder','reholder','open',20,0,false,now()),
  ('crossover','crossover','open',15,0,false,now()),
  ('authentication','authentication','open',15,0,false,now())
) AS seed(tier_id,tier_slug,status,max_concurrent,max_active,force_open,updated_at)
WHERE NOT EXISTS (SELECT 1 FROM public.tier_capacity existing WHERE existing.tier_id = seed.tier_id);

CREATE TABLE IF NOT EXISTS public.contact_inquiries (
  id serial PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL,
  topic text NOT NULL,
  message text NOT NULL,
  submitted_at timestamp NOT NULL DEFAULT now(),
  email_sent_at timestamp,
  email_error text,
  ip_address text,
  user_agent text,
  deleted_at timestamp
);
CREATE INDEX IF NOT EXISTS idx_contact_inquiries_submitted_at
  ON public.contact_inquiries (submitted_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_audit_log_entity_action
  ON public.audit_log (entity_id,action,created_at DESC);

CREATE TABLE IF NOT EXISTS public.stolen_reports (
  id serial PRIMARY KEY,
  cert_id text NOT NULL,
  reporter_name text NOT NULL,
  reporter_email text NOT NULL,
  description text,
  verify_token text NOT NULL UNIQUE,
  verified_at timestamp,
  cleared_at timestamp,
  cleared_by text,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.pending_set_lookups (
  id serial PRIMARY KEY,
  printed_code text NOT NULL,
  card_number text NOT NULL,
  language text NOT NULL DEFAULT 'en',
  cert_id text,
  status text NOT NULL DEFAULT 'pending',
  tcgdex_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by text
);
CREATE INDEX IF NOT EXISTS idx_pending_set_lookups_status ON public.pending_set_lookups (status);
CREATE TABLE IF NOT EXISTS public.custom_variants (
  id serial PRIMARY KEY,
  label text NOT NULL,
  normalized_key text NOT NULL UNIQUE,
  created_by text,
  created_at timestamptz DEFAULT now()
);

-- Marketplace persistence previously lived only in awaited application boot.
CREATE TABLE IF NOT EXISTS public.marketplace_listings (
  id serial PRIMARY KEY,
  cert_id text NOT NULL,
  seller_user_id text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  price_pence integer NOT NULL,
  currency text NOT NULL DEFAULT 'GBP',
  title text NOT NULL,
  description text,
  ai_description_used boolean NOT NULL DEFAULT false,
  condition_notes text,
  shipping_method text NOT NULL DEFAULT 'royal_mail_tracked_48',
  shipping_cost_pence integer NOT NULL DEFAULT 0,
  view_count integer NOT NULL DEFAULT 0,
  watch_count integer NOT NULL DEFAULT 0,
  listed_at timestamptz,
  sold_at timestamptz,
  cancelled_at timestamptz,
  frozen_at timestamptz,
  frozen_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_status ON public.marketplace_listings (status);
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_seller ON public.marketplace_listings (seller_user_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_cert_id ON public.marketplace_listings (cert_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_marketplace_listings_active_cert
  ON public.marketplace_listings (cert_id) WHERE status IN ('draft','active');

CREATE TABLE IF NOT EXISTS public.marketplace_listing_images (
  id serial PRIMARY KEY,
  listing_id integer NOT NULL,
  image_url text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketplace_listing_images_listing_id
  ON public.marketplace_listing_images (listing_id);

CREATE TABLE IF NOT EXISTS public.marketplace_offers (
  id serial PRIMARY KEY,
  listing_id integer NOT NULL,
  buyer_user_id text NOT NULL,
  seller_user_id text NOT NULL,
  amount_pence integer NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  message text,
  counter_offer_id integer,
  expires_at timestamptz,
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketplace_offers_listing ON public.marketplace_offers (listing_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_offers_buyer ON public.marketplace_offers (buyer_user_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_offers_seller ON public.marketplace_offers (seller_user_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_offers_status
  ON public.marketplace_offers (status) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS public.marketplace_orders (
  id serial PRIMARY KEY,
  order_number text NOT NULL UNIQUE,
  listing_id integer NOT NULL,
  cert_id text NOT NULL,
  buyer_user_id text NOT NULL,
  seller_user_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending_payment',
  price_pence integer NOT NULL,
  shipping_pence integer NOT NULL DEFAULT 0,
  total_pence integer NOT NULL,
  commission_rate numeric(5,4) NOT NULL,
  commission_pence integer NOT NULL,
  stripe_fee_pence integer NOT NULL DEFAULT 0,
  seller_net_pence integer NOT NULL,
  stripe_payment_intent_id text,
  stripe_charge_id text,
  stripe_transfer_id text,
  escrow_release_at timestamptz,
  buyer_name text NOT NULL,
  buyer_email text NOT NULL,
  ship_to_name text NOT NULL,
  ship_to_line1 text NOT NULL,
  ship_to_line2 text,
  ship_to_city text NOT NULL,
  ship_to_postcode text NOT NULL,
  ship_to_country text NOT NULL DEFAULT 'GB',
  paid_at timestamptz,
  shipped_at timestamptz,
  delivered_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  refunded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_buyer ON public.marketplace_orders (buyer_user_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_seller ON public.marketplace_orders (seller_user_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_listing ON public.marketplace_orders (listing_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_status ON public.marketplace_orders (status);
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_escrow_release
  ON public.marketplace_orders (escrow_release_at) WHERE status = 'delivered';
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_payment_intent
  ON public.marketplace_orders (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.marketplace_order_events (
  id serial PRIMARY KEY,
  order_id integer NOT NULL,
  event_type text NOT NULL,
  actor_type text NOT NULL DEFAULT 'system',
  actor_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketplace_order_events_order_id ON public.marketplace_order_events (order_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_order_events_type ON public.marketplace_order_events (event_type);

CREATE TABLE IF NOT EXISTS public.marketplace_shipments (
  id serial PRIMARY KEY,
  order_id integer NOT NULL,
  carrier text NOT NULL DEFAULT 'royal_mail',
  service_code text,
  tracking_number text,
  label_url text,
  cost_pence integer,
  weight_grams integer,
  dispatched_at timestamptz,
  delivered_at timestamptz,
  last_tracking_event text,
  last_tracking_event_at timestamptz,
  royal_mail_order_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketplace_shipments_order_id ON public.marketplace_shipments (order_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_shipments_tracking
  ON public.marketplace_shipments (tracking_number) WHERE tracking_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.marketplace_conversations (
  id serial PRIMARY KEY,
  listing_id integer,
  order_id integer,
  buyer_user_id text NOT NULL,
  seller_user_id text NOT NULL,
  last_message_at timestamptz,
  buyer_unread_count integer NOT NULL DEFAULT 0,
  seller_unread_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketplace_conversations_buyer ON public.marketplace_conversations (buyer_user_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_conversations_seller ON public.marketplace_conversations (seller_user_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_conversations_listing
  ON public.marketplace_conversations (listing_id) WHERE listing_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.marketplace_messages (
  id serial PRIMARY KEY,
  conversation_id integer NOT NULL,
  sender_user_id text NOT NULL,
  body text NOT NULL,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketplace_messages_conversation_id
  ON public.marketplace_messages (conversation_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_messages_created_at ON public.marketplace_messages (created_at);

CREATE TABLE IF NOT EXISTS public.marketplace_reviews (
  id serial PRIMARY KEY,
  order_id integer NOT NULL UNIQUE,
  reviewer_user_id text NOT NULL,
  reviewee_user_id text NOT NULL,
  direction text NOT NULL,
  rating integer NOT NULL,
  comment text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketplace_reviews_reviewee ON public.marketplace_reviews (reviewee_user_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_reviews_direction ON public.marketplace_reviews (direction);

CREATE TABLE IF NOT EXISTS public.marketplace_disputes (
  id serial PRIMARY KEY,
  order_id integer NOT NULL,
  opened_by_user_id text NOT NULL,
  reason text NOT NULL,
  description text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  resolution text,
  resolution_notes text,
  resolved_by_admin_id text,
  resolved_at timestamptz,
  refund_amount_pence integer,
  evidence_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketplace_disputes_order_id ON public.marketplace_disputes (order_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_disputes_status ON public.marketplace_disputes (status);

CREATE TABLE IF NOT EXISTS public.marketplace_watchlist (
  id serial PRIMARY KEY,
  user_id text NOT NULL,
  listing_id integer NOT NULL,
  price_alert_threshold_pence integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_marketplace_watchlist_user_listing
  ON public.marketplace_watchlist (user_id,listing_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_watchlist_user ON public.marketplace_watchlist (user_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_watchlist_listing ON public.marketplace_watchlist (listing_id);

CREATE TABLE IF NOT EXISTS public.marketplace_dac7_quarterly (
  id serial PRIMARY KEY,
  seller_user_id text NOT NULL,
  year integer NOT NULL,
  quarter integer NOT NULL,
  gross_sales_pence bigint NOT NULL DEFAULT 0,
  transaction_count integer NOT NULL DEFAULT 0,
  commission_collected_pence bigint NOT NULL DEFAULT 0,
  last_updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (seller_user_id,year,quarter)
);
CREATE INDEX IF NOT EXISTS idx_marketplace_dac7_seller ON public.marketplace_dac7_quarterly (seller_user_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_dac7_year ON public.marketplace_dac7_quarterly (year);

-- Promotion and payment idempotency schema.
CREATE TABLE IF NOT EXISTS public.promotions (
  id serial PRIMARY KEY,
  name varchar(100) NOT NULL,
  banner_text varchar(200) NOT NULL,
  standard_pct integer NOT NULL DEFAULT 0 CHECK (standard_pct BETWEEN 0 AND 100),
  priority_pct integer NOT NULL DEFAULT 0 CHECK (priority_pct BETWEEN 0 AND 100),
  express_pct integer NOT NULL DEFAULT 0 CHECK (express_pct BETWEEN 0 AND 100),
  standard_coupon_id varchar(100),
  priority_coupon_id varchar(100),
  express_coupon_id varchar(100),
  active boolean NOT NULL DEFAULT false,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.promotions
  ADD COLUMN IF NOT EXISTS stacking_mode varchar(20) NOT NULL DEFAULT 'best_of',
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS one_active_promotion
  ON public.promotions ((active)) WHERE active = true;

CREATE TABLE IF NOT EXISTS public.promo_codes (
  id serial PRIMARY KEY,
  code varchar(64) NOT NULL,
  label varchar(200),
  percent integer NOT NULL CHECK (percent BETWEEN 1 AND 100),
  max_uses integer CHECK (max_uses IS NULL OR max_uses >= 1),
  uses_count integer NOT NULL DEFAULT 0,
  expires_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS promo_codes_code_unique
  ON public.promo_codes (code) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.stripe_webhook_events (
  stripe_event_id text PRIMARY KEY,
  event_type text,
  processed_at timestamptz NOT NULL DEFAULT now()
);

-- Preserve the one-time non-schema backfills that previously piggy-backed on
-- boot schema writers. Numbered execution makes them deterministic and auditable.
UPDATE public.users SET member_credits_last_granted_at = now() - interval '92 days'
WHERE member_credits_last_granted_at IS NULL
  AND id IN (SELECT DISTINCT user_id FROM public.member_credits);
UPDATE public.users SET can_grade = true
WHERE role IN ('grader','senior_grader') AND can_grade = false AND deleted_at IS NULL;
UPDATE public.users SET role = 'admin', updated_at = now()
WHERE lower(email) = lower('mintvaultuk@gmail.com')
  AND coalesce(role,'') <> 'admin' AND deleted_at IS NULL;

-- One migration-owned audit fact replaces dozens of best-effort boot audit
-- writes. The migration journal remains the canonical application record.
INSERT INTO public.audit_log (entity_type,entity_id,action,admin_user,details,created_at)
SELECT 'schema','0115_runtime_schema_convergence','numbered_migration_applied','system_migration',
       '{"authority":"numbered_migration","runtime_ddl_removed":true,"migration":"0115_runtime_schema_convergence.sql"}'::jsonb,
       now()
WHERE NOT EXISTS (
  SELECT 1 FROM public.audit_log
  WHERE entity_type = 'schema'
    AND entity_id = '0115_runtime_schema_convergence'
    AND action = 'numbered_migration_applied'
);

-- End-state assertion: a green journal row must imply the key former runtime
-- authorities really exist. Any missing object rolls the transaction back.
DO $contract$
DECLARE
  required_relation text;
BEGIN
  FOREACH required_relation IN ARRAY ARRAY[
    'public.member_credits',
    'public.estimate_credits',
    'public.grading_sessions',
    'public.ai_accuracy_log',
    'public.contact_inquiries',
    'public.stolen_reports',
    'public.marketplace_listings',
    'public.promotions',
    'public.stripe_webhook_events'
  ]
  LOOP
    IF to_regclass(required_relation) IS NULL THEN
      RAISE EXCEPTION '0115 convergence contract missing %', required_relation;
    END IF;
  END LOOP;
END
$contract$;
