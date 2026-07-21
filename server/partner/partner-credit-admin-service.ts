/**
 * G6C Super Admin partner-credit adjustments.
 *
 * This is a server-only domain boundary. Future HTTP handlers must derive tenant and actor from
 * the authenticated Super Admin session; neither identity is safe to accept directly from a
 * browser payload. The ledger remains authoritative and append-only: this service only creates
 * compensating `admin_adjustment` rows and never changes a balance, reservation, or prior entry.
 *
 * Locked status policy:
 * - active: add and remove are allowed;
 * - suspended: add and remove are allowed for Super Admin correction/reactivation preparation;
 * - closed: all NEW financial adjustments are blocked. An exact idempotent replay of an entry
 *   created before closure is still returned with `alreadyApplied: true`; it makes no mutation and
 *   lets the caller determine the established result reliably. G6B release/expiry is unchanged.
 */
import { createHash } from "node:crypto";
import type pg from "pg";
import { partnerAdminQuery, withPartnerAdminTransaction } from "./db";
import {
  MAX_ENTRY_MAGNITUDE,
  WalletRequestError,
  optionalText,
  optionalUuid,
  parseBalance,
  requireIdempotencyKey,
  requireReason,
  requireTenantId,
} from "./partner-wallet-errors";

type AdminAdjustmentOperation = "CREDIT_ADD" | "CREDIT_REMOVE";
type WalletStatus = "active" | "suspended" | "closed";
type DatabaseTimestamp = Date | string;

/** Identity resolved by a trusted Super Admin authentication boundary, never a request body. */
export interface AdminCreditActor {
  actorUserId: string | null;
  actorEmail?: string | null;
}

/** Tenant identity must be server-resolved before this service is called. */
export interface AdminCreditAdjustmentInput {
  tenantId: string;
  quantity: number;
  reason: string;
  idempotencyKey: string;
}

export interface AdminWalletSummary {
  walletId: string;
  tenantId: string;
  partnerLegalName: string | null;
  status: WalletStatus;
  postedLedgerBalance: number;
  activeReservedCredits: number;
  availableCredits: number;
  createdAt: string;
  updatedAt: string;
  suspendedAt: string | null;
  closedAt: string | null;
}

export interface AdminLedgerEntry {
  id: string;
  amount: number;
  entryType: string;
  source: string;
  reason: string;
  actorType: string;
  actorUserId: string | null;
  actorEmail: string | null;
  idempotencyKey: string;
  correlationId: string | null;
  externalRef: string | null;
  createdAt: string;
}

export interface AdminCreditAdjustmentResult {
  operation: AdminAdjustmentOperation;
  entry: AdminLedgerEntry;
  summary: AdminWalletSummary;
  alreadyApplied: boolean;
}

