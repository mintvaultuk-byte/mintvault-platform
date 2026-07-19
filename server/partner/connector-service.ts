/**
 * Trusted Intake Connector — Phase G1 foundation + G2 validation engine.
 *
 * Moves an approved Partner handoff (partner_submission_handoffs) into a tightly controlled internal
 * processing record, up to and including `ready_for_import` — and NO FURTHER (G3 is a follow-up,
 * not-yet-built pass; see .claude/controlled-code-lead/tasks/partner-network-connector-g2-g5/
 * PROGRAMME-PLAN.md). No function in this file can create a MintVault submission/certificate/
 * payment/label, and none can transition a record into `imported` (hard-blocked below, independent
 * of the transition matrix). `ready_for_import` renames G1's `awaiting_validation` (migration 0009)
 * — same lifecycle position, renamed to match this programme's naming; safe because the connector
 * flag has never been ON outside a disposable test database, so no real row ever held the old name.
 *
 * Every state-changing function: (1) checks the connector feature flag + emergency stop BEFORE
 * opening a transaction, (2) validates the current state against the legal-transition matrix,
 * (3) uses a guarded `WHERE id=$1 AND version=$2 AND state=$3` UPDATE so an illegal/stale transition
 * affects zero rows rather than silently succeeding, (4) appends an immutable history row in the
 * SAME transaction as the state change. No function here returns a raw database error to its caller
 * — every failure is normalised to a ConnectorError (connector-errors.ts).
 */
import type pg from "pg";
import { withConnectorTx, connectorQuery } from "./connector-db";
import { resolveGlobalFlag } from "./flags";
import { ConnectorError, toConnectorError } from "./connector-errors";

export const CONNECTOR_STATES = [
  "queued",
  "claimed",
  "validating",
  "ready_for_import",
  "rejected",
  "failed",
  "cancelled",
  "imported",
] as const;
export type ConnectorState = (typeof CONNECTOR_STATES)[number];

const TERMINAL_STATES = new Set<ConnectorState>(["rejected", "cancelled", "imported"]);

/**
 * The explicit legal-transition matrix — the single source of truth for every state change.
 * `ready_for_import -> validating` (G2C, explicit revalidation) is the one addition beyond a pure
 * rename of G1's matrix.
 */
export const LEGAL_TRANSITIONS: Record<ConnectorState, ConnectorState[]> = {
  queued: ["claimed", "cancelled"],
  claimed: ["validating", "queued", "cancelled", "failed"],
  validating: ["ready_for_import", "rejected", "failed", "cancelled"],
  ready_for_import: ["cancelled", "validating"],
  failed: ["queued", "cancelled"],
  rejected: [],
  cancelled: [],
  imported: [],
};

const DEFAULT_CLAIM_LEASE_SECONDS = 300;
const DEFAULT_RETRY_DELAY_SECONDS = 300;

export interface ConnectorRecord {
  id: string;
  tenantId: string;
  partnerSubmissionId: string;
  handoffId: string;
  sourceHandoffIdempotencyKey: string | null;
  state: ConnectorState;
  attemptCount: number;
  claimedBy: string | null;
  claimedAt: string | null;
  claimExpiresAt: string | null;
  nextRetryAt: string | null;
  lastErrorCategory: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  version: number;
}

/** Narrow, non-leaking read shape — no claim internals, no role names, no stack information. */
export interface ConnectorStatus {
  connectorId: string;
  handoffReference: string;
  state: ConnectorState;
  attemptCount: number;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ConnectorRow {
  id: string;
  tenant_id: string;
  partner_submission_id: string;
  handoff_id: string;
  source_handoff_idempotency_key: string | null;
  state: string;
  attempt_count: number;
  claimed_by: string | null;
  claimed_at: string | null;
  claim_expires_at: string | null;
  next_retry_at: string | null;
  last_error_category: string | null;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  version: number;
}

function mapRow(row: ConnectorRow): ConnectorRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    partnerSubmissionId: row.partner_submission_id,
    handoffId: row.handoff_id,
    sourceHandoffIdempotencyKey: row.source_handoff_idempotency_key,
    state: row.state as ConnectorState,
    attemptCount: row.attempt_count,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    claimExpiresAt: row.claim_expires_at,
    nextRetryAt: row.next_retry_at,
    lastErrorCategory: row.last_error_category,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    version: row.version,
  };
}

