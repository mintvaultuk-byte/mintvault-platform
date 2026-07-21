/**
 * G6D credit settlement at the existing MintVault submission boundary.
 *
 * Partner-origin grading is never allowed to proceed without a proven active (or exact already-
 * consumed) reservation. Mapping, reservation and operational accounting faults are recorded as
 * immutable evidence and stop the MintVault status transition; entered grading work remains intact
 * for authorised reconciliation/recovery.
 */
import type pg from "pg";
import { assertPartnerAccountingDatabaseTopology, withPartnerAdminTransaction } from "./db";
import { assertPartnerCreditDefinerModel } from "./definer-guard";
import {
  CreditReservationError,
  consumeReservedCreditInTransaction,
  expireReservedCreditInTransaction,
  reserveCreditInTransaction,
  releaseReservedCreditInTransaction,
  type CreditReservation,
} from "./partner-credit-reservation-service";

const CREDIT_SOURCE = "portal" as const;
// `received` means MintVault physically holds the card. Releasing its reservation would let a
// Partner cancel after intake and submit a free replacement grading.
const PRE_GRADING_DESTINATION_STATUSES = new Set(["draft", "new", "paid"]);
const GRADE_COMPLETION_STATUSES = new Set(["ready_to_return", "completed"]);
const PARTNER_SUBMISSION_CREDIT_TTL_MS = 365 * 24 * 60 * 60 * 1000;

export class PartnerSubmissionCreditLifecycleError extends Error {
  constructor(
    message: string,
    readonly code:
      | "connector_link_inconsistent"
      | "reservation_link_inconsistent"
      | "credit_schema_incomplete"
      | "credit_settlement_required"
      | "destination_credit_hold_active" = "reservation_link_inconsistent"
  ) {
    super(message);
    this.name = "PartnerSubmissionCreditLifecycleError";
  }
}

export type ConnectorReservationReleaseOutcome =
  "released" | "expired" | "legacy_missing_credit_schema" | "legacy_no_reservation" | "already_settled";

export type ConnectorTerminalReleaseReason =
  | "connector_rejected"
  | "connector_cancelled"
  | "validation_rejected"
  | "validation_cancelled"
  | "reconciliation_cancelled"
  | "permanent_failure_cancelled";

export interface ConnectorReservationReleaseResult {
  outcome: ConnectorReservationReleaseOutcome;
  reservationId: string | null;
}

type ReservationRow = CreditReservation;

interface PartnerDestinationLink {
  connector_id: string | null;
  connector_tenant_id: string | null;
  connector_partner_submission_id: string | null;
  tenant_id: string;
  location_id: string | null;
  partner_submission_id: string;
  destination_submission_id: number;
  state: string | null;
  mapping_deleted_at: string | null;
}

interface DestinationHoldRow {
  id: string;
  tenant_id: string;
  partner_submission_id: string;
  destination_submission_id: number;
  reservation_id: string;
  released_at: string | null;
  recovery_reservation_id: string | null;
  recovery_idempotency_key: string | null;
}

export async function partnerCreditSchemaState(
  client: pg.PoolClient
): Promise<"ready" | "legacy_missing_credit_schema"> {
  const result = await client.query<{
    wallets: string | null;
    ledger: string | null;
    reservations: string | null;
    events: string | null;
  }>(
    `SELECT to_regclass('public.partner_wallets')::text AS wallets,
            to_regclass('public.partner_credit_ledger')::text AS ledger,
            to_regclass('public.partner_credit_reservations')::text AS reservations,
            to_regclass('public.partner_credit_reservation_events')::text AS events`
  );
  const row = result.rows[0];
  const objects = [row?.wallets, row?.ledger, row?.reservations, row?.events];
  if (objects.every((value) => !value)) return "legacy_missing_credit_schema";
  if (objects.some((value) => !value)) {
    throw new PartnerSubmissionCreditLifecycleError(
      "Partner credit accounting schema is incomplete and requires reconciliation.",
      "credit_schema_incomplete"
    );
  }
  return "ready";
}

/**
 * G6D depends on the G6A/G6B base tables *and* its own immutable evidence,
 * destination hold and release capability. A partially deployed 0016/0017/0019
 * set is not a legacy deployment and must never fall through to generic grading.
 */
