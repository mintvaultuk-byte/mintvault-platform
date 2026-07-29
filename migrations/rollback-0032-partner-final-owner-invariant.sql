-- rollback-0032-partner-final-owner-invariant.sql
-- Removes the Partner final-owner invariant trigger and marker table.

DROP TRIGGER IF EXISTS partner_organisations_final_owner_invariant ON partner_organisations;
DROP TRIGGER IF EXISTS partner_user_roles_final_owner_invariant ON partner_user_roles;
DROP TRIGGER IF EXISTS partner_users_final_owner_invariant ON partner_users;

DROP FUNCTION IF EXISTS partner_enforce_final_owner_invariant();
DROP TABLE IF EXISTS partner_owner_invariant_tenants;
DROP INDEX IF EXISTS uq_partner_invitations_one_live_per_user;
