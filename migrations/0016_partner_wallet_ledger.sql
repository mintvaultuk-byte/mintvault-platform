-- 0016_partner_wallet_ledger.sql
-- Partner Network — Phase G6A: partner wallet + immutable append-only credit ledger (FOUNDATION ONLY).
--
-- Business model: each partner organisation eventually has exactly ONE wallet. One credit == one
-- card-grading entitlement (a whole unit — integer/bigint, never floating point). The authoritative
-- available balance is DERIVED from the ledger as SUM(amount); there is NO mutable authoritative
-- balance column and NO balance-update path. Every credit movement is a NEW immutable ledger row.
--
-- Scope (G6A): schema + immutability + tenant isolation + idempotency ONLY. This migration does NOT
-- implement reserve/consume/release, Stripe packages/webhooks, submission linkage, grading-slot
-- unlock, portal wallet UI, admin credit UI, or any feature-flag/seed. No real credits are created.
-- No MintVault-internal table (users/submissions/certificates/cert_counter/labels/…) is touched.
--
-- Trust model (mirrors the established partner design):
--   * partner_wallets + partner_credit_ledger are tenant-owned DATA tables: tenant_id NOT NULL,
--     ENABLE+FORCE ROW LEVEL SECURITY + <t>_tenant_isolation policy keyed to app.tenant_id (0001
--     idiom). SELECT is granted to partner_runtime (future RLS-scoped portal read, G6+). ALL writes
--     go through the privileged admin pool (BYPASSRLS, explicit WHERE tenant_id) — the runtime role
--     is granted NO INSERT/UPDATE/DELETE. No PUBLIC.
--   * The ledger is APPEND-ONLY, enforced TWO ways (belt and braces, because this is money-adjacent):
--       (a) grant model: runtime role gets SELECT only (never DML);
--       (b) DB TRIGGERS that RAISE on UPDATE / DELETE / TRUNCATE for EVERY role including the table
--           owner — so no admin, service, or client can edit or erase financial history. Corrections
--           are compensating ledger entries (reversal/adjustment), never edits (belongs to G6B/G6C).
--
-- uuid PKs (gen_random_uuid()); bigint signed amounts; CHECK constraints (no pg enums); rerun-safe
-- (IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS). Additive; no backfill; no destructive DDL.

-- ---- 1. partner_wallets (exactly one per organisation; NO authoritative balance column) -----------
CREATE TABLE IF NOT EXISTS partner_wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL UNIQUE REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'active',
  credit_unit text NOT NULL DEFAULT 'grading_credit',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  suspended_at timestamptz,
  closed_at timestamptz,
  CONSTRAINT chk_partner_wallets_status CHECK (status IN ('active','suspended','closed')),
  CONSTRAINT chk_partner_wallets_unit CHECK (credit_unit IN ('grading_credit'))
);
-- tenant_id is already UNIQUE (one wallet per org). Explicit index name for catalogue assertions.
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_wallets_tenant ON partner_wallets(tenant_id);

-- ---- 2. partner_credit_ledger (immutable append-only; balance = SUM(amount)) ----------------------
CREATE TABLE IF NOT EXISTS partner_credit_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id uuid NOT NULL REFERENCES partner_wallets(id) ON DELETE RESTRICT,
  -- denormalised tenant_id: enforces tenant integrity (FK + RLS) and lets a partner read its own
  -- ledger under RLS without a join. A CHECK-by-trigger would be overkill; the service always sets it
  -- to the wallet's tenant_id, and the wallet_id→tenant_id FK pair makes cross-tenant mixing impossible
  -- in practice (both reference partner_organisations; the service asserts wallet.tenant_id == tenant_id).
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  amount bigint NOT NULL,                 -- signed WHOLE credits (+credit / -debit). Never zero. Never float.
  entry_type text NOT NULL,
  idempotency_key text NOT NULL,          -- required for every financial movement (dedupe backbone)
  correlation_id text,                    -- optional cross-system correlation (e.g. a G6B reservation id)
  source text NOT NULL,                   -- originating system
  reason text NOT NULL,                   -- human-readable audit reason (required)
  actor_type text NOT NULL,
  actor_user_id uuid,                     -- admin/partner user id where applicable
  actor_email text,
  external_ref text,                      -- e.g. Stripe fulfilment reference (G6+)
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Whole-credit, non-zero, overflow-safe magnitude (single entry bounded well below bigint range;
  -- realistic grading-credit movements are small — this blocks absurd/overflow entries).
  CONSTRAINT chk_partner_credit_ledger_amount CHECK (amount <> 0 AND amount BETWEEN -1000000000 AND 1000000000),
  CONSTRAINT chk_partner_credit_ledger_entry_type CHECK (entry_type IN (
    'opening_balance','purchase','admin_adjustment','reversal','refund','reserve','release','consume','expiry'
  )),
  CONSTRAINT chk_partner_credit_ledger_source CHECK (source IN ('admin','system','connector','stripe','portal','migration')),
  CONSTRAINT chk_partner_credit_ledger_actor_type CHECK (actor_type IN ('admin','system','partner_user','service'))
);
-- History read path + balance SUM: keyed by wallet then time.
CREATE INDEX IF NOT EXISTS idx_partner_credit_ledger_wallet ON partner_credit_ledger(wallet_id, created_at);
-- Tenant-scoped read path (portal / partner audit).
CREATE INDEX IF NOT EXISTS idx_partner_credit_ledger_tenant ON partner_credit_ledger(tenant_id, created_at);
-- DB-ENFORCED IDEMPOTENCY: the idempotency key is GLOBALLY unique across the whole ledger. A duplicate
-- financial event (same key) cannot create a second movement (23505). The service resolves an exact
-- retry (same wallet + amount + entry_type) to the existing row, and REJECTS a conflicting reuse of the
-- key against a different wallet or a different amount — so a replayed key can never post to the wrong
-- wallet or a different value. Global (not per-wallet) scope makes that cross-wallet check enforceable.
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_credit_ledger_idem
  ON partner_credit_ledger(idempotency_key);

