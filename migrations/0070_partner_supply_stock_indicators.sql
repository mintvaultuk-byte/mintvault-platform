-- 0070 — Partner supply operations indicators.
--
-- This deliberately records only a shop's current counted units. It does not invent a
-- consumption formula, decrement stock on grading, or create a warehouse/ERP subsystem.
-- Ordered units and completed-card indicators remain derived from their authoritative ledgers.

DO $$
BEGIN
  IF to_regclass('public.partner_supply_products') IS NULL
     OR to_regclass('public.partner_locations') IS NULL
     OR to_regclass('public.partner_grading_work_items') IS NULL THEN
    RAISE EXCEPTION '0070 requires supply catalogue, Partner locations and grading work items.';
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS partner_supply_stock_counts (
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL,
  product_code text NOT NULL REFERENCES partner_supply_products(code) ON DELETE RESTRICT,
  known_units integer NOT NULL CHECK (known_units >= 0),
  counted_by_user_id uuid REFERENCES partner_users(id) ON DELETE SET NULL,
  counted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, location_id, product_code),
  FOREIGN KEY (tenant_id, location_id) REFERENCES partner_locations(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_partner_supply_stock_counts_tenant_location
  ON partner_supply_stock_counts(tenant_id, location_id, counted_at DESC);

ALTER TABLE partner_supply_stock_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_supply_stock_counts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS partner_supply_stock_counts_tenant_location_isolation ON partner_supply_stock_counts;
CREATE POLICY partner_supply_stock_counts_tenant_location_isolation ON partner_supply_stock_counts
  USING (
    tenant_id = partner_current_tenant()
    AND location_id = NULLIF(current_setting('app.location_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = partner_current_tenant()
    AND location_id = NULLIF(current_setting('app.location_id', true), '')::uuid
  );

REVOKE ALL PRIVILEGES ON partner_supply_stock_counts FROM partner_runtime;
GRANT SELECT ON partner_supply_stock_counts TO partner_runtime;
-- The restricted runtime can only upsert a current count at its bound shop. It cannot rewrite
-- the tenant, shop, product identity or delete a historical count.
GRANT INSERT (tenant_id, location_id, product_code, known_units, counted_by_user_id, counted_at)
  ON partner_supply_stock_counts TO partner_runtime;
GRANT UPDATE (known_units, counted_by_user_id, counted_at)
  ON partner_supply_stock_counts TO partner_runtime;

DO $$
BEGIN
  IF to_regclass('public.partner_supply_stock_counts') IS NULL THEN
    RAISE EXCEPTION '0070 incomplete: partner_supply_stock_counts is missing.';
  END IF;
  IF has_table_privilege('partner_runtime', 'public.partner_supply_stock_counts', 'DELETE')
     OR has_column_privilege('partner_runtime', 'public.partner_supply_stock_counts', 'tenant_id', 'UPDATE')
     OR has_column_privilege('partner_runtime', 'public.partner_supply_stock_counts', 'location_id', 'UPDATE')
     OR has_column_privilege('partner_runtime', 'public.partner_supply_stock_counts', 'product_code', 'UPDATE') THEN
    RAISE EXCEPTION '0070 privilege assertion failed: partner_runtime can rewrite supply stock identity.';
  END IF;
END$$;
