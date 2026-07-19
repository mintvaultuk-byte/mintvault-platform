/**
 * Trusted Intake Connector — Phase G3E: consistency inspection, reconciliation and recovery.
 *
 * See .claude/controlled-code-lead/tasks/partner-network-connector-g3e-g3f/RECONCILIATION-RUNBOOK.md
 * for the full scenario table this file implements. Two kinds of function live here:
 *
 *  - Inspectors (`inspect*`, `sweepConnectorLineageIntegrity`) — READ-ONLY, never mutate anything,
 *    safe to call at any time regardless of the connector flag or emergency stop.
 *  - Recovery actions (`reconcileConnector`, `completeFromExistingDestination`,
 *    `recoverReservedImport`, `recoverExpiredImportClaim`, `recoverInterruptedImport`,
 *    `markManualReview`, `resolveManualReview`, `acknowledgePermanentFailure`) — every one requires
 *    an explicit `actorId` + `reason`, checks the connector flag/emergency stop first (same as every
 *    G1–G3 state-changing function), and appends an immutable `partner_connector_events` row in the
 *    SAME transaction as any state change it makes. None of them ever DELETEs a `submissions` row,
 *    creates a second destination for a connector that already has one, or silently repairs a
 *    detected inconsistency without an audit trail.
 */
import type pg from "pg";
import { withConnectorTx, connectorQuery } from "./connector-db";
import { resolveGlobalFlag } from "./flags";
import { ConnectorError, toConnectorError } from "./connector-errors";
import { calculateSourceFingerprint, SOURCE_FINGERPRINT_VERSION } from "./connector-fingerprint";
import { loadValidationRows, toFingerprintSource, type ConnectorRow } from "./connector-validation-service";
import { getConnectorImport, importValidatedConnector, type ConnectorImportRecord } from "./connector-import-service";
import { claimConnectorRecord } from "./connector-service";

async function assertConnectorActive(): Promise<void> {
  const [stopped, enabled] = await Promise.all([
    resolveGlobalFlag("partner_emergency_stop"),
    resolveGlobalFlag("partner_connector_enabled"),
  ]);
  if (stopped) throw new ConnectorError("emergency_stop", "The connector is stopped.");
  if (!enabled) throw new ConnectorError("feature_disabled", "The connector is disabled.");
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ConnectorError) throw err;
    throw toConnectorError(err);
  }
}

function requireActorAndReason(actorId: string | null | undefined, reason: string | null | undefined): void {
  if (!actorId || !actorId.trim()) {
    throw new ConnectorError("manual_review_required", "A reconciliation action requires a non-empty actorId.", false);
  }
  if (!reason || !reason.trim()) {
    throw new ConnectorError("manual_review_required", "A reconciliation action requires a non-empty reason.", false);
  }
}

async function writeReconciliationEvent(
  client: pg.PoolClient,
  connectorRecordId: string,
  fromState: string | null,
  toState: string,
  eventType: string,
  metadata: Record<string, unknown>,
  actorId: string
): Promise<void> {
  await client.query(
    `INSERT INTO partner_connector_events
       (connector_record_id, from_state, to_state, event_type, attempt_number, metadata, actor_type, actor_id)
     SELECT $1, $2, $3, $4, attempt_count, $5, 'operator', $6 FROM partner_connector_records WHERE id = $1`,
    [connectorRecordId, fromState, toState, eventType, JSON.stringify(metadata ?? {}), actorId]
  );
}

// ---------------------------------------------------------------------------------------------
// Inspectors — read-only.
// ---------------------------------------------------------------------------------------------

export type IssueCode =
  | "destination_missing"
  | "mapping_missing"
  | "mapping_duplicate"
  | "destination_duplicate"
  | "import_interrupted"
  | "claim_expired"
  | "stale_fingerprint"
  | "corrupt_lineage";

export interface ConsistencyIssue {
  code: IssueCode;
  entity: "connector" | "mapping" | "destination" | "validation" | "evidence";
  safeDetail: string;
}

const STALE_RESERVATION_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour — generous; a real import completes in one transaction in milliseconds

