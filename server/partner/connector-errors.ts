/**
 * Trusted Intake Connector (Phase G1) — structured, safe error model. No raw SQL, no stack traces,
 * no secrets, no unnecessary personal data ever leaves connector-service.ts through this type.
 */

export const CONNECTOR_ERROR_CODES = [
  "feature_disabled",
  "emergency_stop",
  "handoff_not_found",
  "handoff_not_ready",
  "unauthorised",
  "invalid_state_transition",
  "already_claimed",
  "stale_claim",
  "idempotency_conflict",
  "validation_pending",
  "transient_database_error",
  "permanent_processing_error",
  "cancelled",
  // G3 — exactly-once import.
  "import_not_ready",
  "import_claim_required",
  "import_claim_expired",
  "import_claimant_mismatch",
  "import_version_conflict",
  "import_validation_missing",
  "import_validation_invalid",
  "import_blocking_findings",
  "import_source_stale",
  "import_mapping_conflict",
  "import_destination_conflict",
  "import_destination_missing",
  "import_owner_resolution_failed",
  "import_service_mapping_missing",
  "import_service_mapping_stale",
  "import_reference_allocation_failed",
  "import_submission_creation_failed",
  "import_item_creation_failed",
  "import_reconciliation_required",
  "import_already_completed",
  "import_cancelled",
  "import_emergency_stopped",
  "unknown_import_error",
] as const;
export type ConnectorErrorCode = (typeof CONNECTOR_ERROR_CODES)[number];

/** Every code's default retryability — callers may override per-call where the spec requires it. */
const RETRYABLE_BY_CODE: Record<ConnectorErrorCode, boolean> = {
  feature_disabled: false,
  emergency_stop: false,
  handoff_not_found: false,
  handoff_not_ready: false,
  unauthorised: false,
  invalid_state_transition: false,
  already_claimed: true, // another claimant may release/expire soon
  stale_claim: true,
  idempotency_conflict: false,
  validation_pending: true,
  transient_database_error: true,
  permanent_processing_error: false,
  cancelled: false,
  // G3 — exactly-once import. Non-retryable = the caller must act (revalidate, re-authenticate,
  // escalate) before trying again; retryable = a bare retry may succeed with no other change.
  import_not_ready: false, // wrong state — caller must wait for/drive validation first
  import_claim_required: false,
  import_claim_expired: true, // caller may reclaim and retry
  import_claimant_mismatch: false,
  import_version_conflict: true, // caller may re-read and retry with the current version
  import_validation_missing: false, // must validate first
  import_validation_invalid: false, // must fix + revalidate first
  import_blocking_findings: false, // must fix + revalidate first
  import_source_stale: false, // must revalidate first; already routes the connector back to validating
  import_mapping_conflict: true, // a concurrent importer may finish momentarily — re-read and retry
  import_destination_conflict: false, // genuine data conflict, needs investigation
  import_destination_missing: false, // reconciliation_required, not a bare retry
  import_owner_resolution_failed: true, // transient DB issue on the resolution step
  import_service_mapping_missing: false, // configuration gap, not transient
  import_service_mapping_stale: false, // must revalidate first
  import_reference_allocation_failed: true, // bounded retry already attempted internally; caller may retry the whole call once more
  import_submission_creation_failed: true, // whole transaction rolled back cleanly; safe to retry
  import_item_creation_failed: true, // whole transaction rolled back cleanly; safe to retry
  import_reconciliation_required: false, // needs human review, never a bare retry
  import_already_completed: false, // not an error state — caller should treat the returned destination as success
  import_cancelled: false,
  import_emergency_stopped: false,
  unknown_import_error: true,
};

/**
 * Safe, non-leaking public/internal message + operator-action hint for every G3 import error code —
 * separate from the ConnectorError's own `message` (which may be more specific/internal), this is
 * what a caller-facing surface (a future G4 admin UI, or a test assertion) should actually display.
 * No raw SQL, table name, or stack text appears in any of these strings.
 */
export const IMPORT_ERROR_GUIDANCE: Partial<
  Record<ConnectorErrorCode, { publicMessage: string; operatorAction: string; requiresReconciliation: boolean }>
