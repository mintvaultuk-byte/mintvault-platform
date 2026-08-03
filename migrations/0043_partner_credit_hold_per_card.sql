-- 0043_partner_credit_hold_per_card.sql
-- Partner Network G6D: per-card credit HOLDS, and tenant isolation for the holds table.
--
-- UNAPPLIED AND FORWARD-ONLY. Like 0042 this migration is additive; it edits no applied migration.
-- It must be applied AFTER 0042 and rolled back BEFORE it.
--
-- ===========================================================================================
-- PART 1 — HOLDS BECOME PER RESERVATION, NOT PER DESTINATION
-- ===========================================================================================
-- Partner grading credits are per CARD (owner directive, 2026-08-03), so a cancelled N-card
-- submission releases N reservations. Recovery must therefore restore N of them.
--
-- 0041 keyed the active-hold uniqueness on the DESTINATION alone:
--
--     CREATE UNIQUE INDEX uq_partner_submission_credit_holds_active_destination
--       ON partner_submission_credit_holds(destination_submission_id) WHERE released_at IS NULL;
--
-- which permits exactly ONE unreleased hold per destination. That was right while a submission
-- collapsed to a single reservation, but under the per-card model it makes N-card recovery
-- impossible to represent: `recoverPartnerDestinationCreditHold` could link only one predecessor
-- reservation to one replacement, and `findReservationsForPartnerSubmission` requires EVERY
-- historical reservation to be linked by a released hold to a live replacement. The remaining
-- N-1 predecessors could never be authorised, so a recovered multi-card submission could never
-- settle — it failed closed forever with `reservation_count_mismatch`.
--
-- The hold is conceptually per CARD (it records "this specific credit was released and owes a
-- replacement"), so the uniqueness key becomes (destination_submission_id, reservation_id).
-- The GATE is unchanged and still correct: every guard asks "does ANY unreleased hold exist for
-- this destination?", which is true for 1 hold and equally true for N.
--
-- ===========================================================================================
-- PART 2 — ROW LEVEL SECURITY ON partner_submission_credit_holds
-- ===========================================================================================
-- 0041 created two tables. It enabled ENABLE + FORCE ROW LEVEL SECURITY and a tenant-isolation
-- policy on `partner_credit_accounting_exceptions` — and on `partner_submission_credit_holds`
-- it enabled NOTHING, despite that table carrying tenant_id, partner_submission_id,
-- destination_submission_id and reservation_id.
--
-- Today the practical exposure is limited: partner_runtime holds no grant on the table at all
-- (0041 grants only SELECT, INSERT to partner_credit_lifecycle_definer, which is BYPASSRLS
-- regardless), so isolation currently rests entirely on privilege absence. That is a single point
-- of failure. The moment anyone grants the portal runtime SELECT — an obvious future request, so
-- a partner can see that a submission is on hold — there would be no tenant isolation whatsoever
-- and every tenant would read every other tenant's holds.
--
-- This brings the table in line with every other partner_* table and with its own sibling created
-- in the same migration. It is defence in depth, applied before the grant that would need it.

-- ---------------------------------------------------------------------------------------------
-- PART 1
-- ---------------------------------------------------------------------------------------------
DROP INDEX IF EXISTS uq_partner_submission_credit_holds_active_destination;

CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_submission_credit_holds_active_destination_reservation
  ON partner_submission_credit_holds(destination_submission_id, reservation_id)
  WHERE released_at IS NULL;

-- A single reservation must still never carry two unreleased holds, on any destination.
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_submission_credit_holds_active_reservation
  ON partner_submission_credit_holds(reservation_id)
  WHERE released_at IS NULL;

-- Recovery resolves predecessors by submission; make that lookup indexed rather than a scan.
CREATE INDEX IF NOT EXISTS idx_partner_submission_credit_holds_active_submission
  ON partner_submission_credit_holds(tenant_id, partner_submission_id)
  WHERE released_at IS NULL;

-- ---------------------------------------------------------------------------------------------
-- PART 2
-- ---------------------------------------------------------------------------------------------
ALTER TABLE partner_submission_credit_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_submission_credit_holds FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
     WHERE p.polrelid = 'public.partner_submission_credit_holds'::regclass
       AND p.polname = 'partner_submission_credit_holds_tenant_isolation'
  ) THEN
    -- Identical shape to every other partner_* isolation policy: keyed to the transaction-local
    -- app.tenant_id GUC via public.partner_current_tenant(), which fails closed (NULL) when the
    -- context is missing, empty or malformed.
    EXECUTE 'CREATE POLICY partner_submission_credit_holds_tenant_isolation
               ON partner_submission_credit_holds
               USING (tenant_id = public.partner_current_tenant())
               WITH CHECK (tenant_id = public.partner_current_tenant())';
  END IF;
END$$;

-- The lifecycle definer is BYPASSRLS and must keep working; no grant changes are made here.
-- partner_runtime deliberately receives NO grant on this table in this migration: enabling RLS is
-- a precondition for any future read grant, not a licence to add one.
