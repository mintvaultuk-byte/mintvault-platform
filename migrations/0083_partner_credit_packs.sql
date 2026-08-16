-- P5 — BUY MORE GRADING CREDITS: the pack catalogue.
--
-- NUMBER SAFETY: 0083 follows 0078-0082 from this pass, all above the global high-water mark of 0077
-- discovered across every ref in the repository. The runner rejects duplicate numbers.
--
-- ============================================================================================
-- PRICING IS DELIBERATELY NOT DECIDED HERE
-- ============================================================================================
-- `stripe_price_id` is NULLABLE and every seeded pack starts NULL. A pack with no price id CANNOT be
-- purchased — the checkout path refuses it — so the entire architecture (catalogue, permissions,
-- checkout, webhook-authoritative grant, replay safety) is complete and testable while the £ amounts
-- remain an owner decision. Setting prices later is a DATA change: create the Stripe Prices, write
-- their ids into these rows. No migration, no deploy, no code change.
--
-- That is also why packs are rows rather than a hard-coded array: adding a 250 pack after the pilot
-- is an INSERT, not a release.
--
-- ============================================================================================
-- WHY THE GRANT PATH NEEDS NO NEW LEDGER MACHINERY
-- ============================================================================================
-- The credit ledger already permits `entry_type='purchase'` and `source='stripe'` (migration 0016's
-- CHECK constraints) — nothing had ever written such a row. Granting therefore reuses the existing
-- boundary `appendFoundationCredit()` with source='stripe' and idempotency_key = the Stripe EVENT
-- id, which the pre-existing `uq_partner_credit_ledger_idem (source, idempotency_key)` turns into an
-- exactly-once guarantee at the database level.
--
-- Combined with the pre-existing `stripe_webhook_events` claim table, a replayed or concurrently
-- delivered event is stopped TWICE, by two independent mechanisms:
--   1. INSERT ... ON CONFLICT DO NOTHING on stripe_webhook_events (claim), and
--   2. the ledger's unique index (grant).
-- Neither is a new invention here; this migration only supplies the catalogue they price against.
--
-- MIXED-VERSION SAFETY (I17): purely additive — one new table plus seed rows. An OLD application
-- version does not know it exists. Safe to apply before the deploy.
--
-- ROLLBACK / DOWN-PATH: `DROP TABLE IF EXISTS partner_credit_packs;`. Safe while no checkout has been
-- taken; afterwards forward-fix only, because ledger rows reference pack codes in their metadata.

CREATE TABLE IF NOT EXISTS partner_credit_packs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stable business identifier used in checkout requests and ledger metadata. Never a raw integer,
  -- so a pack's credit count can never be mistaken for its identity.
  code text NOT NULL UNIQUE,
  credits integer NOT NULL CHECK (credits > 0 AND credits <= 10000),
  /*
   * NULL until the owner creates the Stripe Price and records its id. A NULL price id means
   * "catalogued but not purchasable", which is exactly the pilot state: the pack list is real, the
   * flow is real, and no money can move until pricing is deliberately configured.
   */
  stripe_price_id text,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- One Stripe Price backs at most one pack, so a webhook can never map an amount to two packs.
  CONSTRAINT uq_partner_credit_packs_price UNIQUE (stripe_price_id)
);

CREATE INDEX IF NOT EXISTS idx_partner_credit_packs_active
  ON partner_credit_packs (active, sort_order) WHERE active;

-- The five pilot packs. Idempotent: re-applying does not resurrect a pack the owner deactivated, and
-- does not overwrite a stripe_price_id that has since been configured.
INSERT INTO partner_credit_packs (code, credits, sort_order)
VALUES ('PACK_5', 5, 1), ('PACK_10', 10, 2), ('PACK_25', 25, 3), ('PACK_50', 50, 4), ('PACK_100', 100, 5)
ON CONFLICT (code) DO NOTHING;

-- The catalogue is global reference data, not tenant-owned: every partner sees the same packs, so
-- there is no tenant_id and correctly no RLS policy. It is therefore outside the tenant-isolation
-- sweep in partner-rls-isolation.test.ts, which asserts RLS only for partner_% tables HAVING a
-- tenant_id column. Read-only to the runtime — a partner may list packs, never edit them.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_runtime') THEN
    GRANT SELECT ON public.partner_credit_packs TO partner_runtime;
  END IF;
END$$;

-- ---------------------------------------------------------------------------------------------
-- Purchase permission
-- ---------------------------------------------------------------------------------------------
-- Only `partner.credits.view` existed; there was no way to express "may spend money". Seeded into
-- the same RBAC catalogue 0034 established, so the existing permission machinery carries it.
--
-- OWNER gets it. MANAGER deliberately does NOT by default — billing authority is granted, never
-- assumed (plan OD-5 default). GRADER never.
DO $$
BEGIN
  IF to_regclass('public.partner_permissions') IS NOT NULL THEN
    INSERT INTO partner_permissions (code, label)
    VALUES ('partner.credits.purchase', 'Buy Grading Credit packs for this organisation')
    ON CONFLICT (code) DO NOTHING;

    IF to_regclass('public.partner_role_permissions') IS NOT NULL
       AND to_regclass('public.partner_roles') IS NOT NULL THEN
      INSERT INTO partner_role_permissions (role_id, permission_id)
      SELECT r.id, p.id
        FROM partner_roles r
        JOIN partner_permissions p ON p.code = 'partner.credits.purchase'
       WHERE r.code = 'PARTNER_OWNER'
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;
END$$;
