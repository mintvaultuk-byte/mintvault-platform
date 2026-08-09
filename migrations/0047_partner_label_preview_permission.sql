-- Add the narrowly-scoped live certificate-preview permission to deployed
-- Partner RBAC catalogues. This additive migration follows the immutable 0034
-- seed so new and upgraded environments converge without changing an applied
-- migration checksum.

INSERT INTO partner_permissions (code, label)
VALUES ('partner.cards.preview', 'partner.cards.preview')
ON CONFLICT (code) DO NOTHING;

INSERT INTO partner_role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM partner_roles r
  JOIN partner_permissions p ON p.code = 'partner.cards.preview'
 WHERE r.code IN ('PARTNER_OWNER', 'PARTNER_MANAGER', 'MVGS_ASSESSMENT_TECHNICIAN')
ON CONFLICT DO NOTHING;

DO $$
DECLARE missing_count integer;
BEGIN
  SELECT count(*) INTO missing_count
    FROM (VALUES
      ('PARTNER_OWNER'),
      ('PARTNER_MANAGER'),
      ('MVGS_ASSESSMENT_TECHNICIAN')
    ) expected(role_code)
   WHERE NOT EXISTS (
     SELECT 1
       FROM partner_role_permissions rp
       JOIN partner_roles r ON r.id = rp.role_id
       JOIN partner_permissions p ON p.id = rp.permission_id
      WHERE r.code = expected.role_code
        AND p.code = 'partner.cards.preview'
   );
  IF missing_count <> 0 THEN
    RAISE EXCEPTION '0047 preview permission incomplete: % expected role grant(s) missing', missing_count;
  END IF;
END$$;
