-- 0099_partner_credit_checkout_operation_idempotency.sql
--
-- A Partner Checkout Session is a payment operation, not a button press. 0097 recorded the
-- provenance of a Session after Stripe returned it, which left a retry/multi-window/restart gap:
-- each request could create another payable Session before any local row existed. This additive
-- migration gives the server one durable active operation per initiator/pack/Stripe environment,
-- with immutable price/credit snapshot fields. It never touches a wallet, ledger, reservation,
-- Card Job, pack configuration, or external Stripe object.

ALTER TABLE partner_credit_checkout_sessions
  ALTER COLUMN stripe_session_id DROP NOT NULL;

ALTER TABLE partner_credit_checkout_sessions
  ADD COLUMN IF NOT EXISTS checkout_operation_key uuid,
  ADD COLUMN IF NOT EXISTS checkout_url text,
  ADD COLUMN IF NOT EXISTS checkout_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS credits integer,
  ADD COLUMN IF NOT EXISTS price_pence integer,
  ADD COLUMN IF NOT EXISTS tax_behavior text;

-- Legacy provenance was created only for the five fixed, VAT-inclusive packs. Backfill the new
-- evidence fields from that locked catalogue without changing any payment/wallet state. Unknown
-- historical packs intentionally remain NULL and cannot be treated as a new operation.
UPDATE partner_credit_checkout_sessions
   SET checkout_operation_key = COALESCE(checkout_operation_key, gen_random_uuid()),
       credits = COALESCE(
         credits,
         CASE pack_code
           WHEN 'PACK_5' THEN 5
           WHEN 'PACK_10' THEN 10
           WHEN 'PACK_25' THEN 25
           WHEN 'PACK_50' THEN 50
           WHEN 'PACK_100' THEN 100
           ELSE NULL
         END
       ),
       price_pence = COALESCE(
         price_pence,
         CASE pack_code
           WHEN 'PACK_5' THEN 5000
           WHEN 'PACK_10' THEN 10000
           WHEN 'PACK_25' THEN 25000
           WHEN 'PACK_50' THEN 50000
           WHEN 'PACK_100' THEN 100000
           ELSE NULL
         END
       ),
       tax_behavior = COALESCE(tax_behavior, 'inclusive'),
       checkout_expires_at = COALESCE(checkout_expires_at, created_at + interval '24 hours')
 WHERE checkout_operation_key IS NULL
    OR credits IS NULL
    OR price_pence IS NULL
    OR tax_behavior IS NULL
    OR checkout_expires_at IS NULL;

ALTER TABLE partner_credit_checkout_sessions
  DROP CONSTRAINT IF EXISTS chk_partner_credit_checkout_sessions_status,
  DROP CONSTRAINT IF EXISTS chk_partner_credit_checkout_sessions_grant_fields;

ALTER TABLE partner_credit_checkout_sessions
  ADD CONSTRAINT chk_partner_credit_checkout_sessions_status
    CHECK (status IN ('creating', 'created', 'granted', 'expired')),
  ADD CONSTRAINT chk_partner_credit_checkout_sessions_grant_fields
    CHECK (
      (status IN ('creating', 'created', 'expired') AND granted_event_id IS NULL AND granted_at IS NULL)
      OR (status = 'granted' AND granted_event_id IS NOT NULL AND granted_at IS NOT NULL)
    ),
  ADD CONSTRAINT chk_partner_credit_checkout_sessions_snapshot
    CHECK (
      (credits IS NULL AND price_pence IS NULL)
      OR (credits > 0 AND price_pence > 0 AND tax_behavior = 'inclusive')
    );

CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_credit_checkout_sessions_operation_key
  ON partner_credit_checkout_sessions (checkout_operation_key)
  WHERE checkout_operation_key IS NOT NULL;

-- A paid operation changes to granted; a naturally elapsed operation changes to expired before a
-- later attempt is inserted. The partial uniqueness is the database, not renderer, backstop for a
-- rapid retry or a second Partner window.
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_credit_checkout_sessions_active_operation
  ON partner_credit_checkout_sessions (tenant_id, initiating_user_id, pack_code, stripe_environment)
  WHERE status IN ('creating', 'created');

CREATE INDEX IF NOT EXISTS idx_partner_credit_checkout_sessions_active_lookup
  ON partner_credit_checkout_sessions (
    tenant_id, initiating_user_id, pack_code, stripe_environment, checkout_expires_at DESC
  )
  WHERE status IN ('creating', 'created');

-- 0097 made every stripe_session_id immutable. A new operation necessarily starts before Stripe
-- has returned one, so permit exactly the one NULL -> value transition (and the accompanying URL /
-- expiry fields). Every identity/snapshot value remains immutable afterwards.
CREATE OR REPLACE FUNCTION partner_credit_checkout_session_identity_no_mutate() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.pack_code IS DISTINCT FROM OLD.pack_code
     OR NEW.initiating_user_id IS DISTINCT FROM OLD.initiating_user_id
     OR NEW.stripe_price_id IS DISTINCT FROM OLD.stripe_price_id
     OR NEW.stripe_currency IS DISTINCT FROM OLD.stripe_currency
     OR NEW.stripe_environment IS DISTINCT FROM OLD.stripe_environment
     OR NEW.checkout_operation_key IS DISTINCT FROM OLD.checkout_operation_key
     OR NEW.credits IS DISTINCT FROM OLD.credits
     OR NEW.price_pence IS DISTINCT FROM OLD.price_pence
     OR NEW.tax_behavior IS DISTINCT FROM OLD.tax_behavior
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.stripe_session_id IS NOT NULL AND NEW.stripe_session_id IS DISTINCT FROM OLD.stripe_session_id)
     OR (OLD.checkout_url IS NOT NULL AND NEW.checkout_url IS DISTINCT FROM OLD.checkout_url)
     OR (OLD.checkout_expires_at IS NOT NULL AND OLD.stripe_session_id IS NOT NULL
         AND NEW.checkout_expires_at IS DISTINCT FROM OLD.checkout_expires_at) THEN
    RAISE EXCEPTION 'partner_credit_checkout_sessions identity fields are immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.stripe_session_id IS NULL
     AND NEW.stripe_session_id IS NULL
     AND (NEW.checkout_url IS NOT NULL OR NEW.checkout_expires_at IS NULL) THEN
    RAISE EXCEPTION 'creating checkout intent cannot publish a URL before Stripe returns a Session'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
