-- Rollback for 0107. NARROWS uniqueness back to the key alone.
--
-- DESTRUCTIVE IN EFFECT: if any two rows share an idempotency_key across tenants or actions —
-- which 0107 deliberately permits — recreating the global index FAILS. Resolve those rows with the
-- owner before running this; do not delete audit rows to force it through, the ledger is
-- append-only by design.
DROP INDEX IF EXISTS uq_partner_management_audit_idem;

CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_management_audit_idem
  ON partner_management_audit(idempotency_key)
  WHERE idempotency_key IS NOT NULL AND result = 'succeeded';
