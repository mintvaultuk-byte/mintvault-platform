# G4 API Contract

Namespace: `/api/super-admin/connector-ops`. All routes `requireAdmin`. Explicit G4 rate-limiter (stateless/DB-backed, not a new in-process store) applied at the router. CSRF handled globally. Responses: reads return flat JSON objects/arrays; mutations return `{ ok: true, result: <ImportOutcome|action-summary>, requestId }`; errors return `{ error: { code, message, requestId } }` with a stable code (below) and safe message (from `IMPORT_ERROR_GUIDANCE` where applicable). No raw SQL/stack ever returned.

## Read endpoints
- `GET  /partners?search=&status=&page=&pageSize=` → `{ partners:[{id, legalName, status, accreditationLevel, health, connectorCount, needsReviewCount, reconciliationRequiredCount, recentActivityAt}], page, pageSize, total, totalPages }`
- `GET  /partners/:partnerId` → `{ partner, connectorSummary, queueSummary, unresolvedManualReviews, reconciliationRequiredCount, recentActions[] }`
- `GET  /records?partnerId=&state=&reconciliationRequired=&manualReview=&stale=&failed=&interrupted=&search=&page=&pageSize=` → paginated record rows (deterministic ORDER BY updated_at DESC, id ASC)
- `GET  /records/:recordId` → `{ record, partner, validationRuns[], latestValidation, ownerResolution, importState, mapping, destination, attempts[], reconciliationFindings[], manualReviewState, adminActions[] }` (redacted)
- `GET  /records/:recordId/attempts?page=&pageSize=` → append-only attempts (via `getImportAttempts`), deterministic pagination
- `GET  /records/:recordId/mapping` → source→destination mapping + exactly-once identifiers
- `GET  /worker/status` → `{ featureEnabled(read-only), emergencyStop(read-only), connectorCounts, eligibleCount, claimedCount, expiredClaims, reconciliationRequiredCount, manualReviewCount, configuredWorkerLimit, retryCounters, lastProcessingAt }`
- `GET  /metrics` → aggregated internal metrics only (counts by state, throughput windows) — no high-cardinality/personal data

## Mutation endpoints (all: body requires `reason`; `requestId` accepted or generated; `idempotencyKey` optional; `expectedVersion` where noted)
- `POST /records/:recordId/retry` → `importValidatedConnector` (or `recoverInterruptedImport`/`recoverReservedImport` selected by current state)
- `POST /records/:recordId/reconcile` → `reconcileConnector`
- `POST /records/:recordId/reconcile/resolve` body `{ resolution: 'retain'|'retry'|'mark_manual', reason }` → `completeFromExistingDestination` | `recoverReservedImport` | `markManualReview`
- `POST /records/:recordId/manual-review/resolve` body `{ resolution: 'retry'|'cancel', reason, expectedVersion }` → `resolveManualReview`
- `POST /records/:recordId/ack-failure` body `{ reason, expectedVersion }` → `acknowledgePermanentFailure`
- `POST /records/:recordId/release-claim` body `{ reason }` → `recoverExpiredImportClaim` (expired lease only)
- `POST /records/batch-retry` body `{ recordIds:[...] (≤25), reason }` → bounded loop; per-record results

## Deferred endpoints (documented; NOT implemented this pass)
`POST /connector/:id/pause|resume|disable`, `POST /connector/global-stop` — return not-implemented-by-design in the contract; visibility only via `GET /worker/status`.

## Stable error codes
`UNAUTHENTICATED, FORBIDDEN, PARTNER_NOT_FOUND, CONNECTOR_NOT_FOUND, CONNECTOR_RECORD_NOT_FOUND, INVALID_STATE_TRANSITION, RECORD_ALREADY_COMPLETED, MANUAL_REVIEW_REQUIRED, RECONCILIATION_REQUIRED, CONNECTOR_PAUSED(reserved/unused this pass), CONNECTOR_DISABLED, GLOBAL_PROCESSING_DISABLED, RETRY_NOT_ALLOWED, OPERATION_CONFLICT, IDEMPOTENCY_CONFLICT, REQUEST_ALREADY_COMPLETED, VALIDATION_FAILED, TRANSIENT_DATABASE_ERROR, INTERNAL_ERROR`. Mapped from `ConnectorError.code` via a G4 code map; unknown → INTERNAL_ERROR with safe message + requestId.
