-- rollback-0034-partner-rbac-seed.sql
--
-- Removes the Partner RBAC reference catalogue seeded by 0034.
--
-- REFUSES TO RUN if any partner user currently holds one of these roles. Deleting a role row
-- cascades (partner_user_roles.role_id and partner_role_permissions.role_id are both ON DELETE
-- CASCADE from partner_roles), so running this against a live estate would silently strip every
-- affected partner user of its role assignment — a mass, invisible de-authorisation. That is far
-- worse than leaving reference data in place, so this fails loudly and early instead.
--
-- House style: matches the fail-closed refusal used by rollback-0033 and the other partner
-- rollback scripts.
--
-- WHEN THIS IS ACTUALLY SAFE: only on an environment where the Partner surface was never used —
-- no partner_user_roles rows referencing these roles. In every other case the correct response to
-- an unwanted grant is a NEW numbered migration that revokes exactly that grant, not a rollback of
-- the whole catalogue. Revocation is a deliberate, reviewable act; see
-- docs/partner-rbac-change-policy.md.
--
-- NOTE ON REVERSIBILITY: 0034 is reference data, not schema. Rolling it back returns the estate to
-- the state that produced PARTNER_ROLE_NOT_CONFIGURED. It exists for completeness and for
-- disposable-environment teardown, not as a routine operational step.

BEGIN;

DO $$
DECLARE
  assigned bigint;
BEGIN
  SELECT count(*) INTO assigned
    FROM partner_user_roles ur
    JOIN partner_roles r ON r.id = ur.role_id
   WHERE r.code IN (
     'PARTNER_OWNER','PARTNER_MANAGER','MVGS_ASSESSMENT_TECHNICIAN',
     'PARTNER_RECEPTION','PARTNER_FINANCE_VIEWER','PARTNER_TRAINEE'
   );

  IF assigned > 0 THEN
    RAISE EXCEPTION
      'rollback-0034 refuses to run: % partner user role assignment(s) reference a role seeded by 0034. '
      'Deleting these roles cascades to partner_user_roles and would silently de-authorise those users. '
      'To remove a single grant, write a new numbered migration that revokes exactly that grant.', assigned;
  END IF;
END$$;

-- Mappings first (explicit, rather than relying on the cascade, so the intent is readable).
DELETE FROM partner_role_permissions rp
 USING partner_roles r
 WHERE r.id = rp.role_id
   AND r.code IN (
     'PARTNER_OWNER','PARTNER_MANAGER','MVGS_ASSESSMENT_TECHNICIAN',
     'PARTNER_RECEPTION','PARTNER_FINANCE_VIEWER','PARTNER_TRAINEE'
   );

DELETE FROM partner_roles
 WHERE code IN (
   'PARTNER_OWNER','PARTNER_MANAGER','MVGS_ASSESSMENT_TECHNICIAN',
   'PARTNER_RECEPTION','PARTNER_FINANCE_VIEWER','PARTNER_TRAINEE'
 );

-- Permissions last: only those no longer referenced by any surviving role mapping, so a
-- hand-added role that legitimately uses one of these permissions is never broken.
DELETE FROM partner_permissions p
 WHERE p.code IN (
   'partner.dashboard.view','partner.organisation.view','partner.location.view','partner.users.view',
   'partner.users.manage','partner.sessions.revoke','partner.documents.view','partner.training.view',
   'partner.credits.view','partner.orders.view','partner.orders.create','partner.orders.edit',
   'partner.orders.submit','partner.orders.cancel','partner.cards.view','partner.cards.receive',
   'partner.cards.scan','partner.cards.assess','partner.support.view','partner.support.create'
 )
   AND NOT EXISTS (SELECT 1 FROM partner_role_permissions rp WHERE rp.permission_id = p.id);

COMMIT;
