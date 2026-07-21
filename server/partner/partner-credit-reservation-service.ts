/**
 * G6B partner credit reservation lifecycle.
 *
 * One partner grading credit can be reserved for one card, then either consumed once or returned to
 * availability by release/expiry. The wallet ledger remains append-only: reservation lifecycle facts
 * are recorded in partner_credit_reservation_events, and only consumption writes a -1 wallet-ledger row.
 */
import { createHash } from "node:crypto";
import type pg from "pg";
import { partnerAdminQuery, withPartnerAdminTransaction } from "./db";
import {
  optionalText,
  optionalUuid,
  parseBalance,
  requireIdempotencyKey,
  requireReason,
  requireTenantId,
  validateActorType,
  validateMetadata,
  validateSource,
  type LedgerActorType,
  type LedgerSource,
} from "./partner-wallet-errors";

export type ReservationStatus = "active" | "consumed" | "released" | "expired";
export type ReservationEventType = "reserved" | "consumed" | "released" | "expired";

export const CREDIT_RESERVATION_ERROR_CODES = [
  "VALIDATION_ERROR",
  "WALLET_NOT_FOUND",
  "WALLET_INACTIVE",
  "INSUFFICIENT_CREDITS",
  "IDEMPOTENCY_CONFLICT",
  "RESERVATION_NOT_FOUND",
  "RESERVATION_NOT_ACTIVE",
  "RESERVATION_EXPIRED",
  "RESERVATION_NOT_EXPIRED",
  "CARD_ALREADY_RESERVED",
  "INTERNAL_ERROR",
] as const;
export type CreditReservationErrorCode = (typeof CREDIT_RESERVATION_ERROR_CODES)[number];

export class CreditReservationError extends Error {
  readonly code: CreditReservationErrorCode;
  constructor(code: CreditReservationErrorCode, message: string) {
    super(message);
    this.name = "CreditReservationError";
    this.code = code;
  }
}

export interface ReservationActor {
  actorUserId: string | null;
  actorEmail: string | null;
}

export interface CreditReservation {
  id: string;
  wallet_id: string;
  tenant_id: string;
  location_id: string | null;
  card_reference: string;
  submission_reference: string | null;
  reserved_credits: number;
  status: ReservationStatus;
  idempotency_key: string;
  request_fingerprint: string;
  source: LedgerSource;
  reason: string;
  actor_type: LedgerActorType;
  actor_user_id: string | null;
  actor_email: string | null;
  external_ref: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  expires_at: string;
  consumed_at: string | null;
  released_at: string | null;
  expired_at: string | null;
}

export interface ReservationEvent {
  id: string;
  reservation_id: string;
  wallet_id: string;
  tenant_id: string;
  event_type: ReservationEventType;
  amount: number;
  idempotency_key: string;
  request_fingerprint: string;
  source: LedgerSource;
  reason: string;
  actor_type: LedgerActorType;
  actor_user_id: string | null;
  actor_email: string | null;
  external_ref: string | null;
  metadata: Record<string, unknown>;
  ledger_entry_id: string | null;
  created_at: string;
}

export interface CreditPosition {
  walletId: string;
  tenantId: string;
  ledgerBalance: number;
  activeReserved: number;
  availableBalance: number;
  consumedReservations: number;
}

export interface MutationResult {
  reservation: CreditReservation;
  event: ReservationEvent | null;
  alreadyApplied: boolean;
}

export interface ReserveCreditInput {
  /** Server-resolved organisation id. Never pass a tenant id from an untrusted request body. */
  tenantId: string;
  /** Server-resolved location id where applicable. Never pass a location id from an untrusted request body. */
  locationId?: string | null;
  cardReference: string;
  submissionReference?: string | null;
  expiresAt: Date | string;
  idempotencyKey: string;
  source: LedgerSource;
  reason: string;
  actorType: LedgerActorType;
  externalRef?: string | null;
  metadata?: Record<string, unknown>;
  now?: Date;
}

export interface ReservationTransitionInput {
  /** Server-resolved organisation id. Never pass a tenant id from an untrusted request body. */
  tenantId: string;
  reservationId: string;
  idempotencyKey?: string;
  source: LedgerSource;
  reason: string;
  actorType: LedgerActorType;
  externalRef?: string | null;
  metadata?: Record<string, unknown>;
  now?: Date;
}