export interface AdminLedgerPage {
  entries: AdminLedgerEntry[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface ValidatedAdjustment {
  tenantId: string;
  quantity: number;
  reason: string;
  idempotencyKey: string;
  actorUserId: string;
  actorEmail: string | null;
}

interface WalletRow {
  wallet_id: string;
  tenant_id: string;
  partner_legal_name: string | null;
  status: WalletStatus;
  created_at: DatabaseTimestamp;
  updated_at: DatabaseTimestamp;
  suspended_at: DatabaseTimestamp | null;
  closed_at: DatabaseTimestamp | null;
}

interface LedgerRow {
  id: string;
  amount: string;
  entry_type: string;
  source: string;
  reason: string;
  actor_type: string;
  actor_user_id: string | null;
  actor_email: string | null;
  idempotency_key: string;
  correlation_id: string | null;
  external_ref: string | null;
  request_fingerprint: string;
  created_at: string;
  cursor_created_at: string;
}

const LEDGER_RETURNING =
  "id, amount, entry_type, source, reason, actor_type, actor_user_id, actor_email, idempotency_key, correlation_id, external_ref, request_fingerprint, created_at, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS cursor_created_at";
const LEDGER_HISTORY_COLUMNS =
  "l.id, l.amount, l.entry_type, l.source, l.reason, l.actor_type, l.actor_user_id, l.actor_email, l.idempotency_key, l.correlation_id, l.external_ref, l.created_at, to_char(l.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS cursor_created_at";
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const CURSOR_MAX_LENGTH = 500;
const CURSOR_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

function isCanonicalCursorTimestamp(value: string): boolean {
  if (!CURSOR_TIMESTAMP_RE.test(value)) return false;
  // JavaScript normalises impossible calendar dates (for example, February 30). Compare the
  // millisecond-safe prefix after parsing so a cursor always contains a real PostgreSQL timestamp.
  const milliseconds = `${value.slice(0, 23)}Z`;
  const parsed = new Date(milliseconds);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === milliseconds;
}

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

function requireQuantity(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0 || raw > MAX_ENTRY_MAGNITUDE) {
    throw new WalletRequestError(
      "INVALID_AMOUNT",
      `quantity must be a positive whole credit amount no greater than ${MAX_ENTRY_MAGNITUDE}.`
    );
  }
  return raw;
}

function requireAdjustmentReason(raw: unknown): string {
  try {
    return requireReason(raw);
  } catch {
    throw new WalletRequestError("INVALID_REASON", "reason is required and must be meaningful text.");
  }
}

function requireAdjustmentIdempotencyKey(raw: unknown): string {
  try {
    return requireIdempotencyKey(raw);
  } catch {
    throw new WalletRequestError("INVALID_IDEMPOTENCY_KEY", "idempotencyKey is required for every adjustment.");
  }
}

function requireAdminActor(actor: AdminCreditActor): { actorUserId: string; actorEmail: string | null } {
  const actorUserId = optionalUuid(actor?.actorUserId, "actorUserId");
  if (!actorUserId) throw new WalletRequestError("ACTOR_REQUIRED", "A verified Super Admin actor is required.");
  return {
    actorUserId,
    // Email casing is not actor identity. Canonicalise before both fingerprinting and persistence
    // so an otherwise exact retry from a normalised auth session does not become a false conflict.
    actorEmail: optionalText(actor.actorEmail, "actorEmail", 320)?.toLowerCase() ?? null,
  };
}

function validateAdjustment(actor: AdminCreditActor, input: AdminCreditAdjustmentInput): ValidatedAdjustment {
  const verifiedActor = requireAdminActor(actor);
  return {
    tenantId: requireTenantId(input.tenantId),
    quantity: requireQuantity(input.quantity),
    reason: requireAdjustmentReason(input.reason),
    idempotencyKey: requireAdjustmentIdempotencyKey(input.idempotencyKey),
    ...verifiedActor,
  };
}

function normalizeLedger(row: LedgerRow): AdminLedgerEntry {
  return {
    id: row.id,
    amount: parseBalance(row.amount),
    entryType: row.entry_type,
    source: row.source,
    reason: row.reason,
    actorType: row.actor_type,
    actorUserId: row.actor_user_id,
    actorEmail: row.actor_email,
    idempotencyKey: row.idempotency_key,
    correlationId: row.correlation_id,
    externalRef: row.external_ref,
    createdAt: row.cursor_created_at,
  };
}

/** Convert node-postgres timestamptz values to the stable UTC string contract exposed to routes. */
function normalizeSummaryTimestamp(value: DatabaseTimestamp): string {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new WalletRequestError("INTERNAL_ERROR", "Could not normalize a wallet timestamp.");
  }
  return timestamp.toISOString();
}

function normalizeOptionalSummaryTimestamp(value: DatabaseTimestamp | null): string | null {
  return value === null ? null : normalizeSummaryTimestamp(value);
}

function adjustmentFingerprint(operation: AdminAdjustmentOperation, input: ValidatedAdjustment): string {
  return requestFingerprint({
    operation,
    tenant_id: input.tenantId,
    quantity: input.quantity,
    reason: input.reason,
    actor_type: "admin",
    actor_user_id: input.actorUserId,
    actor_email: input.actorEmail,
    source: "admin",
    entry_type: "admin_adjustment",
  });
}

function adjustmentMetadata(operation: AdminAdjustmentOperation, quantity: number): Record<string, unknown> {
  return {
    adjustment_operation: operation,
    adjustment_quantity: quantity,
  };
}

function parsePageSize(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_PAGE_SIZE;
  const value =
    typeof raw === "number" ? raw : typeof raw === "string" && /^[1-9]\d*$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    throw new WalletRequestError("INVALID_PAGINATION", `pageSize must be a whole number from 1 to ${MAX_PAGE_SIZE}.`);
  }
  return value;
}

interface LedgerCursor {
  version: 1;
  walletId: string;
  createdAt: string;
  id: string;
}

function invalidCursor(): never {
  throw new WalletRequestError("INVALID_PAGINATION", "cursor is invalid.");
}

function encodeCursor(walletId: string, row: LedgerRow): string {
  return Buffer.from(
    JSON.stringify({ version: 1, walletId, createdAt: row.cursor_created_at, id: row.id } satisfies LedgerCursor),
    "utf8"
  ).toString("base64url");
}

