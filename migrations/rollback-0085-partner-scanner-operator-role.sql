-- ============================================================================================
-- ROLLBACK 0085 — SCANNER_OPERATOR ROLE
--
-- Removes the SCANNER_OPERATOR role and the two capabilities 0085 split out of
-- partner.cards.scan. Forward-fix is preferred; this exists for the release rollback path.
--
-- REFUSES WHILE ANYONE HOLDS THE ROLE. Deleting a role that is still assigned would strip real
-- people of their access without saying so, and partner_user_roles would cascade the rows away —
-- an access change disguised as a schema rollback. Reassign those users first, deliberately.
--
-- Removing partner.stations.enrol and partner.cards.fix returns the routes that reference them to
-- being unreachable, so this rollback MUST be paired with reverting the application to a build that
-- gates those routes on partner.cards.scan again. Rolling back the database alone would leave
-- station enrolment and image invalidation permanently 403 for everybody.
-- ============================================================================================

DO $$
DECLARE
  v_holders bigint;
BEGIN
  SELECT count(*) INTO v_holders
    FROM partner_user_roles ur
    JOIN partner_roles r ON r.id = ur.role_id
   WHERE r.code = 'SCANNER_OPERATOR';
  IF v_holders > 0 THEN
    RAISE EXCEPTION
      'Refusing to roll back 0085: % user(s) still hold SCANNER_OPERATOR. Reassign them first — dropping the role here would silently revoke their access.',
      v_holders;
  END IF;
END$$;

DELETE FROM partner_role_permissions
 WHERE role_id IN (SELECT id FROM partner_roles WHERE code = 'SCANNER_OPERATOR');

DELETE FROM partner_roles WHERE code = 'SCANNER_OPERATOR';

DELETE FROM partner_role_permissions
 WHERE permission_id IN (
   SELECT id FROM partner_permissions WHERE code IN ('partner.stations.enrol', 'partner.cards.fix')
 );

DELETE FROM partner_permissions WHERE code IN ('partner.stations.enrol', 'partner.cards.fix');