/** Emergency stop overrides the flag: check it first so a stopped connector never reports merely "disabled". */
async function assertConnectorActive(): Promise<void> {
  const [stopped, enabled] = await Promise.all([
    resolveGlobalFlag("partner_emergency_stop"),
    resolveGlobalFlag("partner_connector_enabled"),
  ]);
  if (stopped) throw new ConnectorError("emergency_stop", "The connector is stopped.");
  if (!enabled) throw new ConnectorError("feature_disabled", "The connector is disabled.");
}

/**
 * Every exported function routes its DB work through this — the ONE place that turns any thrown
 * value into a ConnectorError, so the "no raw database error ever escapes" contract this file
 * documents (top of file) is actually true everywhere, not just in the one function that happened
 * to have its own try/catch.
 */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ConnectorError) throw err;
    throw toConnectorError(err);
  }
}

async function writeEvent(
  client: pg.PoolClient,
  connectorRecordId: string,
  fromState: ConnectorState | null,
  toState: ConnectorState,
  eventType: string,
  attemptNumber: number,
  metadata: Record<string, unknown>,
  actorId?: string | null
): Promise<void> {
  await client.query(
    `INSERT INTO partner_connector_events
       (connector_record_id, from_state, to_state, event_type, attempt_number, metadata, actor_type, actor_id)
     VALUES ($1,$2,$3,$4,$5,$6,'system',$7)`,
    [connectorRecordId, fromState, toState, eventType, attemptNumber, JSON.stringify(metadata ?? {}), actorId ?? null]
  );
}

/**
 * First request creates the one canonical connector record for a handoff; a repeat request for the
 * SAME handoff returns that same record (DB-enforced via UNIQUE(handoff_id), safe under concurrent
 * duplicate calls). A DIFFERENT handoff reusing the same idempotencyKey fails with
 * idempotency_conflict rather than silently creating a wrong-handoff record.
 */
export async function ensureConnectorRecordForHandoff(params: {
  tenantId: string;
  handoffId: string;
  idempotencyKey?: string | null;
}): Promise<ConnectorRecord> {
  await assertConnectorActive();
  const { tenantId, handoffId } = params;
  return guarded(() =>
    withConnectorTx(async (client) => {
      const handoffRes = await client.query<{
        id: string;
        tenant_id: string;
        submission_id: string;
        status: string;
        idempotency_key: string | null;
      }>(
        `SELECT h.id, h.tenant_id, h.submission_id, h.status, s.idempotency_key
         FROM partner_submission_handoffs h
         JOIN partner_submissions s ON s.id = h.submission_id
        WHERE h.id = $1`,
        [handoffId]
      );
      // RLS (app.tenant_id set by withConnectorTx below) already collapses "does not exist" and
      // "belongs to another tenant" into the same empty result — no existence leak either way.
      if (handoffRes.rows.length === 0) {
        throw new ConnectorError("handoff_not_found", "Handoff not found.");
      }
      const handoff = handoffRes.rows[0];
      if (handoff.status !== "pending") {
        throw new ConnectorError(
          "handoff_not_ready",
          `Handoff is not ready for connector processing (status=${handoff.status}).`
        );
      }
      const sourceKey = params.idempotencyKey ?? handoff.idempotency_key ?? null;

      try {
        const insertRes = await client.query<ConnectorRow>(
          `INSERT INTO partner_connector_records
           (tenant_id, partner_submission_id, handoff_id, source_handoff_idempotency_key)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (handoff_id) DO NOTHING
         RETURNING *`,
          [tenantId, handoff.submission_id, handoffId, sourceKey]
        );
        if (insertRes.rows.length === 1) {
          const rec = insertRes.rows[0];
          await writeEvent(client, rec.id, null, "queued", "created", 0, {});
          return mapRow(rec);
        }
        // Conflict on handoff_id: the canonical record already exists — return it (idempotent).
        const existing = await client.query<ConnectorRow>(
          `SELECT * FROM partner_connector_records WHERE handoff_id = $1`,
          [handoffId]
        );
        if (existing.rows.length === 1) return mapRow(existing.rows[0]);
        throw new ConnectorError(
          "transient_database_error",
          "Could not resolve connector record after insert conflict.",
          true
        );
      } catch (err) {
        const pgErr = err as { code?: string; constraint?: string };
        if (pgErr?.code === "23505" && String(pgErr.constraint ?? "").includes("idem_key")) {
          throw new ConnectorError(
            "idempotency_conflict",
            "This idempotency key is already attached to a different handoff."
          );
        }
        if (err instanceof ConnectorError) throw err;
        throw toConnectorError(err);
      }
    }, tenantId)
  );
}