/** Read-only. Checks a mapping row (if any) against its own internal consistency rules. */
export async function inspectImportMapping(connectorId: string): Promise<ConsistencyIssue[]> {
  return guarded(async () => {
    const mapping = await getConnectorImport(connectorId);
    if (!mapping) return [];
    const issues: ConsistencyIssue[] = [];
    if (mapping.state === "completed") {
      if (mapping.destinationSubmissionId == null) {
        issues.push({
          code: "destination_missing",
          entity: "mapping",
          safeDetail: "completed mapping has no destination_submission_id",
        });
      } else {
        const dest = await connectorQuery<{ id: number }>(`SELECT id FROM submissions WHERE id = $1`, [
          mapping.destinationSubmissionId,
        ]);
        if (dest.rows.length === 0) {
          issues.push({
            code: "destination_missing",
            entity: "mapping",
            safeDetail: "destination_submission_id does not resolve",
          });
        }
      }
    } else if (mapping.state === "reserved") {
      const ageMs = Date.now() - new Date(mapping.reservedAt).getTime();
      if (ageMs > STALE_RESERVATION_THRESHOLD_MS) {
        issues.push({
          code: "import_interrupted",
          entity: "mapping",
          safeDetail: "reservation has been open far longer than any real import takes",
        });
      }
    }
    return issues;
  });
}

/** Read-only. Given a destination submission id, checks it exists and is referenced by at most one mapping. */
export async function inspectDestinationSubmission(destinationSubmissionId: number): Promise<ConsistencyIssue[]> {
  return guarded(async () => {
    const issues: ConsistencyIssue[] = [];
    const dest = await connectorQuery<{ id: number }>(`SELECT id FROM submissions WHERE id = $1`, [
      destinationSubmissionId,
    ]);
    if (dest.rows.length === 0) {
      issues.push({ code: "destination_missing", entity: "destination", safeDetail: "no submissions row for this id" });
      return issues;
    }
    const mappings = await connectorQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM partner_connector_imports WHERE destination_submission_id = $1`,
      [destinationSubmissionId]
    );
    if (mappings.rows[0].n > 1) {
      issues.push({
        code: "destination_duplicate",
        entity: "destination",
        safeDetail: "more than one mapping references this destination",
      });
    }
    return issues;
  });
}

/**
 * Read-only. Recomputes the source fingerprint fresh (same loader G2/G3D use — never a second,
 * drift-prone copy) and compares against the latest completed validation run, WITHOUT attempting an
 * import. Purely diagnostic — a stale fingerprint here is not itself an error the importer hasn't
 * already independently guarded against; this exists so an operator/dashboard can see staleness
 * before attempting an import at all.
 */
export async function inspectValidationChain(connectorId: string): Promise<ConsistencyIssue[]> {
  return guarded(async () => {
    const issues: ConsistencyIssue[] = [];
    const connRes = await connectorQuery<ConnectorRow>(
      `SELECT id, tenant_id, partner_submission_id, handoff_id, state, claimed_by, version, attempt_count
         FROM partner_connector_records WHERE id = $1`,
      [connectorId]
    );
    if (connRes.rows.length === 0) return issues;
    const connector = connRes.rows[0];

    const runRes = await connectorQuery<{
      source_fingerprint: string | null;
      source_fingerprint_version: number | null;
    }>(
      `SELECT source_fingerprint, source_fingerprint_version FROM partner_connector_validation_runs
        WHERE connector_record_id = $1 AND completed_at IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`,
      [connectorId]
    );
    const run = runRes.rows[0];
    if (!run || run.source_fingerprint == null) return issues;

    await withConnectorTx(async (client) => {
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [connector.tenant_id]);
      const rows = await loadValidationRows(client, connector);
      const fingerprint = calculateSourceFingerprint(toFingerprintSource(rows));
      if (fingerprint !== run.source_fingerprint || run.source_fingerprint_version !== SOURCE_FINGERPRINT_VERSION) {
        issues.push({
          code: "stale_fingerprint",
          entity: "validation",
          safeDetail: "a fresh recompute no longer matches the last completed validation run",
        });
      }
    }, connector.tenant_id);
    return issues;
  });
}

/** Read-only. Checks the immutable event log has an entry matching the connector's current terminal-ish state. */
export async function inspectConnectorEvidence(connectorId: string): Promise<ConsistencyIssue[]> {
  return guarded(async () => {
    const issues: ConsistencyIssue[] = [];
    const connRes = await connectorQuery<{ state: string }>(
      `SELECT state FROM partner_connector_records WHERE id = $1`,
      [connectorId]
    );
    const state = connRes.rows[0]?.state;
    if (state !== "imported") return issues;
    const ev = await connectorQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM partner_connector_events WHERE connector_record_id = $1 AND to_state = 'imported'`,
      [connectorId]
    );
    if (ev.rows[0].n === 0) {
      issues.push({
        code: "corrupt_lineage",
        entity: "evidence",
        safeDetail: "connector is imported but no matching event was recorded",
      });
    }
    return issues;
  });
}