export async function assertPartnerCreditLifecycleReady(
  client: pg.PoolClient
): Promise<"ready" | "legacy_missing_credit_schema"> {
  try {
    assertPartnerAccountingDatabaseTopology();
  } catch {
    throw new PartnerSubmissionCreditLifecycleError(
      "Partner G6D credit settlement is unavailable until database topology is reconciled.",
      "credit_schema_incomplete"
    );
  }
  const accounting = await partnerCreditSchemaState(client);
  if (accounting === "legacy_missing_credit_schema") return accounting;
  const result = await client.query<{
    imports: string | null;
    exceptions: string | null;
    holds: string | null;
    release_function: string | null;
  }>(
    `SELECT to_regclass('public.partner_connector_imports')::text AS imports,
            to_regclass('public.partner_credit_accounting_exceptions')::text AS exceptions,
            to_regclass('public.partner_submission_credit_holds')::text AS holds,
            to_regprocedure('public.partner_connector_release_submission_credit(uuid,uuid,uuid,text)')::text
              AS release_function`
  );
  const row = result.rows[0];
  if (!row?.imports || !row.exceptions || !row.holds || !row.release_function) {
    throw new PartnerSubmissionCreditLifecycleError(
      "Partner G6D lifecycle schema is incomplete; migrations 0016, 0017 and 0019 must be applied together.",
      "credit_schema_incomplete"
    );
  }
  try {
    await assertPartnerCreditDefinerModel((sql, params) => client.query(sql, params));
  } catch {
    throw new PartnerSubmissionCreditLifecycleError(
      "Partner G6D lifecycle capability is unavailable and requires operator reconciliation.",
      "credit_schema_incomplete"
    );
  }
  return "ready";
}

async function findReservationForPartnerSubmission(
  client: pg.PoolClient,
  tenantId: string,
  partnerSubmissionId: string,
  lock: boolean,
  allowAuthorisedRecovery = false
): Promise<ReservationRow | null> {
  const result = await client.query<ReservationRow>(
    `SELECT id, wallet_id, tenant_id, location_id, card_reference, submission_reference, reserved_credits,
            status, idempotency_key, request_fingerprint, source, reason, actor_type, actor_user_id,
            actor_email, external_ref, metadata, created_at, updated_at, expires_at, consumed_at,
            released_at, expired_at
       FROM partner_credit_reservations
      WHERE tenant_id=$1
        AND source=$2
        AND submission_reference=$3
      ORDER BY created_at ASC, id ASC
      LIMIT 3${lock ? " FOR UPDATE" : ""}`,
    [tenantId, CREDIT_SOURCE, partnerSubmissionId]
  );
  if (result.rows.length > 1) {
    // A recovery necessarily retains the released/expired predecessor for
    // immutable accounting history. It is the sole narrow exception to the
    // no-duplicates invariant, and only when the persisted hold explicitly
    // links that predecessor to this exact replacement reservation.
    if (allowAuthorisedRecovery && result.rows.length === 2) {
      const replacement = result.rows.find((row) => row.status === "active" || row.status === "consumed");
      const predecessor = result.rows.find(
        (row) => row !== replacement && (row.status === "released" || row.status === "expired")
      );
      if (replacement && predecessor) {
        const authorised = await client.query(
          `SELECT 1
             FROM partner_submission_credit_holds
            WHERE tenant_id=$1
              AND partner_submission_id=$2
              AND reservation_id=$3
              AND recovery_reservation_id=$4
              AND released_at IS NOT NULL
            LIMIT 1`,
          [tenantId, partnerSubmissionId, predecessor.id, replacement.id]
        );
        if (authorised.rows.length === 1) return replacement;
      }
    }
    throw new PartnerSubmissionCreditLifecycleError(
      "Partner submission has more than one authoritative credit reservation and requires reconciliation.",
      "reservation_link_inconsistent"
    );
  }
  return result.rows[0] ?? null;
}

/**
 * A reservation's composite location FK proves its location belongs to its tenant, but the source
 * submission uses a separate legacy FK. Re-read the source to make corruption explicit rather than
 * using it as a release/consume bridge.
 */
async function assertReservationSourceSubmission(
  client: pg.PoolClient,
  reservation: ReservationRow,
  tenantId: string,
  partnerSubmissionId: string
): Promise<void> {
  if (reservation.tenant_id !== tenantId || reservation.submission_reference !== partnerSubmissionId) {
    throw new PartnerSubmissionCreditLifecycleError(
      "Partner submission credit linkage is inconsistent.",
      "reservation_link_inconsistent"
    );
  }
  const source = await client.query(
    `SELECT id
       FROM partner_submissions
      WHERE id=$1 AND tenant_id=$2 AND location_id IS NOT DISTINCT FROM $3::uuid`,
    [partnerSubmissionId, tenantId, reservation.location_id]
  );
  if (source.rowCount !== 1) {
    throw new PartnerSubmissionCreditLifecycleError(
      "Partner submission credit linkage is inconsistent.",
      "reservation_link_inconsistent"
    );
  }
}

async function releaseOrExpireActiveReservation(
  client: pg.PoolClient,
  reservation: ReservationRow,
  params: {
    source: "connector" | "portal";
    reason: string;
    actorType: "system" | "partner_user";
    actorUserId: string | null;
    actorEmail: string | null;
    keySuffix: string;
    connectorRecordId?: string;
  }
): Promise<"released" | "expired"> {
  const now = new Date();
  const metadata = {
    partner_submission_id: reservation.submission_reference,
    g6d_settlement: true,
    ...(params.connectorRecordId ? { connector_record_id: params.connectorRecordId } : {}),
  };
  const common = {
    tenantId: reservation.tenant_id,
    reservationId: reservation.id,
    source: params.source,
    reason: params.reason,
    actorType: params.actorType,
    externalRef: reservation.external_ref,
    metadata,
    now,
  } as const;
  if (new Date(reservation.expires_at).getTime() <= now.getTime()) {
    await expireReservedCreditInTransaction(
      client,
      { actorUserId: null, actorEmail: null },
      {
        ...common,
        source: "system",
        reason: "Partner grading-credit reservation expired before cancellation.",
        idempotencyKey: `g6d-expire:${params.keySuffix}:${reservation.id}`,
      }
    );
    return "expired";
  }
  await releaseReservedCreditInTransaction(
    client,
    { actorUserId: params.actorUserId, actorEmail: params.actorEmail },
    { ...common, idempotencyKey: `g6d-release:${params.keySuffix}:${reservation.id}` }
  );
  return "released";
}

