-- 0102 — Partner supplies ordering (STAGING rollout candidate)
--
-- Durable, tenant-scoped operational orders for the fixed Partner supplies catalogue.  This is not
-- a checkout, payment, price or inventory system: it records a Partner request first, snapshots
-- the fulfilment context, then creates retryable operational-notification work.
--
-- SECURITY / LIFECYCLE RULES
--   * Every child relation carries tenant_id and uses a composite tenant identity. PostgreSQL FKs
--     bypass RLS, so a bare location_id/user_id/order_id FK would permit a cross-tenant pivot.
--   * The Partner portal can insert its own canonical request but cannot update order status or
--     notification state. Super Admin-only application code owns status transitions.
--   * Events and line items are append-only. An order's original request/address/contact snapshots
--     are immutable. Delivery state is separate from the order's durable existence.
--   * No Stripe/payment/product price/stock tables are introduced here.

-- Explicit supplies authority. These are deliberately not borrowed from grading-submission
-- `partner.orders.*`: receiving physical fulfilment requests is a separate authority. Owners and
-- managers may view/submit; Reception may view the resulting status but cannot request stock.
DO $$
BEGIN
  IF to_regclass('public.partner_roles') IS NULL
     OR to_regclass('public.partner_permissions') IS NULL
     OR to_regclass('public.partner_role_permissions') IS NULL THEN
    RAISE EXCEPTION '0102 requires the Partner RBAC catalogue from 0034';
  END IF;
END$$;

INSERT INTO partner_permissions (code, label) VALUES
  ('partner.supplies.view', 'View Partner supplies requests'),
  ('partner.supplies.submit', 'Submit Partner supplies requests')
ON CONFLICT (code) DO NOTHING;

INSERT INTO partner_role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM partner_roles r
  JOIN partner_permissions p ON p.code = 'partner.supplies.view'
 WHERE r.code IN ('PARTNER_OWNER', 'PARTNER_MANAGER', 'PARTNER_RECEPTION')
ON CONFLICT DO NOTHING;

INSERT INTO partner_role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM partner_roles r
  JOIN partner_permissions p ON p.code = 'partner.supplies.submit'
 WHERE r.code IN ('PARTNER_OWNER', 'PARTNER_MANAGER')
ON CONFLICT DO NOTHING;

