-- 0057 — partner.credits.purchase
--
-- Adds ONE permission: the authority to spend a shop's money on grading credits through Stripe.
--
-- WHY A SEPARATE PERMISSION, AND NOT partner.credits.view
-- ------------------------------------------------------
-- Viewing a balance and spending £1,000 are different authorities. partner.credits.view is held by
-- PARTNER_FINANCE_VIEWER, a role whose entire purpose is read-only financial oversight (0034 grants
-- it exactly four view permissions and no write anywhere). Gating checkout on credits.view would
-- silently hand that role a payment button. So purchase is its own permission, granted to the two
-- roles that already carry commercial authority for the shop:
--
--   PARTNER_OWNER    — holds every permission by definition.
--   PARTNER_MANAGER  — already holds users.manage and the full orders.* lifecycle.
--
-- Deliberately NOT granted: PARTNER_FINANCE_VIEWER (read-only by design),
-- MVGS_ASSESSMENT_TECHNICIAN and PARTNER_RECEPTION (operational, not commercial), PARTNER_TRAINEE
-- (view-only, no live processing).
--
-- WHY A NEW FILE AND NOT AN EDIT TO 0034
-- --------------------------------------
-- 0034 is already applied on staging. Editing it would change its checksum and the runner refuses
-- to proceed on a migration edited after being applied ("Checksum mismatch ... Refusing to
-- proceed."). The catalogue is therefore extended additively, exactly as 0034 itself is written:
-- temp tables, natural-key joins, ON CONFLICT DO NOTHING, and a completeness assertion that rolls
-- the whole file back rather than leaving a half-seeded security catalogue behind.
--
-- Idempotent and re-appliable: every INSERT is ON CONFLICT DO NOTHING and the temp tables are
-- ON COMMIT DROP.
--
-- Numbering: 0056 is the highest applied-or-pending number; 0045 is permanently unused and 0046
-- belongs to the partner MFA repair branch already journalled on staging, so 0057 is the next free
-- number (see docs/migration-ownership-partner-0049.md).
--
-- ROLLBACK: migrations/rollback-0057-partner-credits-purchase-permission.sql

-- ---------------------------------------------------------------------------------------------
-- Pre-flight. 0001 creates the three RBAC tables and 0034 seeds them; without both, seeding a
-- single permission into an empty catalogue would produce a role-less, unusable grant.
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.partner_permissions') IS NULL
     OR to_regclass('public.partner_roles') IS NULL
     OR to_regclass('public.partner_role_permissions') IS NULL THEN
    RAISE EXCEPTION
      '0057 refuses to run: the partner RBAC tables do not exist. Apply 0001_partner_foundation first.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM partner_roles WHERE code = 'PARTNER_OWNER')
     OR NOT EXISTS (SELECT 1 FROM partner_roles WHERE code = 'PARTNER_MANAGER') THEN
    RAISE EXCEPTION
      '0057 refuses to run: PARTNER_OWNER/PARTNER_MANAGER are not seeded. Apply 0034_partner_rbac_seed first.';
  END IF;
END$$;

-- ---------------------------------------------------------------------------------------------
-- The addition, expressed exactly as 0034 expresses the catalogue.
-- ---------------------------------------------------------------------------------------------
CREATE TEMP TABLE _rbac_perms_0057 (code text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO _rbac_perms_0057 (code) VALUES
  ('partner.credits.purchase');

CREATE TEMP TABLE _rbac_map_0057 (role_code text, permission_code text) ON COMMIT DROP;
INSERT INTO _rbac_map_0057 (role_code, permission_code) VALUES
  ('PARTNER_OWNER',   'partner.credits.purchase'),
  ('PARTNER_MANAGER', 'partner.credits.purchase');

-- label = code, matching 0034's convention so partner-rbac-parity's label assertion holds.
INSERT INTO partner_permissions (code, label)
SELECT code, code FROM _rbac_perms_0057 ORDER BY code
ON CONFLICT (code) DO NOTHING;

-- Joined by natural key so this can never depend on generated uuids.
INSERT INTO partner_role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM _rbac_map_0057 m
  JOIN partner_roles r ON r.code = m.role_code
  JOIN partner_permissions p ON p.code = m.permission_code
 ORDER BY m.role_code, m.permission_code
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------------------------
-- Completeness assertion + negative assertion.
--
-- The negative half is the security-bearing one: it proves the permission did NOT leak to a role
-- that must not spend money. A seed that quietly granted PARTNER_FINANCE_VIEWER would otherwise be
-- journalled as applied and nothing downstream would notice.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  missing_perms int;
  missing_maps  int;
  leaked        text;
BEGIN
  SELECT count(*) INTO missing_perms
    FROM _rbac_perms_0057 c
   WHERE NOT EXISTS (SELECT 1 FROM partner_permissions p WHERE p.code = c.code AND p.label = c.code);

  SELECT count(*) INTO missing_maps
    FROM _rbac_map_0057 m
   WHERE NOT EXISTS (
     SELECT 1 FROM partner_role_permissions rp
       JOIN partner_roles r ON r.id = rp.role_id
       JOIN partner_permissions p ON p.id = rp.permission_id
      WHERE r.code = m.role_code AND p.code = m.permission_code);

  IF missing_perms > 0 OR missing_maps > 0 THEN
    RAISE EXCEPTION
      '0057 incomplete: % permission row(s) and % role-mapping row(s) missing after seed.',
      missing_perms, missing_maps;
  END IF;

  SELECT string_agg(r.code, ', ' ORDER BY r.code) INTO leaked
    FROM partner_role_permissions rp
    JOIN partner_roles r ON r.id = rp.role_id
    JOIN partner_permissions p ON p.id = rp.permission_id
   WHERE p.code = 'partner.credits.purchase'
     AND r.code NOT IN ('PARTNER_OWNER', 'PARTNER_MANAGER');

  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION
      '0057 refuses to complete: partner.credits.purchase is granted to role(s) that must not spend money: %',
      leaked;
  END IF;
END$$;
