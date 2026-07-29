-- 0032_partner_final_owner_invariant.sql
-- Partner Network — database-level final active OWNER invariant.
--
-- Policy: once a Partner tenant has ever had an ACTIVE PARTNER_OWNER, an ACTIVE partner may not
-- commit a user/role/org change that leaves it with zero ACTIVE owners. This permits creating a
-- Partner company before its first owner invitation is accepted. Revoked/deleted partners are exempt
-- because their ordinary access is already disabled by organisation status.

CREATE TABLE IF NOT EXISTS partner_owner_invariant_tenants (
  tenant_id uuid PRIMARY KEY REFERENCES partner_organisations(id) ON DELETE CASCADE,
  first_active_owner_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_invitations_one_live_per_user
  ON partner_invitations(user_id)
  WHERE status IN ('PENDING','SENT','DELIVERY_FAILED');

-- Historical backfill. partner_users and partner_user_roles are FORCE ROW LEVEL SECURITY, which
-- subjects the table OWNER to RLS too. The migrator runs as the non-superuser owner (pn_migrator)
-- with no app.tenant_id set, so partner_current_tenant() is NULL, the policy matches zero rows, and
-- this INSERT would silently backfill NOTHING — leaving every pre-existing partner unprotected until
-- some later write happened to mark it. That is the same superuser-masked failure mode documented in
-- 0006_partner_definer_role.sql. Drop FORCE for the owner for the duration of the read only (the
-- policy itself stays enabled for every other role), then restore it. The migration runner wraps this
-- file in a single transaction, so FORCE is restored even if the backfill fails.
ALTER TABLE partner_users NO FORCE ROW LEVEL SECURITY;
ALTER TABLE partner_user_roles NO FORCE ROW LEVEL SECURITY;

INSERT INTO partner_owner_invariant_tenants (tenant_id)
SELECT DISTINCT u.tenant_id
  FROM partner_users u
  JOIN partner_user_roles ur ON ur.user_id = u.id AND ur.tenant_id = u.tenant_id
  JOIN partner_roles r ON r.id = ur.role_id
 WHERE u.status = 'ACTIVE'
   AND r.code = 'PARTNER_OWNER'
ON CONFLICT DO NOTHING;

ALTER TABLE partner_users FORCE ROW LEVEL SECURITY;
ALTER TABLE partner_user_roles FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION partner_enforce_final_owner_invariant() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  affected uuid[];
  tenant uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    affected := ARRAY[NEW.tenant_id];
  ELSIF TG_OP = 'UPDATE' THEN
    SELECT array_agg(DISTINCT tenant_id) INTO affected
      FROM (VALUES (NEW.tenant_id), (OLD.tenant_id)) AS x(tenant_id)
     WHERE tenant_id IS NOT NULL;
  ELSE
    affected := ARRAY[OLD.tenant_id];
  END IF;

  IF affected IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  INSERT INTO partner_owner_invariant_tenants (tenant_id)
  SELECT DISTINCT u.tenant_id
    FROM partner_users u
    JOIN partner_user_roles ur ON ur.user_id = u.id AND ur.tenant_id = u.tenant_id
    JOIN partner_roles r ON r.id = ur.role_id
   WHERE u.tenant_id = ANY(affected)
     AND u.status = 'ACTIVE'
     AND r.code = 'PARTNER_OWNER'
  ON CONFLICT DO NOTHING;

  FOREACH tenant IN ARRAY affected LOOP
    IF EXISTS (
      SELECT 1
        FROM partner_owner_invariant_tenants seen
        JOIN partner_organisations o ON o.id = seen.tenant_id
       WHERE seen.tenant_id = tenant
         AND o.status = 'ACTIVE'
    ) AND NOT EXISTS (
      SELECT 1
        FROM partner_users u
        JOIN partner_user_roles ur ON ur.user_id = u.id AND ur.tenant_id = u.tenant_id
        JOIN partner_roles r ON r.id = ur.role_id
       WHERE u.tenant_id = tenant
         AND u.status = 'ACTIVE'
         AND r.code = 'PARTNER_OWNER'
    ) THEN
      RAISE EXCEPTION 'partner_final_owner_required'
        USING ERRCODE = '23514',
              CONSTRAINT = 'partner_final_owner_required';
    END IF;
  END LOOP;

  RETURN COALESCE(NEW, OLD);
END;
$fn$;

DROP TRIGGER IF EXISTS partner_users_final_owner_invariant ON partner_users;
CREATE CONSTRAINT TRIGGER partner_users_final_owner_invariant
AFTER INSERT OR UPDATE OR DELETE ON partner_users
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION partner_enforce_final_owner_invariant();

DROP TRIGGER IF EXISTS partner_user_roles_final_owner_invariant ON partner_user_roles;
CREATE CONSTRAINT TRIGGER partner_user_roles_final_owner_invariant
AFTER INSERT OR UPDATE OR DELETE ON partner_user_roles
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION partner_enforce_final_owner_invariant();

DROP TRIGGER IF EXISTS partner_organisations_final_owner_invariant ON partner_organisations;
CREATE CONSTRAINT TRIGGER partner_organisations_final_owner_invariant
AFTER UPDATE OR DELETE ON partner_organisations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION partner_enforce_final_owner_invariant();

GRANT SELECT, INSERT ON partner_owner_invariant_tenants TO partner_runtime;