export interface ReconciliationIssue {
  code: string;
  severity: "error" | "warning";
  tenantId: string | null;
  walletId?: string | null;
  reservationId?: string | null;
  detail: string;
}

const RESERVATION_COLS =
  "id, wallet_id, tenant_id, location_id, card_reference, submission_reference, reserved_credits, status, idempotency_key, request_fingerprint, source, reason, actor_type, actor_user_id, actor_email, external_ref, metadata, created_at, updated_at, expires_at, consumed_at, released_at, expired_at";
const EVENT_COLS =
  "id, reservation_id, wallet_id, tenant_id, event_type, amount, idempotency_key, request_fingerprint, source, reason, actor_type, actor_user_id, actor_email, external_ref, metadata, ledger_entry_id, created_at";

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}

function requestFingerprint(payload: Record<string, unknown>): string {
  return createHash("sha256").update(stableJson(payload), "utf8").digest("hex");
}

function normalizeJson(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return {};
}

function normalizeReservation(row: Record<string, unknown>): CreditReservation {
  return {
    ...(row as unknown as CreditReservation),
    reserved_credits: parseBalance(row.reserved_credits),
    metadata: normalizeJson(row.metadata),
  };
}

function normalizeEvent(row: Record<string, unknown>): ReservationEvent {
  return {
    ...(row as unknown as ReservationEvent),
    amount: parseBalance(row.amount),
    metadata: normalizeJson(row.metadata),
  };
}

function requireCardReference(raw: unknown): string {
  const s = optionalText(raw, "cardReference", 200);
  if (!s) throw new CreditReservationError("VALIDATION_ERROR", "cardReference is required.");
  return s;
}

function requireFutureExpiry(raw: Date | string, now: Date): Date {
  const d = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(d.getTime()))
    throw new CreditReservationError("VALIDATION_ERROR", "expiresAt must be a valid date.");
  if (d.getTime() <= now.getTime()) {
    throw new CreditReservationError("VALIDATION_ERROR", "expiresAt must be in the future.");
  }
  return d;
}

function validateCommon(
  actor: ReservationActor,
  input: {
    tenantId: string;
    idempotencyKey?: string;
    source: LedgerSource;
    reason: string;
    actorType: LedgerActorType;
    externalRef?: string | null;
    metadata?: Record<string, unknown>;
  }
) {
  return {
    tenantId: requireTenantId(input.tenantId),
    idempotencyKey: input.idempotencyKey ? requireIdempotencyKey(input.idempotencyKey) : null,
    source: validateSource(input.source),
    reason: requireReason(input.reason),
    actorType: validateActorType(input.actorType),
    actorUserId: optionalUuid(actor.actorUserId, "actorUserId"),
    actorEmail: optionalText(actor.actorEmail, "actorEmail", 320),
    externalRef: optionalText(input.externalRef, "externalRef"),
    metadata: validateMetadata(input.metadata),
  };
}

function pgConflictToDomain(err: unknown): never {
  const pg = err as { code?: string; constraint?: string };
  if (pg?.code === "23505" && pg.constraint === "uq_partner_credit_reserve_card_live") {
    throw new CreditReservationError(
      "CARD_ALREADY_RESERVED",
      "This card already has a live or consumed credit reservation."
    );
  }
  if (pg?.code === "23505") {
    throw new CreditReservationError(
      "IDEMPOTENCY_CONFLICT",
      "idempotencyKey was already used for a different request."
    );
  }
  if (pg?.code === "23503") {
    throw new CreditReservationError(
      "VALIDATION_ERROR",
      "Referenced wallet, location, ledger entry or reservation does not exist."
    );
  }
  throw err;
}

type WalletOperation = "reserve" | "consume" | "release" | "expire";