/** Narrow, non-leaking read. Available even when the connector flag is OFF or emergency-stopped. */
export async function getConnectorStatus(params: {
  tenantId: string;
  connectorId: string;
}): Promise<ConnectorStatus | null> {
  return guarded(async () => {
    const { rows } = await connectorQuery<ConnectorRow>(
      `SELECT * FROM partner_connector_records WHERE id = $1 AND tenant_id = $2`,
      [params.connectorId, params.tenantId]
    );
    if (rows.length === 0) return null; // wrong tenant or unknown id — identical response, no existence leak
    const rec = rows[0];
    return {
      connectorId: rec.id,
      handoffReference: rec.handoff_id,
      state: rec.state as ConnectorState,
      attemptCount: rec.attempt_count,
      lastErrorCode: rec.last_error_code,
      createdAt: rec.created_at,
      updatedAt: rec.updated_at,
    };
  });
}

/**
 * Claim ONE queued (or expired-claim) record across ALL tenants — the global work-queue primitive a
 * future worker polls. FOR UPDATE SKIP LOCKED guarantees two concurrent callers never claim the same
 * row. Returns null when nothing is claimable (not an error).
 */
export async function claimNextConnectorRecord(
  claimedBy: string,
  leaseSeconds = DEFAULT_CLAIM_LEASE_SECONDS
): Promise<ConnectorRecord | null> {
  await assertConnectorActive();
  return guarded(() =>
    withConnectorTx(async (client) => {
      const { rows } = await client.query<ConnectorRow>(
        `SELECT * FROM partner_connector_records
        WHERE state = 'queued' OR (state = 'claimed' AND claim_expires_at < now())
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1`
      );
      if (rows.length === 0) return null;
      const rec = rows[0];
      const upd = await client.query<ConnectorRow>(
        `UPDATE partner_connector_records
          SET state = 'claimed', claimed_by = $1, claimed_at = now(),
              claim_expires_at = now() + ($2 || ' seconds')::interval,
              attempt_count = attempt_count + 1, version = version + 1, updated_at = now()
        WHERE id = $3 AND version = $4
        RETURNING *`,
        [claimedBy, leaseSeconds, rec.id, rec.version]
      );
      if (upd.rows.length === 0) {
        throw new ConnectorError("stale_claim", "Record changed between selection and claim.");
      }
      await writeEvent(
        client,
        rec.id,
        rec.state as ConnectorState,
        "claimed",
        "claimed",
        upd.rows[0].attempt_count,
        {},
        claimedBy
      );
      return mapRow(upd.rows[0]);
    })
  );
}

/**
 * Claim a SPECIFIC record by id. Fails with already_claimed if it's currently held by a live lease.
 * `tenantId`, when supplied, is checked against the record's actual tenant before anything else —
 * a mismatch fails with `unauthorised`. Optional because the global work-queue caller doesn't (and
 * shouldn't) claim on behalf of a specific tenant; a future tenant-scoped caller should always pass
 * it.
 */
