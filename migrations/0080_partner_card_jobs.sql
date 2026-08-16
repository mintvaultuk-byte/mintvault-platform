-- P3 — THE CANONICAL PARTNER CARD JOB.
--
-- NUMBER SAFETY: 0080 follows 0078/0079 from this pass, both above the global high-water mark of
-- 0077 discovered across every ref in the repository. The runner rejects duplicate numbers.
--
-- ============================================================================================
-- WHY THIS TABLE EXISTS AT ALL
-- ============================================================================================
-- The partner programme is specified entirely in terms of a "Card Job": one paid job = one
-- permanent MV number = one physical card. THAT ENTITY DID NOT EXIST. A repository-wide search for
-- card_job / cardJob / grading_job returned zero hits. What existed instead:
--
--   * partner_submissions          — an ORDER. Carries a scalar `card_count`, not a row per card.
--   * partner_submission_cards     — INTAKE only. Migration 0007 states the omission is deliberate:
--                                    "NO grade/cert/label columns exist on this table AT ALL".
--                                    It also carries `quantity >= 1`, so it is not one-card-one-row.
--   * partner_credit_reservations  — linked to a card by `card_reference TEXT`, with NO foreign key,
--                                    matched elsewhere by STRING COMPARISON (see 0076's allocator).
--
-- So the chain from "a credit was spent" to "this MV number" was stitched from nullable text and had
-- no referential integrity anywhere along it. Invariants I1 (one Card Job <-> one MV forever),
-- I2 (one NEW Card Job <-> exactly one reservation), I4 (FIX mints no MV/reservation) and I8
-- (FRONT/BACK belong to the same job) had nothing to attach to.
--
-- ============================================================================================
-- THE UNIT OF IDENTITY: (card row, ordinal) — NOT the card row
-- ============================================================================================
-- This is not a new invention; it is the convention the credit system ALREADY uses.
-- server/partner/submission-service.ts expands each card row by its `quantity` into units and
-- reserves one credit per unit, keyed `partner-submission-card:<cardId>:<ordinal>`. Its own comment
-- states: "the unit of account here is (card row, ordinal) — not the card row."
--
-- A Card Job is therefore that same unit, and `card_reference` below is stored in EXACTLY that
-- format so an existing reservation and its Card Job are joinable without a backfill guess and
-- without changing how credits are reserved. Reusing the convention is what makes this additive.
--
-- ============================================================================================
-- SCOPE: PARTNER (the certificates FK is conditional — see PART 1b)
-- ============================================================================================
-- `certificate_id` gets a REAL foreign key to core `public.certificates` — but attached
-- CONDITIONALLY, in PART 1b, only where that table exists. Production, staging and every
-- application-scope harness therefore get full referential integrity; a partner-only disposable
-- database, which has no `certificates` table to point at, still gets the table.
--
-- That matters because submission acceptance now writes a Card Job in the SAME transaction as the
-- credit reservation. An unconditional FK would make this migration unusable on partner-only
-- databases and every partner suite that submits would fail — measured, not assumed: it took the
-- suite from 187 to 270 failures. The invariant that actually carries I1 is the UNIQUE index in
-- PART 2, which is unconditional; the FK adds "and that certificate really exists", which is only
-- meaningful on a database that has certificates at all.
--
-- ============================================================================================
-- MIXED-VERSION SAFETY (invariant I17)
-- ============================================================================================
-- Purely additive: one new table, its indexes and its triggers. No existing table is altered, no
-- column dropped, no constraint on an existing table changed. An OLD application version does not
-- know this table exists and is entirely unaffected, so this is safe to apply BEFORE the deploy
-- (expand -> migrate -> deploy). Nothing writes to it until the new code ships.
--
-- ROLLBACK / DOWN-PATH: `DROP TABLE IF EXISTS partner_card_jobs CASCADE;` — safe while no code
-- writes to it. Once Card Jobs carry live MV allocations this becomes forward-fix only, per project
-- policy (never a destructive rollback on real data).

-- ---------------------------------------------------------------------------------------------
-- PART 1 — the table
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS partner_card_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  submission_id uuid NOT NULL REFERENCES partner_submissions(id) ON DELETE RESTRICT,
  card_id uuid NOT NULL REFERENCES partner_submission_cards(id) ON DELETE RESTRICT,
  -- Which unit of a quantity>1 card row this job is. 1-based, matching the credit expansion.
  ordinal integer NOT NULL CHECK (ordinal >= 1),
  -- Byte-identical to the reservation convention: 'partner-submission-card:<cardId>:<ordinal>'.
  card_reference text NOT NULL,

  -- The paid authority for this job. RESTRICT, never CASCADE: a reservation may not be deleted out
  -- from under a job that it paid for.
  reservation_id uuid REFERENCES partner_credit_reservations(id) ON DELETE RESTRICT,

  -- The permanent identity. NULL until allocation; immutable once set (PART 3).
  -- The foreign key is attached CONDITIONALLY in PART 1b — see the reasoning there.
  certificate_id integer,
  mv_number text,

  status text NOT NULL DEFAULT 'CREDIT_RESERVED',

  -- Location provenance is snapshotted at creation so a later shop rename/move cannot rewrite it.
  location_id uuid,
  created_by uuid,
  cancelled_at timestamptz,
  cancelled_reason text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Composite identity, so child tables can carry (id, tenant_id) and make a cross-tenant reference
  -- structurally impossible rather than merely policed. Same idiom as partner_wallets (0016).
  CONSTRAINT uq_partner_card_jobs_identity UNIQUE (id, tenant_id),

  CONSTRAINT chk_partner_card_jobs_status CHECK (status IN (
    'CREDIT_RESERVED',   -- paid authority held; no capture yet
    'NEEDS_SCAN',        -- awaiting FRONT/BACK
    'CAPTURING',         -- a capture session is open
    'FIX_REQUIRED',      -- a side was invalidated; zero-credit replacement authorised
    'READY_TO_GRADE',    -- both sides accepted
    'GRADING',
    'SUBMITTED',         -- credit consumed exactly once at this edge
    'QA_REVIEW',
    'APPROVED',
    'PRINTABLE',
    'COMPLETED',         -- terminal
    'CANCELLED'          -- terminal; reservation released exactly once
  )),

  -- An MV number and its certificate arrive together or not at all. This is what stops a job
  -- carrying a "number" that no certificate backs, or a certificate with no number recorded.
  CONSTRAINT chk_partner_card_jobs_mv_pairing CHECK (
    (certificate_id IS NULL AND mv_number IS NULL) OR
    (certificate_id IS NOT NULL AND mv_number IS NOT NULL)
  ),

  CONSTRAINT chk_partner_card_jobs_terminal_times CHECK (
    (status = 'CANCELLED' AND cancelled_at IS NOT NULL)
    OR (status = 'COMPLETED' AND completed_at IS NOT NULL AND cancelled_at IS NULL)
    OR (status NOT IN ('CANCELLED', 'COMPLETED') AND cancelled_at IS NULL AND completed_at IS NULL)
  )
);

