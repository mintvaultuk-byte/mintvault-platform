-- 0017_partner_credit_reservations.sql
-- Partner Network — Phase G6B: credit reservation, consumption, release and expiry engine.
--
-- Additive backend/domain infrastructure only. No portal UI, Stripe purchase flow, grading-workflow
-- integration, production scheduler, or MintVault-internal table mutation. G6A's immutable
-- partner_credit_ledger remains append-only; this migration adds a durable reservation lifecycle and
-- a separate append-only reservation event log for zero-sum lifecycle evidence. Consumption is the
-- only lifecycle step that debits the wallet ledger (-1 credit).
--
-- Accounting model:
--   total remaining credits = SUM(partner_credit_ledger.amount)
--   active reserved credits = SUM(partner_credit_reservations.reserved_credits WHERE status='active')
--   available credits       = total remaining credits - active reserved credits
--
-- Release/expiry return availability by moving the reservation out of active status; they do NOT
-- append a positive wallet-credit row, because reservation never debits the wallet ledger.

-- Needed for database-enforced location tenant identity on reservations.
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_locations_identity ON partner_locations(id, tenant_id);

CREATE TABLE IF NOT EXISTS partner_credit_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  location_id uuid,
  card_reference text NOT NULL,
  submission_reference text,
  reserved_credits bigint NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active',
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  source text NOT NULL,
  reason text NOT NULL,
  actor_type text NOT NULL,
  actor_user_id uuid,
  actor_email text,
  external_ref text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  released_at timestamptz,
  expired_at timestamptz,
  CONSTRAINT uq_partner_credit_reservations_identity UNIQUE (id, tenant_id),
  CONSTRAINT fk_partner_credit_reservations_wallet_identity
    FOREIGN KEY (wallet_id, tenant_id) REFERENCES partner_wallets(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_partner_credit_reservations_location_identity
    FOREIGN KEY (location_id, tenant_id) REFERENCES partner_locations(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT chk_partner_credit_reservations_amount CHECK (reserved_credits = 1),
  CONSTRAINT chk_partner_credit_reservations_status CHECK (status IN ('active','consumed','released','expired')),
  CONSTRAINT chk_partner_credit_reservations_source CHECK (source IN ('admin','system','connector','stripe','portal','migration')),
  CONSTRAINT chk_partner_credit_reservations_actor_type CHECK (actor_type IN ('admin','system','partner_user','service')),
  CONSTRAINT chk_partner_credit_reservations_fingerprint CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_partner_credit_reservations_card_ref CHECK (length(btrim(card_reference)) > 0 AND length(card_reference) <= 200),
  CONSTRAINT chk_partner_credit_reservations_expiry CHECK (expires_at > created_at),
  CONSTRAINT chk_partner_credit_reservations_terminal_times CHECK (
    (status = 'active' AND consumed_at IS NULL AND released_at IS NULL AND expired_at IS NULL)
    OR (status = 'consumed' AND consumed_at IS NOT NULL AND released_at IS NULL AND expired_at IS NULL)
    OR (status = 'released' AND released_at IS NOT NULL AND consumed_at IS NULL AND expired_at IS NULL)
    OR (status = 'expired' AND expired_at IS NOT NULL AND consumed_at IS NULL AND released_at IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_credit_reserve_idem
  ON partner_credit_reservations(tenant_id, source, idempotency_key);

-- One live or already-consumed entitlement per partner card reference. In G6B this reference is the
-- unique grading-attempt card/submission reference; a later regrade/resubmission must use its own new
-- reference. Released/expired reservations may be attempted again with a fresh key.
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_credit_reserve_card_live
  ON partner_credit_reservations(tenant_id, card_reference)
  WHERE status IN ('active','consumed');

CREATE INDEX IF NOT EXISTS idx_partner_credit_reservations_wallet_status
  ON partner_credit_reservations(wallet_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_partner_credit_reservations_tenant_status
  ON partner_credit_reservations(tenant_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_partner_credit_reservations_expiry
  ON partner_credit_reservations(expires_at)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS partner_credit_reservation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL,
  wallet_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  event_type text NOT NULL,
  amount bigint NOT NULL DEFAULT 1,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  source text NOT NULL,
  reason text NOT NULL,
  actor_type text NOT NULL,
  actor_user_id uuid,
  actor_email text,
  external_ref text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ledger_entry_id uuid REFERENCES partner_credit_ledger(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_partner_credit_reservation_events_reservation_identity
    FOREIGN KEY (reservation_id, tenant_id) REFERENCES partner_credit_reservations(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_partner_credit_reservation_events_wallet_identity
    FOREIGN KEY (wallet_id, tenant_id) REFERENCES partner_wallets(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT chk_partner_credit_reservation_events_type CHECK (event_type IN ('reserved','consumed','released','expired')),
  CONSTRAINT chk_partner_credit_reservation_events_amount CHECK (amount = 1),
  CONSTRAINT chk_partner_credit_reservation_events_source CHECK (source IN ('admin','system','connector','stripe','portal','migration')),
  CONSTRAINT chk_partner_credit_reservation_events_actor_type CHECK (actor_type IN ('admin','system','partner_user','service')),
  CONSTRAINT chk_partner_credit_reservation_events_fingerprint CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_partner_credit_reservation_events_ledger_link CHECK (
    (event_type = 'consumed' AND ledger_entry_id IS NOT NULL)
    OR (event_type <> 'consumed' AND ledger_entry_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_credit_reservation_events_idem
  ON partner_credit_reservation_events(tenant_id, source, idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_credit_reservation_events_terminal
  ON partner_credit_reservation_events(reservation_id)
  WHERE event_type IN ('consumed','released','expired');
CREATE INDEX IF NOT EXISTS idx_partner_credit_reservation_events_reservation
  ON partner_credit_reservation_events(reservation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_partner_credit_reservation_events_tenant
  ON partner_credit_reservation_events(tenant_id, created_at);

CREATE OR REPLACE FUNCTION partner_credit_reservation_identity_no_mutate() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.wallet_id IS DISTINCT FROM OLD.wallet_id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.location_id IS DISTINCT FROM OLD.location_id
     OR NEW.card_reference IS DISTINCT FROM OLD.card_reference
     OR NEW.submission_reference IS DISTINCT FROM OLD.submission_reference
     OR NEW.reserved_credits IS DISTINCT FROM OLD.reserved_credits
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.actor_type IS DISTINCT FROM OLD.actor_type
     OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
     OR NEW.actor_email IS DISTINCT FROM OLD.actor_email
     OR NEW.external_ref IS DISTINCT FROM OLD.external_ref
     OR NEW.metadata IS DISTINCT FROM OLD.metadata
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'partner_credit_reservations identity fields are immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status <> 'active'
     AND (NEW.status IS DISTINCT FROM OLD.status
          OR NEW.consumed_at IS DISTINCT FROM OLD.consumed_at
          OR NEW.released_at IS DISTINCT FROM OLD.released_at
          OR NEW.expired_at IS DISTINCT FROM OLD.expired_at) THEN
    RAISE EXCEPTION 'partner_credit_reservations terminal lifecycle fields are immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'active' THEN
    IF NEW.status = 'active'
       AND (NEW.consumed_at IS DISTINCT FROM OLD.consumed_at
            OR NEW.released_at IS DISTINCT FROM OLD.released_at
            OR NEW.expired_at IS DISTINCT FROM OLD.expired_at) THEN
      RAISE EXCEPTION 'partner_credit_reservations active lifecycle timestamps are immutable'
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.status = 'consumed'
       AND (OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL OR NEW.released_at IS NOT NULL OR NEW.expired_at IS NOT NULL) THEN
      RAISE EXCEPTION 'partner_credit_reservations invalid consume transition'
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.status = 'released'
       AND (OLD.released_at IS NOT NULL OR NEW.released_at IS NULL OR NEW.consumed_at IS NOT NULL OR NEW.expired_at IS NOT NULL) THEN
      RAISE EXCEPTION 'partner_credit_reservations invalid release transition'
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.status = 'expired'
       AND (OLD.expired_at IS NOT NULL OR NEW.expired_at IS NULL OR NEW.consumed_at IS NOT NULL OR NEW.released_at IS NOT NULL) THEN
      RAISE EXCEPTION 'partner_credit_reservations invalid expiry transition'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION partner_credit_reservation_events_no_mutate() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'partner_credit_reservation_events is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE OR REPLACE FUNCTION partner_credit_ledger_preserve_active_reservations() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  resulting_balance bigint;
  active_reserved bigint;
BEGIN
  IF NEW.amount >= 0 THEN
    RETURN NEW;
  END IF;

  -- Serialize direct ledger debits with reservation/service transitions for the same wallet.
  PERFORM 1
    FROM partner_wallets
   WHERE id = NEW.wallet_id AND tenant_id = NEW.tenant_id
   FOR UPDATE;

  SELECT COALESCE(SUM(amount), 0)::bigint + NEW.amount
    INTO resulting_balance
    FROM partner_credit_ledger
   WHERE wallet_id = NEW.wallet_id AND tenant_id = NEW.tenant_id;

  SELECT COALESCE(SUM(reserved_credits), 0)::bigint
    INTO active_reserved
    FROM partner_credit_reservations
   WHERE wallet_id = NEW.wallet_id AND tenant_id = NEW.tenant_id AND status = 'active';

  IF resulting_balance < active_reserved THEN
    RAISE EXCEPTION 'partner_credit_ledger debit would underfund active reservations'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_partner_credit_reservation_identity_no_mutate'
                 AND tgrelid = 'partner_credit_reservations'::regclass) THEN
    EXECUTE 'CREATE TRIGGER trg_partner_credit_reservation_identity_no_mutate'
         || ' BEFORE UPDATE ON partner_credit_reservations'
         || ' FOR EACH ROW EXECUTE FUNCTION partner_credit_reservation_identity_no_mutate()';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_partner_credit_reservation_events_no_row_mutate'
                 AND tgrelid = 'partner_credit_reservation_events'::regclass) THEN
    EXECUTE 'CREATE TRIGGER trg_partner_credit_reservation_events_no_row_mutate'
         || ' BEFORE UPDATE OR DELETE ON partner_credit_reservation_events'
         || ' FOR EACH ROW EXECUTE FUNCTION partner_credit_reservation_events_no_mutate()';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_partner_credit_reservation_events_no_truncate'
                 AND tgrelid = 'partner_credit_reservation_events'::regclass) THEN
    EXECUTE 'CREATE TRIGGER trg_partner_credit_reservation_events_no_truncate'
         || ' BEFORE TRUNCATE ON partner_credit_reservation_events'
         || ' FOR EACH STATEMENT EXECUTE FUNCTION partner_credit_reservation_events_no_mutate()';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_partner_credit_ledger_preserve_active_reservations'
                 AND tgrelid = 'partner_credit_ledger'::regclass) THEN
    EXECUTE 'CREATE TRIGGER trg_partner_credit_ledger_preserve_active_reservations'
         || ' BEFORE INSERT ON partner_credit_ledger'
         || ' FOR EACH ROW EXECUTE FUNCTION partner_credit_ledger_preserve_active_reservations()';
  END IF;
END$$;

CREATE OR REPLACE VIEW partner_credit_availability WITH (security_invoker = true) AS
  SELECT w.id AS wallet_id,
         w.tenant_id,
         w.status,
         COALESCE(SUM(l.amount), 0)::bigint AS ledger_balance,
         COALESCE(r.active_reserved, 0)::bigint AS active_reserved,
         (COALESCE(SUM(l.amount), 0) - COALESCE(r.active_reserved, 0))::bigint AS available_balance,
         COALESCE(c.consumed_count, 0)::bigint AS consumed_reservations
    FROM partner_wallets w
    LEFT JOIN partner_credit_ledger l ON l.wallet_id = w.id AND l.tenant_id = w.tenant_id
    LEFT JOIN (
      SELECT wallet_id, tenant_id, COALESCE(SUM(reserved_credits), 0)::bigint AS active_reserved
        FROM partner_credit_reservations
       WHERE status = 'active'
       GROUP BY wallet_id, tenant_id
    ) r ON r.wallet_id = w.id AND r.tenant_id = w.tenant_id
    LEFT JOIN (
      SELECT wallet_id, tenant_id, COUNT(*)::bigint AS consumed_count
        FROM partner_credit_reservations
       WHERE status = 'consumed'
       GROUP BY wallet_id, tenant_id
    ) c ON c.wallet_id = w.id AND c.tenant_id = w.tenant_id
   GROUP BY w.id, w.tenant_id, w.status, r.active_reserved, c.consumed_count;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['partner_credit_reservations','partner_credit_reservation_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation ON %I USING (tenant_id = partner_current_tenant()) WITH CHECK (tenant_id = partner_current_tenant())',
      t, t
    );
  END LOOP;
END$$;

GRANT SELECT ON partner_credit_reservations, partner_credit_reservation_events, partner_credit_availability TO partner_runtime;