export async function claimConnectorRecord(
  connectorId: string,
  claimedBy: string,
  leaseSeconds = DEFAULT_CLAIM_LEASE_SECONDS,
  tenantId?: string
): Promise<ConnectorRecord> {
  await assertConnectorActive();
  return guarded(() =>
    withConnectorTx(async (client) => {
      const { rows } = await client.query<ConnectorRow>(
        `SELECT * FROM partner_connector_records WHERE id = $1 FOR UPDATE`,
        [connectorId]
      );
      if (rows.length === 0) throw new ConnectorError("handoff_not_found", "Connector record not found.");
      const rec = rows[0];
      if (tenantId && rec.tenant_id !== tenantId) {
        throw new ConnectorError("unauthorised", "This record does not belong to the specified tenant.");
      }
      if (TERMINAL_STATES.has(rec.state as ConnectorState)) {
        throw new ConnectorError("invalid_state_transition", `Cannot claim a record in terminal state ${rec.state}.`);
      }
      const leaseExpired =
        rec.state === "claimed" && rec.claim_expires_at != null && new Date(rec.claim_expires_at) < new Date();
      const claimable = rec.state === "queued" || leaseExpired;
      if (!claimable) throw new ConnectorError("already_claimed", "Record is already claimed by another processor.");
      const upd = await client.query<ConnectorRow>(
        `UPDATE partner_connector_records
          SET state = 'claimed', claimed_by = $1, claimed_at = now(),
              claim_expires_at = now() + ($2 || ' seconds')::interval,
              attempt_count = attempt_count + 1, version = version + 1, updated_at = now()
        WHERE id = $3 AND version = $4
        RETURNING *`,
        [claimedBy, leaseSeconds, connectorId, rec.version]
      );
      if (upd.rows.length === 0) throw new ConnectorError("stale_claim", "Record changed between read and claim.");
      await writeEvent(
        client,
        connectorId,
        rec.state as ConnectorState,
        "claimed",
        "claimed",
        upd.rows[0].attempt_count,
        {},
        claimedBy
      );
      return mapRow(upd.rows[0]);
    })
  );
}

/**
 * Move a record through one legal transition. `toState = "imported"` is hard-blocked BEFORE the
 * transaction opens — G1 must never legitimately reach it, independent of the transition matrix.
 * `tenantId`, when supplied, is checked against the record's actual tenant before anything else.
 * Moving INTO `queued` (an explicit release or a failed→queued retry) clears claimed_by/claimed_at/
 * claim_expires_at/next_retry_at — the same fields releaseConnectorClaim clears — so a requeued
 * record never carries a stale claimant or a stale retry time forward.
 */
export async function transitionConnectorState(params: {
  connectorId: string;
  claimant?: string | null;
  tenantId?: string;
  expectedVersion: number;
  toState: ConnectorState;
  eventType: string;
  metadata?: Record<string, unknown>;
}): Promise<ConnectorRecord> {
  if (params.toState === "imported") {
    throw new ConnectorError(
      "invalid_state_transition",
      "G1 connector functions must never transition a record into 'imported'."
    );
  }
  await assertConnectorActive();
  const { connectorId, expectedVersion, toState, eventType, claimant, tenantId } = params;
  return guarded(() =>
    withConnectorTx(async (client) => {
      const { rows } = await client.query<ConnectorRow>(
        `SELECT * FROM partner_connector_records WHERE id = $1 FOR UPDATE`,
        [connectorId]
      );
      if (rows.length === 0) throw new ConnectorError("handoff_not_found", "Connector record not found.");
      const rec = rows[0];
      if (tenantId && rec.tenant_id !== tenantId) {
        throw new ConnectorError("unauthorised", "This record does not belong to the specified tenant.");
      }
      const fromState = rec.state as ConnectorState;
      const legalFrom = LEGAL_TRANSITIONS[fromState] ?? [];
      if (!legalFrom.includes(toState)) {
        throw new ConnectorError("invalid_state_transition", `Cannot move from ${fromState} to ${toState}.`);
      }
      // No "&& claimant" short-circuit here — if the record IS claimed/validating, a caller MUST pass
      // the matching claimant, not just omit the parameter to skip the check (previously an omitted
      // claimant silently bypassed ownership verification entirely).
      if (rec.claimed_by && (fromState === "claimed" || fromState === "validating") && claimant !== rec.claimed_by) {
        throw new ConnectorError("stale_claim", "Only the current claimant may transition this record.");
      }
      const completing = toState === "rejected" || toState === "cancelled";
      const requeuing = toState === "queued";
      const upd = await client.query<ConnectorRow>(
        `UPDATE partner_connector_records
          SET state = $1, version = version + 1, updated_at = now(),
              completed_at = CASE WHEN $5::boolean THEN now() ELSE completed_at END,
              claimed_by = CASE WHEN $6::boolean THEN NULL ELSE claimed_by END,
              claimed_at = CASE WHEN $6::boolean THEN NULL ELSE claimed_at END,
              claim_expires_at = CASE WHEN $6::boolean THEN NULL ELSE claim_expires_at END,
              next_retry_at = CASE WHEN $6::boolean THEN NULL ELSE next_retry_at END
        WHERE id = $2 AND version = $3 AND state = $4
        RETURNING *`,
        [toState, connectorId, expectedVersion, fromState, completing, requeuing]
      );
      if (upd.rows.length === 0) throw new ConnectorError("stale_claim", "Record changed since last read.");
      await writeEvent(
        client,
        connectorId,
        fromState,
        toState,
        eventType,
        upd.rows[0].attempt_count,
        params.metadata ?? {},
        claimant ?? null
      );
      return mapRow(upd.rows[0]);
    })
  );
}