-- ---------------------------------------------------------------------------------------------
-- PART 1b — the certificate foreign key, attached only where `certificates` exists
-- ---------------------------------------------------------------------------------------------
-- WHY CONDITIONAL, and why this is not a weakening.
--
-- An unconditional FK to core `public.certificates` makes this migration APPLICATION-scope, i.e.
-- unusable on a partner-only disposable database. That is not an abstract concern: submission
-- acceptance now writes a Card Job in the same transaction as the credit reservation, so with the
-- table absent EVERY partner-scope suite that submits fails. Measured, not assumed — an
-- unconditional FK took the suite from 187 to 270 failures, breaking exactly the credit-lifecycle
-- suites (per-card lifecycle, recovery cardinality, submission credit lifecycle, onboarding matrix).
--
-- The alternative of dropping the FK entirely would trade real production integrity for test
-- convenience. This keeps both: wherever `certificates` exists — production, staging, and every
-- application-scope harness — the FK is created and referential integrity is fully enforced. On a
-- partner-only database there is no `certificates` table to point at, so the column stands alone and
-- the partner suites can exercise the Card Job path properly.
--
-- The invariant that actually carries I1 ("one Card Job <-> one MV forever") is the UNIQUE index in
-- PART 2, not the FK, and that is unconditional. The FK adds "and the certificate really exists",
-- which is meaningful only on a database that HAS certificates.
DO $$
BEGIN
  IF to_regclass('public.certificates') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_partner_card_jobs_certificate')
  THEN
    ALTER TABLE partner_card_jobs
      ADD CONSTRAINT fk_partner_card_jobs_certificate
      FOREIGN KEY (certificate_id) REFERENCES public.certificates(id) ON DELETE RESTRICT;
  END IF;
