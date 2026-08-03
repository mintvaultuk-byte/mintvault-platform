/**
 * G4 Super-Admin connector operations — service layer.
 *
 * The ONLY place G4 business orchestration lives (routes are thin). Two responsibilities:
 *  - READS: deterministic, bounded, parameterised cross-tenant queries via the privileged admin pool
 *    (partnerAdminQuery) — the same connection the existing super-admin shell uses. No connector
 *    business logic is re-implemented; reads are display projections only.
 *  - MUTATIONS: every operator action DELEGATES to an existing, audited, idempotent G3F service
 *    (import / reconciliation / claim), never re-implementing import/claim/reconciliation logic. Each
 *    mutation is wrapped in an append-only admin-action audit (attempt row before, terminal row
 *    after) and preserves exactly-once, provenance, and validation/import history untouched.
 *
 * Actor identity is always server-derived (never from the request body). Secrets are never returned
 * (reads project explicit safe columns only). Connector runtime errors are mapped to stable G4 codes
 * via toG4Error and never leak SQL/stack text.
 */
import { partnerAdminQuery, withPartnerAdminTransaction } from "./db";
import {
  getConnectorImport,
  getImportAttempts,
  getImportedDestination,
  type ImportAttemptRecord,
} from "./connector-import-service";
import { getLatestValidationRun, requestConnectorRevalidation } from "./connector-validation-service";
import {
  reconcileConnector,
  recoverReservedImport,
  recoverInterruptedImport,
  recoverExpiredImportClaim,
  markManualReview,
  resolveManualReview,
  acknowledgePermanentFailure,
  inspectConnectorConsistency,
} from "./connector-reconciliation-service";
import { G4RequestError } from "./connector-admin-errors";
import {
  partnerCreditSchemaState,
  assertPartnerCreditLifecycleReady,
  PartnerSubmissionCreditLifecycleError,
  recoverPartnerDestinationCreditHold,
} from "./partner-submission-credit-lifecycle";

export interface ActorContext {
  actorUserId: string;
  actorEmail: string;
  requestId: string;
  idempotencyKey?: string;
}

/** The claimant identity a G4 operator presents to the connector services. */
function claimantOf(actor: ActorContext): string {
  return `g4:${actor.actorUserId}`;
}

// ---------------------------------------------------------------------------
// Record lookup (admin pool) — tenant/version/state needed by every mutation.
// ---------------------------------------------------------------------------
interface RecordRow {
  id: string;
  tenant_id: string;
  state: string;
  version: number;
  partner_submission_id: string;
  handoff_id: string;
  attempt_count: number;
  claimed_by: string | null;
  claim_expires_at: string | null;
  next_retry_at: string | null;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
}

async function loadRecord(recordId: string): Promise<RecordRow> {
  const { rows } = await partnerAdminQuery<RecordRow>(
    `SELECT id, tenant_id, state, version, partner_submission_id, handoff_id, attempt_count,
            claimed_by, claim_expires_at, next_retry_at, last_error_code, created_at, updated_at
       FROM partner_connector_records WHERE id = $1`,
    [recordId]
  );
  if (rows.length === 0) throw new G4RequestError("CONNECTOR_RECORD_NOT_FOUND", "Connector record not found.");
  return rows[0];
}

// ---------------------------------------------------------------------------
// Audit (append-only, admin pool) — attempt row before, terminal row after.
// ---------------------------------------------------------------------------
type AdminActionType =
  | "retry_import"
  | "retry_interrupted"
  | "resume_reserved"
  | "request_revalidation"
  | "request_reconciliation"
  | "reconcile_retain"
  | "reconcile_retry"
  | "reconcile_mark_manual"
  | "manual_review_retry"
  | "manual_review_cancel"
  | "ack_permanent_failure"
  | "release_expired_claim"
  | "batch_retry";

async function recordAttempt(
  actor: ActorContext,
  actionType: AdminActionType,
  rec: { id: string | null; tenant_id: string | null; state: string | null }
): Promise<void> {
  await partnerAdminQuery(
    `INSERT INTO partner_connector_admin_actions
       (partner_organisation_id, connector_record_id, action_type, actor_user_id, actor_email,
        request_id, idempotency_key, before_state, reason, result)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'attempted')`,
    [
      rec.tenant_id,
      rec.id,
      actionType,
      actor.actorUserId,
      actor.actorEmail,
      actor.requestId,
      actor.idempotencyKey ?? null,
      rec.state,
      "__attempt__",
    ]
  );
}

