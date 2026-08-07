-- rollback-0053-partner-mfa-failure-lockout.sql
--
-- Reverses 0053 by dropping the two columns it added to partner_users.
--
-- ⚠️  THIS ROLLBACK RE-OPENS THE SECOND-FACTOR BRUTE-FORCE HOLE. With these columns gone there is
-- no per-account failure ceiling on POST /api/partner/auth/mfa, and an attacker holding a
-- phished password can grind TOTP codes from rotating source addresses. Deploy the matching
-- application rollback WITH it — server/partner/auth.ts recordPartnerMfaFailure() references both
-- columns, and on a database without them the UPDATE raises 42703, which the route treats as a
-- failed verification (fail CLOSED: the caller is refused, the account is not upgraded). That is
-- safe but total: no user can complete an MFA challenge until the application is also rolled back.
--
-- Journal guard: refuse while any migration numbered above 53 is journalled. The threshold is
-- always this file's OWN number; if this file is ever renumbered, the integer moves with it.

BEGIN;

DO $$
DECLARE
  later_migrations bigint := 0;
BEGIN
  -- to_regclass, not a direct reference: a direct one raises 42P01 on a database that has no
  -- schema_migrations table at all (matches rollback-0047/0048).
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE $q$SELECT count(*) FROM schema_migrations
                WHERE filename ~ '^[0-9]{4}_' AND left(filename,4)::integer > 53$q$
      INTO later_migrations;
    IF later_migrations > 0 THEN
      RAISE EXCEPTION 'rollback-0053 refused: % later migration journal row(s) exist. Resolve newer migrations first.',
        later_migrations;
    END IF;
  END IF;

  IF to_regclass('public.partner_users') IS NULL THEN
    RAISE NOTICE 'rollback-0053: partner_users absent; nothing to do.';
    RETURN;
  END IF;
END$$;

ALTER TABLE partner_users DROP COLUMN IF EXISTS mfa_locked_until;
ALTER TABLE partner_users DROP COLUMN IF EXISTS failed_mfa_count;

DO $$
DECLARE
  remaining integer;
BEGIN
  SELECT count(*) INTO remaining
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'partner_users'
     AND column_name IN ('failed_mfa_count', 'mfa_locked_until');
  IF remaining <> 0 THEN
    RAISE EXCEPTION 'rollback-0053: % 0053 column(s) survive the drop', remaining;
  END IF;
END$$;

COMMIT;