/**
 * Called only by the trusted connector while it moves a record to rejected/cancelled. A missing
 * G6B schema is a normal legacy deployment; a missing reservation is a normal pre-G6D submission.
 * Cross-tenant/corrupt tuples are never downgraded to either legacy state.
 */
export async function releasePartnerReservationForConnectorTerminalState(
  client: pg.PoolClient,
  connector: { id: string; tenantId: string; partnerSubmissionId: string },
  terminalReason: ConnectorTerminalReleaseReason
): Promise<ConnectorReservationReleaseResult> {
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [connector.tenantId]);
  if ((await assertPartnerCreditLifecycleReady(client)) === "legacy_missing_credit_schema") {
    return { outcome: "legacy_missing_credit_schema", reservationId: null };
  }
  const result = await client.query<{ outcome: string; reservation_id: string | null }>(
    `SELECT outcome, reservation_id
       FROM partner_connector_release_submission_credit($1::uuid, $2::uuid, $3::uuid, $4::text)`,
    [connector.id, connector.tenantId, connector.partnerSubmissionId, terminalReason]
  );
  const row = result.rows[0];
  if (!row || row.outcome === "corrupt_linkage") {
    throw new PartnerSubmissionCreditLifecycleError(
      "Connector record, import, source submission or reservation linkage is inconsistent.",
      "connector_link_inconsistent"
    );
  }
  if (!["released", "expired", "legacy_no_reservation", "already_settled"].includes(row.outcome)) {
    throw new PartnerSubmissionCreditLifecycleError(
      "Connector credit release returned an invalid lifecycle result.",
      "connector_link_inconsistent"
    );
  }
  return {
    outcome: row.outcome as Exclude<ConnectorReservationReleaseOutcome, "legacy_missing_credit_schema">,
    reservationId: row.reservation_id,
  };
}

async function relationExists(client: pg.PoolClient, relation: string): Promise<boolean> {
  const result = await client.query<{ relation: string | null }>("SELECT to_regclass($1)::text AS relation", [
    relation,
  ]);
  return !!result.rows[0]?.relation;
}

async function hasAuthoritativeMappingForSource(
  client: pg.PoolClient,
  tenantId: string,
  partnerSubmissionId: string
): Promise<boolean> {
  if (!(await relationExists(client, "public.partner_connector_imports"))) return false;
  const mapping = await client.query(
    `SELECT 1
       FROM partner_connector_imports
      WHERE partner_organisation_id=$1 AND partner_submission_id=$2
      LIMIT 1`,
    [tenantId, partnerSubmissionId]
  );
  return mapping.rowCount === 1;
}

async function lockDestinationForPartnerCancellation(
  client: pg.PoolClient,
  params: { tenantId: string; partnerSubmissionId: string; locationId: string | null }
): Promise<{
  connector_import_id: string;
  connector_id: string;
  destination_submission_id: number | null;
  state: string;
  mapping_deleted_at: string | null;
  status: string | null;
  deleted_at: string | null;
  tracking_number: string | null;
} | null> {
  if (!(await relationExists(client, "public.partner_connector_imports"))) return null;
  const destination = await client.query<{
    connector_import_id: string;
    connector_id: string;
    destination_submission_id: number | null;
    state: string;
    mapping_deleted_at: string | null;
    status: string | null;
    deleted_at: string | null;
    tracking_number: string | null;
  }>(
    `SELECT i.id AS connector_import_id, i.connector_record_id AS connector_id,
            i.destination_submission_id, i.state,
            (to_jsonb(i)->>'deleted_at')::timestamptz AS mapping_deleted_at,
            s.status, s.deleted_at, s.tracking_number
       FROM partner_connector_imports i
       JOIN partner_connector_records r
         ON r.id=i.connector_record_id
        AND r.tenant_id=i.partner_organisation_id
        AND r.partner_submission_id=i.partner_submission_id
       LEFT JOIN submissions s ON s.id=i.destination_submission_id
      WHERE i.partner_organisation_id=$1
        AND i.partner_submission_id=$2
        AND i.partner_location_id IS NOT DISTINCT FROM $3::uuid
      FOR UPDATE OF i, r`,
    [params.tenantId, params.partnerSubmissionId, params.locationId]
  );
  if (destination.rows.length > 1) {
    throw new PartnerSubmissionCreditLifecycleError(
      "Partner submission destination linkage is ambiguous and requires review.",
      "reservation_link_inconsistent"
    );
  }
  const row = destination.rows[0] ?? null;
  if (!row || !row.destination_submission_id) return row;
  const locked = await client.query<{ status: string; deleted_at: string | null; tracking_number: string }>(
    "SELECT status, deleted_at, tracking_number FROM submissions WHERE id=$1 FOR UPDATE",
    [row.destination_submission_id]
  );
  if (locked.rowCount !== 1) return row;
  return { ...row, ...locked.rows[0] };
}