function parseCursor(raw: unknown, walletId: string): LedgerCursor | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > CURSOR_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    return invalidCursor();
  }
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalidCursor();
    const cursor = value as Record<string, unknown>;
    if (
      Object.keys(cursor).length !== 4 ||
      cursor.version !== 1 ||
      typeof cursor.walletId !== "string" ||
      typeof cursor.createdAt !== "string" ||
      typeof cursor.id !== "string" ||
      !isCanonicalCursorTimestamp(cursor.createdAt)
    ) {
      return invalidCursor();
    }
    const cursorWalletId = optionalUuid(cursor.walletId, "cursor.walletId");
    const cursorId = optionalUuid(cursor.id, "cursor.id");
    if (!cursorWalletId || !cursorId || cursorWalletId !== walletId) return invalidCursor();
    return { version: 1, walletId: cursorWalletId, createdAt: cursor.createdAt, id: cursorId };
  } catch {
    return invalidCursor();
  }
}

const INSUFFICIENT_AVAILABLE_MESSAGE =
  "Requested removal exceeds the wallet's available credits after active reservations.";

/**
 * The G6B reservation-protection trigger raises check_violation with this PL/pgSQL origin. Keep
 * the detector deliberately narrow: unrelated check violations continue to the repository's safe
 * generic database-error mapper and never become an insufficient-credit response.
 */
export function mapAdminCreditDatabaseError(error: unknown): unknown {
  const pgError = error as { code?: unknown; where?: unknown };
  if (
    pgError?.code === "23514" &&
    typeof pgError.where === "string" &&
    /^PL\/pgSQL function partner_credit_ledger_preserve_active_reservations\(\) line \d+ at RAISE$/.test(pgError.where)
  ) {
    return new WalletRequestError("INSUFFICIENT_AVAILABLE_CREDITS", INSUFFICIENT_AVAILABLE_MESSAGE);
  }
  return error;
}

async function findLedgerByKey(client: pg.PoolClient, idempotencyKey: string): Promise<LedgerRow | null> {
  const r = await client.query<LedgerRow>(
    `SELECT ${LEDGER_RETURNING}
       FROM partner_credit_ledger
      WHERE source='admin' AND idempotency_key=$1`,
    [idempotencyKey]
  );
  return r.rowCount ? r.rows[0] : null;
}

async function loadWalletForUpdate(client: pg.PoolClient, tenantId: string): Promise<WalletRow> {
  const r = await client.query<WalletRow>(
    `SELECT w.id AS wallet_id, w.tenant_id, o.legal_name AS partner_legal_name, w.status,
            w.created_at, w.updated_at, w.suspended_at, w.closed_at
       FROM partner_wallets w
       JOIN partner_organisations o ON o.id=w.tenant_id
      WHERE w.tenant_id=$1
      FOR UPDATE OF w`,
    [tenantId]
  );
  if (!r.rowCount) throw new WalletRequestError("WALLET_NOT_FOUND", "Wallet not found for this organisation.");
  return r.rows[0];
}

async function loadSummaryForWallet(client: pg.PoolClient, wallet: WalletRow): Promise<AdminWalletSummary> {
  const r = await client.query<{ posted_balance: string; active_reserved: string }>(
    `SELECT
       COALESCE((SELECT SUM(amount) FROM partner_credit_ledger WHERE wallet_id=$1 AND tenant_id=$2), 0)::bigint AS posted_balance,
       COALESCE((SELECT SUM(reserved_credits) FROM partner_credit_reservations WHERE wallet_id=$1 AND tenant_id=$2 AND status='active'), 0)::bigint AS active_reserved`,
    [wallet.wallet_id, wallet.tenant_id]
  );
  const postedLedgerBalance = parseBalance(r.rows[0]?.posted_balance);
  const activeReservedCredits = parseBalance(r.rows[0]?.active_reserved);
  return {
    walletId: wallet.wallet_id,
    tenantId: wallet.tenant_id,
    partnerLegalName: wallet.partner_legal_name,
    status: wallet.status,
    postedLedgerBalance,
    activeReservedCredits,
    availableCredits: postedLedgerBalance - activeReservedCredits,
    createdAt: normalizeSummaryTimestamp(wallet.created_at),
    updatedAt: normalizeSummaryTimestamp(wallet.updated_at),
    suspendedAt: normalizeOptionalSummaryTimestamp(wallet.suspended_at),
    closedAt: normalizeOptionalSummaryTimestamp(wallet.closed_at),
  };
}

function assertAdjustmentStatus(status: WalletStatus): void {
  if (status === "closed") {
    throw new WalletRequestError("WALLET_CLOSED", "Closed wallets cannot receive new credit adjustments.");
  }
  if (status !== "active" && status !== "suspended") {
    throw new WalletRequestError("VALIDATION_ERROR", "Wallet status does not permit an admin adjustment.");
  }
}

