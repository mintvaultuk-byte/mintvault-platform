-- rollback-partner-auth-invitations-rbac.sql
-- Reverses migration 0020_partner_auth_invitations_rbac.sql. NOT a numbered migration.
--
-- This is deliberately conservative: invitation, membership-origin, or access-audit evidence
-- makes the rollback refuse before any destructive statement. Preserve that security history and
-- use a forward corrective migration instead. It is safe only for an empty, dependency-free
-- disposable installation.
BEGIN;

DO $$
DECLARE has_later boolean := false;
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE $sql$
      SELECT EXISTS (
        SELECT 1 FROM schema_migrations
         WHERE CASE WHEN filename ~ '^[0-9]+_' THEN substring(filename FROM '^([0-9]+)_')::integer > 20 ELSE false END
      )
    $sql$ INTO has_later;
  END IF;
  IF has_later THEN
    RAISE EXCEPTION 'refusing Partner authentication rollback: a later migration (0021+) is applied; roll it back first';
  END IF;
END$$;

-- FORCE RLS can hide populated rows from the migration owner. These changes and the checks are
-- one transaction, so refusal restores the original FORCE state atomically.
ALTER TABLE IF EXISTS partner_invitations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS partner_invitation_locations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS partner_users NO FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF to_regclass('public.partner_access_audit_events') IS NOT NULL
     AND EXISTS (SELECT FROM partner_access_audit_events LIMIT 1) THEN
    RAISE EXCEPTION 'refusing Partner authentication rollback: immutable access-audit evidence exists';
  END IF;
  IF to_regclass('public.partner_invitations') IS NOT NULL
     AND EXISTS (SELECT FROM partner_invitations LIMIT 1) THEN
    RAISE EXCEPTION 'refusing Partner authentication rollback: invitation lifecycle data exists';
  END IF;
  IF to_regclass('public.partner_invitation_locations') IS NOT NULL
     AND EXISTS (SELECT FROM partner_invitation_locations LIMIT 1) THEN
    RAISE EXCEPTION 'refusing Partner authentication rollback: invitation location evidence exists';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='partner_users' AND column_name='invitation_id'
  ) AND EXISTS (SELECT FROM partner_users WHERE invitation_id IS NOT NULL LIMIT 1) THEN
    RAISE EXCEPTION 'refusing Partner authentication rollback: Partner users retain invitation origins';
  END IF;
END$$;

DROP FUNCTION IF EXISTS public.partner_accept_invitation(text, text, text, text);
DROP TRIGGER IF EXISTS trg_partner_access_audit_no_row_mutate ON partner_access_audit_events;
DROP TRIGGER IF EXISTS trg_partner_access_audit_no_truncate ON partner_access_audit_events;
DROP TABLE IF EXISTS partner_invitation_locations;
DROP TABLE IF EXISTS partner_access_audit_events;
ALTER TABLE IF EXISTS partner_users DROP CONSTRAINT IF EXISTS fk_partner_users_invitation;
ALTER TABLE IF EXISTS partner_users DROP COLUMN IF EXISTS invitation_id;
DROP TABLE IF EXISTS partner_invitations;
DROP FUNCTION IF EXISTS partner_access_audit_no_mutate();

-- partner_users predates 0020 and survives the rollback; restore its established RLS posture.
ALTER TABLE IF EXISTS partner_users FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE 'DELETE FROM schema_migrations WHERE filename = ''0020_partner_auth_invitations_rbac.sql''';
  END IF;
END$$;

COMMIT;
