/**
 * Trusted Intake Connector — Phase G3D: exactly-once MintVault intake importer.
 *
 * Moves a `ready_for_import` connector record into a real MintVault `submissions` +
 * `submission_items` intake, exactly once, or safely returns the existing destination on a retry.
 * See .claude/controlled-code-lead/tasks/partner-network-connector-g3/IDEMPOTENCY-AND-TRANSACTION.md
 * for the full transaction-sequence design this file implements, and DESTINATION-BOUNDARY.md /
 * CUSTOMER-OWNERSHIP-DECISION.md / SERVICE-PRICE-MAPPING.md for the field-level decisions.
 *
 * The entire reservation -> owner resolution -> reference allocation -> submission creation ->
 * mapping completion -> connector transition sequence is ONE database transaction. `ready_for_import
 * -> importing -> imported` is still written as two separate UPDATEs (mirroring the brief's own
 * state-machine shape and giving the connector event log two distinct entries), but because both
 * happen inside the same transaction, `importing` is never durably observable by another session on
 * its own — a crash anywhere in this function rolls back every write it made, leaving the connector
 * exactly where it started (`ready_for_import`, no mapping row). See IDEMPOTENCY-AND-TRANSACTION.md's
 * crash-point table for why this collapses every crash scenario to one of exactly two safe outcomes.
 */
import type pg from "pg";
import { withConnectorTx, connectorQuery } from "./connector-db";
import { resolveGlobalFlag } from "./flags";
import { ConnectorError, toConnectorError } from "./connector-errors";
import { calculateSourceFingerprint, SOURCE_FINGERPRINT_VERSION } from "./connector-fingerprint";
import { loadValidationRows, toFingerprintSource, type ConnectorRow } from "./connector-validation-service";
import { resolveDestinationOwner } from "./connector-owner-resolution";
import { allocateReferenceAndInsert } from "./connector-reference";

const MAPPING_VERSION = 1;

interface FullConnectorRow extends ConnectorRow {
  claim_expires_at: string | null;
}

export interface ImportOutcome {
  outcome: "imported" | "already_completed" | "stale";
  destinationSubmissionId: number | null;
  destinationReference: string | null;
}

export interface ConnectorImportRecord {
  id: string;
  connectorRecordId: string;
  state: "reserved" | "completed" | "reconciliation_required" | "failed";
  destinationSubmissionId: number | null;
  reservedAt: string;
  completedAt: string | null;
  reconciledAt: string | null;
}

