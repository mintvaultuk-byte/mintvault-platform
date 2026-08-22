-- Disposable/staging rollback for 0104_partner_supplies_orders.sql.
--
-- Production use requires a separate retention review: a real supplies order is an
-- operational record a Partner has already been told was received, and the event
-- table is the audit of what a human then did with it. Dropping these tables
-- destroys that evidence. On staging the data is synthetic and the drop is safe.
--
-- Order matters: the child tables carry composite tenant FKs onto the parent, so the
-- parent is dropped last. CASCADE removes the triggers, RLS policies, indexes and the
-- events sequence that 0104 created alongside each table.
DROP TABLE IF EXISTS partner_supplies_order_notifications CASCADE;
DROP TABLE IF EXISTS partner_supplies_order_events CASCADE;
DROP TABLE IF EXISTS partner_supplies_order_items CASCADE;
DROP TABLE IF EXISTS partner_supplies_orders CASCADE;

-- Both functions are created by 0104 and used by nothing else.
DROP FUNCTION IF EXISTS partner_supplies_orders_enforce_update();
DROP FUNCTION IF EXISTS partner_supplies_append_only();

-- Withdraw the additive RBAC authority. The mappings must go before the permissions
-- they reference.
DELETE FROM partner_role_permissions
 WHERE permission_id IN (
   SELECT id FROM partner_permissions WHERE code IN ('partner.supplies.view', 'partner.supplies.submit')
 );
DELETE FROM partner_permissions WHERE code IN ('partner.supplies.view', 'partner.supplies.submit');

-- uq_partner_locations_identity and uq_partner_users_identity are deliberately RETAINED.
-- 0104 creates them only when absent, they are semantically identical to the composite
-- identity constraints other Partner migrations rely on, and they are harmless without
-- the supplies tables. Dropping them here would break unrelated foreign keys.
