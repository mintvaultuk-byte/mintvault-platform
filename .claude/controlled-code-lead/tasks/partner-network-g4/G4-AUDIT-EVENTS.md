# G4 Audit Events

## Table: `partner_connector_admin_actions` (migration 0014, append-only)
Written via the privileged admin pool (`partnerAdminQuery`). SELECT+INSERT grant to `partner_connector_runtime`, no UPDATE/DELETE/TRUNCATE, no PUBLIC. Supplementary admin ledger; the G3F service's own in-txn `partner_connector_events` row remains the authoritative per-record evidence.

Columns:
- `id uuid PK DEFAULT gen_random_uuid()`
- `partner_organisation_id uuid NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT` (nullable — some actions are record-scoped only / cross-cutting)
- `connector_record_id uuid NULL REFERENCES partner_connector_records(id) ON DELETE RESTRICT`
- `import_mapping_id uuid NULL REFERENCES partner_connector_imports(id) ON DELETE RESTRICT`
- `action_type text NOT NULL` CHECK in the deterministic set (below)
- `actor_user_id uuid NOT NULL` (server-derived `session.authUserId`)
- `actor_email text NOT NULL` (server-derived `session.adminEmail`)
- `request_id text NOT NULL`
- `idempotency_key text NULL`
- `before_state text NULL`, `after_state text NULL` (connector-record state strings; NOT full-row dumps)
- `reason text NOT NULL` (required for every mutation)
- `result text NOT NULL` CHECK IN ('attempted','succeeded','failed','no_op')
- `error_code text NULL` (safe `ConnectorError.code`), `error_summary text NULL` (safe non-leaking message)
- `created_at timestamptz NOT NULL DEFAULT now()`

Constraint: partial UNIQUE `(idempotency_key) WHERE idempotency_key IS NOT NULL AND result='succeeded'` — a completed action for an idempotency key is recorded once; reuse returns the recorded result.

Indexes (only real query paths): `(connector_record_id, created_at)` history lookup; `(partner_organisation_id, created_at)` partner audit view; partial unique on idempotency_key.

## action_type set (deterministic)
`retry_import, retry_interrupted, resume_reserved, request_revalidation, request_reconciliation, reconcile_retain, reconcile_retry, reconcile_mark_manual, manual_review_retry, manual_review_cancel, ack_permanent_failure, release_expired_claim, batch_retry`.

Emitted by the current service: `request_revalidation` (opRequestRevalidation), `request_reconciliation` (opRequestReconciliation), `resume_reserved` / `retry_interrupted` (opRetryRecord, per dispatched recovery service), `reconcile_mark_manual` (opMarkManualReview), `manual_review_retry` / `manual_review_cancel` (opResolveManualReview), `ack_permanent_failure` (opAckPermanentFailure), `release_expired_claim` (opReleaseExpiredClaim). The remainder (`retry_import`, `reconcile_retain`, `reconcile_retry`, `batch_retry`) are reserved forward values in the CHECK set for later operations.

## Recording protocol (two-pool split)
1. Before delegating: INSERT a row `result='attempted'` with before_state, action_type, actor, request_id, idempotency_key, reason (own admin-pool txn — commits so the attempt is durable even if the service call dies).
2. Call the G3F service (its own connector-pool txn; writes the authoritative `partner_connector_events`).
3. After: INSERT a terminal row `result IN ('succeeded'|'failed'|'no_op')` with after_state + error_code/summary on failure. (Append-only → a second row, not an update. The pair (attempted, terminal) shares request_id.)

## Redaction
- No secrets/tokens/passwords/connection-strings/full source payloads/raw headers in any column.
- `before_state`/`after_state` are state STRINGS only. `error_code`/`error_summary` come from `ConnectorError`/`IMPORT_ERROR_GUIDANCE` (already non-leaking). `reason` is admin free-text (operator-authored; not provider data).
- Tests seed secret-looking connector config and assert none appears in any admin-actions row.

## Proven by tests
Every mutation produces ≥1 admin-actions row with correct actor/action/before/after/result; failed mutation records a `failed` terminal row with a safe code; runtime role cannot UPDATE/DELETE rows (42501); idempotency-key reuse returns the recorded success without a second effect; no secret in payload.
