/**
 * G5 Super-Admin partner-management — stable error surface + pure helpers.
 *
 * Pure (no DB/I/O) so it is unit-testable without a harness. Mirrors the G4 connector-admin-errors
 * conventions: a stable API error-code union, a request-shaping error class, an error→shape mapper that
 * never leaks SQL/stack, HTTP-status mapping, and the request-shaping helpers (reason/version/pagination
 * validation, status-transition rules, contact-type validation) the routes/service reuse.
 */

export const G5_ERROR_CODES = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "PARTNER_NOT_FOUND",
  "CONTACT_NOT_FOUND",
  "BRANDING_NOT_FOUND",
  "INVALID_PARTNER_STATUS",
  "INVALID_STATUS_TRANSITION",
  "DUPLICATE_PRIMARY_CONTACT",
  "VERSION_CONFLICT",
  "VALIDATION_ERROR",
  "REASON_REQUIRED",
  "BAD_REQUEST",
  "RATE_LIMITED",
  "IDEMPOTENCY_CONFLICT",
  "REQUEST_ALREADY_COMPLETED",
  "INTERNAL_ERROR",
] as const;
export type G5ErrorCode = (typeof G5_ERROR_CODES)[number];

export interface G5ErrorShape {
  code: G5ErrorCode;
  message: string;
}

/** A request-shaping error raised before/within the service with a stable code. */
export class G5RequestError extends Error {
  readonly code: G5ErrorCode;
  constructor(code: G5ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Map any thrown value to a safe G5 error shape. Never leaks SQL/stack; unknown → INTERNAL_ERROR. */
export function toG5Error(err: unknown): G5ErrorShape {
  if (err instanceof G5RequestError) return { code: err.code, message: err.message };
  const pg = err as { code?: string; constraint?: string };
  // Postgres unique-violation surfaced past the service guards → a friendly 409 by constraint.
  if (pg?.code === "23505") {
    if (pg.constraint === "uq_partner_contacts_primary") {
      return {
        code: "DUPLICATE_PRIMARY_CONTACT",
        message: "An active primary contact already exists for this partner.",
      };
    }
    return { code: "IDEMPOTENCY_CONFLICT", message: "A conflicting record already exists." };
  }
  // Postgres check-violation (e.g. an out-of-allow-list enum value that slipped past validation) → 400.
  if (pg?.code === "23514") {
    return { code: "VALIDATION_ERROR", message: "A field value is not permitted." };
  }
  return { code: "INTERNAL_ERROR", message: "An internal error occurred." };
}

/** HTTP status for a G5 code. */
export function g5StatusFor(code: G5ErrorCode): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "FORBIDDEN":
      return 403;
    case "PARTNER_NOT_FOUND":
    case "CONTACT_NOT_FOUND":
    case "BRANDING_NOT_FOUND":
      return 404;
    case "VERSION_CONFLICT":
    case "DUPLICATE_PRIMARY_CONTACT":
    case "IDEMPOTENCY_CONFLICT":
      return 409;
    case "RATE_LIMITED":
      return 429;
    case "REQUEST_ALREADY_COMPLETED":
      return 200;
    case "INTERNAL_ERROR":
      return 500;
    default:
      return 400; // BAD_REQUEST, VALIDATION_ERROR, REASON_REQUIRED, INVALID_PARTNER_STATUS, INVALID_STATUS_TRANSITION
  }
}

// ---- Pure request-shaping helpers ----------------------------------------------------------------

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