async function recordTerminal(
  actor: ActorContext,
  actionType: AdminActionType,
  rec: { id: string | null; tenant_id: string | null; after_state: string | null },
  reason: string,
  result: "succeeded" | "failed" | "no_op",
  error?: { code: string; summary: string }
): Promise<void> {
  await partnerAdminQuery(
    `INSERT INTO partner_connector_admin_actions
       (partner_organisation_id, connector_record_id, action_type, actor_user_id, actor_email,
        request_id, idempotency_key, after_state, reason, result, error_code, error_summary)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      rec.tenant_id,
      rec.id,
      actionType,
      actor.actorUserId,
      actor.actorEmail,
      actor.requestId,
      actor.idempotencyKey ?? null,
      rec.after_state,
      reason,
      result,
      error?.code ?? null,
      error?.summary ?? null,
    ]
  );
}

/** Idempotency short-circuit: a prior succeeded terminal row for this key returns without re-acting. */
async function priorSuccess(idempotencyKey: string | undefined): Promise<boolean> {
  if (!idempotencyKey) return false;
  const { rows } = await partnerAdminQuery(
    `SELECT 1 FROM partner_connector_admin_actions WHERE idempotency_key = $1 AND result = 'succeeded' LIMIT 1`,
    [idempotencyKey]
  );
  return rows.length > 0;
}

/**
 * Wrap a mutation: idempotency check → attempt row → delegate to the G3F service → terminal row.
 * Errors are recorded as a failed terminal row and rethrown (the route maps them to a G4 envelope).
 */
async function withAudit<T>(
  actor: ActorContext,
  actionType: AdminActionType,
  recordId: string,
  reason: string,
  delegate: (rec: RecordRow) => Promise<T>
): Promise<{ result: T; alreadyCompleted: boolean } | { result: null; alreadyCompleted: true }> {
  if (await priorSuccess(actor.idempotencyKey)) {
    return { result: null, alreadyCompleted: true };
  }
  const rec = await loadRecord(recordId);
  await recordAttempt(actor, actionType, rec);
  try {
    const result = await delegate(rec);
    const after = await partnerAdminQuery<{ state: string }>(
      `SELECT state FROM partner_connector_records WHERE id = $1`,
      [recordId]
    );
    await recordTerminal(
      actor,
      actionType,
      { id: rec.id, tenant_id: rec.tenant_id, after_state: after.rows[0]?.state ?? null },
      reason,
      "succeeded"
    );
    return { result, alreadyCompleted: false };
  } catch (err) {
    // Concurrency: two same-idempotency-key requests can both pass priorSuccess and both delegate;
    // the second succeeded-terminal INSERT hits the partial-unique (pg 23505). The delegate already
    // completed and another request recorded the canonical success, so this is an idempotent replay,
    // not a failure — return alreadyCompleted WITHOUT writing a spurious 'failed' row. (Any raw 23505
    // reaching here is from recordTerminal's succeeded INSERT: the G3F delegates surface only
    // ConnectorError, never a raw pg error.)
    if ((err as { code?: string }).code === "23505") {
      return { result: null, alreadyCompleted: true };
    }
    const { toG4Error } = await import("./connector-admin-errors");
    const g4 = toG4Error(err);
    await recordTerminal(
      actor,
      actionType,
      { id: rec.id, tenant_id: rec.tenant_id, after_state: null },
      reason,
      "failed",
      {
        code: g4.connectorCode ?? g4.code,
        summary: g4.message,
      }
    );
    throw err;
  }
}

// ---------------------------------------------------------------------------
// MUTATIONS (Phase 7) — each delegates to exactly one G3F service.
// ---------------------------------------------------------------------------
export async function opRequestRevalidation(
  actor: ActorContext,
  recordId: string,
  reason: string,
  expectedVersion: number
) {
  return withAudit(actor, "request_revalidation", recordId, reason, async (rec) => {
    await requestConnectorRevalidation({
      connectorId: rec.id,
      claimant: claimantOf(actor),
      expectedVersion,
      tenantId: rec.tenant_id,
    });
    return { revalidationRequested: true };
  });
}

export async function opRequestReconciliation(actor: ActorContext, recordId: string, reason: string) {
  return withAudit(actor, "request_reconciliation", recordId, reason, async (rec) => {
    return reconcileConnector({ connectorId: rec.id, actorId: actor.actorUserId, reason, tenantId: rec.tenant_id });
  });
}

/**
 * Controlled G6D recovery: a Super Admin creates a replacement reservation
 * before the linked MintVault destination hold is lifted. It is intentionally
 * record-scoped so the tenant/source tuple is server-derived, never supplied by
 * a browser request.
 */
export async function opRecoverSubmissionCredit(actor: ActorContext, recordId: string, reason: string) {
  if (!actor.idempotencyKey) {
    throw new G4RequestError("BAD_REQUEST", "idempotencyKey is required for credit recovery.");
  }
  const rec = await loadRecord(recordId);
  const recovered = await recoverPartnerDestinationCreditHold({
    tenantId: rec.tenant_id,
    partnerSubmissionId: rec.partner_submission_id,
    actorUserId: actor.actorUserId,
    actorEmail: actor.actorEmail,
    idempotencyKey: actor.idempotencyKey,
    reason,
  });
  // G6D writes immutable recovery evidence itself. Do not overload the older
  // G4 action-type constraint with a misleading label.
  return { result: { recovered: true, ...recovered }, alreadyCompleted: recovered.alreadyRecovered };
}

/**
 * Retry an eligible record: dispatch to the correct recovery service by mapping/record state, and
 * record the audit under the label of the service that actually ran (resume_reserved vs
 * retry_interrupted) so the append-only ledger identifies which recovery path was taken. The branch
 * is resolved from a pre-read; the actual exactly-once guarantee still lives in the delegated,
 * version-guarded G3F service, and withAudit's idempotency short-circuit prevents any second effect.
 */
export async function opRetryRecord(actor: ActorContext, recordId: string, reason: string, expectedVersion: number) {
  const rec = await loadRecord(recordId);
  const mapping = await getConnectorImport(rec.id);
  const isReserved = mapping?.state === "reserved";
  const isInterrupted = rec.state === "ready_for_import" || rec.state === "importing";
  if (!isReserved && !isInterrupted) {
    throw new G4RequestError(
      "RETRY_NOT_ALLOWED",
      "This record is not in a directly retryable state; use reconcile, revalidate, or release-claim first."
    );
  }
  const label: AdminActionType = isReserved ? "resume_reserved" : "retry_interrupted";
  return withAudit(actor, label, recordId, reason, async (fresh) => {
    const args = {
      connectorId: fresh.id,
      claimant: claimantOf(actor),
      expectedVersion,
      actorId: actor.actorUserId,
      reason,
      tenantId: fresh.tenant_id,
    };
    return isReserved ? recoverReservedImport(args) : recoverInterruptedImport(args);
  });
}

export async function opReleaseExpiredClaim(actor: ActorContext, recordId: string, reason: string) {
  return withAudit(actor, "release_expired_claim", recordId, reason, async (rec) => {
    await recoverExpiredImportClaim({
      connectorId: rec.id,
      claimant: claimantOf(actor),
      actorId: actor.actorUserId,
      reason,
      tenantId: rec.tenant_id,
    });
    return { claimReleased: true };
  });
}

export async function opMarkManualReview(actor: ActorContext, recordId: string, reason: string) {
  return withAudit(actor, "reconcile_mark_manual", recordId, reason, async (rec) => {
    await markManualReview({ connectorId: rec.id, actorId: actor.actorUserId, reason, tenantId: rec.tenant_id });
    return { markedManualReview: true };
  });
}

export async function opResolveManualReview(
  actor: ActorContext,
  recordId: string,
  reason: string,
  resolution: "retry" | "cancel",
  expectedVersion: number
) {
  const actionType = resolution === "retry" ? "manual_review_retry" : "manual_review_cancel";
  return withAudit(actor, actionType, recordId, reason, async (rec) => {
    await resolveManualReview({
      connectorId: rec.id,
      actorId: actor.actorUserId,
      reason,
      resolution,
      tenantId: rec.tenant_id,
      expectedVersion,
    });
    return { resolvedManualReview: resolution };
  });
}

export async function opAckPermanentFailure(
  actor: ActorContext,
  recordId: string,
  reason: string,
  expectedVersion: number
) {
  return withAudit(actor, "ack_permanent_failure", recordId, reason, async (rec) => {
    await acknowledgePermanentFailure({
      connectorId: rec.id,
      actorId: actor.actorUserId,
      reason,
      tenantId: rec.tenant_id,
      expectedVersion,
    });
    return { acknowledged: true };
  });
}

// ---------------------------------------------------------------------------
// READS (Phase 6) — deterministic, bounded, secret-free projections.
// ---------------------------------------------------------------------------
export async function listPartnerOrgs(search: string | undefined, offset: number, limit: number) {
  const like = search ? `%${search}%` : null;
  const { rows } = await partnerAdminQuery(
    `SELECT o.id, o.legal_name, o.status, o.accreditation_level, o.health, o.created_at,
            count(r.id)::int AS connector_count,
            count(r.id) FILTER (WHERE r.state IN ('reconciliation_required','manual_review'))::int AS needs_review_count,
            count(r.id) FILTER (WHERE r.state = 'reconciliation_required')::int AS reconciliation_required_count,
            max(r.updated_at) AS recent_activity_at
       FROM partner_organisations o
       LEFT JOIN partner_connector_records r ON r.tenant_id = o.id
      WHERE ($1::text IS NULL OR o.legal_name ILIKE $1)
      GROUP BY o.id
      ORDER BY o.created_at DESC, o.id ASC
      LIMIT $2 OFFSET $3`,
    [like, limit, offset]
  );
  const total = await partnerAdminQuery<{ n: number }>(
    `SELECT count(*)::int AS n FROM partner_organisations WHERE ($1::text IS NULL OR legal_name ILIKE $1)`,
    [like]
  );
  return { rows, total: total.rows[0].n };
}

export async function listConnectorRecords(
  filters: {
    partnerId?: string;
    state?: string;
    reconciliationRequired?: boolean;
    manualReview?: boolean;
    failed?: boolean;
    search?: string;
  },
  offset: number,
  limit: number
) {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, val: unknown) => {
    params.push(val);
    clauses.push(sql.replace("$?", `$${params.length}`));
  };
  if (filters.partnerId) add("r.tenant_id = $?", filters.partnerId);
  if (filters.state) add("r.state = $?", filters.state);
  if (filters.reconciliationRequired) clauses.push("r.state = 'reconciliation_required'");
  if (filters.manualReview) clauses.push("r.state = 'manual_review'");
  if (filters.failed) clauses.push("r.state = 'failed'");
  if (filters.search) add("r.handoff_id::text ILIKE $?", `%${filters.search}%`);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(limit, offset);
  const { rows } = await partnerAdminQuery(
    `SELECT r.id, r.tenant_id, r.state, r.attempt_count, r.last_error_code, r.claim_expires_at,
            r.next_retry_at, r.version, r.created_at, r.updated_at
       FROM partner_connector_records r
       ${where}
      ORDER BY r.updated_at DESC, r.id ASC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const countParams = params.slice(0, params.length - 2);
  const total = await partnerAdminQuery<{ n: number }>(
    `SELECT count(*)::int AS n FROM partner_connector_records r ${where}`,
    countParams
  );
  return { rows, total: total.rows[0].n };
}

export async function getRecordDetail(recordId: string) {
  const rec = await loadRecord(recordId);
  const [validation, mapping, destination, attempts, consistency, partnerCredit] = await Promise.all([
    getLatestValidationRun(rec.id),
    getConnectorImport(rec.id),
    getImportedDestination(rec.id),
    getImportAttempts(rec.id),
    inspectConnectorConsistency(rec.id).catch(() => null),
    getPartnerSubmissionCreditProjection(rec.tenant_id, rec.partner_submission_id),
  ]);
  const findings = validation?.findings ?? [];
  const adminActions = await getRecordAuditHistory(recordId, 0, 50);
  return {
    record: projectRecord(rec),
    latestValidation: validation,
    validationFindings: findings,
    mapping,
    destination,
    attempts,
    reconciliation: consistency,
    partnerCredit,
    adminActions: adminActions.rows,
  };
}

/**
 * Safe, read-only G6D projection for the existing Super Admin connector detail.
 * A missing row is intentional for pre-G6D submissions and never changes the
 * connector lifecycle; it merely lets operators identify the automatic credit
 * reservation associated with a Partner-created submission.
 */
export async function getPartnerSubmissionCreditProjection(tenantId: string, partnerSubmissionId: string) {
  return withPartnerAdminTransaction(async (client) => {
    try {
      if ((await partnerCreditSchemaState(client)) === "legacy_missing_credit_schema") return null;
      await assertPartnerCreditLifecycleReady(client);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    } catch (error) {
      if (error instanceof PartnerSubmissionCreditLifecycleError && error.code === "credit_schema_incomplete") {
        return {
          error: "credit_schema_incomplete",
          message:
            "Partner credit accounting schema is incomplete and requires reconciliation before this projection can be read.",
        };
      }
      throw error;
    }
    const conflicts = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM partner_credit_reservations
        WHERE tenant_id=$1 AND submission_reference=$2 AND source='portal'`,
      [tenantId, partnerSubmissionId]
    );
    if (Number(conflicts.rows[0]?.count ?? "0") > 1) {
      return {
        error: "reservation_link_inconsistent",
        message: "Partner submission has more than one authoritative credit reservation and requires reconciliation.",
        reservationLinkConflict: true,
      };
    }
    const { rows } = await client.query<{
      reservation_id: string;
      reservation_status: string;
      wallet_status: string | null;
      partner_id: string;
      partner_legal_name: string;
    }>(
      `SELECT reservation.id AS reservation_id,
              reservation.status AS reservation_status,
              wallet.status AS wallet_status,
              organisation.id AS partner_id,
              organisation.legal_name AS partner_legal_name
         FROM partner_credit_reservations reservation
         JOIN partner_organisations organisation
           ON organisation.id = reservation.tenant_id
         LEFT JOIN partner_wallets wallet
           ON wallet.tenant_id = reservation.tenant_id
        WHERE reservation.tenant_id = $1
          AND reservation.submission_reference = $2
          AND reservation.source = 'portal'
        ORDER BY reservation.created_at ASC, reservation.id ASC
        LIMIT 1`,
      [tenantId, partnerSubmissionId]
    );
    const holds = await client.query<{
      id: string;
      destination_submission_id: number;
      reason_code: string;
      created_at: string;
      released_at: string | null;
    }>(
      `SELECT id, destination_submission_id, reason_code, created_at, released_at
         FROM partner_submission_credit_holds
        WHERE tenant_id=$1 AND partner_submission_id=$2
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [tenantId, partnerSubmissionId]
    );
    const reservation = rows[0];
    if (!reservation && holds.rows.length === 0) return null;
    return {
      ...(reservation ?? {}),
      destinationCreditHold: holds.rows[0] ?? null,
      reservationLinkConflict: false,
    };
  });
}

