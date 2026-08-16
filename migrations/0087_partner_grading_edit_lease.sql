-- ============================================================================================
-- 0087 — GRADING EDIT LEASE (P9)
--
-- THE GAP. Nothing anywhere in the repo prevents two graders opening the same Card Job and both
-- saving. `grep` for grading_lease / edit_lease returns nothing. Today the second save simply wins,
-- silently, and the first grader's assessment disappears without either of them being told — the
-- classic last-write-wins corruption, on a record that becomes a permanent published grade.
--
-- WHY A TABLE AND NOT AN IN-MEMORY MAP. A lease held in process memory would be lost on every
-- rolling deploy and invisible to the other Fly Machine, so two graders routed to different
-- machines would BOTH believe they held it. Invariant I19 forbids process-local authoritative
-- state, and an edit lease is authoritative by definition: it decides who may write.
--
-- WHY ONE PARTIAL UNIQUE INDEX RATHER THAN APPLICATION LOGIC. "At most one active editor per Card
-- Job" is an invariant, and an invariant enforced by a SELECT-then-INSERT is not enforced at all —
-- two concurrent acquires interleave between the read and the write. A UNIQUE index makes the
-- second one fail at the database, which is the only place it cannot be raced.
--
-- EXPIRY IS A TIMESTAMP, NOT A FLAG. A grader closing a laptop must not lock a card forever, and a
-- boolean cannot expire on its own. `expires_at` is advanced by the heartbeat; once it passes, the
-- lease is dead and reacquirable by anyone permitted — with no cleanup job required for correctness,
-- because every read compares against now().
--
-- REVISION IS THE SECOND, INDEPENDENT GUARD. The lease says who may write; `revision` says what they
-- were looking at. A grader who held the lease, lost it to an authorised takeover, and then
-- submitted a form loaded ten minutes ago must be refused — and the lease alone cannot catch that,
-- because by then they no longer hold it and the check would merely say "not the holder" when the
-- honest answer is "your copy is stale".
--
-- ADDITIVE: one new table, no change to any existing one. Old app versions ignore it entirely
-- (invariant I17) — they simply never acquire, which is exactly today's behaviour.
--
-- ROLLBACK: rollback-0087-partner-grading-edit-lease.sql drops the table. Losing it loses only the
-- concurrency protection, which fails OPEN to today's behaviour rather than blocking grading.
-- ============================================================================================

DO $$
BEGIN
  IF to_regclass('public.partner_card_jobs') IS NULL THEN
    RAISE EXCEPTION '0087 requires partner_card_jobs (migration 0080)';
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS partner_grading_leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT,
  card_job_id uuid NOT NULL,
  -- The human who may currently write. NOT a station: grading happens in a browser, and binding a
  -- lease to a Mac would stop a grader continuing on another machine after a crash.
  holder_user_id uuid NOT NULL,
  holder_display text,
  location_id uuid,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  -- Set when an authorised takeover ended this lease, so the audit trail can distinguish a grader
  -- who finished from one whose work was taken off them.
  taken_over_by uuid,
  taken_over_at timestamptz,
  /*
   * The editor's view of the card. Incremented on every accepted write, and compared on the next
   * one. Two graders cannot hold the lease at once, but a STALE holder — one whose lease expired or
   * was taken over while their browser sat open — can still POST an old form, and this is what
   * refuses it.
   */
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Composite identity so a cross-tenant reference is structurally impossible, matching the
  -- convention 0080/0082 established.
  CONSTRAINT uq_partner_grading_leases_identity UNIQUE (id, tenant_id),
  CONSTRAINT fk_partner_grading_leases_card_job
    FOREIGN KEY (card_job_id, tenant_id) REFERENCES partner_card_jobs (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT chk_partner_grading_leases_expiry CHECK (expires_at > acquired_at),
  CONSTRAINT chk_partner_grading_leases_takeover CHECK (
    (taken_over_by IS NULL AND taken_over_at IS NULL)
    OR (taken_over_by IS NOT NULL AND taken_over_at IS NOT NULL AND released_at IS NOT NULL)
  )
);

/*
 * THE INVARIANT, enforced where it cannot be raced: at most ONE live lease per Card Job.
 *
 * "Live" means not released and not expired. Expiry is deliberately NOT in the predicate — a
 * partial index cannot reference now(), because the index would have to be rebuilt continuously.
 * So the index enforces "one unreleased lease", and the SERVICE releases an expired one inside the
 * same transaction as the next acquire. That ordering is what makes an abandoned lease
 * reacquirable without a sweeper, and it is why acquisition must never be a bare INSERT.
 */
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_grading_leases_one_active
  ON partner_grading_leases (card_job_id)
  WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_partner_grading_leases_tenant
  ON partner_grading_leases (tenant_id, expires_at DESC);

-- ---------------------------------------------------------------------------------------------
-- RLS — the same shape every other tenant-owned partner table uses.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE partner_grading_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_grading_leases FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS partner_grading_leases_tenant_isolation ON partner_grading_leases;
CREATE POLICY partner_grading_leases_tenant_isolation ON partner_grading_leases
  USING (tenant_id = partner_current_tenant())
  WITH CHECK (tenant_id = partner_current_tenant());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_runtime') THEN
    -- No DELETE: a lease is evidence of who was editing what and when. It is RELEASED, never removed.
    GRANT SELECT, INSERT, UPDATE ON public.partner_grading_leases TO partner_runtime;
  END IF;
END$$;

-- ---------------------------------------------------------------------------------------------
-- Fail-closed assertions, in the same transaction as the change.
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.partner_grading_leases') IS NULL THEN
    RAISE EXCEPTION '0087 did not create partner_grading_leases';
  END IF;
  IF to_regclass('public.uq_partner_grading_leases_one_active') IS NULL THEN
    RAISE EXCEPTION '0087 did not create the one-active-lease invariant';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables WHERE tablename = 'partner_grading_leases' AND rowsecurity
  ) THEN
    RAISE EXCEPTION '0087: RLS is not enabled on partner_grading_leases';
  END IF;
END$$;
