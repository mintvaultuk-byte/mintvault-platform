# G5 Audit & Idempotency

## Audit (append-only)
Every mutation writes to `partner_management_audit` via the G4 `withAudit` two-row pattern: an `attempted` row before the write, a terminal `succeeded`/`failed`/`no_op` row after — sharing request_id + idempotency_key; actor (`actor_user_id`/`actor_email`) server-derived; `before_state`/`after_state` are SAFE JSON summaries (state strings + changed-field names, never secrets); `reason` required for status changes; `error_code`/`error_summary` from the mapped safe error on failure. Internal notes are their own append-only record (`partner_internal_notes`) AND emit a `note_added` audit row for the unified view.

## Immutability (DB-enforced)
`partner_internal_notes` + `partner_management_audit`: GRANT SELECT, INSERT to partner_connector_runtime only — UPDATE/DELETE/TRUNCATE reject 42501 (proven in the migration test); owner is pn_migrator; grantee privileges exactly [INSERT,SELECT]; PUBLIC none; partner_runtime has zero privilege (partner-isolation proven). The admin service NEVER issues UPDATE/DELETE against these (asserted: no edit/delete endpoint exists).

## Idempotency & concurrency
- Idempotency-key short-circuit (`priorSuccess`) + partial-unique `(idempotency_key) WHERE result='succeeded'` + `23505→alreadyCompleted` (no spurious failed row) — reused verbatim from G4, for retryable ops (note-add, status change).
- Optimistic locking: `expectedVersion` on profile/contact/branding edits; the aggregate version (partner_profiles.version for the partner; per-row version for contacts/branding) is re-checked under `UPDATE … WHERE version=$expected` (rowCount 0 → VERSION_CONFLICT). Contacts primary-uniqueness enforced by the partial-unique + a pre-check (DUPLICATE_PRIMARY_CONTACT). No lost updates; concurrent same-key ops converge.
- Ordering: G5 does its OWN writes (unlike G4 delegation), so each mutation runs the domain write + audit terminal in ONE transaction where atomicity matters (status change + audit; contact write + audit), so a failed write never leaves a false `succeeded` audit row.

## Redaction
No secrets/tokens/passwords/hashes/session data in any read projection, audit payload, error, or log. Tests seed secret-looking values and assert absence in API JSON + audit rows.