export function clampPagination(
  pageRaw: unknown,
  pageSizeRaw: unknown
): { page: number; pageSize: number; offset: number } {
  const page = toPosInt(pageRaw, 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, toPosInt(pageSizeRaw, DEFAULT_PAGE_SIZE));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function toPosInt(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

export function requireReason(raw: unknown): string {
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (reason.length === 0) throw new G5RequestError("REASON_REQUIRED", "A reason is required for this action.");
  if (reason.length > 2000) throw new G5RequestError("BAD_REQUEST", "Reason is too long.");
  return reason;
}

/** An optional reason: a non-blank trimmed value bounded to 2000 chars, else the supplied default. */
export function optionalReason(raw: unknown, fallback: string): string {
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (reason.length === 0) return fallback;
  if (reason.length > 2000) throw new G5RequestError("BAD_REQUEST", "Reason is too long.");
  return reason;
}

export function requireVersion(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n) {
    throw new G5RequestError("BAD_REQUEST", "expectedVersion is required and must be a non-negative integer.");
  }
  return n;
}

export function requireNonEmpty(raw: unknown, field: string): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (s.length === 0) throw new G5RequestError("VALIDATION_ERROR", `${field} is required.`);
  if (s.length > 500) throw new G5RequestError("VALIDATION_ERROR", `${field} is too long.`);
  return s;
}

export function optionalText(raw: unknown, field: string, max = 500): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw new G5RequestError("VALIDATION_ERROR", `${field} must be text.`);
  const s = raw.trim();
  if (s.length > max) throw new G5RequestError("VALIDATION_ERROR", `${field} is too long.`);
  return s.length ? s : null;
}

// ---- Domain rules (pure, unit-tested) ------------------------------------------------------------

export const PARTNER_STATUSES = ["PENDING", "ACTIVE", "SUSPENDED", "REVOKED"] as const;
export type PartnerStatus = (typeof PARTNER_STATUSES)[number];

/** Business-status lifecycle over the EXISTING partner_organisations.status values. Label-only. */
const STATUS_TRANSITIONS: Record<PartnerStatus, PartnerStatus[]> = {
  PENDING: ["ACTIVE", "REVOKED"],
  ACTIVE: ["SUSPENDED", "REVOKED"],
  SUSPENDED: ["ACTIVE", "REVOKED"],
  REVOKED: [],
};

export function isPartnerStatus(s: unknown): s is PartnerStatus {
  return typeof s === "string" && (PARTNER_STATUSES as readonly string[]).includes(s);
}

/** Whether `to` is a permitted transition from `from`. */
export function canTransitionStatus(from: string, to: string): boolean {
  if (!isPartnerStatus(from) || !isPartnerStatus(to)) return false;
  return STATUS_TRANSITIONS[from].includes(to);
}

/** The set of statuses reachable from the current one (for the UI). */
export function allowedNextStatuses(from: string): PartnerStatus[] {
  return isPartnerStatus(from) ? [...STATUS_TRANSITIONS[from]] : [];
}

/** Whether a status change to SUSPENDED/REVOKED is high-risk (typed-confirm in the UI). */
export function isHighRiskStatus(to: string): boolean {
  return to === "SUSPENDED" || to === "REVOKED";
}

export const CONTACT_TYPES = ["general", "billing", "technical", "operations"] as const;
export function requireContactType(raw: unknown): (typeof CONTACT_TYPES)[number] {
  if (typeof raw === "string" && (CONTACT_TYPES as readonly string[]).includes(raw)) {
    return raw as (typeof CONTACT_TYPES)[number];
  }
  throw new G5RequestError("VALIDATION_ERROR", "contact_type must be one of general|billing|technical|operations.");
}

export const ORGANISATION_KINDS = [
  "shop",
  "independent_grader",
  "franchise",
  "scanning_centre",
  "enterprise",
  "other",
] as const;
export function optionalOrganisationKind(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "string" && (ORGANISATION_KINDS as readonly string[]).includes(raw)) return raw;
  throw new G5RequestError("VALIDATION_ERROR", "organisation_kind is not a recognised value.");
}

export const BRANDING_STATUSES = ["draft", "ready", "disabled"] as const;
export function optionalBrandingStatus(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "string" && (BRANDING_STATUSES as readonly string[]).includes(raw)) return raw;
  throw new G5RequestError("VALIDATION_ERROR", "branding_status is not a recognised value.");
}
