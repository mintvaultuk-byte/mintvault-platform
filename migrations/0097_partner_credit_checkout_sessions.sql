-- 0097_partner_credit_checkout_sessions.sql
-- Partner Grading Credit Checkout provenance.
--
-- The webhook grant already re-reads the Checkout Session from Stripe and verifies Price, currency,
-- environment and paid state before touching the append-only wallet ledger. This table adds the
-- missing local binding: a verified Stripe Session must also match a server-created Checkout intent
-- for the same tenant, pack, Price, currency and Stripe mode. A random or manually-created Checkout
-- Session in the Stripe account can therefore not mint Partner credits merely by carrying plausible
-- metadata.
--
-- Additive only. It records future Checkout Sessions; it does not alter wallets, ledger rows,
-- reservations, Card Jobs, packs or existing payments.

CREATE TABLE IF NOT EXISTS partner_credit_checkout_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  stripe_session_id text NOT NULL,
  pack_code text NOT NULL REFERENCES partner_credit_packs(code) ON DELETE RESTRICT,
  initiating_user_id uuid NOT NULL,
  stripe_price_id text NOT NULL,
  stripe_currency text NOT NULL,
  stripe_environment text NOT NULL,
  status text NOT NULL DEFAULT 'created',
  granted_event_id text,
  granted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_partner_credit_checkout_sessions_stripe_session UNIQUE (stripe_session_id),
  CONSTRAINT chk_partner_credit_checkout_sessions_currency CHECK (stripe_currency ~ '^[a-z]{3}$'),
  CONSTRAINT chk_partner_credit_checkout_sessions_environment CHECK (stripe_environment IN ('test','live')),
  CONSTRAINT chk_partner_credit_checkout_sessions_status CHECK (status IN ('created','granted')),
  CONSTRAINT chk_partner_credit_checkout_sessions_grant_fields CHECK (
    (status = 'created' AND granted_event_id IS NULL AND granted_at IS NULL)
    OR (status = 'granted' AND granted_event_id IS NOT NULL AND granted_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_partner_credit_checkout_sessions_tenant
  ON partner_credit_checkout_sessions (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_partner_credit_checkout_sessions_pack
  ON partner_credit_checkout_sessions (pack_code, stripe_environment);

CREATE OR REPLACE FUNCTION partner_credit_checkout_session_identity_no_mutate() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.stripe_session_id IS DISTINCT FROM OLD.stripe_session_id
     OR NEW.pack_code IS DISTINCT FROM OLD.pack_code
     OR NEW.initiating_user_id IS DISTINCT FROM OLD.initiating_user_id
     OR NEW.stripe_price_id IS DISTINCT FROM OLD.stripe_price_id
     OR NEW.stripe_currency IS DISTINCT FROM OLD.stripe_currency
     OR NEW.stripe_environment IS DISTINCT FROM OLD.stripe_environment
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'partner_credit_checkout_sessions identity fields are immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger
     WHERE tgname = 'trg_partner_credit_checkout_session_identity_no_mutate'
       AND tgrelid = 'partner_credit_checkout_sessions'::regclass
  ) THEN
    EXECUTE 'CREATE TRIGGER trg_partner_credit_checkout_session_identity_no_mutate'
         || ' BEFORE UPDATE ON partner_credit_checkout_sessions'
         || ' FOR EACH ROW EXECUTE FUNCTION partner_credit_checkout_session_identity_no_mutate()';
  END IF;
END$$;

ALTER TABLE partner_credit_checkout_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_credit_checkout_sessions FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname='public'
       AND tablename='partner_credit_checkout_sessions'
       AND policyname='partner_credit_checkout_sessions_tenant_isolation'
  ) THEN
    CREATE POLICY partner_credit_checkout_sessions_tenant_isolation
      ON partner_credit_checkout_sessions
      USING (tenant_id = partner_current_tenant())
      WITH CHECK (tenant_id = partner_current_tenant());
  END IF;
END$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_runtime') THEN
    GRANT SELECT ON public.partner_credit_checkout_sessions TO partner_runtime;
  END IF;
END$$;
