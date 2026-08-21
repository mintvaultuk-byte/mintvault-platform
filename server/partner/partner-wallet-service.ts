/**
 * G6A partner wallet + credit ledger — narrow server-side domain/service layer (FOUNDATION ONLY).
 *
 * The ONLY place wallet/ledger orchestration lives. All access is through the privileged admin pool
 * (partnerAdminQuery, BYPASSRLS, no RLS context) with an EXPLICIT server-derived tenant scope on every
 * statement — the tenant id is NEVER trusted from an untrusted client; callers pass a server-resolved
 * organisation id. Reads are deterministic/bounded/parameterised. The only write is an append to the
 * immutable ledger; there is NO update/delete method and NO balance-mutation path — the authoritative
 * balance is always SUM(amount) over the ledger. G6A's write boundary accepts positive credit events
 * only; debit, reserve, consume, and release semantics remain deferred.
 *
 * G6A exposes: ensureWallet, getWallet, getBalance, listLedger, and a tightly-controlled internal
 * appendFoundationCredit() for trusted server-side foundation callers. It does NOT expose a partner-facing mutation
 * route, an admin adjustment UI, reserve/consume/release semantics, Stripe, or submission linkage.
 */
import { createHash } from "node:crypto";
import type pg from "pg";
import { partnerAdminQuery } from "./db";
import {
  WalletRequestError,
  validateCreditAmount,
  validateEntryType,
  validateSource,
  validateActorType,
  requireReason,
  requireIdempotencyKey,
  requireTenantId,
  optionalText,
  optionalUuid,
  validateMetadata,
  parseBalance,
  clampPagination,
  type LedgerEntryType,
  type LedgerSource,
  type LedgerActorType,
  type WalletStatus,
} from "./partner-wallet-errors";

/** Server-derived acting identity (never from an untrusted client body). */
export interface WalletActor {
  actorUserId: string | null;
  actorEmail: string | null;
}

export interface PartnerWallet {
  id: string;
  tenant_id: string;
  status: WalletStatus;
  credit_unit: string;
  created_at: string;
  updated_at: string;
  suspended_at: string | null;
  closed_at: string | null;
}

export interface WalletBalance {
  walletId: string;
  tenantId: string;
  status: WalletStatus;
  creditUnit: string;
  balance: number;
  ledgerEntryCount: number;
}

export interface LedgerEntry {
  id: string;
  wallet_id: string;
  tenant_id: string;
  amount: number;
  entry_type: LedgerEntryType;
  idempotency_key: string;
  correlation_id: string | null;
  source: LedgerSource;
  reason: string;
  actor_type: LedgerActorType;
  actor_user_id: string | null;
  actor_email: string | null;
  external_ref: string | null;
  metadata: Record<string, unknown>;
  request_fingerprint: string;
  created_at: string;
}

export interface AppendFoundationCreditInput {
  tenantId: string; // server-resolved organisation id
  amount: number; // positive whole credits; debits are outside G6A
  entryType: LedgerEntryType;
  source: LedgerSource;
  reason: string;
  idempotencyKey: string;
  actorType: LedgerActorType;
  correlationId?: string | null;
  externalRef?: string | null;
  metadata?: Record<string, unknown>;
}

const WALLET_COLS = "id, tenant_id, status, credit_unit, created_at, updated_at, suspended_at, closed_at";
const LEDGER_COLS =
  "id, wallet_id, tenant_id, amount, entry_type, idempotency_key, correlation_id, source, reason, actor_type, actor_user_id, actor_email, external_ref, metadata, request_fingerprint, created_at";

type Queryable = {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params?: unknown[]): Promise<pg.QueryResult<T>>;
};

const partnerAdminQueryable: Queryable = {
  query: (sql: string, params?: unknown[]) => partnerAdminQuery(sql, params ?? []),
};

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

/** node-pg returns bigint as string; coerce the amount column of a ledger row to an exact JS integer. */
function normalizeEntry(row: Record<string, unknown>): LedgerEntry {
  return { ...(row as unknown as LedgerEntry), amount: parseBalance(row.amount) };
}

async function loadOrgWithClient(client: Queryable, tenantId: string): Promise<void> {
  const r = await client.query<{ id: string }>("SELECT id FROM partner_organisations WHERE id = $1", [tenantId]);
  if (r.rowCount === 0) throw new WalletRequestError("ORG_NOT_FOUND", "Partner organisation not found.");
}

