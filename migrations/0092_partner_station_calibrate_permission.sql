-- 0092 — moving the capture area becomes a MAINTENANCE authority, not a shop-floor one.
--
-- WHY. The capture window is fixed in a proven physical position on the scanner bed. Normal shop
-- work is: place the card inside it, Preview, Scan. Nobody on the shop floor needs to move it, and
-- somebody moving it by accident is expensive in a way that is not obvious at the time — every card
-- captured afterwards is framed differently from every card captured before, and a certificate whose
-- FRONT and BACK straddle the change is not one piece of evidence at all.
--
-- Until now `POST /stations/calibrations` was gated on `partner.cards.scan`: the same capability a
-- Scanner Operator needs to do their ordinary job. So the least-privileged role in the system could
-- silently repoint the station's physical acquisition rectangle.
--
-- WHAT THIS CHANGES. One new capability, granted to exactly the three roles that already hold
-- `partner.stations.enrol` — the roles that could already bring a whole new Mac into service, for
-- whom recalibrating an existing one is strictly less consequential. Nobody who could not already
-- perform station MANAGEMENT gains anything, and SCANNER_OPERATOR loses an ability it should never
-- have had.
--
-- ADDITIVE. No permission is dropped, no role is removed, no existing grant is revoked. The only
-- behavioural change is at the route, which now demands this capability instead of `cards.scan`.
--
-- DELIBERATELY NOT GRANTED TO SCANNER_OPERATOR. That role is pinned at exactly three permissions by
-- 0085's own assertion, and this migration must leave that count untouched — the check below proves
-- it rather than trusting it.

DO $$
BEGIN
  IF to_regclass('public.partner_roles') IS NULL
     OR to_regclass('public.partner_permissions') IS NULL
     OR to_regclass('public.partner_role_permissions') IS NULL THEN
    RAISE NOTICE '0092: partner RBAC tables absent, skipping';
    RETURN;
  END IF;

  INSERT INTO partner_permissions (code, label) VALUES
    ('partner.stations.calibrate', 'Move a grading station''s physical capture area')
  ON CONFLICT (code) DO NOTHING;

  -- The same three roles that hold partner.stations.enrol. Station management, not station operation.
  INSERT INTO partner_role_permissions (role_id, permission_id)
  SELECT r.id, p.id
    FROM partner_roles r
    JOIN partner_permissions p ON p.code = 'partner.stations.calibrate'
   WHERE r.code IN ('PARTNER_OWNER', 'PARTNER_MANAGER', 'MVGS_ASSESSMENT_TECHNICIAN')
  ON CONFLICT DO NOTHING;

  -- 0085 pins SCANNER_OPERATOR at exactly three permissions and raises if that changes. Prove the
  -- same thing here, so a future edit that grants this capability shop-floor-wide fails loudly at
  -- migration time instead of quietly widening who can move a scanner's capture area.
  IF EXISTS (
    SELECT 1
      FROM partner_role_permissions rp
      JOIN partner_roles r ON r.id = rp.role_id
      JOIN partner_permissions p ON p.id = rp.permission_id
     WHERE r.code = 'SCANNER_OPERATOR'
       AND p.code = 'partner.stations.calibrate'
  ) THEN
    RAISE EXCEPTION 'SCANNER_OPERATOR must not hold partner.stations.calibrate';
  END IF;
END$$;