async function loadWalletForUpdate(
  client: pg.PoolClient,
  tenantId: string,
  operation: WalletOperation
): Promise<{ id: string; tenant_id: string; status: string }> {
  // Only reservation/consumption need the wallet lock: both make an available-balance decision or
  // write a ledger debit. Release/expiry never touch the wallet or ledger, so they intentionally do
  // not read it at all (see transitionReservationInTransaction). This lets the connector retain a
  // strictly column-scoped reservation grant rather than any wallet privilege.
  const lockClause = operation === "reserve" || operation === "consume" ? "FOR UPDATE" : "";
  const wallet = await client.query<{ id: string; tenant_id: string; status: string }>(
    `SELECT id, tenant_id, status FROM partner_wallets WHERE tenant_id = $1 ${lockClause}`,
    [tenantId]
  );
  if (wallet.rowCount === 0)
    throw new CreditReservationError("WALLET_NOT_FOUND", "Wallet not found for this organisation.");
  const status = wallet.rows[0].status;
  if (!["active", "suspended", "closed"].includes(status)) {
    throw new CreditReservationError("WALLET_INACTIVE", `wallet is ${status}; cannot ${operation} credits.`);
  }
  if ((operation === "reserve" || operation === "consume") && status !== "active") {
    throw new CreditReservationError("WALLET_INACTIVE", `wallet is ${status}; cannot ${operation} credits.`);
  }
  return wallet.rows[0];
}

function assertReservationWallet(wallet: { id: string; tenant_id: string }, reservation: CreditReservation): void {
  if (wallet.id !== reservation.wallet_id || wallet.tenant_id !== reservation.tenant_id) {
    throw new CreditReservationError("RESERVATION_NOT_FOUND", "Reservation not found for this organisation.");
  }
}

async function loadPositionForWallet(
  client: pg.PoolClient,
  walletId: string,
  tenantId: string
): Promise<CreditPosition> {
  const ledger = await client.query<{ balance: string }>(
    "SELECT COALESCE(SUM(amount), 0)::bigint AS balance FROM partner_credit_ledger WHERE wallet_id=$1 AND tenant_id=$2",
    [walletId, tenantId]
  );
  const reserved = await client.query<{ active_reserved: string; consumed: string }>(
    `SELECT
       COALESCE(SUM(reserved_credits) FILTER (WHERE status='active'), 0)::bigint AS active_reserved,
       COUNT(*) FILTER (WHERE status='consumed')::bigint AS consumed
       FROM partner_credit_reservations
      WHERE wallet_id=$1 AND tenant_id=$2`,
    [walletId, tenantId]
  );
  const ledgerBalance = parseBalance(ledger.rows[0]?.balance);
  const activeReserved = parseBalance(reserved.rows[0]?.active_reserved);
  return {
    walletId,
    tenantId,
    ledgerBalance,
    activeReserved,
    availableBalance: ledgerBalance - activeReserved,
    consumedReservations: parseBalance(reserved.rows[0]?.consumed),
  };
}

async function findReservationById(
  client: pg.PoolClient,
  tenantId: string,
  reservationId: string,
  lock: boolean
): Promise<CreditReservation | null> {
  const id = optionalUuid(reservationId, "reservationId");
  const r = await client.query<Record<string, unknown>>(
    `SELECT ${RESERVATION_COLS} FROM partner_credit_reservations WHERE tenant_id=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`,
    [tenantId, id]
  );
  return r.rowCount ? normalizeReservation(r.rows[0]) : null;
}

async function findEventByKey(
  client: pg.PoolClient,
  tenantId: string,
  source: LedgerSource,
  idempotencyKey: string
): Promise<ReservationEvent | null> {
  const r = await client.query<Record<string, unknown>>(
    `SELECT ${EVENT_COLS} FROM partner_credit_reservation_events WHERE tenant_id=$1 AND source=$2 AND idempotency_key=$3`,
    [tenantId, source, idempotencyKey]
  );
  return r.rowCount ? normalizeEvent(r.rows[0]) : null;
}