async function adjustmentResultForExisting(
  client: pg.PoolClient,
  wallet: WalletRow,
  operation: AdminAdjustmentOperation,
  existing: LedgerRow,
  fingerprint: string
): Promise<AdminCreditAdjustmentResult> {
  if (existing.request_fingerprint !== fingerprint) {
    throw new WalletRequestError(
      "IDEMPOTENCY_CONFLICT",
      "idempotencyKey was already used for a materially different adjustment."
    );
  }
  return {
    operation,
    entry: normalizeLedger(existing),
    summary: await loadSummaryForWallet(client, wallet),
    alreadyApplied: true,
  };
}

async function adjustCredits(
  operation: AdminAdjustmentOperation,
  actor: AdminCreditActor,
  rawInput: AdminCreditAdjustmentInput
): Promise<AdminCreditAdjustmentResult> {
  const input = validateAdjustment(actor, rawInput);
  const fingerprint = adjustmentFingerprint(operation, input);
  const signedAmount = operation === "CREDIT_ADD" ? input.quantity : -input.quantity;

  return withPartnerAdminTransaction(async (client) => {
    // Idempotency is intentionally evaluated before wallet status: an exact established replay is
    // safe even after closure because it returns evidence only and cannot append another entry.
    // A changed request using that key still conflicts before any status result is considered.
    const beforeLock = await findLedgerByKey(client, input.idempotencyKey);
    if (beforeLock && beforeLock.request_fingerprint !== fingerprint) {
      throw new WalletRequestError(
        "IDEMPOTENCY_CONFLICT",
        "idempotencyKey was already used for a materially different adjustment."
      );
    }

    // This is the same wallet row lock used by G6B. Holding it serialises an adjustment with
    // reserve/consume/release/expiry before computing the removable available amount.
    const wallet = await loadWalletForUpdate(client, input.tenantId);
    if (beforeLock) return adjustmentResultForExisting(client, wallet, operation, beforeLock, fingerprint);

    // Recheck after the wallet lock to resolve same-wallet concurrent replays without relying on
    // in-memory state. Cross-wallet races are resolved below by the unique ledger index.
    const afterLock = await findLedgerByKey(client, input.idempotencyKey);
    if (afterLock) return adjustmentResultForExisting(client, wallet, operation, afterLock, fingerprint);

    assertAdjustmentStatus(wallet.status);
    const before = await loadSummaryForWallet(client, wallet);
    if (operation === "CREDIT_REMOVE" && input.quantity > before.availableCredits) {
      throw new WalletRequestError("INSUFFICIENT_AVAILABLE_CREDITS", INSUFFICIENT_AVAILABLE_MESSAGE);
    }

    let inserted;
    try {
      inserted = await client.query<LedgerRow>(
        `INSERT INTO partner_credit_ledger
         (wallet_id, tenant_id, amount, entry_type, idempotency_key, correlation_id, source, reason,
          actor_type, actor_user_id, actor_email, external_ref, metadata, request_fingerprint)
       VALUES ($1,$2,$3,'admin_adjustment',$4,NULL,'admin',$5,'admin',$6,$7,NULL,$8::jsonb,$9)
       ON CONFLICT (source, idempotency_key) DO NOTHING
       RETURNING ${LEDGER_RETURNING}`,
        [
          wallet.wallet_id,
          wallet.tenant_id,
          signedAmount,
          input.idempotencyKey,
          input.reason,
          input.actorUserId,
          input.actorEmail,
          JSON.stringify(adjustmentMetadata(operation, input.quantity)),
          fingerprint,
        ]
      );
    } catch (error) {
      throw mapAdminCreditDatabaseError(error);
    }

    if (!inserted.rowCount) {
      const winner = await findLedgerByKey(client, input.idempotencyKey);
      if (!winner)
        throw new WalletRequestError("INTERNAL_ERROR", "Could not resolve the adjustment idempotency result.");
      return adjustmentResultForExisting(client, wallet, operation, winner, fingerprint);
    }

    return {
      operation,
      entry: normalizeLedger(inserted.rows[0]),
      summary: await loadSummaryForWallet(client, wallet),
      alreadyApplied: false,
    };
  });
}

/** Create one immutable positive `admin_adjustment` ledger entry. */
export async function addCredits(
  actor: AdminCreditActor,
  input: AdminCreditAdjustmentInput
): Promise<AdminCreditAdjustmentResult> {
  return adjustCredits("CREDIT_ADD", actor, input);
}