/**
 * Record a processing failure. Sets next_retry_at only when retryable — a permanent failure never
 * gets a retry time, so listRetryableConnectorRecords() naturally excludes it.
 */
export async function recordConnectorFailure(params: {
  connectorId: string;
  claimant?: string | null;
  tenantId?: string;
  expectedVersion: number;
  errorCategory: string;
  errorCode: string;
  retryable: boolean;
  metadata?: Record<string, unknown>;
}): Promise<ConnectorRecord> {
  await assertConnectorActive();
  const { connectorId, expectedVersion, errorCategory, errorCode, retryable, claimant, tenantId } = params;
  return guarded(() =>
    withConnectorTx(async (client) => {
      const { rows } = await client.query<ConnectorRow>(
        `SELECT * FROM partner_connector_records WHERE id = $1 FOR UPDATE`,
        [connectorId]
      );
      if (rows.length === 0) throw new ConnectorError("handoff_not_found", "Connector record not found.");
      const rec = rows[0];
      if (tenantId && rec.tenant_id !== tenantId) {
        throw new ConnectorError("unauthorised", "This record does not belong to the specified tenant.");
      }
      const fromState = rec.state as ConnectorState;
      const legalFrom = LEGAL_TRANSITIONS[fromState] ?? [];
      if (!legalFrom.includes("failed")) {
        throw new ConnectorError("invalid_state_transition", `Cannot fail a record from state ${fromState}.`);
      }
      // No "&& claimant" short-circuit — see transitionConnectorState for why an omitted claimant must
      // not bypass ownership verification on an actually-claimed record.
      if (rec.claimed_by && (fromState === "claimed" || fromState === "validating") && claimant !== rec.claimed_by) {
        throw new ConnectorError("stale_claim", "Only the current claimant may record a failure for this record.");
      }
      const upd = await client.query<ConnectorRow>(
        `UPDATE partner_connector_records
          SET state = 'failed', last_error_category = $1, last_error_code = $2,
              next_retry_at = CASE WHEN $3::boolean THEN now() + ($6 || ' seconds')::interval ELSE NULL END,
              version = version + 1, updated_at = now()
        WHERE id = $4 AND version = $5 AND state = $7
        RETURNING *`,
        [errorCategory, errorCode, retryable, connectorId, expectedVersion, DEFAULT_RETRY_DELAY_SECONDS, fromState]
      );
      if (upd.rows.length === 0) throw new ConnectorError("stale_claim", "Record changed since last read.");
      await writeEvent(
        client,
        connectorId,
        fromState,
        "failed",
        "failed",
        upd.rows[0].attempt_count,
        { errorCategory, errorCode, retryable, ...(params.metadata ?? {}) },
        claimant ?? null
      );
      return mapRow(upd.rows[0]);
    })
  );
}

/**
 * Only the current claimant may release; releasing returns the record to queued for reclaiming
 * (the claim fields are cleared by the UPDATE below).
 */
