-- rollback-0043-partner-credit-hold-per-card.sql
--
-- Reverses 0043. Run this BEFORE rollback-0042, which must run before the 0041 rollback.
-- NOT a forward migration (no NNNN_ prefix → the numbered runner ignores it).
-- Owner-approved protected action only; rehearse on a disposable database first.
--
-- ============================== IRREVERSIBLE ONCE USED ==============================
-- 0043 exists to permit N unreleased holds per destination (one per card). Restoring 0041's
-- `uq_partner_submission_credit_holds_active_destination` — UNIQUE (destination_submission_id)
-- WHERE released_at IS NULL — is therefore IMPOSSIBLE as soon as any multi-card submission has
-- been cancelled, because that submission legitimately holds N rows on one destination.
--
-- Rather than let `CREATE UNIQUE INDEX` fail with an opaque duplicate-key error halfway through,
-- the pre-check below refuses first and NAMES the destinations that block the rollback, so the
-- operator can decide whether to recover or release those holds before retrying.
-- ===================================================================================
--
-- Wrapped in a single transaction so a mid-script failure rolls back atomically and behaves
-- identically under `psql -f` and node-postgres.

BEGIN;

DO $$
DECLARE
  blocking text;
BEGIN
  IF to_regclass('public.partner_submission_credit_holds') IS NULL THEN
    RETURN; -- 0041 already rolled back; nothing to do.
  END IF;

  -- Refuse if restoring the destination-unique index would be impossible.
  SELECT string_agg(DISTINCT destination_submission_id::text, ', ')
    INTO blocking
    FROM (
      SELECT destination_submission_id
        FROM public.partner_submission_credit_holds
       WHERE released_at IS NULL
       GROUP BY destination_submission_id
      HAVING count(*) > 1
    ) multi;

  IF blocking IS NOT NULL THEN
    RAISE EXCEPTION
      'cannot roll back 0043: destination submission(s) % hold more than one unreleased per-card credit hold. Recover or release those holds first (Super Admin credit recovery), then retry.',
      blocking;
  END IF;
END$$;

-- Part 2 reversal — tenant isolation on the holds table.
DO $$
BEGIN
  IF to_regclass('public.partner_submission_credit_holds') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS partner_submission_credit_holds_tenant_isolation ON public.partner_submission_credit_holds';
    EXECUTE 'ALTER TABLE public.partner_submission_credit_holds NO FORCE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE public.partner_submission_credit_holds DISABLE ROW LEVEL SECURITY';
  END IF;
END$$;

-- Part 1 reversal — restore 0041's index shape.
DROP INDEX IF EXISTS idx_partner_submission_credit_holds_active_submission;
DROP INDEX IF EXISTS uq_partner_submission_credit_holds_active_reservation;
DROP INDEX IF EXISTS uq_partner_submission_credit_holds_active_destination_reservation;

DO $$
BEGIN
  IF to_regclass('public.partner_submission_credit_holds') IS NOT NULL THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_submission_credit_holds_active_destination
               ON public.partner_submission_credit_holds(destination_submission_id)
               WHERE released_at IS NULL';
  END IF;
END$$;

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM schema_migrations WHERE filename = '0043_partner_credit_hold_per_card.sql';
  END IF;
END$$;

COMMIT;
