-- Project Control — durable live-evidence backbone.
--
-- ADDITIVE ONLY. Creates four brand-new `pc_*` tables plus their indexes and one trigger. It does
-- NOT touch migration 0030's nine tables, nor any existing table, column, constraint or row.
-- There is no backfill, no rename, no drop. Reverting drops only these four objects
-- (migrations/rollback-0039-project-control-live-evidence.sql).
--
-- MIGRATION NUMBER: 0039. Verified free across every local and remote ref: the highest number
-- allocated anywhere is 0038 (NFC UID uniqueness, on an unmerged grading branch). The gaps at
-- 0025 and 0027-0029 are deliberately NOT reused — the runner applies present files in numeric
-- order and has no monotonicity check, so a number below the applied watermark would run AFTER
-- migrations numbered above it on any database that is already ahead. Allocating above the
-- watermark makes the order unambiguous whatever lands first.
--
-- SAFETY: every statement is IF NOT EXISTS or guarded, so re-running is a no-op. No CONCURRENTLY,
-- so it runs inside the runner's default transaction.
--
-- WHY THIS EXISTS
-- ---------------
-- The live-evidence sources (GitHub, application probes, migration ledger, feature flags) have
-- been computing their answers per request and holding them in module-level process caches. That
-- is not coordination: production runs TWO Fly machines, so two operators can see different
-- evidence, a "refresh" can appear to do nothing, and nothing survives a restart. There is also
-- no history — no way to ask "when did staging start running this commit?".
--
-- These four tables make the evidence durable, shared and append-only:
--
--   pc_sync_runs         one row per attempt, successful or not. The audit ledger.
--   pc_sync_leases       cross-machine single-flight, with expiry so a crash cannot block forever.
--   pc_sync_checkpoints  per-source continuation state (ETags, cursors) so a repeat sync is cheap.
--   pc_evidence_snapshots  immutable observations. Append-only, enforced by trigger.
--
-- THE RULE THE SCHEMA ENFORCES
-- ----------------------------
-- A failed sync must never destroy the last good evidence. Snapshots are INSERT-only: a failure
-- writes a new row recording the failure, it does not overwrite or delete the successful row
-- before it. "What do we know?" is therefore always "the newest snapshot per (source, environment,
-- entity)", and a bad sync can only ever add a row saying it went wrong.
--
-- NO EXPLICIT TRANSACTION HERE, DELIBERATELY.
--
-- The runner (scripts/db/migrate.ts) already wraps each transaction-safe file in ONE transaction
-- together with the `schema_migrations` row that records it. A `BEGIN;`/`COMMIT;` inside the file
-- commits the runner's transaction early, so the journal INSERT then runs in autocommit and the
-- DDL is no longer atomic with its own ledger entry — a torn apply becomes possible, and the
-- runner's ROLLBACK becomes a no-op for everything above the stray COMMIT. This is the same
-- defect found in 0033 during review and pinned against 0034 by
-- tests/partner-rbac-migration.test.ts.

-- ── pc_sync_runs ────────────────────────────────────────────────────────────────────────────
-- One row per sync attempt. Never updated except to close out the run it describes.
CREATE TABLE IF NOT EXISTS pc_sync_runs (
  id              BIGSERIAL PRIMARY KEY,
  sync_id         TEXT        NOT NULL,
  source_type     TEXT        NOT NULL,
  trigger_type    TEXT        NOT NULL,
  -- Actor for manual runs; NULL for scheduled ones. An email, never a credential.
  actor           TEXT,
  target          TEXT        NOT NULL,
  environment     TEXT,
  state           TEXT        NOT NULL DEFAULT 'QUEUED',
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  checkpoint_before TEXT,
  checkpoint_after  TEXT,
  rate_limit_remaining INTEGER,
  rate_limit_reset_at  TIMESTAMPTZ,
  counts          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  warnings        JSONB       NOT NULL DEFAULT '[]'::jsonb,
  -- A short stable code, never a raw exception and never a URL.
  error_code      TEXT,
  payload_digest  TEXT,
  -- Which machine ran it. Lets an operator tell the two Fly machines apart.
  worker_identity TEXT,
  CONSTRAINT pc_sync_runs_sync_id_key UNIQUE (sync_id),
  CONSTRAINT pc_sync_runs_state_check CHECK (
    state IN ('QUEUED','RUNNING','SUCCEEDED','PARTIAL','FAILED','RATE_LIMITED','UNAVAILABLE','CANCELLED','EXPIRED')
  ),
  CONSTRAINT pc_sync_runs_trigger_check CHECK (trigger_type IN ('manual','scheduled','startup'))
);

CREATE INDEX IF NOT EXISTS idx_pc_sync_runs_source_requested
  ON pc_sync_runs (source_type, requested_at DESC);
-- Finding the current run, and the last successful one, are the two hot reads.
CREATE INDEX IF NOT EXISTS idx_pc_sync_runs_state
  ON pc_sync_runs (source_type, state, requested_at DESC);