-- Existing parents pre-date the composite-tenant-FK idiom. Add identities without changing rows.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_partner_locations_identity') THEN
    ALTER TABLE partner_locations
      ADD CONSTRAINT uq_partner_locations_identity UNIQUE (id, tenant_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_partner_users_identity') THEN
    ALTER TABLE partner_users
      ADD CONSTRAINT uq_partner_users_identity UNIQUE (id, tenant_id);
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS partner_supplies_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_ref text NOT NULL UNIQUE DEFAULT ('SUP-' || upper(replace(gen_random_uuid()::text, '-', ''))),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  -- The current Partner model makes the organisation id its tenant id. Retain partner_id explicitly
  -- in the durable order because fulfilment exports require it, while enforcing that it cannot diverge.
  partner_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL,
  requesting_user_id uuid NOT NULL,

  partner_name_snapshot text NOT NULL,
  shop_name_snapshot text NOT NULL,
  contact_name_snapshot text NOT NULL,
  contact_email_snapshot text NOT NULL,
  contact_phone_snapshot text,
  delivery_address_snapshot text NOT NULL,
  delivery_postcode_snapshot text NOT NULL,
  delivery_country_snapshot text NOT NULL DEFAULT 'GB',
  notes text,

  status text NOT NULL DEFAULT 'RECEIVED'
    CHECK (status IN ('RECEIVED', 'PROCESSING', 'DISPATCHED', 'CANCELLED')),
  idempotency_key text NOT NULL
    CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{16,128}$'),
  request_fingerprint char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_partner_supplies_orders_partner_matches_tenant CHECK (partner_id = tenant_id),
  CONSTRAINT uq_partner_supplies_orders_tenant_idempotency UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT uq_partner_supplies_orders_identity UNIQUE (id, tenant_id),
  CONSTRAINT fk_partner_supplies_orders_location_tenant
    FOREIGN KEY (location_id, tenant_id) REFERENCES partner_locations(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_partner_supplies_orders_requester_tenant
    FOREIGN KEY (requesting_user_id, tenant_id) REFERENCES partner_users(id, tenant_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_partner_supplies_orders_tenant_created
  ON partner_supplies_orders (tenant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_partner_supplies_orders_status_created
  ON partner_supplies_orders (status, created_at ASC, id ASC);

CREATE TABLE IF NOT EXISTS partner_supplies_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL,
  product_code text NOT NULL CHECK (product_code IN ('PLASTIC_GRADED_SLABS', 'PRINT_PAPER_LABEL_STOCK', 'NFC_TAGS')),
  product_label_snapshot text NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_partner_supplies_order_items_product UNIQUE (order_id, product_code),
  CONSTRAINT fk_partner_supplies_order_items_order_tenant
    FOREIGN KEY (order_id, tenant_id) REFERENCES partner_supplies_orders(id, tenant_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_partner_supplies_order_items_tenant_order
  ON partner_supplies_order_items (tenant_id, order_id);

CREATE TABLE IF NOT EXISTS partner_supplies_order_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'ORDER_RECEIVED', 'NOTIFICATION_ATTEMPTED', 'NOTIFICATION_SENT', 'NOTIFICATION_FAILED', 'NOTIFICATION_REQUEUED',
    'NOTIFICATION_RECONCILIATION_REQUIRED',
    'STATUS_PROCESSING', 'STATUS_DISPATCHED', 'STATUS_CANCELLED'
  )),
  actor_partner_user_id uuid,
  actor_admin_user_id uuid,
  actor_admin_email text,
  before_status text,
  after_status text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fk_partner_supplies_order_events_order_tenant
    FOREIGN KEY (order_id, tenant_id) REFERENCES partner_supplies_orders(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT chk_partner_supplies_order_events_actor CHECK (
    actor_partner_user_id IS NOT NULL OR actor_admin_user_id IS NOT NULL OR event_type LIKE 'NOTIFICATION_%'
  )
);
CREATE INDEX IF NOT EXISTS idx_partner_supplies_order_events_tenant_order
  ON partner_supplies_order_events (tenant_id, order_id, id ASC);

CREATE TABLE IF NOT EXISTS partner_supplies_order_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL,
  provider_idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'CLAIMED', 'SENT', 'FAILED')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0 AND attempt_count <= 12),
  last_attempt_at timestamptz,
  -- Set at claim time: a worker may have reached Resend even if it crashes before recording SENT.
  -- Preserve it across recovery so stale uncertain delivery never becomes a duplicate send.
  uncertain_delivery_at timestamptz,
  -- NULL after a terminal send or an exhausted automatic retry budget. Only a fresh, audited
  -- Super Admin step-up may requeue an exhausted FAILED notification; completed sends cannot be
  -- re-enqueued accidentally.
  next_attempt_at timestamptz DEFAULT now(),
  claim_token uuid,
  claim_expires_at timestamptz,
  sent_at timestamptz,
  provider_message_id text,
  failure_code text CHECK (failure_code IN ('PROVIDER_UNAVAILABLE', 'PROVIDER_REJECTED', 'PROVIDER_UNCERTAIN')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_partner_supplies_order_notifications_order UNIQUE (order_id, tenant_id),
  CONSTRAINT fk_partner_supplies_order_notifications_order_tenant
    FOREIGN KEY (order_id, tenant_id) REFERENCES partner_supplies_orders(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT chk_partner_supplies_order_notifications_sent CHECK (
    (status = 'SENT' AND sent_at IS NOT NULL AND provider_message_id IS NOT NULL AND failure_code IS NULL)
    OR (status <> 'SENT' AND sent_at IS NULL)
  ),
  CONSTRAINT chk_partner_supplies_order_notifications_claim CHECK (
    (status = 'CLAIMED' AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL)
    OR (status <> 'CLAIMED' AND claim_token IS NULL AND claim_expires_at IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_partner_supplies_order_notifications_due
  ON partner_supplies_order_notifications (next_attempt_at, id)
  WHERE status IN ('PENDING', 'FAILED');

-- Immutable snapshots and a server-owned state machine. The trigger protects the database boundary
-- as well as the Super Admin route: no direct UPDATE can skip the legal transition graph.
CREATE OR REPLACE FUNCTION partner_supplies_orders_enforce_update() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE legal boolean := false;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.public_ref IS DISTINCT FROM OLD.public_ref
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.partner_id IS DISTINCT FROM OLD.partner_id
     OR NEW.location_id IS DISTINCT FROM OLD.location_id
     OR NEW.requesting_user_id IS DISTINCT FROM OLD.requesting_user_id
     OR NEW.partner_name_snapshot IS DISTINCT FROM OLD.partner_name_snapshot
     OR NEW.shop_name_snapshot IS DISTINCT FROM OLD.shop_name_snapshot
     OR NEW.contact_name_snapshot IS DISTINCT FROM OLD.contact_name_snapshot
     OR NEW.contact_email_snapshot IS DISTINCT FROM OLD.contact_email_snapshot
     OR NEW.contact_phone_snapshot IS DISTINCT FROM OLD.contact_phone_snapshot
     OR NEW.delivery_address_snapshot IS DISTINCT FROM OLD.delivery_address_snapshot
     OR NEW.delivery_postcode_snapshot IS DISTINCT FROM OLD.delivery_postcode_snapshot
     OR NEW.delivery_country_snapshot IS DISTINCT FROM OLD.delivery_country_snapshot
     OR NEW.notes IS DISTINCT FROM OLD.notes
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'partner_supplies_orders: immutable request/snapshot fields cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    legal := (OLD.status = 'RECEIVED' AND NEW.status IN ('PROCESSING', 'CANCELLED'))
          OR (OLD.status = 'PROCESSING' AND NEW.status IN ('DISPATCHED', 'CANCELLED'));
    IF NOT legal THEN
      RAISE EXCEPTION 'partner_supplies_orders: illegal transition % -> %', OLD.status, NEW.status
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_partner_supplies_orders_enforce_update ON partner_supplies_orders;
CREATE TRIGGER trg_partner_supplies_orders_enforce_update
  BEFORE UPDATE ON partner_supplies_orders
  FOR EACH ROW EXECUTE FUNCTION partner_supplies_orders_enforce_update();
ALTER TABLE partner_supplies_orders ENABLE ALWAYS TRIGGER trg_partner_supplies_orders_enforce_update;

CREATE OR REPLACE FUNCTION partner_supplies_append_only() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$fn$;
DROP TRIGGER IF EXISTS trg_partner_supplies_order_items_append_only ON partner_supplies_order_items;
CREATE TRIGGER trg_partner_supplies_order_items_append_only
  BEFORE UPDATE OR DELETE ON partner_supplies_order_items
  FOR EACH ROW EXECUTE FUNCTION partner_supplies_append_only();
ALTER TABLE partner_supplies_order_items ENABLE ALWAYS TRIGGER trg_partner_supplies_order_items_append_only;
DROP TRIGGER IF EXISTS trg_partner_supplies_order_events_append_only ON partner_supplies_order_events;
CREATE TRIGGER trg_partner_supplies_order_events_append_only
  BEFORE UPDATE OR DELETE ON partner_supplies_order_events
  FOR EACH ROW EXECUTE FUNCTION partner_supplies_append_only();
ALTER TABLE partner_supplies_order_events ENABLE ALWAYS TRIGGER trg_partner_supplies_order_events_append_only;

-- Tenant RLS exactly mirrors the Partner foundation. The Super Admin connection is privileged and
-- must still use explicit tenant predicates in application services.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'partner_supplies_orders', 'partner_supplies_order_items',
    'partner_supplies_order_events', 'partner_supplies_order_notifications'
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

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_runtime') THEN
    -- Partner routes create the durable request and read their own history. They hold NO UPDATE or
    -- DELETE right, so status/provider outcomes cannot be modified from the Partner surface.
    GRANT SELECT, INSERT ON partner_supplies_orders TO partner_runtime;
    GRANT SELECT, INSERT ON partner_supplies_order_items TO partner_runtime;
    GRANT SELECT, INSERT ON partner_supplies_order_events TO partner_runtime;
    GRANT SELECT, INSERT ON partner_supplies_order_notifications TO partner_runtime;
    GRANT USAGE ON SEQUENCE partner_supplies_order_events_id_seq TO partner_runtime;
  END IF;
END$$;

-- Explicit runtime checks catch an accidentally partial migration before it is journalled applied.
DO $$
BEGIN
  IF to_regclass('public.partner_supplies_orders') IS NULL
     OR to_regclass('public.partner_supplies_order_items') IS NULL
     OR to_regclass('public.partner_supplies_order_events') IS NULL
     OR to_regclass('public.partner_supplies_order_notifications') IS NULL THEN
    RAISE EXCEPTION '0102 did not create the Partner supplies tables';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_partner_supplies_orders_tenant_idempotency') THEN
    RAISE EXCEPTION '0102 did not create tenant-local supplies idempotency';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_partner_supplies_orders_enforce_update' AND tgenabled = 'A') THEN
    RAISE EXCEPTION '0102 did not enable the supplies transition trigger';
  END IF;
END$$;