export interface ConnectorConsistencyReport {
  connectorId: string;
  connectorState: string | null;
  mapping: ConnectorImportRecord | null;
  issues: ConsistencyIssue[];
}

/**
 * Read-only. The main single-connector inspector — combines mapping, evidence, claim-expiry and
 * imported-without-mapping checks. `inspectValidationChain`'s fingerprint recompute is deliberately
 * NOT included here (it's the most expensive check, requires a transaction, and is purely
 * informational) — call it separately when a caller specifically wants staleness insight.
 */
export async function inspectConnectorConsistency(connectorId: string): Promise<ConnectorConsistencyReport> {
  return guarded(async () => {
    const connRes = await connectorQuery<{ state: string; claim_expires_at: string | null }>(
      `SELECT state, claim_expires_at FROM partner_connector_records WHERE id = $1`,
      [connectorId]
    );
    const connectorState = connRes.rows[0]?.state ?? null;
    const mapping = await getConnectorImport(connectorId);
    const issues: ConsistencyIssue[] = [];

    if (connectorState === "imported" && !mapping) {
      issues.push({
        code: "mapping_missing",
        entity: "connector",
        safeDetail: "connector is imported but no import mapping exists",
      });
    }
    issues.push(...(await inspectImportMapping(connectorId)));
    issues.push(...(await inspectConnectorEvidence(connectorId)));

    if (
      connRes.rows[0] &&
      ["claimed", "validating", "ready_for_import"].includes(connectorState ?? "") &&
      connRes.rows[0].claim_expires_at != null &&
      new Date(connRes.rows[0].claim_expires_at) < new Date()
    ) {
      issues.push({
        code: "claim_expired",
        entity: "connector",
        safeDetail: "the processing claim on this record has expired",
      });
    }

    return { connectorId, connectorState, mapping, issues };
  });
}

export interface LineageDuplicate {
  kind: "mapping_duplicate" | "destination_duplicate";
  key: string;
  count: number;
}

/**
 * Read-only, GLOBAL sweep (not scoped to one connector) — an operator/cron-level invariant check.
 * In normal operation this always returns an empty array: the four UNIQUE constraints on
 * partner_connector_imports (migration 0010) make a real duplicate impossible to create through the
 * application. This function exists as defence in depth against a hypothetical future constraint
 * weakening or manual DB tampering — proven by a dedicated test that deliberately drops the
 * constraint on a disposable database, not by finding a real duplicate in normal operation.
 */
export async function sweepConnectorLineageIntegrity(): Promise<LineageDuplicate[]> {
  return guarded(async () => {
    const dupes: LineageDuplicate[] = [];
    const mappingDupes = await connectorQuery<{ connector_record_id: string; n: number }>(
      `SELECT connector_record_id, count(*)::int AS n FROM partner_connector_imports
        GROUP BY connector_record_id HAVING count(*) > 1`
    );
    for (const row of mappingDupes.rows) {
      dupes.push({ kind: "mapping_duplicate", key: row.connector_record_id, count: row.n });
    }
    const destDupes = await connectorQuery<{ destination_submission_id: number; n: number }>(
      `SELECT destination_submission_id, count(*)::int AS n FROM partner_connector_imports
        WHERE destination_submission_id IS NOT NULL
        GROUP BY destination_submission_id HAVING count(*) > 1`
    );
    for (const row of destDupes.rows) {
      dupes.push({ kind: "destination_duplicate", key: String(row.destination_submission_id), count: row.n });
    }
    return dupes;
  });
}

// ---------------------------------------------------------------------------------------------
// Reconciliation engine and recovery actions — mutating, every call requires actorId + reason.
// ---------------------------------------------------------------------------------------------