/** Create one immutable negative `admin_adjustment` ledger entry, never exceeding available credits. */
export async function removeCredits(
  actor: AdminCreditActor,
  input: AdminCreditAdjustmentInput
): Promise<AdminCreditAdjustmentResult> {
  return adjustCredits("CREDIT_REMOVE", actor, input);
}

/** Authoritative point-in-time wallet/ledger/reservation projection for future Super Admin routes. */
export async function getWalletSummary(tenantIdRaw: string): Promise<AdminWalletSummary> {
  const tenantId = requireTenantId(tenantIdRaw);
  const r = await partnerAdminQuery<{
    wallet_id: string;
    tenant_id: string;
    partner_legal_name: string | null;
    status: WalletStatus;
    created_at: DatabaseTimestamp;
    updated_at: DatabaseTimestamp;
    suspended_at: DatabaseTimestamp | null;
    closed_at: DatabaseTimestamp | null;
    posted_balance: string;
    active_reserved: string;
  }>(
    `SELECT w.id AS wallet_id, w.tenant_id, o.legal_name AS partner_legal_name, w.status,
            w.created_at, w.updated_at, w.suspended_at, w.closed_at,
            COALESCE((SELECT SUM(amount) FROM partner_credit_ledger WHERE wallet_id=w.id AND tenant_id=w.tenant_id), 0)::bigint AS posted_balance,
            COALESCE((SELECT SUM(reserved_credits) FROM partner_credit_reservations WHERE wallet_id=w.id AND tenant_id=w.tenant_id AND status='active'), 0)::bigint AS active_reserved
       FROM partner_wallets w
       JOIN partner_organisations o ON o.id=w.tenant_id
      WHERE w.tenant_id=$1`,
    [tenantId]
  );
  if (!r.rowCount) throw new WalletRequestError("WALLET_NOT_FOUND", "Wallet not found for this organisation.");
  const row = r.rows[0];
  const postedLedgerBalance = parseBalance(row.posted_balance);
  const activeReservedCredits = parseBalance(row.active_reserved);
  return {
    walletId: row.wallet_id,
    tenantId: row.tenant_id,
    partnerLegalName: row.partner_legal_name,
    status: row.status,
    postedLedgerBalance,
    activeReservedCredits,
    availableCredits: postedLedgerBalance - activeReservedCredits,
    createdAt: normalizeSummaryTimestamp(row.created_at),
    updatedAt: normalizeSummaryTimestamp(row.updated_at),
    suspendedAt: normalizeOptionalSummaryTimestamp(row.suspended_at),
    closedAt: normalizeOptionalSummaryTimestamp(row.closed_at),
  };
}

/**
 * Bounded newest-first ledger history using a wallet-bound opaque keyset cursor. The cursor keeps
 * PostgreSQL's microsecond timestamp text and UUID tie-breaker, so records are neither repeated
 * nor skipped when multiple entries share a display-millisecond. Metadata and fingerprints stay
 * server-private.
 */
export async function listLedgerEntries(
  tenantIdRaw: string,
  pageSizeRaw?: unknown,
  cursorRaw?: unknown
): Promise<AdminLedgerPage> {
  const tenantId = requireTenantId(tenantIdRaw);
  const pageSize = parsePageSize(pageSizeRaw);
  const wallet = await partnerAdminQuery<{ id: string }>("SELECT id FROM partner_wallets WHERE tenant_id=$1", [
    tenantId,
  ]);
  if (!wallet.rowCount) throw new WalletRequestError("WALLET_NOT_FOUND", "Wallet not found for this organisation.");
  const cursor = parseCursor(cursorRaw, wallet.rows[0].id);
  const params: unknown[] = [wallet.rows[0].id, tenantId];
  const keysetWhere = cursor
    ? ` AND (l.created_at, l.id) < ($${params.push(cursor.createdAt)}::timestamptz,$${params.push(cursor.id)}::uuid)`
    : "";
  const rows = await partnerAdminQuery<LedgerRow>(
    `SELECT ${LEDGER_HISTORY_COLUMNS}
       FROM partner_credit_ledger l
      WHERE l.wallet_id=$1 AND l.tenant_id=$2${keysetWhere}
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT $${params.push(pageSize + 1)}`,
    params
  );
  const hasMore = rows.rows.length > pageSize;
  const returned = hasMore ? rows.rows.slice(0, pageSize) : rows.rows;
  return {
    entries: returned.map(normalizeLedger),
    hasMore,
    nextCursor: hasMore && returned.length ? encodeCursor(wallet.rows[0].id, returned[returned.length - 1]) : null,
  };
}
