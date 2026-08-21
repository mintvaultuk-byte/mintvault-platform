-- 0107 — Scope the Partner management audit idempotency namespace to (tenant, action).
--
-- WHY
-- =============================================================================================
-- `partner_management_audit.idempotency_key` was a GLOBAL namespace: uq_partner_management_audit_idem
-- is unique on the key alone, and priorSuccess() matched on the key alone. That was safe only while
-- MintVault staff were the sole producers of a key.
--
-- First-shop onboarding added self-service Partner Owner routes that also write this ledger, so a
-- customer became a producer. A Partner-chosen key registered as 'succeeded' would then make a LATER
-- Super Admin mutation carrying the same key short-circuit to {ok:true, alreadyCompleted:true}
-- WITHOUT EXECUTING — including the containment actions: suspend partner, revoke invitation, reset
-- MFA, revoke sessions. The ledger is append-only and the index is unique-on-success, so the
-- collision would be permanent and unclearable from any UI.
--
-- The application now also namespaces customer-originated keys with the authenticated tenant
-- (server/partner/routes.ts, partnerOriginatedIdempotencyKey). This migration is the second,
-- independent defence: it makes the DATABASE incapable of expressing a cross-tenant or
-- cross-action replay match.
--
-- SAFETY
-- - This WIDENS uniqueness (key -> tenant + action + key). Every row that satisfied the old index
--   satisfies the new one, so no existing data can violate it and no backfill is required.
-- - Replacing a partial unique index requires DROP + CREATE; PostgreSQL cannot alter the key list
--   in place. Both run in this migration's own transaction, so the constraint is never absent
--   from a committed state.
-- - No row is read, rewritten or deleted.

DO $$
BEGIN
  IF to_regclass('public.partner_management_audit') IS NULL THEN
    RAISE EXCEPTION '0107 requires partner_management_audit from 0015';
  END IF;
END$$;

DROP INDEX IF EXISTS uq_partner_management_audit_idem;

CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_management_audit_idem
  ON partner_management_audit(tenant_id, action_type, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND result = 'succeeded';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname='public' AND tablename='partner_management_audit'
       AND indexname='uq_partner_management_audit_idem'
       AND indexdef LIKE '%tenant_id%' AND indexdef LIKE '%action_type%'
       AND indexdef LIKE '%idempotency_key%'
  ) THEN
    RAISE EXCEPTION '0107 did not scope the management-audit idempotency index to (tenant, action, key)';
  END IF;
END$$;
