-- 0109 — THE EXPLICIT ONBOARDING TEST-CARD MARKER.
--
-- NUMBER SAFETY: 0108 is the global high-water mark across every ref in the repository, so 0109 is
-- free. The runner rejects duplicate numbers before anything runs.
--
-- ============================================================================================
-- WHY A COLUMN AND NOT A QUERY
-- ============================================================================================
-- Onboarding needs to answer one question — "has this shop scanned its test card yet, and how far
-- has it got?" — and there was NO canonical way to ask it. Every available answer was an inference:
-- the newest Card Job, the newest MV number, the newest submission, or "whatever was created near
-- the time the shop was set up". Each of those is wrong the moment a real customer card is scanned
-- during onboarding, or the operator scans twice, or a second Mac is enrolled. An onboarding gate
-- built on a guess would then either pass a shop that never tested, or refuse a shop that did.
--
-- So the marker is DECLARED, not deduced: a Card Job is an onboarding test because the operation
-- that created it said so, and for no other reason.
--
-- ============================================================================================
-- WHAT THIS DOES NOT CHANGE
-- ============================================================================================
-- `purpose` is metadata about WHY a job was started. It is deliberately inert everywhere else:
--   * Credits.   An ONBOARDING_TEST job reserves and consumes exactly one Grading Credit, through
--                the same canonical engine, on the same code path. A free test card would be a
--                different feature and a different decision; this is not it.
--   * Grading.   MVGS, sub-grades, the Pristine gate and the label pipeline never read this column.
--                A test card is graded by the identical maths as any other card, which is the whole
--                point of testing with it.
--   * Identity.  It mints a real MV number and a real certificate, exactly as before.
--   * Evidence.  Capture, admission and the evidence ledger are untouched.
--   * Isolation. The column carries no cross-tenant meaning; every read is still tenant-scoped.
--
-- MIXED-VERSION SAFETY (invariant I17). Additive, with a DEFAULT: an OLD application version that
-- does not know the column exists keeps inserting Card Jobs, and every one of them is NORMAL. That
-- is the correct answer for old code, so this is safe to apply BEFORE the deploy.
--
-- ROLLBACK: migrations/rollback-0109-partner-card-job-purpose.sql (drops the marker; every job
-- reverts to being unmarked, which is the pre-0109 state).

-- ---------------------------------------------------------------------------------------------
-- PART 1 — the marker
-- ---------------------------------------------------------------------------------------------
-- NOT NULL DEFAULT 'NORMAL' is the load-bearing half: existing rows and any insert that does not
-- mention the column are NORMAL, so nothing is retrospectively promoted into being a test card.
ALTER TABLE partner_card_jobs
  ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'NORMAL';

COMMENT ON COLUMN partner_card_jobs.purpose IS
  'Why this Card Job was started. NORMAL = ordinary paid work. ONBOARDING_TEST = the shop''s explicit onboarding test card, set ONLY by a deliberate test-card initiation. Never inferred.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_partner_card_jobs_purpose') THEN
    ALTER TABLE partner_card_jobs
      ADD CONSTRAINT chk_partner_card_jobs_purpose CHECK (purpose IN ('NORMAL', 'ONBOARDING_TEST'));
  END IF;
END$$;

-- ---------------------------------------------------------------------------------------------
-- PART 2 — one CURRENT test card per shop, and no ambiguity about which it is
-- ---------------------------------------------------------------------------------------------
-- Onboarding asks "the" test card's state, so more than one live test card would make the question
-- unanswerable rather than merely untidy. This index makes the ambiguous state unreachable instead
-- of leaving the server to pick a winner.
--
-- Scoped to NON-TERMINAL jobs on purpose. A shop that finished a test card and later needs another
-- one (a second location, a re-test after a hardware change) must be able to start it, so COMPLETED
-- and CANCELLED test cards stand aside. What is forbidden is TWO OPEN test cards at once.
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_card_jobs_open_onboarding_test
  ON partner_card_jobs (tenant_id)
  WHERE purpose = 'ONBOARDING_TEST' AND status NOT IN ('COMPLETED', 'CANCELLED');

-- The readiness read is "this tenant's most recent onboarding test job", so it is served directly.
CREATE INDEX IF NOT EXISTS idx_partner_card_jobs_onboarding_test
  ON partner_card_jobs (tenant_id, created_at DESC)
  WHERE purpose = 'ONBOARDING_TEST';