-- ── pc_sync_leases ──────────────────────────────────────────────────────────────────────────
-- Cross-machine single-flight. One row per source; the PRIMARY KEY is what makes it exclusive.
--
-- A lease is claimed by inserting, or by taking over a row whose expires_at has passed. The owner
-- token proves ownership on release, so a slow machine cannot release a lease that a second
-- machine has already taken over after expiry.
CREATE TABLE IF NOT EXISTS pc_sync_leases (
  source_type  TEXT        PRIMARY KEY,
  owner_token  TEXT        NOT NULL,
  sync_id      TEXT        NOT NULL,
  acquired_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Expiry is the crash-recovery mechanism: a process that dies holding a lease blocks nothing
  -- past this point. Without it a single crash would wedge sync permanently.
  expires_at   TIMESTAMPTZ NOT NULL,
  worker_identity TEXT
);

CREATE INDEX IF NOT EXISTS idx_pc_sync_leases_expiry ON pc_sync_leases (expires_at);

-- ── pc_sync_checkpoints ─────────────────────────────────────────────────────────────────────
-- Per-source, per-resource continuation state. ETags live here so a repeat sync can send
-- If-None-Match and spend no rate-limit quota on unchanged data.
CREATE TABLE IF NOT EXISTS pc_sync_checkpoints (
  id           BIGSERIAL PRIMARY KEY,
  source_type  TEXT        NOT NULL,
  resource_key TEXT        NOT NULL,
  etag         TEXT,
  cursor_value TEXT,
  observed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  sync_id      TEXT,
  CONSTRAINT pc_sync_checkpoints_unique UNIQUE (source_type, resource_key)
);

-- ── pc_evidence_snapshots ───────────────────────────────────────────────────────────────────
-- Immutable observations. APPEND ONLY — see the trigger below.
CREATE TABLE IF NOT EXISTS pc_evidence_snapshots (
  id             BIGSERIAL PRIMARY KEY,
  source_type    TEXT        NOT NULL,
  environment    TEXT,
  entity_type    TEXT        NOT NULL,
  entity_id      TEXT        NOT NULL,
  commit_sha     TEXT,
  status         TEXT,
  freshness      TEXT        NOT NULL DEFAULT 'CURRENT',
  confidence     TEXT        NOT NULL DEFAULT 'machine',
  observed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- After this instant the observation is STALE. Null means "no expiry defined".
  valid_until    TIMESTAMPTZ,
  -- The redacted payload as observed. Never contains a secret value; the writer redacts.
  payload        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  payload_digest TEXT        NOT NULL,
  sync_id        TEXT,
  stale_reason   TEXT,
  CONSTRAINT pc_evidence_snapshots_freshness_check CHECK (
    freshness IN ('CURRENT','STALE','UNKNOWN','UNAVAILABLE','CONTRADICTORY','FAILED')
  )
);

-- The hot query is "newest snapshot for this (source, environment, entity)".
CREATE INDEX IF NOT EXISTS idx_pc_evidence_latest
  ON pc_evidence_snapshots (source_type, environment, entity_type, entity_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_pc_evidence_sync ON pc_evidence_snapshots (sync_id);
CREATE INDEX IF NOT EXISTS idx_pc_evidence_observed ON pc_evidence_snapshots (observed_at DESC);

-- ── Append-only enforcement ─────────────────────────────────────────────────────────────────
--
-- The honesty guarantee of the whole dashboard rests on this: a failed or hostile sync can ADD a
-- row saying something went wrong, but it can never rewrite or remove the successful observation
-- that came before. Enforced in the database rather than in application code, so it holds for
-- every writer including a future one that forgets.
CREATE OR REPLACE FUNCTION pc_evidence_snapshots_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'pc_evidence_snapshots is append-only: % is not permitted. Record a new observation instead.', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pc_evidence_snapshots_append_only ON pc_evidence_snapshots;
CREATE TRIGGER trg_pc_evidence_snapshots_append_only
  BEFORE UPDATE OR DELETE ON pc_evidence_snapshots
  FOR EACH ROW EXECUTE FUNCTION pc_evidence_snapshots_append_only();

-- ── Completeness assertion ──────────────────────────────────────────────────────────────────
-- Do not trust the DDL's exit status; re-read the catalogue. A migration that reports success
-- while an object is missing is the failure mode this repo has already been bitten by.
DO $$
DECLARE
  missing TEXT := '';
BEGIN
  IF to_regclass('public.pc_sync_runs') IS NULL THEN missing := missing || 'pc_sync_runs '; END IF;
  IF to_regclass('public.pc_sync_leases') IS NULL THEN missing := missing || 'pc_sync_leases '; END IF;
  IF to_regclass('public.pc_sync_checkpoints') IS NULL THEN missing := missing || 'pc_sync_checkpoints '; END IF;
  IF to_regclass('public.pc_evidence_snapshots') IS NULL THEN missing := missing || 'pc_evidence_snapshots '; END IF;
  IF missing <> '' THEN
    RAISE EXCEPTION '0039 incomplete: missing %', missing;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_pc_evidence_snapshots_append_only'
  ) THEN
    RAISE EXCEPTION '0039 incomplete: the append-only trigger is absent, so evidence history is not protected.';
  END IF;

  RAISE NOTICE '0039 complete: 4 tables, 7 indexes, 1 append-only trigger.';
END $$;