END$$;

-- ---------------------------------------------------------------------------------------------
-- PART 2 — the invariants, as indexes
-- ---------------------------------------------------------------------------------------------

-- I1: one Card Job <-> one MV forever. A certificate can back at most one job, in one direction...
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_card_jobs_certificate
  ON partner_card_jobs (certificate_id) WHERE certificate_id IS NOT NULL;
-- ...and an MV number is never reused across jobs, in the other.
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_card_jobs_mv_number
  ON partner_card_jobs (mv_number) WHERE mv_number IS NOT NULL;

-- One job per paid unit. Both spellings of the same fact are enforced: the structural key and the
-- text reference the credit system uses. Keeping both means neither can drift from the other.
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_card_jobs_unit
  ON partner_card_jobs (card_id, ordinal);
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_card_jobs_card_reference
  ON partner_card_jobs (tenant_id, card_reference);

-- I2: a reservation funds at most ONE job. Without this, two jobs could point at one paid credit —
-- the "one credit cannot fund two cards" breach, made structurally impossible.
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_card_jobs_reservation
  ON partner_card_jobs (reservation_id) WHERE reservation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_partner_card_jobs_tenant_status
  ON partner_card_jobs (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_partner_card_jobs_submission
  ON partner_card_jobs (tenant_id, submission_id);
-- Serves the FIX queue, which is derived server-side from this tenant's own jobs.
CREATE INDEX IF NOT EXISTS idx_partner_card_jobs_fix_queue
  ON partner_card_jobs (tenant_id, status) WHERE status = 'FIX_REQUIRED';

-- ---------------------------------------------------------------------------------------------
-- PART 3 — immutability (invariants I1, I7)
-- ---------------------------------------------------------------------------------------------
-- ENABLE ALWAYS, matching the house convention set by 0035's origin guard: a plain trigger is
-- skipped when session_replication_role = 'replica', which would let a replication-mode session
-- rewrite the platform's permanent public identity.
CREATE OR REPLACE FUNCTION partner_card_jobs_immutable_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.card_id IS DISTINCT FROM OLD.card_id
     OR NEW.ordinal IS DISTINCT FROM OLD.ordinal
     OR NEW.submission_id IS DISTINCT FROM OLD.submission_id
     OR NEW.card_reference IS DISTINCT FROM OLD.card_reference THEN
    RAISE EXCEPTION 'partner_card_jobs identity (tenant, submission, card, ordinal, reference) is immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- The MV number and its certificate may be stamped ONCE (NULL -> value). Never changed, never
  -- cleared. This is the DB-level half of "MV numbers are permanent and never reused"; the server
  -- transition function is the other half, and neither is trusted alone.
  IF OLD.certificate_id IS NOT NULL AND NEW.certificate_id IS DISTINCT FROM OLD.certificate_id THEN
    RAISE EXCEPTION 'partner_card_jobs.certificate_id is immutable once allocated'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.mv_number IS NOT NULL AND NEW.mv_number IS DISTINCT FROM OLD.mv_number THEN
    RAISE EXCEPTION 'partner_card_jobs.mv_number is immutable once allocated'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- A consumed reservation cannot be swapped for another one, which would silently re-point the
  -- paid authority for an already-graded job.
  IF OLD.reservation_id IS NOT NULL AND NEW.reservation_id IS DISTINCT FROM OLD.reservation_id THEN
    RAISE EXCEPTION 'partner_card_jobs.reservation_id is immutable once set'
      USING ERRCODE = 'restrict_violation';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_partner_card_jobs_immutable_identity ON partner_card_jobs;
CREATE TRIGGER trg_partner_card_jobs_immutable_identity
  BEFORE UPDATE ON partner_card_jobs
  FOR EACH ROW EXECUTE FUNCTION partner_card_jobs_immutable_identity();
ALTER TABLE partner_card_jobs ENABLE ALWAYS TRIGGER trg_partner_card_jobs_immutable_identity;

-- ---------------------------------------------------------------------------------------------
-- PART 4 — the legal transition graph, enforced in the database
-- ---------------------------------------------------------------------------------------------
-- Partner lifecycle has until now been enforced only by ad-hoc guard clauses duplicated across
-- seven call sites in submission-service.ts, with the legal graph existing solely as a doc comment,
-- while `partner_runtime` holds UPDATE on the status column. HQ already has the equivalent DB guard
-- (migrations/status-transition-trigger.sql); Partner did not. This closes that asymmetry.
CREATE OR REPLACE FUNCTION partner_card_jobs_enforce_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  legal boolean := false;
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  -- Terminal means terminal. Nothing leaves COMPLETED or CANCELLED.
  IF OLD.status IN ('COMPLETED', 'CANCELLED') THEN
    RAISE EXCEPTION 'partner_card_jobs: % is terminal; no transition to % is permitted',
      OLD.status, NEW.status USING ERRCODE = 'restrict_violation';
  END IF;

  legal := (OLD.status, NEW.status) IN (
    ('CREDIT_RESERVED', 'NEEDS_SCAN'),
    ('NEEDS_SCAN',      'CAPTURING'),
    ('CAPTURING',       'READY_TO_GRADE'),
    ('CAPTURING',       'NEEDS_SCAN'),      -- capture session abandoned/expired
    -- FIX: a side was invalidated. Reachable from any state where evidence exists, and returns
    -- through CAPTURING. It mints no MV and no reservation — that is enforced by the fact that this
    -- trigger never touches those columns and PART 3 makes them immutable once set.
    ('NEEDS_SCAN',      'FIX_REQUIRED'),
    ('CAPTURING',       'FIX_REQUIRED'),
    ('READY_TO_GRADE',  'FIX_REQUIRED'),
    ('GRADING',         'FIX_REQUIRED'),
    ('FIX_REQUIRED',    'CAPTURING'),
    ('READY_TO_GRADE',  'GRADING'),
    ('GRADING',         'READY_TO_GRADE'),  -- grader released the card
    ('GRADING',         'SUBMITTED'),
    ('SUBMITTED',       'QA_REVIEW'),
    ('QA_REVIEW',       'GRADING'),         -- QA returned it
    ('QA_REVIEW',       'APPROVED'),
    ('APPROVED',        'PRINTABLE'),
    ('PRINTABLE',       'COMPLETED'),
    -- Cancellation is permitted ONLY before any capture work is accepted (pilot policy, plan §24
    -- OD-4 default). Later cancellation is a Super Admin workflow, not a partner self-service path,
    -- because past this point a credit has been consumed or evidence exists.
    ('CREDIT_RESERVED', 'CANCELLED'),
    ('NEEDS_SCAN',      'CANCELLED'),
    ('CAPTURING',       'CANCELLED')
  );

  IF NOT legal THEN
    RAISE EXCEPTION 'partner_card_jobs: illegal transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- READY_TO_GRADE is the gate the whole capture contract rests on, so it is asserted here rather
  -- than trusted to the caller: a job cannot become gradeable without a permanent identity.
  IF NEW.status = 'READY_TO_GRADE' AND NEW.certificate_id IS NULL THEN
    RAISE EXCEPTION 'partner_card_jobs: cannot reach READY_TO_GRADE without an allocated certificate'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_partner_card_jobs_enforce_transition ON partner_card_jobs;
CREATE TRIGGER trg_partner_card_jobs_enforce_transition
  BEFORE UPDATE OF status ON partner_card_jobs
  FOR EACH ROW EXECUTE FUNCTION partner_card_jobs_enforce_transition();
ALTER TABLE partner_card_jobs ENABLE ALWAYS TRIGGER trg_partner_card_jobs_enforce_transition;

-- ---------------------------------------------------------------------------------------------
-- PART 5 — tenant isolation (invariant I6)
-- ---------------------------------------------------------------------------------------------
-- ENABLE + FORCE + one tenant policy, identical to every other partner table. FORCE matters: without
-- it the table OWNER is exempt from its own policy. partner_runtime is NOBYPASSRLS, so knowing
-- another tenant's MV number still returns nothing.
ALTER TABLE partner_card_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_card_jobs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS partner_card_jobs_tenant_isolation ON partner_card_jobs;
CREATE POLICY partner_card_jobs_tenant_isolation ON partner_card_jobs
  USING (tenant_id = partner_current_tenant())
  WITH CHECK (tenant_id = partner_current_tenant());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_runtime') THEN
    -- No DELETE: business records are never hard-deleted (locked rule 17). Cancellation is a status
    -- transition with an audited reason, not a row removal.
    GRANT SELECT, INSERT, UPDATE ON public.partner_card_jobs TO partner_runtime;
  END IF;
END$$;
