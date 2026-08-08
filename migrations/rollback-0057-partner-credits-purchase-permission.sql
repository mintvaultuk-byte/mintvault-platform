-- ROLLBACK 0057 — remove partner.credits.purchase
--
-- Reverts exactly what 0057 seeded: the role→permission mappings and then the permission row.
-- Order matters — partner_role_permissions references partner_permissions, so the mappings go
-- first or the delete is blocked by the FK.
--
-- OWNED STATE ONLY. This file touches nothing that 0034 seeded. It deletes the mappings for
-- 'partner.credits.purchase' whatever role holds them (so a leaked grant is also cleaned up), and
-- then the single permission row. No role row is ever removed — 0034 owns those.
--
-- The numbered runner never executes rollback files (it matches ^\d{4,}_.+\.sql$), so this is run
-- by an operator with `psql -v ON_ERROR_STOP=1 -f`, and must carry its own transaction and its own
-- lock bound.
--
-- DESCENDING-ORDER GUARD: deliberately omitted, matching 0050/0051/0052/0054/0055/0056. This file
-- drops nothing structural — no table, no column, no policy — so no later migration can be
-- structurally invalidated by running it. A later migration that DEPENDS on this permission would
-- be a data dependency, and the application's own capability check fails closed on a missing
-- permission (the route 403s), which is the safe direction.

BEGIN;

-- MUST be the first statement inside this transaction: it must be in force before the first lock.
-- partner_role_permissions is read on the authentication path when a partner session resolves its
-- permission set, so an unbounded wait here would queue partner logins behind this delete.
SET LOCAL lock_timeout = '2s';

-- ---- 1. Mappings first (FK child), for ANY role, so a leaked grant is cleaned up too ----------
DELETE FROM partner_role_permissions rp
 USING partner_permissions p
 WHERE p.id = rp.permission_id
   AND p.code = 'partner.credits.purchase';

-- ---- 2. Then the permission row itself --------------------------------------------------------
DELETE FROM partner_permissions WHERE code = 'partner.credits.purchase';

-- ---- 3. Prove the restoration before committing -----------------------------------------------
DO $$
DECLARE
  perm_rows int;
  map_rows  int;
BEGIN
  SELECT count(*) INTO perm_rows FROM partner_permissions WHERE code = 'partner.credits.purchase';
  SELECT count(*) INTO map_rows
    FROM partner_role_permissions rp
    JOIN partner_permissions p ON p.id = rp.permission_id
   WHERE p.code = 'partner.credits.purchase';

  IF perm_rows <> 0 OR map_rows <> 0 THEN
    RAISE EXCEPTION
      'rollback-0057 incomplete: % permission row(s) and % mapping row(s) remain.', perm_rows, map_rows;
  END IF;
END$$;

-- ---- 4. De-journal, so the runner re-applies 0057 instead of skipping it as applied -----------
-- Reach the journal only through EXECUTE: PL/pgSQL plans a whole expression up front, so a direct
-- reference inside an IF does not short-circuit and raises 42P01 on a database with no journal
-- table. The filename below is DATA, not a comment — a rename-by-grep would miss it.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE $q$DELETE FROM schema_migrations
                WHERE filename = '0057_partner_credits_purchase_permission.sql'$q$;
  END IF;
END$$;

COMMIT;