async function createDestinationCreditHold(
  client: pg.PoolClient,
  destination: { id: number; tracking_number: string },
  params: {
    tenantId: string;
    partnerSubmissionId: string;
    reservationId: string;
    connectorId?: string | null;
    connectorImportId?: string | null;
    actorUserId?: string | null;
    actorEmail?: string | null;
    reasonCode: string;
  }
): Promise<void> {
  const existing = await client.query<DestinationHoldRow>(
    `SELECT id, tenant_id, partner_submission_id, destination_submission_id, reservation_id,
            released_at, recovery_reservation_id, recovery_idempotency_key
       FROM partner_submission_credit_holds
      WHERE destination_submission_id=$1 AND released_at IS NULL
      FOR UPDATE`,
    [destination.id]
  );
  if (existing.rowCount === 1) {
    if (existing.rows[0].reservation_id !== params.reservationId) {
      throw new PartnerSubmissionCreditLifecycleError(
        "Partner destination has a conflicting active credit hold and requires reconciliation.",
        "reservation_link_inconsistent"
      );
    }
    return;
  }
  await client.query(
    `INSERT INTO partner_submission_credit_holds
       (tenant_id, partner_submission_id, destination_submission_id, reservation_id,
        connector_record_id, connector_import_id, reason_code, blocked_by_user_id, blocked_by_email)
     VALUES ($1::uuid,$2::uuid,$3,$4::uuid,$5::uuid,$6::uuid,$7,$8::uuid,$9)`,
    [
      params.tenantId,
      params.partnerSubmissionId,
      destination.id,
      params.reservationId,
      params.connectorId ?? null,
      params.connectorImportId ?? null,
      params.reasonCode,
      params.actorUserId ?? null,
      params.actorEmail ?? null,
    ]
  );
  await auditAccountingException(
    client,
    destination,
    "credit_hold",
    "destination_credit_hold_created",
    {
      tenant_id: params.tenantId,
      partner_submission_id: params.partnerSubmissionId,
      reservation_id: params.reservationId,
      connector_id: params.connectorId ?? null,
      connector_import_id: params.connectorImportId ?? null,
      reason_code: params.reasonCode,
    },
    "destination_credit_hold"
  );
}

/** Releases a reservation from the authenticated Partner cancellation path in the caller's transaction. */
export async function releasePartnerReservationForPartnerCancellation(
  client: pg.PoolClient,
  params: {
    tenantId: string;
    partnerSubmissionId: string;
    actorUserId: string;
    actorEmail: string | null;
  }
): Promise<{ released: boolean; reservationId: string | null; outcome: ConnectorReservationReleaseOutcome }> {
  if ((await assertPartnerCreditLifecycleReady(client)) === "legacy_missing_credit_schema") {
    return { released: false, reservationId: null, outcome: "legacy_missing_credit_schema" };
  }
  const reservation = await findReservationForPartnerSubmission(
    client,
    params.tenantId,
    params.partnerSubmissionId,
    true
  );
  if (!reservation) {
    if (await hasAuthoritativeMappingForSource(client, params.tenantId, params.partnerSubmissionId)) {
      throw new PartnerSubmissionCreditLifecycleError(
        "Partner destination linkage has no active reservation and requires reconciliation.",
        "credit_settlement_required"
      );
    }
    return { released: false, reservationId: null, outcome: "legacy_no_reservation" };
  }
  await assertReservationSourceSubmission(client, reservation, params.tenantId, params.partnerSubmissionId);
  if (reservation.status !== "active") {
    throw new PartnerSubmissionCreditLifecycleError(
      "This submission credit has already been settled and cannot be released."
    );
  }

  const destination = await lockDestinationForPartnerCancellation(client, {
    tenantId: params.tenantId,
    partnerSubmissionId: params.partnerSubmissionId,
    locationId: reservation.location_id,
  });
  if (destination) {
    const row = destination;
    if (
      !row.destination_submission_id ||
      row.status == null ||
      row.state !== "completed" ||
      row.mapping_deleted_at != null ||
      row.deleted_at != null
    ) {
      throw new PartnerSubmissionCreditLifecycleError(
        "Partner submission destination linkage is incomplete and requires review."
      );
    }
    if (!PRE_GRADING_DESTINATION_STATUSES.has(row.status.toLowerCase())) {
      throw new PartnerSubmissionCreditLifecycleError(
        "A Partner submission cannot be cancelled after MintVault has received the cards."
      );
    }
    await createDestinationCreditHold(
      client,
      {
        id: row.destination_submission_id,
        tracking_number: row.tracking_number ?? String(row.destination_submission_id),
      },
      {
        tenantId: params.tenantId,
        partnerSubmissionId: params.partnerSubmissionId,
        reservationId: reservation.id,
        connectorId: row.connector_id,
        connectorImportId: row.connector_import_id,
        actorUserId: params.actorUserId,
        actorEmail: params.actorEmail,
        reasonCode: "partner_cancellation_credit_released",
      }
    );
  }

  const outcome = await releaseOrExpireActiveReservation(client, reservation, {
    source: "portal",
    reason: "Partner cancelled the submission before MintVault received the cards.",
    actorType: "partner_user",
    actorUserId: params.actorUserId,
    actorEmail: params.actorEmail,
    keySuffix: params.partnerSubmissionId,
  });
  return { released: true, reservationId: reservation.id, outcome };
}

