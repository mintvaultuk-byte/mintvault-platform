-- 0112 — Partner supplies commerce: a Super-Admin-owned catalogue and a tenant-isolated order record.
--
-- LINEAGE. Recovered from 0069 on codex/mintvault-final-product-integration (0549c0cc), which was
-- never applied to any database. Renumbered above this lineage's 0110 high-water mark, and adapted
-- to the constraints this lineage actually has — the original asserted an index (0058's
-- uq_partner_public_listings_tenant_location) that does not exist here, and referenced
-- partner_locations(tenant_id, id) in an order this lineage does not carry a unique index for.
--
-- This is an additive, tenant-isolated commerce record. It deliberately does not touch customer
-- records, grading credits, historical locations or existing payment rows. The order is the
-- immutable snapshot: changing a product price, its name, its picture or the tax configuration can
-- never rewrite a completed checkout.
--
-- THREE DELIBERATE DEPARTURES FROM THE RECOVERED VERSION, all owner decisions:
--
--   1. NO HARD-CODED CATALOGUE. The original CHECK constraint enumerated the three products by
--      code, display name, pack size and pricing mode. That was the three-product limit — in the
--      DATABASE, where no admin screen could ever get past it. It is gone, so a fourth product is
--      an INSERT.
--   2. NO LOCKED PRICING MODE. The original pinned the slab box at exactly 7500 pence and refused
--      any change. £75 survives as the seeded STARTING value; it is no longer a rule.
--   3. DESCRIPTION AND IMAGE. A product a shop is asked to buy needs to be describable and
--      showable, so both are first-class columns rather than something bolted on later.

DO $$
BEGIN
  IF to_regclass('public.partner_organisations') IS NULL
     OR to_regclass('public.partner_locations') IS NULL
     OR to_regclass('public.partner_users') IS NULL
     OR to_regclass('public.partner_audit_events') IS NULL THEN
    RAISE EXCEPTION '0111 requires the Partner foundation and audit tables.';
  END IF;
  /*
   * The composite location FK below needs a unique index on partner_locations (id, tenant_id).
   * On THIS lineage that is uq_partner_locations_identity — the same target migration 0104 uses for
   * exactly the same purpose. The recovered version asserted 0058's
   * uq_partner_public_listings_tenant_location, which belongs to a different lineage and does not
   * exist here; asserting the index that IS present is what makes this runnable rather than
   * dropping the check and discovering the mismatch at the FK.
   */
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indrelid = 'public.partner_locations'::regclass
       AND i.indisunique
       AND i.indkey::text = (
         SELECT string_agg(a.attnum::text, ' ' ORDER BY ord)
           FROM unnest(ARRAY['id','tenant_id']) WITH ORDINALITY t(col, ord)
           JOIN pg_attribute a ON a.attrelid = 'public.partner_locations'::regclass AND a.attname = t.col
       )
  ) THEN
    RAISE EXCEPTION '0111 requires a unique (id, tenant_id) index on partner_locations.';
  END IF;
END$$;

/*
 * THE CATALOGUE. Super-Admin-owned, global, and deliberately OPEN-ENDED.
 *
 * NULL active_price_pence is intentional and is not an oversight: a product may be catalogued and
 * visible to MintVault while not being purchasable, which is exactly the state a newly added
 * product is in before somebody decides what it costs. The service refuses to sell it until a
 * positive price exists, so "catalogued" and "on sale" stay different facts.
 *
 * There is NO constraint naming a product. The recovered version carried a CHECK enumerating three
 * codes with their exact display names, pack sizes and pricing modes; that made a fourth product
 * impossible at the database, so no amount of admin UI could ever have added one.
 */
CREATE TABLE IF NOT EXISTS partner_supply_products (
  code text PRIMARY KEY CHECK (code ~ '^[a-z0-9_]{3,64}$'),
  display_name text NOT NULL CHECK (btrim(display_name) <> '' AND length(display_name) <= 120),
  -- What a shop is actually buying, in their words. Optional: a product can be self-evident.
  description text CHECK (description IS NULL OR length(description) <= 2000),
  units_per_pack integer NOT NULL CHECK (units_per_pack > 0),
  active_price_pence integer CHECK (active_price_pence IS NULL OR active_price_pence BETWEEN 1 AND 10000000),
  active boolean NOT NULL DEFAULT true,
  /*
   * The object-storage KEY only — never a URL, never a credential. Delivery is signed at read time
   * by the existing image pipeline, so a stored value can never become a public link by accident.
   */
  image_key text CHECK (image_key IS NULL OR length(image_key) <= 512),
  image_content_type text CHECK (image_content_type IS NULL OR image_content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  image_updated_at timestamptz,
  sort_order integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- An image is a key AND a type together, or neither. A half-set image renders as a broken box.
  CHECK ((image_key IS NULL AND image_content_type IS NULL) OR (image_key IS NOT NULL AND image_content_type IS NOT NULL))
);

/*
 * The three products MintVault sells today, seeded as STARTING VALUES.
 *
 * £75 for a 50-slab box is preserved from the recovered build, but as a seeded number an
 * administrator may change — not as the immutable rule it used to be. The other two are catalogued
 * with no price, which correctly makes them visible to MintVault and unbuyable until priced.
 */
INSERT INTO partner_supply_products (code, display_name, description, units_per_pack, active_price_pence, active, sort_order)
VALUES
  ('plastic_mintvault_slab_box', 'Plastic MintVault slabs', 'Tamper-evident graded card slabs. One box holds 50.', 50, 7500, true, 10),
  ('holographic_printing_paper', 'Holographic printing paper', 'Holographic label stock for printed certificate labels.', 60, NULL, true, 20),
  ('nfc_tags', 'NFC tags', 'Programmable NFC tags for slab verification.', 1000, NULL, true, 30)
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
  -- (id, tenant_id) is the order this lineage indexes — the same target 0104 uses.
  FOREIGN KEY (location_id, tenant_id) REFERENCES partner_locations(id, tenant_id) ON DELETE RESTRICT,
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