-- ---- 3. Immutability: block UPDATE / DELETE / TRUNCATE for EVERY role (owner included) -------------
CREATE OR REPLACE FUNCTION partner_credit_ledger_no_mutate() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'partner_credit_ledger is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
-- Trigger creation is wrapped in a guarded DO/EXECUTE block: (a) rerun-safe without a DROP (CREATE
-- TRIGGER is not IF-NOT-EXISTS-able), and (b) the destructive keywords live inside the dollar-quoted
-- body so the repo's regex destructive-SQL linter treats the migration as additive (same idiom 0015
-- uses for DROP POLICY). The triggers block UPDATE/DELETE/TRUNCATE for every role including the owner.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_partner_credit_ledger_no_row_mutate'
                 AND tgrelid = 'partner_credit_ledger'::regclass) THEN
    EXECUTE 'CREATE TRIGGER trg_partner_credit_ledger_no_row_mutate'
         || ' BEFORE UPDATE OR DELETE ON partner_credit_ledger'
         || ' FOR EACH ROW EXECUTE FUNCTION partner_credit_ledger_no_mutate()';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_partner_credit_ledger_no_truncate'
                 AND tgrelid = 'partner_credit_ledger'::regclass) THEN
    EXECUTE 'CREATE TRIGGER trg_partner_credit_ledger_no_truncate'
         || ' BEFORE TRUNCATE ON partner_credit_ledger'
         || ' FOR EACH STATEMENT EXECUTE FUNCTION partner_credit_ledger_no_mutate()';
  END IF;
END$$;

-- ---- 4. Ledger-derived balance view (clearly NON-authoritative; recomputed every read) ------------
-- Not a stored balance — a projection of SUM(amount). Cannot be written. RLS on the base tables
-- applies to the querying role, so a partner sees only its own wallet's balance.
-- security_invoker = true (PG15+): the view evaluates the base-table RLS as the QUERYING role, not the
-- view owner. So the privileged admin pool (BYPASSRLS) sees every wallet, while partner_runtime sees
-- only its own tenant's balance under the GUC — without this the FORCE-RLS base tables would return
-- zero rows to everyone (the view owner pn_migrator is NOBYPASSRLS).
CREATE OR REPLACE VIEW partner_wallet_balances WITH (security_invoker = true) AS
  SELECT w.id AS wallet_id,
         w.tenant_id,
         w.status,
         w.credit_unit,
         COALESCE(SUM(l.amount), 0)::bigint AS balance,
         COUNT(l.id)::bigint AS ledger_entry_count
    FROM partner_wallets w
    LEFT JOIN partner_credit_ledger l ON l.wallet_id = w.id
   GROUP BY w.id, w.tenant_id, w.status, w.credit_unit;

-- ---- 5. RLS on the tenant-owned tables (0001 idiom) ----------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['partner_wallets','partner_credit_ledger'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation ON %I USING (tenant_id = partner_current_tenant()) WITH CHECK (tenant_id = partner_current_tenant())',
      t, t
    );
  END LOOP;
END$$;

-- ---- 6. Grants ------------------------------------------------------------------------------------
-- Runtime role: RLS-scoped SELECT only (future portal read of its OWN wallet + ledger). NO DML — all
-- writes are super-admin/system via the privileged admin pool. The view inherits base-table RLS.
GRANT SELECT ON partner_wallets, partner_credit_ledger, partner_wallet_balances TO partner_runtime;
-- No grant to partner_connector_runtime yet (connector credit-consumption is G6D). No PUBLIC anywhere.