async function findPartnerDestinationLink(
  client: pg.PoolClient,
  destinationSubmissionId: number
): Promise<PartnerDestinationLink[] | null> {
  // G3 imports do not exist on a genuine legacy deployment. Treat that as an
  // ordinary non-Partner destination, not as a raw undefined-table failure.
  if (!(await relationExists(client, "public.partner_connector_imports"))) return null;
  const result = await client.query<PartnerDestinationLink>(
    `SELECT c.id AS connector_id,
            c.tenant_id AS connector_tenant_id,
            c.partner_submission_id AS connector_partner_submission_id,
            i.partner_organisation_id AS tenant_id,
            i.partner_location_id AS location_id,
            i.partner_submission_id,
            i.destination_submission_id,
            i.state,
            (to_jsonb(i)->>'deleted_at')::timestamptz AS mapping_deleted_at
       FROM partner_connector_imports i
       LEFT JOIN partner_connector_records c ON c.id=i.connector_record_id
      WHERE i.destination_submission_id=$1`,
    [destinationSubmissionId]
  );
  return result.rowCount === 0 ? null : result.rows;
}

async function partnerLinkIssue(client: pg.PoolClient, link: PartnerDestinationLink): Promise<string | null> {
  if (
    !link.connector_id ||
    link.connector_tenant_id !== link.tenant_id ||
    link.connector_partner_submission_id !== link.partner_submission_id
  ) {
    return "connector_import_identity_mismatch";
  }
  const source = await client.query(
    `SELECT 1 FROM partner_submissions
      WHERE id=$1 AND tenant_id=$2 AND location_id IS NOT DISTINCT FROM $3::uuid`,
    [link.partner_submission_id, link.tenant_id, link.location_id]
  );
  return source.rowCount === 1 ? null : "partner_submission_identity_mismatch";
}