async function assertConnectorActive(): Promise<void> {
  const [stopped, enabled] = await Promise.all([
    resolveGlobalFlag("partner_emergency_stop"),
    resolveGlobalFlag("partner_connector_enabled"),
  ]);
  if (stopped) throw new ConnectorError("import_emergency_stopped", "The connector is stopped.");
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

interface ImportMappingRow {
  id: string;
  state: string;
  destination_submission_id: number | null;
}

function splitLocal(email: string | null): string | null {
  return email;
}

/**
 * The exactly-once importer. Preconditions (all enforced BEFORE any write): connector flag ON,
 * emergency stop OFF, connector state `ready_for_import`, active matching claim, matching tenant,
 * matching version, a completed validation run with outcome `valid` and zero blocking findings, and
 * a freshly-recomputed source fingerprint that still matches the validated one.
 */
export async function importValidatedConnector(params: {
  connectorId: string;
  claimant: string;
  expectedVersion: number;
  tenantId?: string;
}): Promise<ImportOutcome> {
  await assertConnectorActive();
  const { connectorId, claimant, expectedVersion, tenantId } = params;
  return guarded(() =>
    withConnectorTx(async (client) => {
      const connRes = await client.query<FullConnectorRow>(
        `SELECT * FROM partner_connector_records WHERE id = $1 FOR UPDATE`,
        [connectorId]
      );
      if (connRes.rows.length === 0) throw new ConnectorError("handoff_not_found", "Connector record not found.");
      const connector = connRes.rows[0];
      if (tenantId && connector.tenant_id !== tenantId) {
        throw new ConnectorError("unauthorised", "This record does not belong to the specified tenant.");
      }

      // Idempotent early return — checked BEFORE any state validation, so a retry against an
      // already-`imported` connector (or a connector whose mapping completed but whose caller never
      // saw the response) always succeeds with the existing destination rather than erroring.
      const existingMapRes = await client.query<ImportMappingRow>(
        `SELECT id, state, destination_submission_id FROM partner_connector_imports WHERE connector_record_id = $1`,
        [connectorId]
      );
      const existingMap = existingMapRes.rows[0] ?? null;
      if (existingMap && existingMap.state === "completed") {
        if (existingMap.destination_submission_id == null) {
          throw new ConnectorError(
            "import_reconciliation_required",
            "A completed import mapping exists with no recorded destination — this requires manual reconciliation.",
            false
          );
        }
        const destRes = await client.query<{ tracking_number: string }>(
          `SELECT tracking_number FROM submissions WHERE id = $1`,
          [existingMap.destination_submission_id]
        );
        if (destRes.rows.length === 0) {
          throw new ConnectorError(
            "import_destination_missing",
            "The recorded destination submission could not be found — this requires manual reconciliation.",
            false
          );
        }
        return {
          outcome: "already_completed",
          destinationSubmissionId: existingMap.destination_submission_id,
          destinationReference: destRes.rows[0].tracking_number,
        };
      }
      if (connector.state === "imported" && !existingMap) {
        throw new ConnectorError(
          "import_reconciliation_required",
          "Connector record is marked imported but no import mapping exists — this requires manual reconciliation.",
          false
        );
      }

      if (connector.state === "rejected" || connector.state === "cancelled") {
        throw new ConnectorError("import_cancelled", `Cannot import a record in state ${connector.state}.`);
      }
      if (connector.state !== "ready_for_import") {
        throw new ConnectorError(
          "import_not_ready",
          `Cannot import a record in state ${connector.state}; must be ready_for_import.`
        );
      }
      if (!connector.claimed_by) {
        throw new ConnectorError("import_claim_required", "This record must be claimed before it can be imported.");
      }
      if (connector.claimed_by !== claimant) {
        throw new ConnectorError("import_claimant_mismatch", "Only the current claimant may import this record.");
      }
      if (connector.version !== expectedVersion) {
        throw new ConnectorError("import_version_conflict", "Record changed since last read.");
      }
      if (connector.claim_expires_at != null && new Date(connector.claim_expires_at) < new Date()) {
        throw new ConnectorError("import_claim_expired", "The processing claim on this record has expired.");
      }

      const runRes = await client.query<{
        id: string;
        outcome: string;
        blocking_error_count: number;
        source_fingerprint: string | null;
        source_fingerprint_version: number | null;
      }>(
        `SELECT id, outcome, blocking_error_count, source_fingerprint, source_fingerprint_version
           FROM partner_connector_validation_runs
          WHERE connector_record_id = $1 AND completed_at IS NOT NULL
          ORDER BY created_at DESC LIMIT 1`,
        [connectorId]
      );
      const run = runRes.rows[0];
      if (!run)
        throw new ConnectorError("import_validation_missing", "No completed validation exists for this record.");
      if (run.outcome !== "valid") {
        throw new ConnectorError(
          "import_validation_invalid",
          `The most recent validation outcome was '${run.outcome}'.`
        );
      }
      if (run.blocking_error_count > 0) {
        throw new ConnectorError(
          "import_blocking_findings",
          "The most recent validation has unresolved blocking findings."
        );
      }
      if (run.source_fingerprint == null || run.source_fingerprint_version == null) {
        throw new ConnectorError(
          "import_validation_invalid",
          "The most recent validation has no recorded fingerprint."
        );
      }

      // Same GUC-scoping requirement loadValidationRows itself documents — must be set before any
      // FORCE-RLS'd Partner table read, using the connector's OWN (non-RLS'd) tenant_id, never a
      // caller-supplied value directly.
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [connector.tenant_id]);

      const rows = await loadValidationRows(client, connector);
      const fingerprint = calculateSourceFingerprint(toFingerprintSource(rows));
      const fingerprintMatches =
        fingerprint === run.source_fingerprint && SOURCE_FINGERPRINT_VERSION === run.source_fingerprint_version;

      if (!fingerprintMatches) {
        // Stale source at import time — same shape SOURCE-FINGERPRINT.md documents for validation
        // itself, including "submission cancelled" (status is a canonical fingerprint field, so a
        // cancellation between validation and import surfaces here as an ordinary mismatch, with no
        // special-case handling needed). Send the connector back through the existing, already-legal
        // ready_for_import -> validating revalidation path (G2C) rather than inventing a new exit
        // state. This COMMITS (not an error the caller should retry blindly) — return a distinct
        // outcome instead of throwing.
        const upd = await client.query<{ state: string }>(
          `UPDATE partner_connector_records
              SET state = 'validating', version = version + 1, updated_at = now(),
                  last_error_category = 'stale_source', last_error_code = 'import_source_stale'
            WHERE id = $1 AND version = $2 AND state = 'ready_for_import'
            RETURNING state`,
          [connectorId, expectedVersion]
        );
        if (upd.rows.length === 0)
          throw new ConnectorError("import_version_conflict", "Record changed since last read.");
        await client.query(
          `INSERT INTO partner_connector_events
             (connector_record_id, from_state, to_state, event_type, attempt_number, metadata, actor_type, actor_id)
           VALUES ($1,'ready_for_import','validating','import_source_stale',$2,$3,'system',$4)`,
          [connectorId, connector.attempt_count, JSON.stringify({}), claimant]
        );
        return { outcome: "stale", destinationSubmissionId: null, destinationReference: null };
      }

      if (!rows.submission || !rows.customer || !rows.serviceTier) {
        // Structurally should be unreachable — a 'valid' outcome with zero blocking findings already
        // required all three to be present (G2's own submission_missing/customer_missing/
        // service_tier rules). Defence in depth, not a path the tests expect to hit.
        throw new ConnectorError(
          "import_validation_invalid",
          "Validated source is missing required data despite a 'valid' outcome.",
          false
        );
      }

      // ---- Reservation ----------------------------------------------------------------------
      await client.query("SAVEPOINT connector_import_reserve");
      let mappingId: string;
      try {
        const reserveRes = await client.query<{ id: string }>(
          `INSERT INTO partner_connector_imports
             (connector_record_id, partner_organisation_id, partner_location_id, partner_submission_id,
              partner_handoff_id, validation_run_id, source_fingerprint, source_fingerprint_version,
              mapping_version, import_attempt, state)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'reserved')
           RETURNING id`,
          [
            connectorId,
            connector.tenant_id,
            rows.location?.id ?? null,
            connector.partner_submission_id,
            connector.handoff_id,
            run.id,
            fingerprint,
            SOURCE_FINGERPRINT_VERSION,
            MAPPING_VERSION,
            connector.attempt_count,
          ]
        );
        await client.query("RELEASE SAVEPOINT connector_import_reserve");
        mappingId = reserveRes.rows[0].id;
      } catch (err) {
        await client.query("ROLLBACK TO SAVEPOINT connector_import_reserve");
        const pgErr = err as { code?: string };
        if (pgErr?.code === "23505") {
          // Lost a reservation race — a concurrent transaction for this SAME connector got there
          // first. It holds (or held) the row lock we also hold, so by the time we observe the
          // conflict it has either committed (re-check below) or rolled back (nothing to find, and
          // this whole transaction is about to fail anyway since we can no longer proceed safely).
          throw new ConnectorError(
            "import_mapping_conflict",
            "A concurrent import attempt for this record is already in progress or complete.",
            true
          );
        }
        throw new ConnectorError("import_destination_conflict", "Could not reserve an import mapping.", false);
      }

      // ---- Owner resolution -------------------------------------------------------------------
      const owner = await resolveDestinationOwner(client, {
        partnerOrganisationId: connector.tenant_id,
        customer: { id: rows.customer.id, fullName: rows.customer.full_name, email: splitLocal(rows.customer.email) },
      });

      // ---- Service/price mapping (mapping version 1 — direct passthrough, see SERVICE-PRICE-MAPPING.md)
      const expandedItems = rows.cards.flatMap((card) =>
        Array.from({ length: Math.max(1, card.quantity) }, () => card)
      );
      const cardCount = expandedItems.length;
      const pricePerCardPence = rows.serviceTier.price_per_card_pence;
      const gradingCostPence = pricePerCardPence * cardCount;
      const totalDeclaredValuePence = expandedItems.reduce((sum, c) => sum + (c.declared_value_pence ?? 0), 0);
      const totalPriceDecimal = (gradingCostPence / 100).toFixed(2);

      // ---- Destination submission + items (reference allocation is the last step before the
      // authoritative INSERT, minimising the window a retry-worthy collision can occur in) --------
      const created = await allocateReferenceAndInsert(client, async (reference) => {
        const subRes = await client.query<{ id: number; tracking_number: string }>(
          `INSERT INTO submissions
             (user_id, status, tracking_number, card_count, total_price, total_declared_value,
              payment_status, service_type, service_tier, grading_cost,
              customer_email, customer_first_name, customer_last_name)
           VALUES ($1,'draft',$2,$3,$4,$5,'unpaid','partner-intake',$6,$7,$8,$9,$10)
           RETURNING id, tracking_number`,
          [
            owner.userId,
            reference,
            cardCount,
            totalPriceDecimal,
            totalDeclaredValuePence,
            rows.submission!.service_tier_code,
            gradingCostPence,
            rows.customer!.email,
            rows.customer!.full_name.trim().split(/\s+/)[0] ?? null,
            rows.customer!.full_name.trim().split(/\s+/).slice(1).join(" ") || null,
          ]
        );
        return subRes.rows[0];
      });

      let cardIndex = 1;
      for (const card of expandedItems) {
        await client.query(
          `INSERT INTO submission_items
             (submission_id, card_index, game, card_set, card_name, card_number, year, declared_value)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            created.id,
            cardIndex++,
            card.game,
            card.card_set,
            card.card_name,
            card.card_number,
            card.year != null ? String(card.year) : null,
            card.declared_value_pence ?? 0,
          ]
        );
      }

      // ---- Complete the mapping, then transition the connector (ready_for_import -> importing ->
      // imported, two UPDATEs, same transaction — see file header for why 'importing' is never
      // durably observable outside this transaction) ----------------------------------------------
      await client.query(
        `UPDATE partner_connector_imports
            SET state = 'completed', destination_submission_id = $1, completed_at = now(), updated_at = now()
          WHERE id = $2`,
        [created.id, mappingId]
      );

      const toImporting = await client.query<{ state: string }>(
        `UPDATE partner_connector_records
            SET state = 'importing', version = version + 1, updated_at = now()
          WHERE id = $1 AND version = $2 AND state = 'ready_for_import'
          RETURNING state, version`,
        [connectorId, expectedVersion]
      );
      if (toImporting.rows.length === 0)
        throw new ConnectorError("import_version_conflict", "Record changed since last read.");
      await client.query(
        `INSERT INTO partner_connector_events
           (connector_record_id, from_state, to_state, event_type, attempt_number, metadata, actor_type, actor_id)
         VALUES ($1,'ready_for_import','importing','import_started',$2,$3,'system',$4)`,
        [connectorId, connector.attempt_count, JSON.stringify({}), claimant]
      );

      const toImported = await client.query<{ version: number }>(
        `UPDATE partner_connector_records
            SET state = 'imported', version = version + 1, updated_at = now(), completed_at = now()
          WHERE id = $1 AND version = $2 AND state = 'importing'
          RETURNING version`,
        [connectorId, expectedVersion + 1]
      );
      if (toImported.rows.length === 0)
        throw new ConnectorError("import_version_conflict", "Record changed since last read.");
      await client.query(
        `INSERT INTO partner_connector_events
           (connector_record_id, from_state, to_state, event_type, attempt_number, metadata, actor_type, actor_id)
         VALUES ($1,'importing','imported','imported',$2,$3,'system',$4)`,
        [connectorId, connector.attempt_count, JSON.stringify({ destinationSubmissionId: created.id }), claimant]
      );

      return {
        outcome: "imported",
        destinationSubmissionId: created.id,
        destinationReference: created.tracking_number,
      };
    }, tenantId)
  );
}

/** Read-only. Available even when the connector flag is off, matching G1/G2's status-read posture. */
export async function getConnectorImport(connectorId: string): Promise<ConnectorImportRecord | null> {
  return guarded(async () => {
    const { rows } = await connectorQuery<{
      id: string;
      connector_record_id: string;
      state: string;
      destination_submission_id: number | null;
      reserved_at: string;
      completed_at: string | null;
      reconciled_at: string | null;
    }>(
      `SELECT id, connector_record_id, state, destination_submission_id, reserved_at, completed_at, reconciled_at
         FROM partner_connector_imports WHERE connector_record_id = $1`,
      [connectorId]
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      id: r.id,
      connectorRecordId: r.connector_record_id,
      state: r.state as ConnectorImportRecord["state"],
      destinationSubmissionId: r.destination_submission_id,
      reservedAt: r.reserved_at,
      completedAt: r.completed_at,
      reconciledAt: r.reconciled_at,
    };
  });
}

/** Read-only. Returns the destination reference for a completed import, or null. */
export async function getImportedDestination(
  connectorId: string
): Promise<{ destinationSubmissionId: number; destinationReference: string } | null> {
  return guarded(async () => {
    const { rows } = await connectorQuery<{ destination_submission_id: number }>(
      `SELECT destination_submission_id FROM partner_connector_imports
        WHERE connector_record_id = $1 AND state = 'completed'`,
      [connectorId]
    );
    if (rows.length === 0 || rows[0].destination_submission_id == null) return null;
    const destRes = await connectorQuery<{ tracking_number: string }>(
      `SELECT tracking_number FROM submissions WHERE id = $1`,
      [rows[0].destination_submission_id]
    );
    if (destRes.rows.length === 0) return null;
    return {
      destinationSubmissionId: rows[0].destination_submission_id,
      destinationReference: destRes.rows[0].tracking_number,
    };
  });
}

export type ConsistencyStatus =
  | "consistent_no_import"
  | "consistent_reserved"
  | "consistent_completed"
  | "needs_review_destination_missing"
  | "needs_review_imported_without_mapping";

/**
 * Read-only inspector (G3E, partial — see RECONCILIATION-RUNBOOK.md for what this proves vs. what
 * remains designed-only). Never mutates anything; a future `reconcileConnectorImport` action would
 * consume this function's output, not replace it.
 */
export async function inspectConnectorImportConsistency(connectorId: string): Promise<{
  status: ConsistencyStatus;
  connectorState: string | null;
  mapping: ConnectorImportRecord | null;
}> {
  return guarded(async () => {
    const connRes = await connectorQuery<{ state: string }>(
      `SELECT state FROM partner_connector_records WHERE id = $1`,
      [connectorId]
    );
    const connectorState = connRes.rows[0]?.state ?? null;
    const mapping = await getConnectorImport(connectorId);

    if (connectorState === "imported" && !mapping) {
      return { status: "needs_review_imported_without_mapping", connectorState, mapping };
    }
    if (mapping?.state === "completed") {
      if (mapping.destinationSubmissionId == null) {
        return { status: "needs_review_destination_missing", connectorState, mapping };
      }
      const dest = await connectorQuery<{ id: number }>(`SELECT id FROM submissions WHERE id = $1`, [
        mapping.destinationSubmissionId,
      ]);
      if (dest.rows.length === 0) {
        return { status: "needs_review_destination_missing", connectorState, mapping };
      }
      return { status: "consistent_completed", connectorState, mapping };
    }
    if (mapping?.state === "reserved") {
      return { status: "consistent_reserved", connectorState, mapping };
    }
    return { status: "consistent_no_import", connectorState, mapping };
  });
}
