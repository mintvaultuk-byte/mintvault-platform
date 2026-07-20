/**
 * G6A partner wallet + credit ledger — stable error surface + pure validation helpers.
 *
 * Pure (no DB/I/O) so it is unit-testable without a harness. Mirrors the G4/G5 error conventions:
 * a stable code union, a request-shaping error class, an error→shape mapper that never leaks SQL/stack,
 * and the integer-safe amount / metadata / field validators the wallet service reuses.
 *
 * Financial-safety invariants encoded here: G6A service credits are positive WHOLE integers, magnitude-bounded
 * (overflow-safe and far inside JS Number.isSafeInteger); metadata is a bounded plain object; every
 * movement carries a required reason + idempotency key.
 */

export const WALLET_ERROR_CODES = [
  "UNAUTHENTICATED",
  "ORG_NOT_FOUND",
  "WALLET_NOT_FOUND",
  "VALIDATION_ERROR",
  "IDEMPOTENCY_CONFLICT",
  "LEDGER_IMMUTABLE",
  "BAD_REQUEST",
  "INTERNAL_ERROR",
] as const;
export type WalletErrorCode = (typeof WALLET_ERROR_CODES)[number];

export interface WalletErrorShape {
  code: WalletErrorCode;
  message: string;
}

export class WalletRequestError extends Error {
  readonly code: WalletErrorCode;
  constructor(code: WalletErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "WalletRequestError";
  }
}

/** Map any thrown value to a safe error shape. Never leaks SQL/stack; unknown → INTERNAL_ERROR. */
export function toWalletError(err: unknown): WalletErrorShape {
  if (err instanceof WalletRequestError) return { code: err.code, message: err.message };
  const pg = err as { code?: string; constraint?: string };
  if (pg?.code === "23505")
    return { code: "IDEMPOTENCY_CONFLICT", message: "A conflicting ledger entry already exists for this key." };
  if (pg?.code === "23514") return { code: "VALIDATION_ERROR", message: "A field value is not permitted." };
  if (pg?.code === "23503")
    return { code: "VALIDATION_ERROR", message: "Referenced wallet or organisation does not exist." };
  // The append-only immutability trigger raises restrict_violation (23001) on UPDATE/DELETE/TRUNCATE.
  if (pg?.code === "23001")
    return { code: "LEDGER_IMMUTABLE", message: "The credit ledger is append-only and cannot be modified." };
  return { code: "INTERNAL_ERROR", message: "An internal error occurred." };
}

export function walletStatusFor(code: WalletErrorCode): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "ORG_NOT_FOUND":
    case "WALLET_NOT_FOUND":
      return 404;
    case "IDEMPOTENCY_CONFLICT":
      return 409;
    case "LEDGER_IMMUTABLE":
      return 409;
    case "INTERNAL_ERROR":
      return 500;
    default:
      return 400; // VALIDATION_ERROR, BAD_REQUEST
  }
}

// ---- Domain vocabularies (kept in lock-step with migration 0016 CHECK constraints) ---------------
export const LEDGER_ENTRY_TYPES = ["opening_balance", "purchase", "admin_adjustment", "refund"] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

export const LEDGER_SOURCES = ["admin", "system", "connector", "stripe", "portal", "migration"] as const;
export type LedgerSource = (typeof LEDGER_SOURCES)[number];

export const LEDGER_ACTOR_TYPES = ["admin", "system", "partner_user", "service"] as const;
export type LedgerActorType = (typeof LEDGER_ACTOR_TYPES)[number];

export const WALLET_STATUSES = ["active", "suspended", "closed"] as const;
export type WalletStatus = (typeof WALLET_STATUSES)[number];

// Single-entry magnitude bound — matches the DB CHECK. Far inside Number.isSafeInteger (2^53) so a
// realistic sum of many entries stays exact in JS. Overflow-safe vs bigint.
export const MAX_ENTRY_MAGNITUDE = 1_000_000_000;
const MAX_METADATA_BYTES = 4096;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A positive G6A credit amount. Signed/debit operations are deliberately deferred to later phases. */
export function validateCreditAmount(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw new WalletRequestError("VALIDATION_ERROR", "amount must be a whole integer number of credits.");
  }
  if (raw <= 0) throw new WalletRequestError("VALIDATION_ERROR", "amount must be a positive credit.");
  if (raw > MAX_ENTRY_MAGNITUDE) {
    throw new WalletRequestError("VALIDATION_ERROR", `amount must be <= ${MAX_ENTRY_MAGNITUDE}.`);
  }
  return raw;
}