> = {
  import_not_ready: {
    publicMessage: "This record is not ready for import.",
    operatorAction: "Wait for validation to complete, or trigger it if not yet started.",
    requiresReconciliation: false,
  },
  import_claim_required: {
    publicMessage: "This record must be claimed before it can be imported.",
    operatorAction: "Claim the record, then retry the import.",
    requiresReconciliation: false,
  },
  import_claim_expired: {
    publicMessage: "The processing claim on this record has expired.",
    operatorAction: "Reclaim the record and retry.",
    requiresReconciliation: false,
  },
  import_claimant_mismatch: {
    publicMessage: "Only the current claimant may import this record.",
    operatorAction: "Use the correct claimant identity, or release and reclaim the record.",
    requiresReconciliation: false,
  },
  import_version_conflict: {
    publicMessage: "This record changed since it was last read.",
    operatorAction: "Re-read the record's current state and retry with the current version.",
    requiresReconciliation: false,
  },
  import_validation_missing: {
    publicMessage: "No completed validation exists for this record.",
    operatorAction: "Run validation before attempting import.",
    requiresReconciliation: false,
  },
  import_validation_invalid: {
    publicMessage: "The most recent validation did not pass.",
    operatorAction: "Resolve the reported findings and revalidate.",
    requiresReconciliation: false,
  },
  import_blocking_findings: {
    publicMessage: "The most recent validation has unresolved blocking findings.",
    operatorAction: "Resolve the reported findings and revalidate.",
    requiresReconciliation: false,
  },
  import_source_stale: {
    publicMessage: "The source data has changed since it was last validated.",
    operatorAction: "Revalidate before attempting import again.",
    requiresReconciliation: false,
  },
  import_mapping_conflict: {
    publicMessage: "Another import attempt for this record is already in progress or complete.",
    operatorAction: "Re-check the record's status; a concurrent attempt may already have succeeded.",
    requiresReconciliation: false,
  },
  import_destination_conflict: {
    publicMessage: "A conflicting destination record already exists.",
    operatorAction: "Escalate for manual review — do not retry blindly.",
    requiresReconciliation: true,
  },
  import_destination_missing: {
    publicMessage: "The recorded destination could not be found.",
    operatorAction: "Escalate for manual reconciliation.",
    requiresReconciliation: true,
  },
  import_owner_resolution_failed: {
    publicMessage: "Could not resolve the destination owner for this import.",
    operatorAction: "Retry; if this persists, escalate for manual review.",
    requiresReconciliation: false,
  },
  import_service_mapping_missing: {
    publicMessage: "No service mapping is configured for this record's service tier.",
    operatorAction: "Configure the missing mapping, then retry.",
    requiresReconciliation: false,
  },
  import_service_mapping_stale: {
    publicMessage: "The service mapping changed since this record was validated.",
    operatorAction: "Revalidate before attempting import again.",
    requiresReconciliation: false,
  },
  import_reference_allocation_failed: {
    publicMessage: "Could not allocate a unique destination reference.",
    operatorAction: "Retry; if this persists across multiple attempts, escalate.",
    requiresReconciliation: false,
  },
  import_submission_creation_failed: {
    publicMessage: "Could not create the destination submission.",
    operatorAction: "Retry; the failed attempt created nothing (transaction rolled back).",
    requiresReconciliation: false,
  },
  import_item_creation_failed: {
    publicMessage: "Could not create the destination submission's item rows.",
    operatorAction: "Retry; the failed attempt created nothing (transaction rolled back).",
    requiresReconciliation: false,
  },
  import_reconciliation_required: {
    publicMessage: "This import requires manual reconciliation before it can proceed.",
    operatorAction: "Escalate for manual review — do not retry.",
    requiresReconciliation: true,
  },
  import_already_completed: {
    publicMessage: "This record has already been imported.",
    operatorAction: "No action needed — use the existing destination.",
    requiresReconciliation: false,
  },
  import_cancelled: {
    publicMessage: "This record was cancelled and cannot be imported.",
    operatorAction: "No action possible — the source submission was cancelled.",
    requiresReconciliation: false,
  },
  import_emergency_stopped: {
    publicMessage: "The connector is stopped.",
    operatorAction: "Wait for the emergency stop to be lifted.",
    requiresReconciliation: false,
  },
  unknown_import_error: {
    publicMessage: "An internal error occurred while importing this record.",
    operatorAction: "Retry; if this persists, escalate for investigation.",
    requiresReconciliation: false,
  },
};

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  readonly retryable: boolean;

  constructor(code: ConnectorErrorCode, message: string, retryable?: boolean) {
    super(message);
    this.code = code;
    this.retryable = retryable ?? RETRYABLE_BY_CODE[code];
  }
}

/**
 * Normalise ANY thrown value (including raw pg errors) into a ConnectorError. Never rethrows the
 * original error's message/stack — unknown failures collapse to a generic, retryable code so a
 * caller can never learn table/column names or SQL text from a connector call.
 */
export function toConnectorError(err: unknown): ConnectorError {
  if (err instanceof ConnectorError) return err;
  return new ConnectorError("transient_database_error", "An internal connector error occurred.", true);
}
