-- ============================================================================================
-- 0085 — SCANNER_OPERATOR ROLE (AG-2)
--
-- THE GAP. `partner.cards.scan` is held by exactly three roles: PARTNER_OWNER, PARTNER_MANAGER and
-- MVGS_ASSESSMENT_TECHNICIAN. It is required both to OPERATE an approved station and, today, to
-- enrol a new one and to remove an image from grading. PARTNER_RECEPTION — the natural shop-floor
-- role — deliberately lacks it. So the only way to let somebody run the scanner has been to also
-- give them grading authority, station enrolment and the power to invalidate evidence.
--
-- That is the opposite of least privilege for the single most numerous role a real shop will have.
--
-- WHY TWO NEW PERMISSIONS AND NOT JUST A ROLE. A role that merely holds `partner.cards.scan` would
-- inherit enrolment and invalidation along with it, because those routes are gated on that same
-- permission. The capability has to be split before a least-privilege role is expressible at all:
--
--   partner.stations.enrol  request enrolment of a NEW Mac / list enrolment locations
--   partner.cards.fix       take an image OUT of grading (the dashboard "remove image" decision)
--
-- NO EXISTING ROLE CHANGES. Both new permissions are granted to precisely the three roles that hold
-- `partner.cards.scan` today, so OWNER, MANAGER and GRADER can do exactly what they could do
-- before this migration — the same set, expressed more precisely. Nothing is revoked from anybody.
--
-- WHAT SCANNER_OPERATOR GETS, AND WHY EACH ONE:
--   partner.location.view   the Scanner shows which shop floor it is operating under
--   partner.cards.view      the minimum operational Card Job information (the FIX queue)
--   partner.cards.scan      operate an APPROVED station: NEW capture and FIX capture
-- and nothing else. No grading, no credits (view or purchase), no staff, no station enrolment or
-- approval, no QA, no orders, no session revocation.
--
-- ADDITIVE. 0034 remains untouched (never edit an applied migration). This inserts one role, two
-- permissions and their grants, all ON CONFLICT DO NOTHING, so re-running is a no-op and an older
-- app version continues to run against the widened catalogue — it simply never asks for the new
-- permissions (invariant I17).
--
-- ROLLBACK: rollback-0085-partner-scanner-operator-role.sql. It refuses while any user still holds
-- the role, because deleting the role would silently strip that person's access.
-- ============================================================================================

DO $$
BEGIN
  IF to_regclass('public.partner_roles') IS NULL
     OR to_regclass('public.partner_permissions') IS NULL
     OR to_regclass('public.partner_role_permissions') IS NULL THEN
    RAISE EXCEPTION '0085 requires the RBAC catalogue from 0034';
  END IF;
END$$;

-- ---------------------------------------------------------------------------------------------
-- PART 1 — the two capabilities that had to be split out of partner.cards.scan
-- ---------------------------------------------------------------------------------------------
INSERT INTO partner_permissions (code, label) VALUES
  ('partner.stations.enrol', 'Request enrolment of a new grading station'),
  ('partner.cards.fix', 'Remove a card image from grading so it can be re-scanned')
ON CONFLICT (code) DO NOTHING;

-- Granted to EXACTLY the roles that hold partner.cards.scan today, so no existing role loses or
-- gains any real-world ability. This is a re-expression, not a change.
INSERT INTO partner_role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM partner_roles r
  JOIN partner_permissions p ON p.code IN ('partner.stations.enrol', 'partner.cards.fix')
 WHERE r.code IN ('PARTNER_OWNER', 'PARTNER_MANAGER', 'MVGS_ASSESSMENT_TECHNICIAN')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------------------------
-- PART 2 — the least-privilege shop-floor role
-- ---------------------------------------------------------------------------------------------
INSERT INTO partner_roles (code, label) VALUES
  ('SCANNER_OPERATOR', 'Scanner Operator')
ON CONFLICT (code) DO NOTHING;

INSERT INTO partner_role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM partner_roles r
  JOIN partner_permissions p
    ON p.code IN ('partner.location.view', 'partner.cards.view', 'partner.cards.scan')
 WHERE r.code = 'SCANNER_OPERATOR'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------------------------
-- PART 3 — fail-closed assertions, in the same transaction
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM partner_roles WHERE code = 'SCANNER_OPERATOR';
  IF v_count <> 1 THEN RAISE EXCEPTION '0085 did not seed the SCANNER_OPERATOR role'; END IF;

  SELECT count(*) INTO v_count
    FROM partner_role_permissions rp
    JOIN partner_roles r ON r.id = rp.role_id
    JOIN partner_permissions p ON p.id = rp.permission_id
   WHERE r.code = 'SCANNER_OPERATOR';
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'SCANNER_OPERATOR must hold exactly 3 permissions, found %', v_count;
  END IF;

  -- The role must NOT be able to grade, buy credits, manage staff or enrol stations. Asserted
  -- explicitly rather than inferred from the count above, because a future edit could swap one
  -- permission for another and keep the total at three.
  SELECT count(*) INTO v_count
    FROM partner_role_permissions rp
    JOIN partner_roles r ON r.id = rp.role_id
    JOIN partner_permissions p ON p.id = rp.permission_id
   WHERE r.code = 'SCANNER_OPERATOR'
     AND p.code IN ('partner.cards.assess', 'partner.credits.purchase', 'partner.credits.view',
                    'partner.users.manage', 'partner.users.view', 'partner.sessions.revoke',
                    'partner.stations.enrol', 'partner.cards.fix');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'SCANNER_OPERATOR holds a forbidden permission (% found)', v_count;
  END IF;

  -- And the three incumbent roles must still hold the split-out capabilities.
  SELECT count(*) INTO v_count
    FROM partner_role_permissions rp
    JOIN partner_roles r ON r.id = rp.role_id
    JOIN partner_permissions p ON p.id = rp.permission_id
   WHERE r.code IN ('PARTNER_OWNER', 'PARTNER_MANAGER', 'MVGS_ASSESSMENT_TECHNICIAN')
     AND p.code IN ('partner.stations.enrol', 'partner.cards.fix');
  IF v_count <> 6 THEN
    RAISE EXCEPTION 'the split-out capabilities were not granted to all three incumbent roles (% of 6)', v_count;
  END IF;
END$$;
