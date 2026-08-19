-- 0098 — Scanner Operator credit-view authority for zero-credit lockout UX.
--
-- SCANNER_OPERATOR still cannot buy credits, grade cards, enrol stations, manage users or invalidate
-- evidence. It must, however, be able to read the shop's authoritative available balance and the
-- server pack catalogue, otherwise the Scanner cannot automatically present the zero-credit top-up
-- lock when a least-privilege shop-floor operator signs in.
--
-- Additive RBAC grant only. Existing roles/permissions are not removed.

DO $$
DECLARE
  v_count integer;
BEGIN
  IF to_regclass('public.partner_roles') IS NULL
     OR to_regclass('public.partner_permissions') IS NULL
     OR to_regclass('public.partner_role_permissions') IS NULL THEN
    RAISE EXCEPTION '0098 requires the RBAC catalogue from 0034 and SCANNER_OPERATOR from 0085';
  END IF;

  INSERT INTO partner_role_permissions (role_id, permission_id)
  SELECT r.id, p.id
    FROM partner_roles r
    JOIN partner_permissions p ON p.code = 'partner.credits.view'
   WHERE r.code = 'SCANNER_OPERATOR'
  ON CONFLICT DO NOTHING;

  SELECT count(*) INTO v_count
    FROM partner_role_permissions rp
    JOIN partner_roles r ON r.id = rp.role_id
    JOIN partner_permissions p ON p.id = rp.permission_id
   WHERE r.code = 'SCANNER_OPERATOR'
     AND p.code = 'partner.credits.view';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SCANNER_OPERATOR must hold partner.credits.view exactly once, found %', v_count;
  END IF;

  SELECT count(*) INTO v_count
    FROM partner_role_permissions rp
    JOIN partner_roles r ON r.id = rp.role_id
    JOIN partner_permissions p ON p.id = rp.permission_id
   WHERE r.code = 'SCANNER_OPERATOR'
     AND p.code IN ('partner.cards.assess', 'partner.credits.purchase',
                    'partner.users.manage', 'partner.users.view', 'partner.sessions.revoke',
                    'partner.stations.enrol', 'partner.cards.fix');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'SCANNER_OPERATOR holds a forbidden non-view permission (% found)', v_count;
  END IF;
END$$;
