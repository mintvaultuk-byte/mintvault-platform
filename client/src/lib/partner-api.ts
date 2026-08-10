/**
 * Partner Portal — typed API client for the isolated /api/partner surface (Phase 1 + Phase 2
 * backend). Wraps the existing apiRequest() so every call carries the partner session cookie and
 * every error is normalised to a plain, user-facing message — never a raw {code,message} object
 * leaked into the UI as "[object Object]".
 */
import { apiRequest } from "./queryClient";

export class PartnerApiError extends Error {
  code: string;
  status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Extract a safe, plain-English message from a thrown apiRequest error. Never returns raw JSON. */
export function partnerErrorMessage(err: unknown): string {
  if (err instanceof PartnerApiError) return err.message;
  const e = err as { body?: { error?: { code?: string; message?: string } | string } };
  const apiErr = e?.body?.error;
  if (apiErr && typeof apiErr === "object" && apiErr.message) return apiErr.message;
  if (typeof apiErr === "string") return apiErr;
  return "Something went wrong. Please try again.";
}

async function req<T>(method: string, url: string, data?: unknown): Promise<T> {
  try {
    const res = await apiRequest(method, url, data);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  } catch (err) {
    const e = err as { status?: number; body?: { error?: { code?: string; message?: string } } };
    const code = e.body?.error?.code ?? "error";
    const message = partnerErrorMessage(err);
    throw new PartnerApiError(e.status ?? 0, code, message);
  }
}

// ---- session / auth ----
export interface PartnerSessionInfo {
  mfaPassed: boolean;
  mfaRequired?: boolean;
  userId?: string;
  tenantId?: string;
  locationId?: string | null;
  viewOnly?: boolean;
  permissions?: string[];
  // Shop-facing identity summary (this branch) — spread from getPartnerPortalContext.
  organisationName?: string;
  tradingName?: string | null;
  displayName?: string;
  role?: string;
  locationName?: string | null;
  // MFA posture (origin/main, P0-E). Disjoint from the identity fields above; GET /session
  // returns both, and dropping either half silently breaks a shipped Portal surface.
  /** An ACTIVE authenticator is registered on this account. */
  mfaEnrolled?: boolean;
  /** Two-step is required but no authenticator exists yet — enrolment is the only way forward. */
  mfaEnrolmentRequired?: boolean;
  /** Unused recovery codes left (count only — the codes themselves are shown once, at issue). */
  recoveryCodesRemaining?: number;
}

export const partnerAuth = {
  login: (email: string, password: string) =>
    req<{ ok: boolean; mfaRequired?: boolean }>("POST", "/api/partner/auth/login", { email, password }),
  mfa: (input: { code?: string; recoveryCode?: string }) =>
    req<{ ok: boolean }>("POST", "/api/partner/auth/mfa", input),
  logout: () => req<{ ok: boolean }>("POST", "/api/partner/auth/logout"),
  session: () => req<PartnerSessionInfo>("GET", "/api/partner/session"),
  switchLocation: (locationId: string) =>
    req<{ ok: boolean; locationId: string }>("POST", "/api/partner/session/location", { locationId }),
  revokeAll: () => req<{ ok: boolean; revoked: number }>("POST", "/api/partner/auth/revoke-all"),
};

/**
 * Minimum password length the server enforces (server/partner/auth.ts MIN_PASSWORD_LEN). Mirrored
 * here ONLY to give the user an instant, plain-English hint before they submit — the server remains
 * the authority and re-checks every time.
 */
export const PARTNER_MIN_PASSWORD_LEN = 10;

// ---- MFA enrolment ----
// Both endpoints are reachable by an mfa-pending session (password accepted, second factor not yet
// done), which is exactly the state a newly-invited user is in. `secret`/`otpauthUri` and
// `recoveryCodes` are shown ONCE and never persisted client-side.
export const partnerMfa = {
  /**
   * Start enrolment. `secondFactor` is only required when REPLACING an authenticator that is already
   * set up (server-enforced — F3); first-time setup takes the password alone. Never persisted.
   */
  enrol: (password: string, secondFactor?: { code?: string; recoveryCode?: string }) =>
    req<{ ok: boolean; enrolmentId: string; secret: string; otpauthUri: string; expiresAt: string }>("POST", "/api/partner/mfa/enrol", {
      password,
      ...(secondFactor?.code ? { code: secondFactor.code } : {}),
      ...(secondFactor?.recoveryCode ? { recoveryCode: secondFactor.recoveryCode } : {}),
    }),
  restart: () =>
    req<{ ok: boolean; enrolmentId: string; secret: string; otpauthUri: string; expiresAt: string }>(
      "POST",
      "/api/partner/mfa/restart"
    ),
  cancel: () => req<{ ok: boolean }>("POST", "/api/partner/mfa/cancel"),
  confirm: (input: { enrolmentId: string; code: string }) =>
    req<{ ok: boolean; recoveryCodes: string[] }>("POST", "/api/partner/mfa/confirm", input),
  /**
   * Replaces every unused recovery code. Requires the account password AND, once an authenticator is
   * enrolled, a current factor (C) — the same proof the server demands to replace the authenticator
   * itself, because a fresh recovery set is a fresh set of second factors. Never persisted.
   */
  regenerateRecoveryCodes: (password: string, secondFactor?: { code?: string; recoveryCode?: string }) =>
    req<{ ok: boolean; recoveryCodes: string[] }>("POST", "/api/partner/mfa/recovery-codes/regenerate", {
      password,
      ...(secondFactor?.code ? { code: secondFactor.code } : {}),
      ...(secondFactor?.recoveryCode ? { recoveryCode: secondFactor.recoveryCode } : {}),
    }),
};

// ---- password reset ----
// `request` is deliberately always-success: the server never discloses whether an account exists,
// and the client must not infer it either. The token is delivered out of band (email) and never
// appears in a response body.
export const partnerPasswordReset = {
  request: (email: string) => req<{ ok: boolean }>("POST", "/api/partner/auth/password-reset/request", { email }),
  consume: (token: string, newPassword: string) =>
    req<{ ok: boolean }>("POST", "/api/partner/auth/password-reset/consume", { token, newPassword }),
};

// ---- customers ----
export interface PartnerCustomer {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  reference: string | null;
  createdAt: string;
}
export const partnerCustomers = {
  list: (search?: string) =>
    req<PartnerCustomer[]>("GET", `/api/partner/customers${search ? `?search=${encodeURIComponent(search)}` : ""}`),
  create: (input: { fullName: string; email?: string | null; phone?: string | null; reference?: string | null }) =>
    req<PartnerCustomer>("POST", "/api/partner/customers", input),
  edit: (
    id: string,
    input: { fullName: string; email?: string | null; phone?: string | null; reference?: string | null }
  ) => req<PartnerCustomer>("PATCH", `/api/partner/customers/${id}`, input),
};

// ---- locations ----
export interface PartnerLocation {
  id: string;
  name: string;
  status: string;
}
export const partnerLocations = {
  list: () => req<PartnerLocation[]>("GET", "/api/partner/locations"),
};

// ---- team ----
export type PartnerTeamRole = "OWNER" | "ADMIN" | "GRADER" | "STAFF";
export type PartnerTeamDisplayRole = PartnerTeamRole | "FINANCE_VIEWER" | "TRAINEE" | "UNASSIGNED";
export type PartnerTeamStatus = "INVITED" | "ACTIVE" | "SUSPENDED" | "REVOKED";

export interface PartnerTeamMember {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: PartnerTeamDisplayRole;
  status: PartnerTeamStatus;
  invitationStatus: string | null;
  invitationExpiresAt: string | null;
  invitationDeliveredAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

export const partnerTeam = {
  list: () => req<{ users: PartnerTeamMember[] }>("GET", "/api/partner/users"),
  invite: (input: { firstName: string; lastName: string; email: string; role: PartnerTeamRole; reason?: string }) =>
    req<{ ok: boolean; result: { userId: string; invitationId: string; deliveryStatus: string } }>(
      "POST",
      "/api/partner/users",
      input
    ),
  resend: (userId: string, reason?: string) =>
    req<{ ok: boolean; result: { invitationId: string; deliveryStatus: string } }>(
      "POST",
      `/api/partner/users/${userId}/resend-invitation`,
      { reason }
    ),
  revokeInvitation: (userId: string, reason: string) =>
    req<{ ok: boolean; result: { revoked: number } }>("POST", `/api/partner/users/${userId}/revoke-invitation`, {
      reason,
    }),
  changeRole: (userId: string, role: PartnerTeamRole, reason: string) =>
    req<{ ok: boolean }>("POST", `/api/partner/users/${userId}/role`, { role, reason }),
  setStatus: (userId: string, status: Exclude<PartnerTeamStatus, "INVITED">, reason: string) =>
    req<{ ok: boolean }>("POST", `/api/partner/users/${userId}/status`, { status, reason }),
  revokeSessions: (userId: string, reason?: string) =>
    req<{ ok: boolean; result: { revoked: number } }>("POST", `/api/partner/users/${userId}/revoke-sessions`, {
      reason,
    }),
};

// ---- service tiers ----
export interface AvailableServiceTier {
  tierCode: string;
  label: string;
  pricePerCardPence: number;
  turnaroundDays: number;
}
export const partnerServiceTiers = {
  list: () => req<AvailableServiceTier[]>("GET", "/api/partner/service-tiers"),
};

// ---- dashboard ----
export interface DashboardCounts {
  draft: number;
  submitted_to_mintvault: number;
  cancelled: number;
}
export const partnerDashboard = {
  summary: () => req<DashboardCounts>("GET", "/api/partner/dashboard/submissions"),
};

// ---- credits and billing ----
export interface PartnerCreditSummary {
  configured: boolean;
  walletStatus: string | null;
  availableCredits: number | null;
  reservedCredits: number | null;
  consumedThisMonth: number | null;
  consumedLifetime: number | null;
  postedBalance: number | null;
  balanceStatus: "healthy" | "low" | "empty" | "inactive" | "unknown";
}

export interface PartnerCreditLedgerEntry {
  id: string;
  date: string;
  type: string;
  quantity: number;
  submissionReference: string | null;
  cardReference: string | null;
  actor: string;
  source: string;
  runningBalance: number;
  reason: string;
}

export interface PartnerCreditView {
  summary: PartnerCreditSummary;
  ledger: PartnerCreditLedgerEntry[];
  purchaseHistory: PartnerCreditLedgerEntry[];
}

export const partnerCredits = {
  view: () => req<PartnerCreditView>("GET", "/api/partner/credits"),
};

// ---- own sessions ----
export interface PartnerSessionView {
  id: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  expiresAt: string;
  ip: string | null;
  revokedAt: string | null;
}

export const partnerSessions = {
  list: () => req<{ sessions: PartnerSessionView[] }>("GET", "/api/partner/sessions"),
  revoke: (sessionId: string) =>
    req<{ ok: boolean; current: boolean }>("POST", `/api/partner/sessions/${sessionId}/revoke`),
};

// ---- submissions ----
export interface SubmissionSummary {
  id: string;
  publicRef: string;
  locationId: string;
  customerId: string | null;
  internalReference: string | null;
  serviceTierCode: string | null;
  estimatedPricePence: number | null;
  cardCount: number;
  status: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
}

export interface SubmissionCard {
  id: string;
  sequence_number: number;
  card_name: string;
  game: string | null;
  card_set: string | null;
  card_number: string | null;
  year: number | null;
  variant: string | null;
  language: string | null;
  declared_value_pence: number | null;
  quantity: number;
  customer_notes: string | null;
  intake_notes: string | null;
  front_image_key: string | null;
  back_image_key: string | null;
  front_image_url: string | null;
  back_image_url: string | null;
  created_at: string;
}

export interface SubmissionEvent {
  id: string;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  reason: string | null;
  created_at: string;
  actor_user_id: string | null;
}

export interface SubmissionDetail {
  submission: SubmissionSummary;
  cards: SubmissionCard[];
  events: SubmissionEvent[];
}

export interface PartnerCatalogueSnapshotResponse {
  snapshot: import("@shared/pokemon-rarity-catalogue").CatalogueSnapshot;
  categories: string[];
}

export const partnerSubmissions = {
  list: (opts: { status?: string; page?: number; pageSize?: number } = {}) => {
    const qs = new URLSearchParams();
    if (opts.status) qs.set("status", opts.status);
    if (opts.page) qs.set("page", String(opts.page));
    if (opts.pageSize) qs.set("pageSize", String(opts.pageSize));
    const suffix = qs.toString() ? `?${qs}` : "";
    return req<{ items: SubmissionSummary[]; total: number }>("GET", `/api/partner/submissions${suffix}`);
  },
  create: (input: {
    locationId: string;
    customerId?: string | null;
    internalReference?: string | null;
    serviceTierCode?: string | null;
    intakeNotes?: string | null;
  }) => req<SubmissionSummary>("POST", "/api/partner/submissions", input),
  detail: (id: string) => req<SubmissionDetail>("GET", `/api/partner/submissions/${id}`),
  edit: (
    id: string,
    input: {
      version: number;
      customerId?: string | null;
      internalReference?: string | null;
      serviceTierCode?: string | null;
      intakeNotes?: string | null;
    }
  ) => req<SubmissionSummary>("PATCH", `/api/partner/submissions/${id}`, input),
  cancel: (id: string, reason: string) =>
    req<SubmissionSummary>("DELETE", `/api/partner/submissions/${id}`, { reason }),
  submit: (id: string, idempotencyKey: string) =>
    req<SubmissionDetail>("POST", `/api/partner/submissions/${id}/submit`, { idempotencyKey }),
};

export const partnerCards = {
  list: (submissionId: string) => req<SubmissionCard[]>("GET", `/api/partner/submissions/${submissionId}/cards`),
  add: (
    submissionId: string,
    input: {
      cardName: string;
      game?: string | null;
      cardSet?: string | null;
      cardNumber?: string | null;
      year?: number | null;
      variant?: string | null;
      language?: string | null;
      declaredValuePence?: number | null;
      quantity?: number;
      customerNotes?: string | null;
      intakeNotes?: string | null;
    }
  ) => req<SubmissionCard>("POST", `/api/partner/submissions/${submissionId}/cards`, input),
  edit: (
    submissionId: string,
    cardId: string,
    input: {
      cardName?: string;
      game?: string | null;
      cardSet?: string | null;
      cardNumber?: string | null;
      year?: number | null;
      variant?: string | null;
      language?: string | null;
      declaredValuePence?: number | null;
      quantity?: number;
      customerNotes?: string | null;
      intakeNotes?: string | null;
    }
  ) => req<SubmissionCard>("PATCH", `/api/partner/submissions/${submissionId}/cards/${cardId}`, input),
  remove: (submissionId: string, cardId: string, reason?: string) =>
    req<{ ok: boolean }>(
      "DELETE",
      `/api/partner/submissions/${submissionId}/cards/${cardId}`,
      reason ? { reason } : undefined
    ),
  uploadImage: async (submissionId: string, cardId: string, side: "front" | "back", file: File) => {
    const form = new FormData();
    form.append("image", file);
    const res = await fetch(`/api/partner/submissions/${submissionId}/cards/${cardId}/images/${side}`, {
      method: "POST",
      credentials: "include",
      body: form,
    });
    if (!res.ok) {
      let body: { error?: { code?: string; message?: string } } = {};
      try {
        body = await res.json();
      } catch {
        /* ignore */
      }
      throw new PartnerApiError(res.status, body.error?.code ?? "error", body.error?.message ?? "Upload failed.");
    }
    return (await res.json()) as { side: "front" | "back"; key: string; url: string | null };
  },
};

export const partnerCatalogue = {
  snapshot: () => req<PartnerCatalogueSnapshotResponse>("GET", "/api/partner/catalogue/snapshot"),
};

/** A stable idempotency key for one submit "session" — regenerated only when the user explicitly retries after a genuine error, never on every render. */
export function newIdempotencyKey(submissionId: string): string {
  return `${submissionId}-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

export function formatPence(pence: number | null | undefined): string {
  if (pence == null) return "Estimated — price confirmed by MintVault";
  return `£${(pence / 100).toFixed(2)} — price confirmed by MintVault`;
}
