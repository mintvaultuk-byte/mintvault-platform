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
