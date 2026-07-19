-- 0011_partner_connector_reconciliation.sql
-- Trusted Intake Connector — Phase G3E: reconciliation state widening.
--
-- Additive only. Widens partner_connector_records.state to permit two new states:
-- 'reconciliation_required' (an ambiguous state the automatic reconciliation engine could not
-- safely resolve on its own) and 'manual_review' (requires an explicit, reasoned, audited human
-- action to exit). Neither state is a new terminal state — both have defined recoverable exits (see
-- .claude/controlled-code-lead/tasks/partner-network-connector-g3e-g3f/RECONCILIATION-RUNBOOK.md).
--
-- No new table. partner_connector_imports (migration 0010) already has reconciled_at/
-- last_safe_error_code columns with UPDATE granted to partner_connector_runtime — this pass is the
-- first to actually write them, no new grant needed. Reconciliation-action audit trail reuses the
-- existing partner_connector_events table (actor_id + metadata jsonb), no new event table.
--
-- Same idempotent drop-then-recreate-under-a-DO-block idiom migrations 0006/0007/0009/0010 already
-- use (the destructive-SQL linter strips dollar-quoted bodies before pattern-matching a bare
-- top-level DROP CONSTRAINT).

DO $$
BEGIN
  EXECUTE 'ALTER TABLE partner_connector_records DROP CONSTRAINT IF EXISTS chk_partner_connector_records_state';
  EXECUTE $c$ALTER TABLE partner_connector_records ADD CONSTRAINT chk_partner_connector_records_state
    CHECK (state IN ('queued','claimed','validating','ready_for_import','importing','reconciliation_required','manual_review','rejected','failed','cancelled','imported'))$c$;
END$$;