/**
 * Ensure a wallet exists for an organisation. Idempotent and concurrency-safe: the tenant_id UNIQUE
 * constraint guarantees exactly one wallet per org even under a race (ON CONFLICT DO NOTHING, then a
 * definitive read). Creates NO credits (empty ledger → zero balance).
 */
export async function ensureWallet(_actor: WalletActor, tenantIdRaw: string): Promise<PartnerWallet> {
  return ensureWalletWithClient(partnerAdminQueryable, _actor, tenantIdRaw);
}

/**
 * Transaction-aware form of `ensureWallet`. First-shop onboarding uses this
 * with its existing Partner-management transaction so a newly ACTIVE-ready
 * shop cannot be committed without its zero-balance canonical wallet.
 */
export async function ensureWalletWithClient(
  client: Queryable,
  _actor: WalletActor,
  tenantIdRaw: string
): Promise<PartnerWallet> {
  const tenantId = requireTenantId(tenantIdRaw);
  await loadOrgWithClient(client, tenantId);
  await client.query("INSERT INTO partner_wallets (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING", [tenantId]);
  const r = await client.query<PartnerWallet>(`SELECT ${WALLET_COLS} FROM partner_wallets WHERE tenant_id = $1`, [tenantId]);
  if (r.rowCount === 0) throw new WalletRequestError("INTERNAL_ERROR", "wallet ensure failed.");
  return r.rows[0];
}

export async function getWallet(tenantIdRaw: string): Promise<PartnerWallet> {
  const tenantId = requireTenantId(tenantIdRaw);
  const r = await queryWallet(partnerAdminQueryable, tenantId);
  if (r.rowCount === 0) throw new WalletRequestError("WALLET_NOT_FOUND", "Wallet not found for this organisation.");
  return r.rows[0];
}

async function queryWallet(client: Queryable, tenantId: string): Promise<pg.QueryResult<PartnerWallet>> {
  return client.query<PartnerWallet>(`SELECT ${WALLET_COLS} FROM partner_wallets WHERE tenant_id = $1`, [tenantId]);
}

/** Ledger-derived balance (authoritative). Reads the derived view; never a stored balance. */
export async function getBalance(tenantIdRaw: string): Promise<WalletBalance> {
  const tenantId = requireTenantId(tenantIdRaw);
  const r = await partnerAdminQuery<{
    wallet_id: string;
    tenant_id: string;
    status: WalletStatus;
    credit_unit: string;
    balance: string;
    ledger_entry_count: string;
  }>(
    "SELECT wallet_id, tenant_id, status, credit_unit, balance, ledger_entry_count FROM partner_wallet_balances WHERE tenant_id = $1",
    [tenantId]
  );
  if (r.rowCount === 0) throw new WalletRequestError("WALLET_NOT_FOUND", "Wallet not found for this organisation.");
  const row = r.rows[0];
  return {
    walletId: row.wallet_id,
    tenantId: row.tenant_id,
    status: row.status,
    creditUnit: row.credit_unit,
    balance: parseBalance(row.balance),
    ledgerEntryCount: parseBalance(row.ledger_entry_count),
  };
}