export interface ReconcileResult {
  action: "none" | "completed_from_existing" | "marked_manual_review" | "recommendation_only";
  report: ConnectorConsistencyReport;
  recommendation?: string;
}

/**
 * Orchestrator. Read-only triage first (inspectConnectorConsistency), then:
 *  - no issues -> no-op, no mutation, no event written (report only).
 *  - the ONLY issue is a missing 'imported' event on an otherwise-consistent connector -> the one
 *    genuinely safe auto-repair (completeFromExistingDestination) — writes the missing event only.
 *  - a stale/interrupted reservation -> returns a recommendation to call recoverReservedImport
 *    (requires a live claimant, which this orchestrator does not have — never auto-invoked).
 *  - an expired claim -> returns a recommendation to call recoverExpiredImportClaim (same reason).
 *  - anything else (destination_missing, mapping_missing, mapping_duplicate, destination_duplicate,
 *    corrupt_lineage) -> markManualReview. Never guesses, never auto-repairs ambiguous corruption.
 */
export async function reconcileConnector(params: {
  connectorId: string;
  actorId: string;
  reason: string;
  tenantId?: string;
}): Promise<ReconcileResult> {
  const { connectorId, actorId, reason, tenantId } = params;
  const report = await inspectConnectorConsistency(connectorId);
  if (report.issues.length === 0) {
    return { action: "none", report };
  }

  const onlyEvidenceGap =
    report.issues.length === 1 && report.issues[0].code === "corrupt_lineage" && report.mapping?.state === "completed";
  if (onlyEvidenceGap) {
    await completeFromExistingDestination({ connectorId, actorId, reason, tenantId });
    return { action: "completed_from_existing", report };
  }

  const onlyReservationStale = report.issues.every((i) => i.code === "import_interrupted");
  if (onlyReservationStale) {
    return {
      action: "recommendation_only",
      report,
      recommendation: "recoverReservedImport (requires a live claimant)",
    };
  }

  const onlyClaimExpired = report.issues.every((i) => i.code === "claim_expired");
  if (onlyClaimExpired) {
    return { action: "recommendation_only", report, recommendation: "recoverExpiredImportClaim" };
  }

  requireActorAndReason(actorId, reason);
  if (report.connectorState === "imported") {
    // 'imported' is terminal and must never transition away, even to flag corruption — see
    // flagMappingForManualReview's own doc comment.
    await flagMappingForManualReview({ connectorId, actorId, reason, tenantId });
  } else {
    await markManualReview({ connectorId, actorId, reason, tenantId });
  }
  return { action: "marked_manual_review", report };
}

/**
 * The one genuinely safe auto-repair: a completed mapping + an existing destination that agree with
 * each other, but the connector's own immutable event log is missing its 'imported' entry (only
 * reachable via corruption of the events table itself, given G3D's single-transaction design).
 * Writes ONLY the missing event — never touches submissions/submission_items, never changes the
 * mapping, and only changes the connector's `state` column if it is not already 'imported' (a second
 * defence-in-depth branch for the same underlying scenario).
 */
