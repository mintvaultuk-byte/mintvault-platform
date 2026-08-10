-- 0069 — Partner supplies and orders.
--
-- This is an additive, tenant-isolated commerce record. It deliberately does not touch customer
-- records, grading credits, historical locations or existing payment rows. The order is the
-- immutable snapshot: changing a product price, tax configuration or shop profile can never rewrite
-- a completed checkout.

DO $$
BEGIN
  IF to_regclass('public.partner_organisations') IS NULL
     OR to_regclass('public.partner_locations') IS NULL
     OR to_regclass('public.partner_audit_events') IS NULL THEN
    RAISE EXCEPTION '0069 requires the Partner foundation and audit tables.';
  END IF;
  -- 0058 deliberately creates this as a UNIQUE INDEX, not a named UNIQUE constraint. PostgreSQL
  -- accepts either as a composite-FK target, so check the actual provider contract rather than
  -- silently imposing a different DDL representation.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indexrelid = 'public.uq_partner_public_listings_tenant_location'::regclass
       AND i.indrelid = 'public.partner_locations'::regclass
       AND i.indisunique
  ) THEN
    RAISE EXCEPTION '0069 requires 0058''s unique (tenant_id, id) index on partner_locations.';
  END IF;
END$$;

-- HQ-owned current catalogue. NULL active_price_pence is intentional: the product may be visible,
-- but is not purchasable until an authorised administrator configures a positive gross price.
CREATE TABLE IF NOT EXISTS partner_supply_products (
  code text PRIMARY KEY,
  display_name text NOT NULL,
  units_per_pack integer NOT NULL CHECK (units_per_pack > 0),
  pricing_mode text NOT NULL CHECK (pricing_mode IN ('LOCKED', 'CONFIGURABLE')),
  active_price_pence integer CHECK (active_price_pence IS NULL OR active_price_pence BETWEEN 1 AND 10000000),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (code = 'plastic_mintvault_slab_box' AND display_name = 'Plastic MintVault slabs' AND units_per_pack = 50
      AND pricing_mode = 'LOCKED' AND active_price_pence = 7500)
    OR (code = 'holographic_printing_paper' AND display_name = 'Holographic printing paper' AND units_per_pack = 60
      AND pricing_mode = 'CONFIGURABLE')
    OR (code = 'nfc_tags' AND display_name = 'NFC tags' AND units_per_pack = 1000
      AND pricing_mode = 'CONFIGURABLE')
  )
);

INSERT INTO partner_supply_products (code, display_name, units_per_pack, pricing_mode, active_price_pence, active)
VALUES
  ('plastic_mintvault_slab_box', 'Plastic MintVault slabs', 50, 'LOCKED', 7500, true),
  ('holographic_printing_paper', 'Holographic printing paper', 60, 'CONFIGURABLE', NULL, true),
  ('nfc_tags', 'NFC tags', 1000, 'CONFIGURABLE', NULL, true)
ON CONFLICT (code) DO NOTHING;