async function loadEventForReservation(
  client: pg.PoolClient,
  tenantId: string,
  reservationId: string,
  eventType: ReservationEventType
): Promise<ReservationEvent | null> {
  const r = await client.query<Record<string, unknown>>(
    `SELECT ${EVENT_COLS} FROM partner_credit_reservation_events
      WHERE tenant_id=$1 AND reservation_id=$2 AND event_type=$3
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [tenantId, reservationId, eventType]
  );
  return r.rowCount ? normalizeEvent(r.rows[0]) : null;
}

async function insertEvent(
  client: pg.PoolClient,
  reservation: CreditReservation,
  input: ReturnType<typeof validateCommon> & { idempotencyKey: string },
  eventType: ReservationEventType,
  fingerprint: string,
  ledgerEntryId: string | null
): Promise<ReservationEvent> {
  const r = await client.query<Record<string, unknown>>(
    `INSERT INTO partner_credit_reservation_events
       (reservation_id, wallet_id, tenant_id, event_type, amount, idempotency_key, request_fingerprint,
        source, reason, actor_type, actor_user_id, actor_email, external_ref, metadata, ledger_entry_id)
     VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)
     RETURNING ${EVENT_COLS}`,
    [
      reservation.id,
      reservation.wallet_id,
      reservation.tenant_id,
      eventType,
      input.idempotencyKey,
      fingerprint,
      input.source,
      input.reason,
      input.actorType,
      input.actorUserId,
      input.actorEmail,
      input.externalRef,
      JSON.stringify(input.metadata),
      ledgerEntryId,
    ]
  );
  return normalizeEvent(r.rows[0]);
}

export async function getCreditPosition(tenantIdRaw: string): Promise<CreditPosition> {
  const tenantId = requireTenantId(tenantIdRaw);
  const r = await partnerAdminQuery<{
    wallet_id: string;
    tenant_id: string;
    ledger_balance: string;
    active_reserved: string;
    available_balance: string;
    consumed_reservations: string;
  }>(
    "SELECT wallet_id, tenant_id, ledger_balance, active_reserved, available_balance, consumed_reservations FROM partner_credit_availability WHERE tenant_id=$1",
    [tenantId]
  );
  if (r.rowCount === 0) throw new CreditReservationError("WALLET_NOT_FOUND", "Wallet not found for this organisation.");
  return {
    walletId: r.rows[0].wallet_id,
    tenantId: r.rows[0].tenant_id,
    ledgerBalance: parseBalance(r.rows[0].ledger_balance),
    activeReserved: parseBalance(r.rows[0].active_reserved),
    availableBalance: parseBalance(r.rows[0].available_balance),
    consumedReservations: parseBalance(r.rows[0].consumed_reservations),
  };
}

/**
 * Reserve within an already-open privileged transaction.
 *
 * G6D uses this boundary to make Partner submission acceptance and its credit reservation one
 * database commit. Callers are responsible for opening a trusted, server-side transaction; this
 * function never accepts a browser-controlled tenant or actor identity.
 */
export async function reserveCreditInTransaction(
  client: pg.PoolClient,
  actor: ReservationActor,
  input: ReserveCreditInput
): Promise<MutationResult> {
  const now = input.now ?? new Date();
  const common = validateCommon(actor, { ...input, idempotencyKey: input.idempotencyKey });
  const idempotencyKey = common.idempotencyKey ?? requireIdempotencyKey(input.idempotencyKey);
  const cardReference = requireCardReference(input.cardReference);
  const locationId = optionalUuid(input.locationId, "locationId");
  const submissionReference = optionalText(input.submissionReference, "submissionReference", 200);
  const expiresAt = requireFutureExpiry(input.expiresAt, now);

  const wallet = await loadWalletForUpdate(client, common.tenantId, "reserve");
  const fingerprint = requestFingerprint({
    operation: "reserve",
    wallet_id: wallet.id,
    tenant_id: wallet.tenant_id,
    location_id: locationId,
    card_reference: cardReference,
    submission_reference: submissionReference,
    reserved_credits: 1,
    expires_at: expiresAt.toISOString(),
    source: common.source,
    reason: common.reason,
    actor_type: common.actorType,
    actor_user_id: common.actorUserId,
    actor_email: common.actorEmail,
    external_ref: common.externalRef,
    metadata: common.metadata,
  });

  const existing = await client.query<Record<string, unknown>>(
    `SELECT ${RESERVATION_COLS} FROM partner_credit_reservations WHERE tenant_id=$1 AND source=$2 AND idempotency_key=$3`,
    [wallet.tenant_id, common.source, idempotencyKey]
  );
  if (existing.rowCount) {
    const reservation = normalizeReservation(existing.rows[0]);
    if (reservation.request_fingerprint !== fingerprint) {
      throw new CreditReservationError(
        "IDEMPOTENCY_CONFLICT",
        "idempotencyKey was already used for a different reservation request."
      );
    }
    const event = await loadEventForReservation(client, wallet.tenant_id, reservation.id, "reserved");
    return { reservation, event, alreadyApplied: true };
  }

  const position = await loadPositionForWallet(client, wallet.id, wallet.tenant_id);
  if (position.availableBalance < 1) {
    throw new CreditReservationError("INSUFFICIENT_CREDITS", "No available grading credit can be reserved.");
  }

  try {
    const inserted = await client.query<Record<string, unknown>>(
      `INSERT INTO partner_credit_reservations
           (wallet_id, tenant_id, location_id, card_reference, submission_reference, reserved_credits, status,
            idempotency_key, request_fingerprint, source, reason, actor_type, actor_user_id, actor_email,
            external_ref, metadata, expires_at)
         VALUES ($1,$2,$3,$4,$5,1,'active',$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)
         RETURNING ${RESERVATION_COLS}`,
      [
        wallet.id,
        wallet.tenant_id,
        locationId,
        cardReference,
        submissionReference,
        idempotencyKey,
        fingerprint,
        common.source,
        common.reason,
        common.actorType,
        common.actorUserId,
        common.actorEmail,
        common.externalRef,
        JSON.stringify(common.metadata),
        expiresAt,
      ]
    );
    const reservation = normalizeReservation(inserted.rows[0]);
    const event = await insertEvent(client, reservation, { ...common, idempotencyKey }, "reserved", fingerprint, null);
    return { reservation, event, alreadyApplied: false };
  } catch (err) {
    return pgConflictToDomain(err);
  }
}

export async function reserveCredit(actor: ReservationActor, input: ReserveCreditInput): Promise<MutationResult> {
  return withPartnerAdminTransaction((client) => reserveCreditInTransaction(client, actor, input));
}

async function transitionReservationInTransaction(
  client: pg.PoolClient,
  actor: ReservationActor,
  input: ReservationTransitionInput,
  eventType: Exclude<ReservationEventType, "reserved">
): Promise<MutationResult> {
  const now = input.now ?? new Date();
  const generatedExpiryKey = eventType === "expired" ? `expiry:${input.reservationId}` : null;
  const common = validateCommon(actor, {
    ...input,
    idempotencyKey: input.idempotencyKey ?? generatedExpiryKey ?? undefined,
  });
  const idempotencyKey = common.idempotencyKey ?? requireIdempotencyKey(input.idempotencyKey);
  const reservationId = optionalUuid(input.reservationId, "reservationId");
  if (!reservationId) throw new CreditReservationError("VALIDATION_ERROR", "reservationId is required.");

  const fingerprint = requestFingerprint({
    operation: eventType,
    tenant_id: common.tenantId,
    reservation_id: reservationId,
    source: common.source,
    reason: common.reason,
    actor_type: common.actorType,
    actor_user_id: common.actorUserId,
    actor_email: common.actorEmail,
    external_ref: common.externalRef,
    metadata: common.metadata,
  });
  const existingEvent = await findEventByKey(client, common.tenantId, common.source, idempotencyKey);
  if (existingEvent) {
    if (existingEvent.request_fingerprint !== fingerprint || existingEvent.event_type !== eventType) {
      throw new CreditReservationError(
        "IDEMPOTENCY_CONFLICT",
        "idempotencyKey was already used for a different reservation transition."
      );
    }
    const reservation = await findReservationById(client, common.tenantId, existingEvent.reservation_id, false);
    if (!reservation)
      throw new CreditReservationError("RESERVATION_NOT_FOUND", "Reservation not found for this organisation.");
    return { reservation, event: existingEvent, alreadyApplied: true };
  }

  const reservation = await findReservationById(client, common.tenantId, reservationId, true);
  if (!reservation)
    throw new CreditReservationError("RESERVATION_NOT_FOUND", "Reservation not found for this organisation.");

  if (reservation.status === eventType) {
    const event = await loadEventForReservation(client, common.tenantId, reservation.id, eventType);
    if (event) return { reservation, event, alreadyApplied: true };
  }
  if (reservation.status !== "active") {
    throw new CreditReservationError(
      "RESERVATION_NOT_ACTIVE",
      `Reservation is ${reservation.status}; it cannot be ${eventType}.`
    );
  }

  // A release/expiry only returns an already-held entitlement to availability. It must remain
  // possible even when the wallet was later suspended or closed, and it does not need any wallet
  // table access. Consumption is different: it writes the immutable debit and must serialize with
  // all other balance decisions against an active wallet.
  if (eventType === "consumed") {
    const wallet = await loadWalletForUpdate(client, common.tenantId, "consume");
    assertReservationWallet(wallet, reservation);
  }

  const expiresAtMs = new Date(reservation.expires_at).getTime();
  if (eventType === "consumed" || eventType === "released") {
    if (expiresAtMs <= now.getTime()) {
      throw new CreditReservationError(
        "RESERVATION_EXPIRED",
        "Reservation has expired and cannot be consumed or manually released."
      );
    }
  } else if (expiresAtMs > now.getTime()) {
    throw new CreditReservationError("RESERVATION_NOT_EXPIRED", "Reservation has not expired yet.");
  }

  let ledgerEntryId: string | null = null;
  const timestampColumn =
    eventType === "consumed" ? "consumed_at" : eventType === "released" ? "released_at" : "expired_at";
  const updated = await client.query<Record<string, unknown>>(
    `UPDATE partner_credit_reservations
          SET status=$1, ${timestampColumn}=now(), updated_at=now()
        WHERE tenant_id=$2 AND id=$3 AND status='active'
        RETURNING ${RESERVATION_COLS}`,
    [eventType === "expired" ? "expired" : eventType, common.tenantId, reservation.id]
  );
  if (updated.rowCount === 0) {
    throw new CreditReservationError("RESERVATION_NOT_ACTIVE", "Reservation was already terminal.");
  }
  const transitioned = normalizeReservation(updated.rows[0]);

  if (eventType === "consumed") {
    const ledgerFingerprint = requestFingerprint({
      operation: "wallet_ledger_consumption",
      reservation_id: transitioned.id,
      wallet_id: transitioned.wallet_id,
      tenant_id: transitioned.tenant_id,
      amount: -1,
    });
    const ledger = await client.query<{ id: string }>(
      `INSERT INTO partner_credit_ledger
           (wallet_id, tenant_id, amount, entry_type, idempotency_key, correlation_id, source, reason,
            actor_type, actor_user_id, actor_email, external_ref, metadata, request_fingerprint)
         VALUES ($1,$2,-1,'admin_adjustment',$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
        RETURNING id`,
      [
        transitioned.wallet_id,
        transitioned.tenant_id,
        `reservation-consume:${transitioned.id}`,
        transitioned.id,
        common.source,
        common.reason,
        common.actorType,
        common.actorUserId,
        common.actorEmail,
        common.externalRef,
        JSON.stringify({ ...common.metadata, reservation_event: "consumed" }),
        ledgerFingerprint,
      ]
    );
    ledgerEntryId = ledger.rows[0].id;
  }

  try {
    const event = await insertEvent(
      client,
      transitioned,
      { ...common, idempotencyKey },
      eventType,
      fingerprint,
      ledgerEntryId
    );
    return { reservation: transitioned, event, alreadyApplied: false };
  } catch (err) {
    return pgConflictToDomain(err);
  }
}

async function transitionReservation(
  actor: ReservationActor,
  input: ReservationTransitionInput,
  eventType: Exclude<ReservationEventType, "reserved">
): Promise<MutationResult> {
  return withPartnerAdminTransaction((client) => transitionReservationInTransaction(client, actor, input, eventType));
}

export function consumeReservedCreditInTransaction(
  client: pg.PoolClient,
  actor: ReservationActor,
  input: ReservationTransitionInput
): Promise<MutationResult> {
  return transitionReservationInTransaction(client, actor, input, "consumed");
}

export function releaseReservedCreditInTransaction(
  client: pg.PoolClient,
  actor: ReservationActor,
  input: ReservationTransitionInput
): Promise<MutationResult> {
  return transitionReservationInTransaction(client, actor, input, "released");
}

export function expireReservedCreditInTransaction(
  client: pg.PoolClient,
  actor: ReservationActor,
  input: ReservationTransitionInput
): Promise<MutationResult> {
  return transitionReservationInTransaction(client, actor, { ...input, source: input.source ?? "system" }, "expired");
}

export async function consumeReservedCredit(
  actor: ReservationActor,
  input: ReservationTransitionInput
): Promise<MutationResult> {
  return transitionReservation(actor, input, "consumed");
}

export async function releaseReservedCredit(
  actor: ReservationActor,
  input: ReservationTransitionInput
): Promise<MutationResult> {
  return transitionReservation(actor, input, "released");
}

export async function expireReservedCredit(
  actor: ReservationActor,
  input: ReservationTransitionInput
): Promise<MutationResult> {
  return transitionReservation(actor, { ...input, source: input.source ?? "system" }, "expired");
}

export async function expireExpiredReservations(
  input: {
    now?: Date;
    limit?: number;
    tenantId?: string | null;
    actor?: ReservationActor;
  } = {}
): Promise<{ processed: number; expired: string[] }> {
  const now = input.now ?? new Date();
  const limit = Math.max(1, Math.min(500, Math.floor(Number(input.limit ?? 100))));
  const tenantId = input.tenantId ? requireTenantId(input.tenantId) : null;
  // The scheduler can arrive before G6D on an upgraded database. Only a wholly absent accounting
  // schema is a legacy no-op; any mixture of wallet/ledger/reservation/event tables is unsafe.
  const schema = await partnerAdminQuery<{
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
  const tables = schema.rows[0];
  const objects = [tables?.wallets, tables?.ledger, tables?.reservations, tables?.events];
  if (objects.every((value) => !value)) return { processed: 0, expired: [] };
  if (objects.some((value) => !value)) {
    throw new Error("Partner credit accounting schema is incomplete; expiry cannot run safely.");
  }
  const rows = await partnerAdminQuery<{ id: string; tenant_id: string }>(
    `SELECT id, tenant_id
       FROM partner_credit_reservations
      WHERE status='active' AND expires_at <= $1 AND ($2::uuid IS NULL OR tenant_id=$2::uuid)
      ORDER BY expires_at ASC, created_at ASC
      LIMIT $3`,
    [now, tenantId, limit]
  );
  const actor = input.actor ?? { actorUserId: null, actorEmail: null };
  const expired: string[] = [];
  for (const row of rows.rows) {
    try {
      const result = await expireReservedCredit(actor, {
        tenantId: row.tenant_id,
        reservationId: row.id,
        idempotencyKey: `reservation-expiry:${row.id}`,
        source: "system",
        reason: "reservation expired",
        actorType: "system",
        now,
      });
      expired.push(result.reservation.id);
    } catch (err) {
      if (
        !(err instanceof CreditReservationError) ||
        (err.code !== "RESERVATION_NOT_ACTIVE" && err.code !== "IDEMPOTENCY_CONFLICT" && err.code !== "WALLET_INACTIVE")
      ) {
        throw err;
      }
    }
  }
  return { processed: rows.rows.length, expired };
}

export async function reconcileCreditReservations(): Promise<{ issues: ReconciliationIssue[] }> {
  const issues: ReconciliationIssue[] = [];
  const pushRows = (
    code: string,
    severity: "error" | "warning",
    rows: Array<Record<string, unknown>>,
    detail: (row: Record<string, unknown>) => string
  ) => {
    for (const row of rows) {
      issues.push({
        code,
        severity,
        tenantId: (row.tenant_id as string | null) ?? null,
        walletId: (row.wallet_id as string | null) ?? null,
        reservationId: (row.reservation_id as string | null) ?? null,
        detail: detail(row),
      });
    }
  };

  const balanceMismatch = await partnerAdminQuery<Record<string, unknown>>(
    `SELECT w.id AS wallet_id, w.tenant_id, COALESCE(v.balance,0)::bigint AS view_balance, COALESCE(l.balance,0)::bigint AS ledger_balance
       FROM partner_wallets w
       LEFT JOIN partner_wallet_balances v ON v.wallet_id=w.id AND v.tenant_id=w.tenant_id
       LEFT JOIN (
         SELECT wallet_id, tenant_id, SUM(amount)::bigint AS balance
           FROM partner_credit_ledger GROUP BY wallet_id, tenant_id
       ) l ON l.wallet_id=w.id AND l.tenant_id=w.tenant_id
      WHERE COALESCE(v.balance,0) <> COALESCE(l.balance,0)`
  );
  pushRows(
    "WALLET_BALANCE_MISMATCH",
    "error",
    balanceMismatch.rows,
    (row) => `view=${row.view_balance} ledger=${row.ledger_balance}`
  );

  const negative = await partnerAdminQuery<Record<string, unknown>>(
    `SELECT wallet_id, tenant_id, ledger_balance, active_reserved, available_balance
       FROM partner_credit_availability
      WHERE ledger_balance < 0 OR active_reserved < 0 OR available_balance < 0`
  );
  pushRows(
    "NEGATIVE_BALANCE",
    "error",
    negative.rows,
    (row) => `ledger=${row.ledger_balance} reserved=${row.active_reserved} available=${row.available_balance}`
  );

  const consumedMissing = await partnerAdminQuery<Record<string, unknown>>(
    `SELECT r.id AS reservation_id, r.wallet_id, r.tenant_id,
            COUNT(DISTINCT e.id)::int AS consume_events,
            COUNT(DISTINCT l.id)::int AS consume_ledger_rows
       FROM partner_credit_reservations r
       LEFT JOIN partner_credit_reservation_events e
         ON e.reservation_id=r.id AND e.tenant_id=r.tenant_id AND e.event_type='consumed'
       LEFT JOIN partner_credit_ledger l
         ON l.wallet_id=r.wallet_id AND l.tenant_id=r.tenant_id AND l.correlation_id=r.id::text AND l.amount=-1
      WHERE r.status='consumed'
      GROUP BY r.id, r.wallet_id, r.tenant_id
     HAVING COUNT(DISTINCT e.id) <> 1 OR COUNT(DISTINCT l.id) <> 1`
  );
  pushRows(
    "CONSUMED_EVIDENCE_MISSING",
    "error",
    consumedMissing.rows,
    (row) => `events=${row.consume_events} ledger_rows=${row.consume_ledger_rows}`
  );

  const terminalMissing = await partnerAdminQuery<Record<string, unknown>>(
    `SELECT r.id AS reservation_id, r.wallet_id, r.tenant_id, r.status, COUNT(e.id)::int AS events
       FROM partner_credit_reservations r
       LEFT JOIN partner_credit_reservation_events e
         ON e.reservation_id=r.id AND e.tenant_id=r.tenant_id AND e.event_type=r.status
      WHERE r.status IN ('released','expired')
      GROUP BY r.id, r.wallet_id, r.tenant_id, r.status
     HAVING COUNT(e.id) <> 1`
  );
  pushRows("TERMINAL_EVIDENCE_MISSING", "error", terminalMissing.rows, (row) => `${row.status} events=${row.events}`);

  const duplicateTerminal = await partnerAdminQuery<Record<string, unknown>>(
    `SELECT reservation_id, tenant_id, COUNT(*)::int AS terminal_events
       FROM partner_credit_reservation_events
      WHERE event_type IN ('consumed','released','expired')
      GROUP BY reservation_id, tenant_id
     HAVING COUNT(*) > 1`
  );
  pushRows(
    "DUPLICATE_TERMINAL_TRANSITION",
    "error",
    duplicateTerminal.rows,
    (row) => `terminal_events=${row.terminal_events}`
  );

  const crossTenant = await partnerAdminQuery<Record<string, unknown>>(
    `SELECT r.id AS reservation_id, r.wallet_id, r.tenant_id, 'reservation_wallet_mismatch' AS kind
       FROM partner_credit_reservations r
       LEFT JOIN partner_wallets w ON w.id=r.wallet_id AND w.tenant_id=r.tenant_id
      WHERE w.id IS NULL
      UNION ALL
     SELECT e.reservation_id, e.wallet_id, e.tenant_id, 'event_reservation_mismatch' AS kind
       FROM partner_credit_reservation_events e
       LEFT JOIN partner_credit_reservations r ON r.id=e.reservation_id AND r.tenant_id=e.tenant_id
      WHERE r.id IS NULL
      UNION ALL
     SELECT r.id AS reservation_id, l.wallet_id, l.tenant_id, 'consume_ledger_mismatch' AS kind
       FROM partner_credit_ledger l
       JOIN partner_credit_reservations r ON r.id::text=l.correlation_id
      WHERE l.amount=-1 AND (l.wallet_id <> r.wallet_id OR l.tenant_id <> r.tenant_id)`
  );
  pushRows("CROSS_TENANT_OR_ORPHAN_REFERENCE", "error", crossTenant.rows, (row) => String(row.kind));

  return { issues };
}