export function validateEntryType(raw: unknown): LedgerEntryType {
  if (typeof raw === "string" && (LEDGER_ENTRY_TYPES as readonly string[]).includes(raw)) return raw as LedgerEntryType;
  throw new WalletRequestError("VALIDATION_ERROR", "entryType is not a recognised ledger entry type.");
}

export function validateSource(raw: unknown): LedgerSource {
  if (typeof raw === "string" && (LEDGER_SOURCES as readonly string[]).includes(raw)) return raw as LedgerSource;
  throw new WalletRequestError("VALIDATION_ERROR", "source is not a recognised ledger source.");
}

export function validateActorType(raw: unknown): LedgerActorType {
  if (typeof raw === "string" && (LEDGER_ACTOR_TYPES as readonly string[]).includes(raw)) return raw as LedgerActorType;
  throw new WalletRequestError("VALIDATION_ERROR", "actorType is not a recognised actor type.");
}

export function requireReason(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (s.length === 0) throw new WalletRequestError("VALIDATION_ERROR", "reason is required for every ledger entry.");
  if (s.length > 2000) throw new WalletRequestError("VALIDATION_ERROR", "reason is too long.");
  return s;
}

export function requireIdempotencyKey(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (s.length === 0)
    throw new WalletRequestError("VALIDATION_ERROR", "idempotencyKey is required for every ledger entry.");
  if (s.length > 200) throw new WalletRequestError("VALIDATION_ERROR", "idempotencyKey is too long.");
  return s;
}

export function requireTenantId(raw: unknown): string {
  if (typeof raw === "string" && UUID_RE.test(raw)) return raw;
  throw new WalletRequestError("VALIDATION_ERROR", "tenantId must be a valid organisation id.");
}

export function optionalUuid(raw: unknown, field: string): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "string" && UUID_RE.test(raw)) return raw.toLowerCase();
  throw new WalletRequestError("VALIDATION_ERROR", `${field} must be a valid UUID.`);
}

export function optionalText(raw: unknown, field: string, max = 500): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw new WalletRequestError("VALIDATION_ERROR", `${field} must be text.`);
  const s = raw.trim();
  if (s.length > max) throw new WalletRequestError("VALIDATION_ERROR", `${field} is too long.`);
  return s.length ? s : null;
}

/** A bounded plain-object metadata blob. Rejects arrays/primitives and oversized payloads. */
export function validateMetadata(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new WalletRequestError("VALIDATION_ERROR", "metadata must be a plain object.");
  }
  let json: string;
  try {
    json = JSON.stringify(raw);
  } catch {
    throw new WalletRequestError("VALIDATION_ERROR", "metadata must be valid JSON.");
  }
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > MAX_METADATA_BYTES) {
    throw new WalletRequestError("VALIDATION_ERROR", `metadata is too large (max ${MAX_METADATA_BYTES} bytes).`);
  }
  return JSON.parse(json) as Record<string, unknown>;
}

/** Parse a bigint SUM (node-pg returns bigint columns as strings) into an exact JS integer. */
export function parseBalance(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw ?? 0);
  if (!Number.isSafeInteger(n)) {
    throw new WalletRequestError("INTERNAL_ERROR", "wallet balance exceeded safe-integer range.");
  }
  return n;
}

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;
export function clampPagination(
  pageRaw: unknown,
  pageSizeRaw: unknown
): { page: number; pageSize: number; offset: number } {
  const toInt = (v: unknown, fb: number) => {
    const n = typeof v === "number" ? v : Number(v);
    return !Number.isFinite(n) || n < 1 ? fb : Math.floor(n);
  };
  const page = toInt(pageRaw, 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, toInt(pageSizeRaw, DEFAULT_PAGE_SIZE));
  return { page, pageSize, offset: (page - 1) * pageSize };
}