/** Bounded, newest-first ledger history for one organisation's wallet. */
export async function listLedger(
  tenantIdRaw: string,
  pageRaw?: unknown,
  pageSizeRaw?: unknown
): Promise<{ entries: LedgerEntry[]; total: number; page: number; pageSize: number }> {
  const wallet = await getWallet(tenantIdRaw);
  const { page, pageSize, offset } = clampPagination(pageRaw, pageSizeRaw);
  const rows = await partnerAdminQuery<Record<string, unknown>>(
    `SELECT ${LEDGER_COLS} FROM partner_credit_ledger WHERE wallet_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
    [wallet.id, pageSize, offset]
  );
  const totalR = await partnerAdminQuery<{ n: string }>(
    "SELECT count(*)::bigint AS n FROM partner_credit_ledger WHERE wallet_id = $1",
    [wallet.id]
  );
  return {
    entries: rows.rows.map(normalizeEntry),
    total: parseBalance(totalR.rows[0].n),
    page,
    pageSize,
  };
}

/**
 * The single G6A write boundary. It is imported only by trusted server code and has no HTTP route.
 * It records positive foundation credits; all debit/spend/reservation behavior remains out of scope.
 * Producer-scoped idempotency compares an immutable fingerprint over every material request field.
 */
export async function appendFoundationCredit(
  actor: WalletActor,
  input: AppendFoundationCreditInput
): Promise<{ entry: LedgerEntry; alreadyApplied: boolean }> {
  return appendFoundationCreditWithClient(partnerAdminQueryable, actor, input);
}

/**
 * The same ledger append boundary, but pinned to an already-open admin transaction.
 *
 * This exists for domain services that need another authoritative state transition to commit or roll
 * back with the append-only ledger row. It keeps the same validation, wallet-status check and
 * producer-scoped idempotency contract as appendFoundationCredit().
 */
export async function appendFoundationCreditWithClient(
  client: Queryable,
  actor: WalletActor,
  input: AppendFoundationCreditInput
): Promise<{ entry: LedgerEntry; alreadyApplied: boolean }> {
  const tenantId = requireTenantId(input.tenantId);
  const amount = validateCreditAmount(input.amount);
  const entryType = validateEntryType(input.entryType);
  const source = validateSource(input.source);
  const actorType = validateActorType(input.actorType);
  const reason = requireReason(input.reason);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const correlationId = optionalText(input.correlationId, "correlationId");
  const externalRef = optionalText(input.externalRef, "externalRef");
  const metadata = validateMetadata(input.metadata);
  const actorUserId = optionalUuid(actor.actorUserId, "actorUserId");
  const actorEmail = optionalText(actor.actorEmail, "actorEmail", 320);

  // Resolve the wallet from the trusted tenant id; it must exist and be active.
  const walletResult = await queryWallet(client, tenantId);
  if (walletResult.rowCount === 0) {
    throw new WalletRequestError("WALLET_NOT_FOUND", "Wallet not found for this organisation.");
  }
  const wallet = walletResult.rows[0];
  if (wallet.status !== "active") {
    throw new WalletRequestError(
      "VALIDATION_ERROR",
      `wallet is ${wallet.status}; cannot append to a non-active wallet.`
    );
  }

  const fingerprint = requestFingerprint({
    wallet_id: wallet.id,
    tenant_id: wallet.tenant_id,
    amount,
    entry_type: entryType,
    source,
    correlation_id: correlationId,
    external_ref: externalRef,
    actor_type: actorType,
    actor_user_id: actorUserId,
    actor_email: actorEmail,
    reason,
    metadata,
  });

  const inserted = await client.query<Record<string, unknown>>(
    `INSERT INTO partner_credit_ledger
       (wallet_id, tenant_id, amount, entry_type, idempotency_key, correlation_id, source, reason,
        actor_type, actor_user_id, actor_email, external_ref, metadata, request_fingerprint)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)
     ON CONFLICT (source, idempotency_key) DO NOTHING
     RETURNING ${LEDGER_COLS}`,
    [
      wallet.id,
      wallet.tenant_id, // server-derived: the wallet's own tenant, never a client value.
      amount,
      entryType,
      idempotencyKey,
      correlationId,
      source,
      reason,
      actorType,
      actorUserId,
      actorEmail,
      externalRef,
      JSON.stringify(metadata),
      fingerprint,
    ]
  );
  if (inserted.rowCount && inserted.rows[0]) {
    return { entry: normalizeEntry(inserted.rows[0]), alreadyApplied: false };
  }

  // Resolve a producer-scoped race. Only an identical canonical request returns the original.
  const existing = await client.query<Record<string, unknown>>(
    `SELECT ${LEDGER_COLS} FROM partner_credit_ledger WHERE source = $1 AND idempotency_key = $2`,
    [source, idempotencyKey]
  );
  if (existing.rowCount && existing.rows[0]) {
    const e = normalizeEntry(existing.rows[0]);
    if (e.request_fingerprint === fingerprint) {
      return { entry: e, alreadyApplied: true };
    }
    throw new WalletRequestError(
      "IDEMPOTENCY_CONFLICT",
      "idempotencyKey was already used by this source for a different request."
    );
  }
  throw new WalletRequestError("INTERNAL_ERROR", "idempotency check failed after ledger conflict.");
}
