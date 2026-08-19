-- Guarded rollback for 0098_scanner_operator_credit_view.sql.
--
-- Removes only the additive SCANNER_OPERATOR -> partner.credits.view grant. Do not run while any
-- active Scanner deployment depends on least-privilege operators seeing zero-credit lockout state.

DELETE FROM partner_role_permissions rp
USING partner_roles r, partner_permissions p
WHERE rp.role_id = r.id
  AND rp.permission_id = p.id
  AND r.code = 'SCANNER_OPERATOR'
  AND p.code = 'partner.credits.view';