-- The authoritative business setting starts explicitly unconfigured. It is not an assertion about
-- MintVault's VAT registration. Every order and payment copies this treatment and its calculated
-- totals, so future configuration cannot alter historical invoices.
CREATE TABLE IF NOT EXISTS partner_supply_tax_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  tax_treatment text NOT NULL CHECK (tax_treatment IN ('UNCONFIGURED', 'VAT_INCLUDED')),
  vat_rate_basis_points integer CHECK (vat_rate_basis_points BETWEEN 0 AND 10000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (tax_treatment = 'UNCONFIGURED' AND vat_rate_basis_points IS NULL)
    OR (tax_treatment = 'VAT_INCLUDED' AND vat_rate_basis_points IS NOT NULL)
  )
);
INSERT INTO partner_supply_tax_settings (singleton, tax_treatment, vat_rate_basis_points)
VALUES (true, 'UNCONFIGURED', NULL)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS partner_supply_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  status text NOT NULL DEFAULT 'PENDING_PAYMENT'
    CHECK (status IN ('PENDING_PAYMENT', 'PAID', 'PROCESSING', 'DISPATCHED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED')),
  delivery_address jsonb NOT NULL CHECK (jsonb_typeof(delivery_address) = 'object'),
  currency char(3) NOT NULL DEFAULT 'GBP' CHECK (currency = 'GBP'),
  gross_total_pence integer NOT NULL CHECK (gross_total_pence > 0),
  tax_treatment text NOT NULL CHECK (tax_treatment IN ('UNCONFIGURED', 'VAT_INCLUDED')),
  vat_rate_basis_points integer CHECK (vat_rate_basis_points BETWEEN 0 AND 10000),
  net_total_pence integer,
  vat_total_pence integer,
  submitted_by_user_id uuid REFERENCES partner_users(id) ON DELETE SET NULL,
  tracking_reference text CHECK (tracking_reference IS NULL OR length(tracking_reference) <= 256),
  paid_at timestamptz,
  dispatched_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  refunded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, location_id) REFERENCES partner_locations(tenant_id, id) ON DELETE RESTRICT,
  CHECK (
    (tax_treatment = 'UNCONFIGURED' AND vat_rate_basis_points IS NULL AND net_total_pence IS NULL AND vat_total_pence IS NULL)
    OR (tax_treatment = 'VAT_INCLUDED' AND vat_rate_basis_points IS NOT NULL AND net_total_pence IS NOT NULL
        AND vat_total_pence IS NOT NULL AND net_total_pence + vat_total_pence = gross_total_pence)
  )
);
CREATE INDEX IF NOT EXISTS idx_partner_supply_orders_tenant_created
  ON partner_supply_orders(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_partner_supply_orders_status_created
  ON partner_supply_orders(status, created_at DESC);

CREATE TABLE IF NOT EXISTS partner_supply_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL REFERENCES partner_supply_orders(id) ON DELETE RESTRICT,
  product_code text NOT NULL,
  product_name_snapshot text NOT NULL,
  units_per_pack_snapshot integer NOT NULL CHECK (units_per_pack_snapshot > 0),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 100),
  gross_unit_price_pence integer NOT NULL CHECK (gross_unit_price_pence > 0),
  gross_line_total_pence integer NOT NULL CHECK (gross_line_total_pence = quantity * gross_unit_price_pence),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, product_code)
);
CREATE INDEX IF NOT EXISTS idx_partner_supply_order_items_tenant_order
  ON partner_supply_order_items(tenant_id, order_id);

CREATE TABLE IF NOT EXISTS partner_supply_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL UNIQUE REFERENCES partner_supply_orders(id) ON DELETE RESTRICT,
  stripe_checkout_session_id text UNIQUE,
  stripe_payment_intent_id text UNIQUE,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')),
  currency char(3) NOT NULL DEFAULT 'GBP' CHECK (currency = 'GBP'),
  gross_total_pence integer NOT NULL CHECK (gross_total_pence > 0),
  tax_treatment text NOT NULL CHECK (tax_treatment IN ('UNCONFIGURED', 'VAT_INCLUDED')),
  vat_rate_basis_points integer CHECK (vat_rate_basis_points BETWEEN 0 AND 10000),
  net_total_pence integer,
  vat_total_pence integer,
  refunded_total_pence integer NOT NULL DEFAULT 0 CHECK (refunded_total_pence >= 0 AND refunded_total_pence <= gross_total_pence),
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (tax_treatment = 'UNCONFIGURED' AND vat_rate_basis_points IS NULL AND net_total_pence IS NULL AND vat_total_pence IS NULL)
    OR (tax_treatment = 'VAT_INCLUDED' AND vat_rate_basis_points IS NOT NULL AND net_total_pence IS NOT NULL
        AND vat_total_pence IS NOT NULL AND net_total_pence + vat_total_pence = gross_total_pence)
  )
);
CREATE INDEX IF NOT EXISTS idx_partner_supply_payments_tenant_order
  ON partner_supply_payments(tenant_id, order_id);