async function auditAccountingException(
  client: pg.PoolClient,
  destination: { id: number; tracking_number: string },
  status: string,
  code: string,
  details: Record<string, unknown>,
  eventType: "settlement_exception" | "destination_credit_hold" | "destination_credit_recovery" = "settlement_exception"
): Promise<void> {
  const partnerSubmissionId = typeof details.partner_submission_id === "string" ? details.partner_submission_id : null;
  const tenantId = typeof details.tenant_id === "string" ? details.tenant_id : null;
  if (!tenantId) {
    throw new PartnerSubmissionCreditLifecycleError(
      "Partner accounting exception is missing its tenant identity.",
      "reservation_link_inconsistent"
    );
  }
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
  const evidenceTable = await client.query<{ relation: string | null }>(
    `SELECT to_regclass('public.partner_credit_accounting_exceptions')::text AS relation`
  );
  if (!evidenceTable.rows[0]?.relation) {
    throw new PartnerSubmissionCreditLifecycleError(
      "Partner accounting-exception evidence is incomplete and requires migration 0019.",
      "credit_schema_incomplete"
    );
  }
  await client.query(
    `INSERT INTO partner_credit_accounting_exceptions
       (tenant_id, partner_submission_id, destination_submission_id, connector_record_id,
        connector_import_id, reservation_id, event_type, reason_code, idempotency_key, metadata)
     VALUES ($1::uuid,$2::uuid,$3,$4::uuid,$5::uuid,$6::uuid,$7,$8,$9,$10::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      tenantId,
      partnerSubmissionId,
      destination.id,
      typeof details.connector_id === "string" ? details.connector_id : null,
      typeof details.connector_import_id === "string" ? details.connector_import_id : null,
      typeof details.reservation_id === "string" ? details.reservation_id : null,
      eventType,
      code,
      `g6d-${eventType}:${destination.id}:${status}:${code}:${partnerSubmissionId ?? "none"}`,
      JSON.stringify({ destination_submission_id: destination.id, requested_status: status, ...details }),
    ]
  );
}

/**
 * Mapping identity failures must stop the MintVault status transition, but the
 * transition's transaction will roll back. Persist the immutable exception in
 * a separate privileged transaction first, then fail the original request.
 */
async function failClosedAccountingException(
  destination: { id: number; tracking_number: string },
  status: string,
  code: string,
  details: Record<string, unknown>
): Promise<never> {
  await withPartnerAdminTransaction((client) => auditAccountingException(client, destination, status, code, details));
  throw new PartnerSubmissionCreditLifecycleError(
    "Partner credit settlement requires reconciliation before the destination status can change.",
    "credit_settlement_required"
  );
}

async function updateDestinationStatus(
  client: pg.PoolClient,
  destinationSubmissionId: number,
  status: string,
  extra: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const assignments = ["status = $2", "updated_at = NOW()"];
  const values: unknown[] = [destinationSubmissionId, status];
  const add = (column: string, value: unknown) => {
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  };
  if (status === "shipped") {
    assignments.push("shipped_at = NOW()");
    if (typeof extra.returnTracking === "string") add("return_tracking", extra.returnTracking);
    if (typeof extra.returnCarrier === "string") add("return_carrier", extra.returnCarrier);
    if (typeof extra.returnService === "string") add("return_service", extra.returnService);
  }
  if (status === "delivered") assignments.push("delivered_at = NOW()");
  if (status === "completed") assignments.push("completed_at = NOW()");
  if (extra.returnPostageCost !== undefined) add("return_postage_cost", extra.returnPostageCost);
  if (extra.onReceiptPhotoUrls !== undefined) add("on_receipt_photo_urls", extra.onReceiptPhotoUrls);
  values.push(JSON.stringify({ status, timestamp: new Date().toISOString(), note: extra.note ?? null }));
  assignments.push(`status_history = COALESCE(status_history, '[]'::jsonb) || $${values.length}::jsonb`);

  const updated = await client.query<Record<string, unknown>>(
    `UPDATE submissions SET ${assignments.join(", ")} WHERE id=$1 RETURNING *`,
    values
  );
  const row = updated.rows[0];
  return { id: row.id, submissionId: row.tracking_number, ...row };
}

async function hasExactConsumedEvidence(client: pg.PoolClient, reservation: ReservationRow): Promise<boolean> {
  const terminal = await client.query<{ count: string; event_type: string | null }>(
    `SELECT count(*)::text AS count, min(event_type) AS event_type
       FROM partner_credit_reservation_events
      WHERE reservation_id=$1
        AND tenant_id=$2
        AND event_type IN ('consumed','released','expired')`,
    [reservation.id, reservation.tenant_id]
  );
  return terminal.rows[0]?.count === "1" && terminal.rows[0]?.event_type === "consumed";
}

async function hasActiveDestinationCreditHold(
  client: pg.PoolClient,
  destinationSubmissionId: number
): Promise<boolean> {
  const hold = await client.query(
    `SELECT 1 FROM partner_submission_credit_holds
      WHERE destination_submission_id=$1 AND released_at IS NULL
      LIMIT 1`,
    [destinationSubmissionId]
  );
  return hold.rowCount === 1;
}

function consumeFailureCode(error: unknown): string {
  if (error instanceof CreditReservationError) return `credit_consume_${error.code.toLowerCase()}`;
  const pgError = error as { code?: unknown } | null;
  if (typeof pgError?.code === "string" && /^[0-9A-Z]{5}$/.test(pgError.code)) {
    return `credit_consume_sqlstate_${pgError.code.toLowerCase()}`;
  }
  return "credit_consume_unknown_failure";
}

/**
 * Consume an active Partner credit and apply the MintVault status write as one commit. The connector
 * import mapping is the authoritative answer to "is this Partner-owned?". Once the accounting
 * tables exist, a missing, released, expired, duplicate or otherwise inconsistent reservation is
 * a hard stop, never a generic-submission fallback. A savepoint exists only to make it possible to
 * write durable evidence after a failed consume; the destination transition always rolls back.
 */
export async function settlePartnerCreditForDestinationStatus(
  destinationSubmissionId: number,
  statusRaw: string,
  extra: Record<string, unknown> = {}
): Promise<Record<string, unknown> | null> {
  const status = statusRaw.toLowerCase();
  if (!GRADE_COMPLETION_STATUSES.has(status)) return null;

  return withPartnerAdminTransaction(async (client) => {
    const destinationResult = await client.query<{ id: number; tracking_number: string }>(
      "SELECT id, tracking_number FROM submissions WHERE id=$1 FOR UPDATE",
      [destinationSubmissionId]
    );
    const destination = destinationResult.rows[0];
    if (!destination) return null;

    const links = await findPartnerDestinationLink(client, destinationSubmissionId);
    if (!links) return null;
    if (links.length !== 1) {
      const first = links[0];
      return failClosedAccountingException(destination, status, "duplicate_partner_destination_link", {
        link_count: links.length,
        partner_submission_id: first?.partner_submission_id ?? null,
        tenant_id: first?.tenant_id ?? null,
      });
    }
    const link = links[0];
    if (link.mapping_deleted_at != null) {
      return failClosedAccountingException(destination, status, "partner_mapping_deleted", {
        partner_submission_id: link.partner_submission_id,
        tenant_id: link.tenant_id,
        connector_id: link.connector_id,
      });
    }
    if (link.state !== "completed") {
      return failClosedAccountingException(destination, status, "partner_mapping_not_completed", {
        partner_submission_id: link.partner_submission_id,
        tenant_id: link.tenant_id,
        connector_id: link.connector_id,
        mapping_state: link.state,
      });
    }
    const issue = await partnerLinkIssue(client, link);
    if (issue) {
      return failClosedAccountingException(destination, status, issue, {
        partner_submission_id: link.partner_submission_id,
        tenant_id: link.tenant_id,
      });
    }

    if ((await partnerCreditSchemaState(client)) === "legacy_missing_credit_schema") {
      // A truly pre-G6A deployment has no credit contract/evidence table. It retains the established
      // legacy behaviour; any mixed or post-G6A deployment is handled explicitly below.
      return updateDestinationStatus(client, destinationSubmissionId, status, extra);
    }

    await assertPartnerCreditLifecycleReady(client);
    if (await hasActiveDestinationCreditHold(client, destinationSubmissionId)) {
      return failClosedAccountingException(destination, status, "destination_credit_hold_active", {
        partner_submission_id: link.partner_submission_id,
        tenant_id: link.tenant_id,
        connector_id: link.connector_id,
      });
    }

    let reservation: ReservationRow | null;
    try {
      reservation = await findReservationForPartnerSubmission(
        client,
        link.tenant_id,
        link.partner_submission_id,
        true,
        true
      );
    } catch (error) {
      if (!(error instanceof PartnerSubmissionCreditLifecycleError)) throw error;
      return failClosedAccountingException(destination, status, error.code, {
        partner_submission_id: link.partner_submission_id,
        tenant_id: link.tenant_id,
      });
    }
    if (!reservation) {
      return failClosedAccountingException(destination, status, "missing_partner_credit_reservation", {
        partner_submission_id: link.partner_submission_id,
        tenant_id: link.tenant_id,
      });
    }

    try {
      await assertReservationSourceSubmission(client, reservation, link.tenant_id, link.partner_submission_id);
    } catch (err) {
      if (!(err instanceof PartnerSubmissionCreditLifecycleError)) throw err;
      return failClosedAccountingException(destination, status, err.code, {
        reservation_id: reservation.id,
        partner_submission_id: link.partner_submission_id,
        tenant_id: link.tenant_id,
      });
    }

    if (reservation.status === "active") {
      await client.query("SAVEPOINT g6d_credit_consume");
      try {
        const consumed = await consumeReservedCreditInTransaction(
          client,
          { actorUserId: null, actorEmail: typeof extra.creditActorEmail === "string" ? extra.creditActorEmail : null },
          {
            tenantId: reservation.tenant_id,
            reservationId: reservation.id,
            idempotencyKey: `g6d-consume:${reservation.id}`,
            source: "system",
            reason: "MintVault grading completed for Partner submission.",
            actorType: "admin",
            externalRef: destination.tracking_number,
            metadata: {
              destination_submission_id: destinationSubmissionId,
              destination_reference: destination.tracking_number,
              partner_submission_id: reservation.submission_reference,
            },
          }
        );
        if (consumed.reservation.status !== "consumed" || consumed.event?.event_type !== "consumed") {
          throw new PartnerSubmissionCreditLifecycleError(
            "Partner credit consumption did not produce exact consumed evidence.",
            "reservation_link_inconsistent"
          );
        }
        await client.query("RELEASE SAVEPOINT g6d_credit_consume");
      } catch (err) {
        await client.query("ROLLBACK TO SAVEPOINT g6d_credit_consume");
        await client.query("RELEASE SAVEPOINT g6d_credit_consume");
        return failClosedAccountingException(destination, status, consumeFailureCode(err), {
          reservation_id: reservation.id,
          partner_submission_id: link.partner_submission_id,
          tenant_id: link.tenant_id,
          error_class: err instanceof CreditReservationError ? "credit_reservation" : "database_or_invariant",
        });
      }
      return updateDestinationStatus(client, destinationSubmissionId, status, extra);
    }

    if (reservation.status === "consumed" && (await hasExactConsumedEvidence(client, reservation))) {
      return updateDestinationStatus(client, destinationSubmissionId, status, extra);
    }

    return failClosedAccountingException(destination, status, "reservation_not_consumable", {
      reservation_id: reservation.id,
      partner_submission_id: link.partner_submission_id,
      tenant_id: link.tenant_id,
      reservation_status: reservation.status,
    });
  });
}

/**
 * Controlled Super Admin recovery for a destination stopped by a pre-arrival
 * cancellation. It creates a new active reservation before removing the hold,
 * in the same transaction, so there is no free-grading interval.
 */
export async function recoverPartnerDestinationCreditHold(params: {
  tenantId: string;
  partnerSubmissionId: string;
  actorUserId: string;
  actorEmail: string | null;
  idempotencyKey: string;
  reason: string;
}): Promise<{ destinationSubmissionId: number; reservationId: string; alreadyRecovered: boolean }> {
  return withPartnerAdminTransaction(async (client) => {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [params.tenantId]);
    if ((await assertPartnerCreditLifecycleReady(client)) === "legacy_missing_credit_schema") {
      throw new PartnerSubmissionCreditLifecycleError(
        "Partner credit recovery is unavailable on a legacy accounting schema.",
        "credit_schema_incomplete"
      );
    }
    const holds = await client.query<DestinationHoldRow>(
      `SELECT id, tenant_id, partner_submission_id, destination_submission_id, reservation_id,
              released_at, recovery_reservation_id, recovery_idempotency_key
         FROM partner_submission_credit_holds
        WHERE tenant_id=$1 AND partner_submission_id=$2
        ORDER BY created_at DESC, id DESC
        LIMIT 1
        FOR UPDATE`,
      [params.tenantId, params.partnerSubmissionId]
    );
    const hold = holds.rows[0];
    if (!hold) {
      throw new PartnerSubmissionCreditLifecycleError(
        "No Partner credit hold exists for this submission.",
        "reservation_link_inconsistent"
      );
    }
    if (hold.released_at) {
      if (hold.recovery_idempotency_key === params.idempotencyKey && hold.recovery_reservation_id) {
        return {
          destinationSubmissionId: hold.destination_submission_id,
          reservationId: hold.recovery_reservation_id,
          alreadyRecovered: true,
        };
      }
      throw new PartnerSubmissionCreditLifecycleError(
        "This Partner destination credit hold has already been recovered.",
        "reservation_link_inconsistent"
      );
    }

    const source = await client.query<{ location_id: string | null }>(
      `SELECT location_id FROM partner_submissions
        WHERE id=$1 AND tenant_id=$2
        FOR UPDATE`,
      [params.partnerSubmissionId, params.tenantId]
    );
    const destination = await client.query<{ id: number; tracking_number: string; deleted_at: string | null }>(
      `SELECT id, tracking_number, deleted_at FROM submissions
        WHERE id=$1
        FOR UPDATE`,
      [hold.destination_submission_id]
    );
    const releasedReservation = await client.query<{
      id: string;
      status: string;
      location_id: string | null;
      card_reference: string;
      external_ref: string | null;
    }>(
      `SELECT id, status, location_id, card_reference, external_ref
         FROM partner_credit_reservations
        WHERE id=$1 AND tenant_id=$2
        FOR KEY SHARE`,
      [hold.reservation_id, params.tenantId]
    );
    if (
      source.rowCount !== 1 ||
      destination.rowCount !== 1 ||
      destination.rows[0].deleted_at != null ||
      releasedReservation.rowCount !== 1 ||
      !["released", "expired"].includes(releasedReservation.rows[0].status) ||
      releasedReservation.rows[0].location_id !== source.rows[0].location_id
    ) {
      throw new PartnerSubmissionCreditLifecycleError(
        "Partner credit recovery linkage is inconsistent and requires reconciliation.",
        "reservation_link_inconsistent"
      );
    }

    const replacement = await reserveCreditInTransaction(
      client,
      { actorUserId: params.actorUserId, actorEmail: params.actorEmail },
      {
        tenantId: params.tenantId,
        locationId: source.rows[0].location_id,
        cardReference: releasedReservation.rows[0].card_reference,
        submissionReference: params.partnerSubmissionId,
        expiresAt: new Date(Date.now() + PARTNER_SUBMISSION_CREDIT_TTL_MS),
        idempotencyKey: `g6d-recovery:${params.idempotencyKey}`,
        source: "portal",
        reason: "Authorised recovery re-reserved Partner grading credit.",
        actorType: "admin",
        externalRef: releasedReservation.rows[0].external_ref,
        metadata: {
          destination_submission_id: hold.destination_submission_id,
          prior_reservation_id: hold.reservation_id,
          recovery_reason: params.reason,
        },
      }
    );
    if (replacement.reservation.status !== "active") {
      throw new PartnerSubmissionCreditLifecycleError(
        "Authorised recovery did not create an active Partner credit reservation.",
        "credit_settlement_required"
      );
    }
    await client.query(
      `UPDATE partner_submission_credit_holds
          SET released_at=now(), recovered_by_user_id=$2::uuid, recovered_by_email=$3,
              recovery_reservation_id=$4::uuid, recovery_idempotency_key=$5
        WHERE id=$1 AND released_at IS NULL`,
      [hold.id, params.actorUserId, params.actorEmail, replacement.reservation.id, params.idempotencyKey]
    );
    await auditAccountingException(
      client,
      destination.rows[0],
      "credit_recovery",
      "destination_credit_hold_recovered",
      {
        tenant_id: params.tenantId,
        partner_submission_id: params.partnerSubmissionId,
        reservation_id: replacement.reservation.id,
        prior_reservation_id: hold.reservation_id,
        recovery_reason: params.reason,
      },
      "destination_credit_recovery"
    );
    return {
      destinationSubmissionId: hold.destination_submission_id,
      reservationId: replacement.reservation.id,
      alreadyRecovered: replacement.alreadyApplied,
    };
  });
}
