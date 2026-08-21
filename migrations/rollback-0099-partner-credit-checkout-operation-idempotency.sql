-- Guarded rollback for 0099_partner_credit_checkout_operation_idempotency.sql.
--
-- Checkout operations are payment provenance. Never run this after an operation has been created;
-- retain the evidence and forward-fix instead.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM partner_credit_checkout_sessions
     WHERE checkout_operation_key IS NOT NULL
        OR credits IS NOT NULL
        OR price_pence IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'refusing 0099 rollback: Checkout operation provenance exists';
  END IF;
END$$;

DROP INDEX IF EXISTS idx_partner_credit_checkout_sessions_active_lookup;
DROP INDEX IF EXISTS uq_partner_credit_checkout_sessions_active_operation;
DROP INDEX IF EXISTS uq_partner_credit_checkout_sessions_operation_key;

ALTER TABLE partner_credit_checkout_sessions
  DROP CONSTRAINT IF EXISTS chk_partner_credit_checkout_sessions_snapshot,
  DROP CONSTRAINT IF EXISTS chk_partner_credit_checkout_sessions_grant_fields,
  DROP CONSTRAINT IF EXISTS chk_partner_credit_checkout_sessions_status;

ALTER TABLE partner_credit_checkout_sessions
  ADD CONSTRAINT chk_partner_credit_checkout_sessions_status
    CHECK (status IN ('created', 'granted')),
  ADD CONSTRAINT chk_partner_credit_checkout_sessions_grant_fields
    CHECK (
      (status = 'created' AND granted_event_id IS NULL AND granted_at IS NULL)
      OR (status = 'granted' AND granted_event_id IS NOT NULL AND granted_at IS NOT NULL)
    ),
  DROP COLUMN IF EXISTS tax_behavior,
  DROP COLUMN IF EXISTS price_pence,
  DROP COLUMN IF EXISTS credits,
  DROP COLUMN IF EXISTS checkout_expires_at,
  DROP COLUMN IF EXISTS checkout_url,
  DROP COLUMN IF EXISTS checkout_operation_key;

ALTER TABLE partner_credit_checkout_sessions
  ALTER COLUMN stripe_session_id SET NOT NULL;

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