export async function completeFromExistingDestination(params: {
  connectorId: string;
  actorId: string;
  reason: string;
  tenantId?: string;
}): Promise<{ destinationSubmissionId: number }> {
  await assertConnectorActive();
  const { connectorId, actorId, reason, tenantId } = params;
  requireActorAndReason(actorId, reason);
  return guarded(() =>
    withConnectorTx(async (client) => {
      const connRes = await client.query<{
        state: string;
        version: number;
        tenant_id: string;
        partner_submission_id: string;
        handoff_id: string;
      }>(
        `SELECT state, version, tenant_id, partner_submission_id, handoff_id
           FROM partner_connector_records WHERE id = $1 FOR UPDATE`,
        [connectorId]
      );
      if (connRes.rows.length === 0) throw new ConnectorError("handoff_not_found", "Connector record not found.");
      const connector = connRes.rows[0];
      if (tenantId && connector.tenant_id !== tenantId) {
        throw new ConnectorError("unauthorised", "This record does not belong to the specified tenant.");
      }
      const mapping = await getConnectorImport(connectorId);
      if (!mapping || mapping.state !== "completed" || mapping.destinationSubmissionId == null) {
        throw new ConnectorError(
          "mapping_missing",
          "No completed mapping with a destination exists to complete from.",
          false
        );
      }
      const dest = await client.query<{ id: number }>(`SELECT id FROM submissions WHERE id = $1`, [
        mapping.destinationSubmissionId,
      ]);
      if (dest.rows.length === 0) {
        throw new ConnectorError("destination_missing", "The mapping's destination does not resolve.", false);
      }

      if (connector.state !== "imported") {
        const upd = await client.query(
          `UPDATE partner_connector_records SET state = 'imported', version = version + 1, updated_at = now(), completed_at = now()
            WHERE id = $1 AND version = $2`,
          [connectorId, connector.version]
        );
        if (upd.rowCount === 0) throw new ConnectorError("import_version_conflict", "Record changed since last read.");
      }
      await writeReconciliationEvent(
        client,
        connectorId,
        connector.state,
        "imported",
        "reconciliation_completed_from_existing",
        { reason, destinationSubmissionId: mapping.destinationSubmissionId },
        actorId
      );

      // G3F: if no completed attempt evidence exists yet for this connector (e.g. a mapping created
      // before this table existed, or a corruption-repair case), append one reconciled/completed
      // attempt so the evidence chain is complete. The connector row FOR UPDATE lock + the partial
      // unique index guarantee at most one completed attempt — so guard on existence first.
      const hasCompleted = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM partner_connector_import_attempts
          WHERE connector_record_id = $1 AND outcome = 'completed'`,
        [connectorId]
      );
      if (hasCompleted.rows[0].n === 0) {
        const mapRow = await client.query<{
          partner_organisation_id: string;
          validation_run_id: string | null;
          source_fingerprint: string | null;
          source_fingerprint_version: number | null;
        }>(
          `SELECT partner_organisation_id, validation_run_id, source_fingerprint, source_fingerprint_version
             FROM partner_connector_imports WHERE id = $1`,
          [mapping.id]
        );
        const m = mapRow.rows[0];
        const numRes = await client.query<{ n: number }>(
          `SELECT COALESCE(MAX(attempt_number),0)+1 AS n FROM partner_connector_import_attempts WHERE connector_record_id = $1`,
          [connectorId]
        );
        await client.query(
          `INSERT INTO partner_connector_import_attempts
             (connector_record_id, import_mapping_id, partner_organisation_id, partner_submission_id,
              partner_handoff_id, validation_run_id, source_fingerprint, source_fingerprint_version,
              attempt_number, attempt_type, claimant, outcome, safe_error_code, destination_submission_id,
              started_at, completed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'reconciled',$10,'completed',NULL,$11, now(), now())`,
          [
            connectorId,
            mapping.id,
            m.partner_organisation_id,
            connector.partner_submission_id,
            connector.handoff_id,
            m.validation_run_id,
            m.source_fingerprint,
            m.source_fingerprint_version,
            numRes.rows[0].n,
            actorId,
            mapping.destinationSubmissionId,
          ]
        );
      }
      return { destinationSubmissionId: mapping.destinationSubmissionId };
    }, tenantId)
  );
}

/**
 * Resumes a stale 'reserved' mapping (RECONCILIATION-RUNBOOK.md scenario 4) by simply calling the
 * importer again — the G3E fix to importValidatedConnector's own reservation step means it now
 * resumes an existing 'reserved' row for the SAME connector in place instead of looping on a
 * conflict. This function's own job is just the audit wrapper: requires actorId+reason, and the
 * caller must supply a claimant that already holds a valid claim (obtain one via
 * recoverExpiredImportClaim first if the original claim lapsed).
 */
export async function recoverReservedImport(params: {
  connectorId: string;
  claimant: string;
  expectedVersion: number;
  actorId: string;
  reason: string;
  tenantId?: string;
}): Promise<ReturnType<typeof importValidatedConnector>> {
  requireActorAndReason(params.actorId, params.reason);
  const mapping = await getConnectorImport(params.connectorId);
  if (!mapping || mapping.state !== "reserved") {
    throw new ConnectorError("mapping_missing", "No stale reservation exists to recover.", false);
  }
  const outcome = await importValidatedConnector({
    connectorId: params.connectorId,
    claimant: params.claimant,
    expectedVersion: params.expectedVersion,
    tenantId: params.tenantId,
  });
  await guarded(() =>
    withConnectorTx(async (client) => {
      await writeReconciliationEvent(
        client,
        params.connectorId,
        null,
        outcome.outcome === "imported" || outcome.outcome === "already_completed" ? "imported" : "validating",
        "reconciliation_reservation_recovered",
        { reason: params.reason, outcome: outcome.outcome },
        params.actorId
      );
    }, params.tenantId)
  );
  return outcome;
}

/**
 * Reclaims a `ready_for_import` (or `claimed`/`validating`) record whose lease has expired — the
 * real gap fixed in connector-service.ts's claimConnectorRecord this pass. This function is the
 * audited wrapper: it delegates the actual claim to claimConnectorRecord (which already writes its
 * own 'claimed' event), then appends a SECOND, reconciliation-specific event carrying the actor+
 * reason a bare re-claim doesn't otherwise capture.
 */
export async function recoverExpiredImportClaim(params: {
  connectorId: string;
  claimant: string;
  actorId: string;
  reason: string;
  tenantId?: string;
  leaseSeconds?: number;
}): Promise<void> {
  requireActorAndReason(params.actorId, params.reason);
  await claimConnectorRecord(params.connectorId, params.claimant, params.leaseSeconds, params.tenantId);
  await guarded(() =>
    withConnectorTx(async (client) => {
      await writeReconciliationEvent(
        client,
        params.connectorId,
        null,
        "claimed",
        "reconciliation_claim_recovered",
        { reason: params.reason, claimant: params.claimant },
        params.actorId
      );
    }, params.tenantId)
  );
}

/**
 * Thin, audited wrapper around a retried importValidatedConnector call — for the common "timeout
 * after commit / lost response" case (RECONCILIATION-RUNBOOK.md scenario 9). Safe because
 * importValidatedConnector is itself already idempotent; this function adds only the actor+reason
 * audit trail a bare retry wouldn't otherwise carry.
 */
export async function recoverInterruptedImport(params: {
  connectorId: string;
  claimant: string;
  expectedVersion: number;
  actorId: string;
  reason: string;
  tenantId?: string;
}): Promise<ReturnType<typeof importValidatedConnector>> {
  requireActorAndReason(params.actorId, params.reason);
  const outcome = await importValidatedConnector({
    connectorId: params.connectorId,
    claimant: params.claimant,
    expectedVersion: params.expectedVersion,
    tenantId: params.tenantId,
  });
  await guarded(() =>
    withConnectorTx(async (client) => {
      await writeReconciliationEvent(
        client,
        params.connectorId,
        null,
        outcome.outcome === "imported" || outcome.outcome === "already_completed" ? "imported" : "validating",
        "reconciliation_import_recovered",
        { reason: params.reason, outcome: outcome.outcome },
        params.actorId
      );
    }, params.tenantId)
  );
  return outcome;
}

const MANUAL_REVIEW_REACHABLE_FROM = new Set(["ready_for_import", "reconciliation_required", "failed", "importing"]);

/**
 * For corruption detected on an ALREADY-`imported` connector (RECONCILIATION-RUNBOOK.md scenarios
 * 5-7) — `imported` is a hard terminal state (LEGAL_TRANSITIONS["imported"] = []), inherited
 * unchanged from G1, and must stay terminal even when its mapping/destination turns out to be
 * corrupted; un-terminaling it would contradict the "post-import cancellation is rejected" safety
 * invariant the whole connector state machine relies on. So corruption on an imported connector is
 * flagged at the MAPPING level instead (`partner_connector_imports.state = 'reconciliation_required'`
 * — a legal mapping state since migration 0010, using the already-granted narrow column UPDATE) —
 * the connector's own `state` column never changes. An audit event is still written on the connector
 * (from_state = to_state = 'imported', since no real transition occurred) so the flag is visible in
 * the immutable history either way.
 */
export async function flagMappingForManualReview(params: {
  connectorId: string;
  actorId: string;
  reason: string;
  tenantId?: string;
}): Promise<void> {
  await assertConnectorActive();
  const { connectorId, actorId, reason, tenantId } = params;
  requireActorAndReason(actorId, reason);
  return guarded(() =>
    withConnectorTx(async (client) => {
      const connRes = await client.query<{ state: string; tenant_id: string }>(
        `SELECT state, tenant_id FROM partner_connector_records WHERE id = $1 FOR UPDATE`,
        [connectorId]
      );
      if (connRes.rows.length === 0) throw new ConnectorError("handoff_not_found", "Connector record not found.");
      const connector = connRes.rows[0];
      if (tenantId && connector.tenant_id !== tenantId) {
        throw new ConnectorError("unauthorised", "This record does not belong to the specified tenant.");
      }
      const mapping = await client.query<{ id: string }>(
        `SELECT id FROM partner_connector_imports WHERE connector_record_id = $1`,
        [connectorId]
      );
      if (mapping.rows.length > 0) {
        await client.query(
          `UPDATE partner_connector_imports
              SET state = 'reconciliation_required', last_safe_error_code = 'corrupt_lineage',
                  reconciled_at = now(), updated_at = now()
            WHERE id = $1`,
          [mapping.rows[0].id]
        );
      }
      await writeReconciliationEvent(
        client,
        connectorId,
        connector.state,
        connector.state,
        "reconciliation_manual_review",
        { reason, mappingFlagged: mapping.rows.length > 0 },
        actorId
      );
    }, tenantId)
  );
}

/**
 * Moves a connector into `manual_review`. Reachable from `ready_for_import`/`importing`/`failed`
 * directly (escalation), or from `reconciliation_required` (the normal reconcileConnector path) —
 * internally always performs the legal `reconciliation_required` hop first when starting from
 * `ready_for_import`/`importing`, writing both transition events, so the underlying state machine's
 * "recoverable transitions only" contract in connector-service.ts's LEGAL_TRANSITIONS is honoured
 * even though this function's own external contract is simpler. Does NOT accept a connector already
 * in the terminal `imported` state — use `flagMappingForManualReview` for that case instead (see its
 * own doc comment for why `imported` must never transition away).
 */
export async function markManualReview(params: {
  connectorId: string;
  actorId: string;
  reason: string;
  tenantId?: string;
}): Promise<void> {
  await assertConnectorActive();
  const { connectorId, actorId, reason, tenantId } = params;
  requireActorAndReason(actorId, reason);
  return guarded(() =>
    withConnectorTx(async (client) => {
      const connRes = await client.query<{ state: string; version: number; tenant_id: string }>(
        `SELECT state, version, tenant_id FROM partner_connector_records WHERE id = $1 FOR UPDATE`,
        [connectorId]
      );
      if (connRes.rows.length === 0) throw new ConnectorError("handoff_not_found", "Connector record not found.");
      const connector = connRes.rows[0];
      if (tenantId && connector.tenant_id !== tenantId) {
        throw new ConnectorError("unauthorised", "This record does not belong to the specified tenant.");
      }
      if (!MANUAL_REVIEW_REACHABLE_FROM.has(connector.state)) {
        throw new ConnectorError(
          "invalid_state_transition",
          `Cannot mark manual_review from state ${connector.state}.`
        );
      }

      let fromState = connector.state;
      let version = connector.version;
      if (fromState === "ready_for_import" || fromState === "importing") {
        const step1 = await client.query<{ version: number }>(
          `UPDATE partner_connector_records SET state = 'reconciliation_required', version = version + 1, updated_at = now()
            WHERE id = $1 AND version = $2 RETURNING version`,
          [connectorId, version]
        );
        if (step1.rows.length === 0)
          throw new ConnectorError("import_version_conflict", "Record changed since last read.");
        await writeReconciliationEvent(
          client,
          connectorId,
          fromState,
          "reconciliation_required",
          "reconciliation_flagged",
          { reason },
          actorId
        );
        fromState = "reconciliation_required";
        version = step1.rows[0].version;
      }

      const upd = await client.query<{ version: number }>(
        `UPDATE partner_connector_records SET state = 'manual_review', version = version + 1, updated_at = now()
          WHERE id = $1 AND version = $2 RETURNING version`,
        [connectorId, version]
      );
      if (upd.rows.length === 0) throw new ConnectorError("import_version_conflict", "Record changed since last read.");
      await writeReconciliationEvent(
        client,
        connectorId,
        fromState,
        "manual_review",
        "reconciliation_manual_review",
        { reason },
        actorId
      );
    }, tenantId)
  );
}

/**
 * The only two exits from `manual_review` — "no arbitrary state editing." `retry` clears claim
 * fields and returns the record to `queued` to re-enter the normal pipeline from scratch; `cancel`
 * moves it to the existing terminal `cancelled` state. Both require actorId+reason.
 */
export async function resolveManualReview(params: {
  connectorId: string;
  actorId: string;
  reason: string;
  resolution: "retry" | "cancel";
  tenantId?: string;
  expectedVersion: number;
}): Promise<void> {
  await assertConnectorActive();
  const { connectorId, actorId, reason, resolution, tenantId, expectedVersion } = params;
  requireActorAndReason(actorId, reason);
  const toState = resolution === "retry" ? "queued" : "cancelled";
  return guarded(() =>
    withConnectorTx(async (client) => {
      const connRes = await client.query<{ state: string; tenant_id: string }>(
        `SELECT state, tenant_id FROM partner_connector_records WHERE id = $1 FOR UPDATE`,
        [connectorId]
      );
      if (connRes.rows.length === 0) throw new ConnectorError("handoff_not_found", "Connector record not found.");
      const connector = connRes.rows[0];
      if (tenantId && connector.tenant_id !== tenantId) {
        throw new ConnectorError("unauthorised", "This record does not belong to the specified tenant.");
      }
      if (connector.state !== "manual_review") {
        throw new ConnectorError(
          "invalid_state_transition",
          `Cannot resolve manual_review from state ${connector.state}.`
        );
      }
      const upd = await client.query(
        `UPDATE partner_connector_records
            SET state = $1, version = version + 1, updated_at = now(),
                claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL, next_retry_at = NULL,
                completed_at = CASE WHEN $1 = 'cancelled' THEN now() ELSE completed_at END
          WHERE id = $2 AND version = $3`,
        [toState, connectorId, expectedVersion]
      );
      if (upd.rowCount === 0) throw new ConnectorError("import_version_conflict", "Record changed since last read.");
      await writeReconciliationEvent(
        client,
        connectorId,
        "manual_review",
        toState,
        "reconciliation_resolved",
        { reason, resolution },
        actorId
      );
    }, tenantId)
  );
}

/**
 * For a `failed` record an operator has decided will never succeed. Moves it to the existing
 * terminal `cancelled` state (no new terminal state introduced) with the reason recorded.
 */
export async function acknowledgePermanentFailure(params: {
  connectorId: string;
  actorId: string;
  reason: string;
  tenantId?: string;
  expectedVersion: number;
}): Promise<void> {
  await assertConnectorActive();
  const { connectorId, actorId, reason, tenantId, expectedVersion } = params;
  requireActorAndReason(actorId, reason);
  return guarded(() =>
    withConnectorTx(async (client) => {
      const connRes = await client.query<{ state: string; tenant_id: string }>(
        `SELECT state, tenant_id FROM partner_connector_records WHERE id = $1 FOR UPDATE`,
        [connectorId]
      );
      if (connRes.rows.length === 0) throw new ConnectorError("handoff_not_found", "Connector record not found.");
      const connector = connRes.rows[0];
      if (tenantId && connector.tenant_id !== tenantId) {
        throw new ConnectorError("unauthorised", "This record does not belong to the specified tenant.");
      }
      if (connector.state !== "failed") {
        throw new ConnectorError(
          "invalid_state_transition",
          `Cannot acknowledge permanent failure from state ${connector.state}.`
        );
      }
      const upd = await client.query(
        `UPDATE partner_connector_records
            SET state = 'cancelled', version = version + 1, updated_at = now(), completed_at = now(),
                claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL, next_retry_at = NULL
          WHERE id = $1 AND version = $2`,
        [connectorId, expectedVersion]
      );
      if (upd.rowCount === 0) throw new ConnectorError("import_version_conflict", "Record changed since last read.");
      await writeReconciliationEvent(
        client,
        connectorId,
        "failed",
        "cancelled",
        "reconciliation_permanent_failure_acknowledged",
        { reason },
        actorId
      );
    }, tenantId)
  );
}