export async function getAttemptHistory(recordId: string): Promise<ImportAttemptRecord[]> {
  await loadRecord(recordId); // 404 if unknown
  return getImportAttempts(recordId);
}

export async function getRecordAuditHistory(recordId: string, offset: number, limit: number) {
  const { rows } = await partnerAdminQuery(
    `SELECT id, action_type, actor_email, request_id, before_state, after_state, reason, result,
            error_code, created_at
       FROM partner_connector_admin_actions
      WHERE connector_record_id = $1
      ORDER BY created_at DESC, id ASC
      LIMIT $2 OFFSET $3`,
    [recordId, limit, offset]
  );
  return { rows };
}

export async function getManualReviewQueue(offset: number, limit: number) {
  const { rows } = await partnerAdminQuery(
    `SELECT r.id, r.tenant_id, r.state, r.last_error_code, r.updated_at, r.version
       FROM partner_connector_records r
      WHERE r.state = 'manual_review'
      ORDER BY r.updated_at ASC, r.id ASC
      LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return { rows };
}

export async function getReconciliationQueue(offset: number, limit: number) {
  const { rows } = await partnerAdminQuery(
    `SELECT r.id, r.tenant_id, r.state, r.last_error_code, r.updated_at, r.version
       FROM partner_connector_records r
      WHERE r.state = 'reconciliation_required'
      ORDER BY r.updated_at ASC, r.id ASC
      LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return { rows };
}

export async function getOperationalHealth() {
  const counts = await partnerAdminQuery<{ state: string; n: number }>(
    `SELECT state, count(*)::int AS n FROM partner_connector_records GROUP BY state`
  );
  const byState: Record<string, number> = {};
  for (const r of counts.rows) byState[r.state] = r.n;
  const derived = await partnerAdminQuery<{ eligible: number; claimed: number; expired: number }>(
    `SELECT
        count(*) FILTER (WHERE state = 'queued' OR (state = 'failed' AND next_retry_at IS NOT NULL AND next_retry_at <= now()))::int AS eligible,
        count(*) FILTER (WHERE claimed_by IS NOT NULL AND (claim_expires_at IS NULL OR claim_expires_at > now()))::int AS claimed,
        count(*) FILTER (WHERE claim_expires_at IS NOT NULL AND claim_expires_at <= now())::int AS expired
       FROM partner_connector_records`
  );
  const flags = await partnerAdminQuery<{ flag: string; enabled: boolean }>(
    `SELECT flag, enabled FROM partner_feature_flags WHERE tenant_id IS NULL AND location_id IS NULL AND flag IN ('partner_connector_enabled','partner_emergency_stop')`
  );
  const flagMap: Record<string, boolean> = {};
  for (const f of flags.rows) flagMap[f.flag] = f.enabled;
  return {
    // READ-ONLY flag visibility (writes deferred — see G4-DISC-01)
    featureEnabled: flagMap["partner_connector_enabled"] ?? false,
    emergencyStop: flagMap["partner_emergency_stop"] ?? false,
    countsByState: byState,
    eligibleCount: derived.rows[0].eligible,
    claimedCount: derived.rows[0].claimed,
    expiredClaims: derived.rows[0].expired,
    reconciliationRequiredCount: byState["reconciliation_required"] ?? 0,
    manualReviewCount: byState["manual_review"] ?? 0,
  };
}

/**
 * WP-3 observability: the connector DRIVER's live state (running / stopped / last-cycle stats) joined
 * to the backlog it is responsible for draining. Built entirely from the existing tables plus the
 * runtime's in-process snapshot — no new table, no new column, no mutation.
 *
 * `pendingHandoffBacklog` is the sweep's own input predicate (a `pending` handoff with no connector
 * record yet), so a runtime that is up but not draining is visible as a backlog that does not fall.
 */
export async function getConnectorRuntimeStatus() {
  const { getConnectorRuntimeSnapshot } = await import("./connector-runtime");
  const backlog = await partnerAdminQuery<{
    pending_handoffs: number;
    queued: number;
    ready_for_import: number;
    importing: number;
    expired_claims: number;
    failed: number;
    retryable_failed: number;
  }>(
    `SELECT
       (SELECT count(*) FROM partner_submission_handoffs h
         WHERE h.status = 'pending'
           AND NOT EXISTS (SELECT 1 FROM partner_connector_records r WHERE r.handoff_id = h.id)
       )::int AS pending_handoffs,
       count(*) FILTER (WHERE r.state = 'queued')::int AS queued,
       count(*) FILTER (WHERE r.state = 'ready_for_import')::int AS ready_for_import,
       count(*) FILTER (WHERE r.state = 'importing')::int AS importing,
       count(*) FILTER (WHERE r.claim_expires_at IS NOT NULL AND r.claim_expires_at <= now())::int AS expired_claims,
       count(*) FILTER (WHERE r.state = 'failed')::int AS failed,
       count(*) FILTER (WHERE r.state = 'failed' AND r.next_retry_at IS NOT NULL AND r.next_retry_at <= now())::int AS retryable_failed
     FROM partner_connector_records r`
  );
  const flags = await partnerAdminQuery<{ flag: string; enabled: boolean }>(
    `SELECT flag, enabled FROM partner_feature_flags
      WHERE tenant_id IS NULL AND location_id IS NULL
        AND flag IN ('partner_connector_enabled','partner_emergency_stop')`
  );
  const flagMap: Record<string, boolean> = {};
  for (const f of flags.rows) flagMap[f.flag] = f.enabled;
  const b = backlog.rows[0];
  return {
    runtime: getConnectorRuntimeSnapshot(),
    featureEnabled: flagMap["partner_connector_enabled"] ?? false,
    emergencyStop: flagMap["partner_emergency_stop"] ?? false,
    backlog: {
      pendingHandoffs: b.pending_handoffs,
      queued: b.queued,
      readyForImport: b.ready_for_import,
      importing: b.importing,
      expiredClaims: b.expired_claims,
      // `failed` that never falls while `retryableFailed` stays at zero means records are stuck
      // permanently; `retryableFailed` that never falls means the requeue step is not running.
      failed: b.failed,
      retryableFailed: b.retryable_failed,
    },
  };
}

function projectRecord(rec: RecordRow) {
  return {
    id: rec.id,
    partnerOrganisationId: rec.tenant_id,
    state: rec.state,
    version: rec.version,
    attemptCount: rec.attempt_count,
    claimExpiresAt: rec.claim_expires_at,
    nextRetryAt: rec.next_retry_at,
    lastErrorCode: rec.last_error_code,
    createdAt: rec.created_at,
    updatedAt: rec.updated_at,
  };
}