CREATE TABLE IF NOT EXISTS partner_supply_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL REFERENCES partner_supply_orders(id) ON DELETE RESTRICT,
  payment_id uuid NOT NULL REFERENCES partner_supply_payments(id) ON DELETE RESTRICT,
  stripe_refund_id text NOT NULL UNIQUE,
  amount_pence integer NOT NULL CHECK (amount_pence > 0),
  admin_email text,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_partner_supply_refunds_tenant_order
  ON partner_supply_refunds(tenant_id, order_id, created_at DESC);

-- A concise immutable order operation trail supplements partner_audit_events with payment/provider
-- identifiers without placing any receipt or delivery details in a generic audit payload.
CREATE TABLE IF NOT EXISTS partner_supply_order_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL REFERENCES partner_supply_orders(id) ON DELETE RESTRICT,
  action text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('partner', 'super_admin', 'stripe_webhook', 'system')),
  actor_user_id uuid,
  actor_email text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_partner_supply_order_events_tenant_order
  ON partner_supply_order_events(tenant_id, order_id, id DESC);

-- Tenant RLS is the floor even for a future route that forgets its WHERE clause. The restricted
-- runtime can read catalogue/tax and its own commerce history, and create only pending checkout
-- evidence. All authoritative state transitions, catalogue price changes and refunds use the
-- Super Admin/webhook path with its separate privileged connection.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'partner_supply_orders', 'partner_supply_order_items', 'partner_supply_payments',
    'partner_supply_refunds', 'partner_supply_order_events'
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

REVOKE ALL PRIVILEGES ON partner_supply_products, partner_supply_tax_settings,
  partner_supply_orders, partner_supply_order_items, partner_supply_payments,
  partner_supply_refunds, partner_supply_order_events FROM partner_runtime;
GRANT SELECT ON partner_supply_products, partner_supply_tax_settings TO partner_runtime;
GRANT SELECT, INSERT ON partner_supply_orders, partner_supply_order_items, partner_supply_payments TO partner_runtime;
-- A checkout session is generated server-side after the pending order is inserted. The runtime is
-- deliberately allowed to persist only that opaque provider identifier; it cannot change price,
-- tax, order state, payment state, totals or a refund.
GRANT UPDATE (stripe_checkout_session_id, updated_at) ON partner_supply_payments TO partner_runtime;
GRANT SELECT ON partner_supply_refunds TO partner_runtime;
-- Partner runtime may append only its own checkout-created evidence. It has no UPDATE/DELETE,
-- refund or status-transition privilege, and RLS binds every event to the authenticated tenant.
GRANT SELECT, INSERT ON partner_supply_order_events TO partner_runtime;

DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(t, ', ' ORDER BY t) INTO missing
    FROM unnest(ARRAY[
      'partner_supply_products', 'partner_supply_tax_settings', 'partner_supply_orders',
      'partner_supply_order_items', 'partner_supply_payments', 'partner_supply_refunds',
      'partner_supply_order_events'
    ]) AS t
   WHERE to_regclass('public.' || t) IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0069 incomplete: missing relation(s): %', missing;
  END IF;
  IF has_table_privilege('partner_runtime', 'public.partner_supply_orders', 'UPDATE')
     OR has_table_privilege('partner_runtime', 'public.partner_supply_orders', 'DELETE')
     OR has_table_privilege('partner_runtime', 'public.partner_supply_payments', 'UPDATE')
     OR has_table_privilege('partner_runtime', 'public.partner_supply_payments', 'DELETE')
     OR has_table_privilege('partner_runtime', 'public.partner_supply_refunds', 'INSERT')
     OR has_table_privilege('partner_runtime', 'public.partner_supply_refunds', 'UPDATE')
     OR has_table_privilege('partner_runtime', 'public.partner_supply_refunds', 'DELETE') THEN
    RAISE EXCEPTION '0069 privilege assertion failed: partner_runtime can mutate authoritative supply state.';
  END IF;
END$$;