-- ---------------------------------------------------------------------------------------------
-- PART 3 — purpose is decided at birth and never afterwards
-- ---------------------------------------------------------------------------------------------
-- WITHOUT THIS, the marker would be worth very little. Anything holding UPDATE on partner_card_jobs
-- could relabel an ordinary customer's graded card as the shop's onboarding test — or, in the other
-- direction, quietly promote a real card into the onboarding gate so the wizard passed without a
-- test ever being scanned. Both are exactly the "accidental promotion" the marker exists to prevent,
-- and neither is a legitimate operation, so the database refuses both rather than trusting callers.
--
-- Written as its OWN trigger rather than as an edit to partner_card_jobs_immutable_identity(): that
-- function is protected grading-lineage code with existing coverage, and adding a second trigger is
-- additive where rewriting it would not be.
--
-- ENABLE ALWAYS, matching the house convention set by 0035's origin guard and reused by 0080: a
-- plain trigger is skipped when session_replication_role = 'replica', which would let a
-- replication-mode session relabel a job.
CREATE OR REPLACE FUNCTION partner_card_jobs_immutable_purpose()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.purpose IS DISTINCT FROM OLD.purpose THEN
    RAISE EXCEPTION 'partner_card_jobs.purpose is decided when the job is created and is immutable (% -> %)',
      OLD.purpose, NEW.purpose USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_partner_card_jobs_immutable_purpose ON partner_card_jobs;
CREATE TRIGGER trg_partner_card_jobs_immutable_purpose
  BEFORE UPDATE ON partner_card_jobs
  FOR EACH ROW EXECUTE FUNCTION partner_card_jobs_immutable_purpose();
ALTER TABLE partner_card_jobs ENABLE ALWAYS TRIGGER trg_partner_card_jobs_immutable_purpose;

-- ---------------------------------------------------------------------------------------------
-- PART 4 — how a test card is actually DECLARED: the armed onboarding intent
-- ---------------------------------------------------------------------------------------------
-- THE PROBLEM THE MARKER ALONE DOES NOT SOLVE. A Card Job is created by MintVault Scanner pressing
-- NEW at the counter. The marker says a job is an onboarding test because the operation that made it
-- said so — but the shop Mac has no way to say so, and inventing one after the fact ("the next job
-- we see", "the newest MV") is exactly the guessing this migration exists to remove.
--
-- So the DECLARATION is made in advance, once, by MintVault, and CONSUMED at creation: an operator
-- arms the onboarding test card for a shop, and the very next NEW at that shop is stamped
-- ONBOARDING_TEST inside the same transaction that mints it, clearing the arm as it goes. The
-- classification is therefore still decided at birth by an explicit instruction — never assigned to
-- a card that already exists, and never guessed.
--
-- ONE-SHOT BY CONSTRUCTION. Consuming the arm is an UPDATE ... WHERE armed_at IS NOT NULL inside the
-- NEW transaction, so two simultaneous NEW presses cannot both claim it: one wins the row, the other
-- creates an ordinary NORMAL card. That is the correct outcome — a shop scanning two cards at once
-- has one test card and one real card, not two test cards.
--
-- LIVES ON partner_profiles because that is the Partner SETUP aggregate, and because 0108 makes it
-- CASCADE: a deleted Partner takes its onboarding state with it, leaving nothing to strand.
ALTER TABLE partner_profiles
  ADD COLUMN IF NOT EXISTS onboarding_test_card_armed_at timestamptz,
  ADD COLUMN IF NOT EXISTS onboarding_test_card_armed_by uuid;

COMMENT ON COLUMN partner_profiles.onboarding_test_card_armed_at IS
  'Set when MintVault declares that this shop''s NEXT new Card Job is its onboarding test card. Cleared by the NEW transaction that consumes it. NULL means no test card is armed.';

-- ---------------------------------------------------------------------------------------------
-- PART 5 — prove the migration did what it claims
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'partner_card_jobs' AND column_name = 'purpose'
       AND is_nullable = 'NO' AND column_default LIKE '%NORMAL%'
  ) THEN
    RAISE EXCEPTION '0109 did not add partner_card_jobs.purpose as NOT NULL DEFAULT NORMAL';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'chk_partner_card_jobs_purpose'
       AND pg_get_constraintdef(oid) LIKE '%ONBOARDING_TEST%'
  ) THEN
    RAISE EXCEPTION '0109 did not constrain partner_card_jobs.purpose to the declared vocabulary';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_partner_card_jobs_open_onboarding_test') THEN
    RAISE EXCEPTION '0109 did not create the single-open-onboarding-test index';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'trg_partner_card_jobs_immutable_purpose' AND tgenabled = 'A'
  ) THEN
    RAISE EXCEPTION '0109 did not install the purpose immutability trigger as ENABLE ALWAYS';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'partner_profiles'
       AND column_name = 'onboarding_test_card_armed_at'
  ) THEN
    RAISE EXCEPTION '0109 did not add partner_profiles.onboarding_test_card_armed_at';
  END IF;
  IF EXISTS (SELECT 1 FROM partner_card_jobs WHERE purpose <> 'NORMAL') THEN
    RAISE EXCEPTION '0109 must not classify any pre-existing Card Job as an onboarding test';
  END IF;
  IF EXISTS (SELECT 1 FROM partner_profiles WHERE onboarding_test_card_armed_at IS NOT NULL) THEN
    RAISE EXCEPTION '0109 must not arm an onboarding test card for any existing Partner';
  END IF;
END$$;