export async function releaseConnectorClaim(params: {
  connectorId: string;
  claimant: string;
  tenantId?: string;
  expectedVersion: number;
}): Promise<ConnectorRecord> {
  await assertConnectorActive();
  const { connectorId, claimant, expectedVersion, tenantId } = params;
  return guarded(() =>
    withConnectorTx(async (client) => {
      const { rows } = await client.query<ConnectorRow>(
        `SELECT * FROM partner_connector_records WHERE id = $1 FOR UPDATE`,
        [connectorId]
      );
      if (rows.length === 0) throw new ConnectorError("handoff_not_found", "Connector record not found.");
      const rec = rows[0];
      if (tenantId && rec.tenant_id !== tenantId) {
        throw new ConnectorError("unauthorised", "This record does not belong to the specified tenant.");
      }
      if (rec.state !== "claimed") {
        throw new ConnectorError("invalid_state_transition", "Only a claimed record can be released.");
      }
      if (rec.claimed_by !== claimant) {
        throw new ConnectorError("stale_claim", "Only the current claimant may release this record.");
      }
      const upd = await client.query<ConnectorRow>(
        `UPDATE partner_connector_records
          SET state = 'queued', claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL,
              version = version + 1, updated_at = now()
        WHERE id = $1 AND version = $2 AND state = 'claimed'
        RETURNING *`,
        [connectorId, expectedVersion]
      );
      if (upd.rows.length === 0) throw new ConnectorError("stale_claim", "Record changed since last read.");
      await writeEvent(client, connectorId, "claimed", "queued", "released", upd.rows[0].attempt_count, {}, claimant);
      return mapRow(upd.rows[0]);
    })
  );
}

/**
 * Phase G2C: extend an active `claimed` or `validating` lease before it expires. Closes the
 * G1-documented gap where `validating` was never treated as reclaimable at all — a long-running
 * validator can now keep its claim alive instead of racing an expiry it has no way to prevent.
 * Only the current claimant, holding the current version, on a non-expired lease may renew.
 */
export async function renewConnectorClaimLease(params: {
  connectorId: string;
  claimant: string;
  expectedVersion: number;
  tenantId?: string;
  leaseSeconds?: number;
}): Promise<ConnectorRecord> {
  await assertConnectorActive();
  const { connectorId, claimant, expectedVersion, tenantId, leaseSeconds = DEFAULT_CLAIM_LEASE_SECONDS } = params;
  return guarded(() =>
    withConnectorTx(async (client) => {
      const { rows } = await client.query<ConnectorRow>(
        `SELECT * FROM partner_connector_records WHERE id = $1 FOR UPDATE`,
        [connectorId]
      );
      if (rows.length === 0) throw new ConnectorError("handoff_not_found", "Connector record not found.");
      const rec = rows[0];
      if (tenantId && rec.tenant_id !== tenantId) {
        throw new ConnectorError("unauthorised", "This record does not belong to the specified tenant.");
      }
      if (rec.state !== "claimed" && rec.state !== "validating") {
        throw new ConnectorError(
          "invalid_state_transition",
          "Only a claimed or validating record can have its lease renewed."
        );
      }
      if (rec.claimed_by !== claimant) {
        throw new ConnectorError("stale_claim", "Only the current claimant may renew this lease.");
      }
      const leaseExpired = rec.claim_expires_at != null && new Date(rec.claim_expires_at) < new Date();
      if (leaseExpired) {
        throw new ConnectorError("stale_claim", "This lease has already expired and may have been reclaimed.");
      }
      const upd = await client.query<ConnectorRow>(
        `UPDATE partner_connector_records
            SET claim_expires_at = now() + ($1 || ' seconds')::interval,
                version = version + 1, updated_at = now()
          WHERE id = $2 AND version = $3 AND claimed_by = $4 AND state = $5
          RETURNING *`,
        [leaseSeconds, connectorId, expectedVersion, claimant, rec.state]
      );
      if (upd.rows.length === 0) throw new ConnectorError("stale_claim", "Record changed since last read.");
      await writeEvent(
        client,
        connectorId,
        rec.state as ConnectorState,
        rec.state as ConnectorState,
        "lease_renewed",
        upd.rows[0].attempt_count,
        { leaseSeconds },
        claimant
      );
      return mapRow(upd.rows[0]);
    })
  );
}

/**
 * Read-only. Lists failed records whose retry time has arrived — the query a future worker will
 * poll. No automatic retry loop exists in G1 (no worker is started by this file).
 */
export async function listRetryableConnectorRecords(limit = 50): Promise<ConnectorRecord[]> {
  return guarded(async () => {
    const { rows } = await connectorQuery<ConnectorRow>(
      `SELECT * FROM partner_connector_records
        WHERE state = 'failed' AND next_retry_at IS NOT NULL AND next_retry_at <= now()
        ORDER BY next_retry_at ASC
        LIMIT $1`,
      [limit]
    );
    return rows.map(mapRow);
  });
}
