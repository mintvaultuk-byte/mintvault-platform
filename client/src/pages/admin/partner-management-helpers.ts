/**
 * G5 Partner-management admin UI — pure helpers.
 *
 * DOM-free and side-effect-free so they are unit-testable without a browser/RTL harness (the repo has
 * none). Status→badge mapping, the client mirror of the server status lifecycle, reason validation,
 * and query-key/query-string builders live here; the page components are thin renderers over these.
 */
import type { AdminBadgeVariant } from "@/components/admin";

export const PARTNER_STATUSES = ["PENDING", "ACTIVE", "SUSPENDED", "REVOKED"] as const;
export type PartnerStatus = (typeof PARTNER_STATUSES)[number];

/** Deterministic status → admin badge variant (never colour-only: the badge also carries the text). */
export function statusBadgeVariant(status: string): AdminBadgeVariant {
  switch (status) {
    case "ACTIVE":
      return "act";
    case "PENDING":
      return "wait";
    case "SUSPENDED":
      return "prog";
    case "REVOKED":
      return "red";
    default:
      return "neu";
  }
}

/** Client mirror of the server's business-status lifecycle (label-only; the server re-validates). */
const STATUS_TRANSITIONS: Record<PartnerStatus, PartnerStatus[]> = {
  PENDING: ["ACTIVE", "REVOKED"],
  ACTIVE: ["SUSPENDED", "REVOKED"],
  SUSPENDED: ["ACTIVE", "REVOKED"],
  REVOKED: [],
};

export function isPartnerStatus(s: string): s is PartnerStatus {
  return (PARTNER_STATUSES as readonly string[]).includes(s);
}

export function allowedNextStatuses(from: string): PartnerStatus[] {
  return isPartnerStatus(from) ? [...STATUS_TRANSITIONS[from]] : [];
}

/** SUSPENDED/REVOKED are destructive-sounding business labels → require a typed confirmation. */
export function isHighRiskStatus(to: string): boolean {
  return to === "SUSPENDED" || to === "REVOKED";
}

export const CONTACT_TYPES = ["general", "billing", "technical", "operations"] as const;
export const ORGANISATION_KINDS = [
  "shop",
  "independent_grader",
  "franchise",
  "scanning_centre",
  "enterprise",
  "other",
] as const;

/** A mutation reason is valid when non-blank and within bounds. */
export function reasonValid(reason: string): boolean {
  const t = (reason ?? "").trim();
  return t.length > 0 && t.length <= 2000;
}

/** A note body is valid when non-blank and within bounds. */
export function noteValid(body: string): boolean {
  const t = (body ?? "").trim();
  return t.length > 0 && t.length <= 10000;
}

/** Human label for an unavailable metric (never rendered as a fake 0). */
export const UNAVAILABLE_LABEL = "Unavailable — no tenant-linked source yet";

export const PARTNER_PILOT_FLAG_BASE = "/api/super-admin/partner-flags";
export const PARTNER_PILOT_READONLY_FLAG = "partner_portal_enabled" as const;
export const PARTNER_PILOT_MUTABLE_FLAGS = ["partner_onboarding_enabled", "partner_login_enabled"] as const;
export type PartnerPilotMutableFlag = (typeof PARTNER_PILOT_MUTABLE_FLAGS)[number];
export type PartnerPilotDisplayFlag = PartnerPilotMutableFlag | typeof PARTNER_PILOT_READONLY_FLAG;

export const PARTNER_PILOT_FLAG_LABELS: Record<PartnerPilotDisplayFlag, string> = {
  partner_portal_enabled: "Partner Portal",
  partner_onboarding_enabled: "Partner Onboarding",
  partner_login_enabled: "Partner Login",
};

export function isPartnerPilotMutableFlag(flag: string): flag is PartnerPilotMutableFlag {
  return (PARTNER_PILOT_MUTABLE_FLAGS as readonly string[]).includes(flag);
}

// ---- Query-key builders (literal API paths so prefix-invalidation works) --------------------------
const BASE = "/api/super-admin/partner-management";
export const pmKeys = {
  partners: (filters: Record<string, unknown>) => [`${BASE}/partners`, filters] as const,
  pilotFlags: () => [PARTNER_PILOT_FLAG_BASE] as const,
  walletBackfill: () => [`${BASE}/wallet-backfills/WALLET-BACKFILL1`] as const,
  partner: (id: string) => [`${BASE}/partners/${id}`] as const,
  users: (id: string) => [`${BASE}/partners/${id}/users`] as const,
  contacts: (id: string) => [`${BASE}/partners/${id}/contacts`] as const,
  branding: (id: string) => [`${BASE}/partners/${id}/branding`] as const,
  notes: (id: string) => [`${BASE}/partners/${id}/notes`] as const,
  activity: (id: string) => [`${BASE}/partners/${id}/activity`] as const,
  statistics: (id: string) => [`${BASE}/partners/${id}/statistics`] as const,
  audit: (id: string) => [`${BASE}/partners/${id}/audit`] as const,
};

/** Deterministic query-string for the partners list (only set filters emitted). */
export function partnersQueryString(filters: {
  search?: string;
  status?: string;
  kind?: string;
  page?: number;
  pageSize?: number;
}): string {
  const p = new URLSearchParams();
  if (filters.status) p.set("status", filters.status);
  if (filters.kind) p.set("kind", filters.kind);
  if (filters.search) p.set("search", filters.search);
  if (filters.page) p.set("page", String(filters.page));
  if (filters.pageSize) p.set("pageSize", String(filters.pageSize));
  const qs = p.toString();
  return qs ? `?${qs}` : "";
}

// ==================================================================================================
// Partner Management & Onboarding UX v1
//
// Everything below is PURE (DOM-free, side-effect-free) so it is unit-testable without a browser
// harness, matching the convention established above. The page components stay thin renderers.
//
// SCOPE NOTE: these helpers deliberately model only what the EXISTING partner database can already
// store. `partner_profiles` already has address/telephone/website/email/notes columns and the server
// PATCH route already accepts them — the gap this release closes is that the UI only ever sent
// `trading_name`. Nothing here invents a column, a status, or an audit action that the schema does
// not already permit.
// ==================================================================================================

/** Roles an admin may assign to a partner user. Mirrors USER_ROLES in the detail page. */
export const PARTNER_USER_ROLES = ["OWNER", "ADMIN", "GRADER", "STAFF"] as const;
export type PartnerUserRole = (typeof PARTNER_USER_ROLES)[number];

export function isPartnerUserRole(v: string): v is PartnerUserRole {
  return (PARTNER_USER_ROLES as readonly string[]).includes(v);
}

/**
 * The editable company-profile fields, in display order.
 *
 * `key` matches the server's PROFILE_FIELDS allow-list exactly (server/partner/partner-management-
 * routes.ts extractProfileFields). A key not in that list is silently dropped by the server, so the
 * two lists must not drift — `partner-management-ux.test.ts` asserts they match.
 */
export interface ProfileFieldDef {
  key: string;
  label: string;
  type: "text" | "email" | "tel" | "url" | "textarea";
  max: number;
  hint?: string;
}

export const PROFILE_FIELD_DEFS: readonly ProfileFieldDef[] = [
  { key: "trading_name", label: "Trading name", type: "text", max: 500 },
  { key: "company_number", label: "Company number", type: "text", max: 500 },
  { key: "vat_number", label: "VAT number", type: "text", max: 500 },
  { key: "primary_email", label: "Contact email", type: "email", max: 500 },
  { key: "primary_phone", label: "Telephone", type: "tel", max: 500 },
  { key: "website", label: "Website", type: "url", max: 500 },
  { key: "address_line1", label: "Address line 1", type: "text", max: 500 },
  { key: "address_line2", label: "Address line 2", type: "text", max: 500 },
  { key: "address_city", label: "Town / city", type: "text", max: 500 },
  { key: "address_postcode", label: "Postcode", type: "text", max: 500 },
  { key: "address_country", label: "Country", type: "text", max: 500 },
  {
    key: "health_note",
    label: "Internal notes",
    type: "textarea",
    max: 500,
    hint: "Internal only — never shown to the partner.",
  },
] as const;

export type ProfileValues = Record<string, string>;

/** Build a form state from the server's profile row: every defined field present, null → "". */
export function profileFormFromRow(row: Record<string, unknown> | null | undefined): ProfileValues {
  const out: ProfileValues = {};
  for (const f of PROFILE_FIELD_DEFS) {
    const v = row?.[f.key];
    out[f.key] = typeof v === "string" ? v : "";
  }
  return out;
}

// ---- Validation ----------------------------------------------------------------------------------

/**
 * Pragmatic email shape check: one @, no whitespace, a dot-bearing domain. Deliberately NOT an
 * RFC-5322 regex — over-strict client validation that rejects a deliverable address is a worse
 * failure than letting the server have the final say, and the server re-validates regardless.
 */
export function emailValid(email: string): boolean {
  const t = (email ?? "").trim();
  if (t.length === 0 || t.length > 320) return false;
  if (/\s/.test(t)) return false;
  const parts = t.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (local.length === 0 || domain.length === 0) return false;
  if (!domain.includes(".")) return false;
  if (domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return false;
  return true;
}

/** Website is optional; when present it must be a parseable http(s) URL. */
export function websiteValid(value: string): boolean {
  const t = (value ?? "").trim();
  if (t.length === 0) return true;
  try {
    const u = new URL(t);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Telephone is optional and intentionally permissive: international formats vary wildly and this is
 * an internal record, not a dialling integration. Rejects only what cannot be a phone number at all.
 */
export function telephoneValid(value: string): boolean {
  const t = (value ?? "").trim();
  if (t.length === 0) return true;
  if (t.length > 50) return false;
  if (!/^[0-9+()\-.\s]+$/.test(t)) return false;
  return (t.match(/[0-9]/g) ?? []).length >= 7;
}

/** UK-shaped postcode normalisation for COMPARISON only — never used to reject user input. */
export function normalisePostcode(value: string): string {
  return (value ?? "").toUpperCase().replace(/\s+/g, "");
}

/** Case/space-insensitive key for comparing company names. Comparison only, never stored. */
export function normaliseName(value: string): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Digits-only key for comparing telephone numbers. Comparison only, never stored. */
export function normalisePhone(value: string): string {
  return (value ?? "").replace(/[^0-9]/g, "");
}

export type FieldErrors = Record<string, string>;

/** Validate the company-profile form. Returns {} when the form may be submitted. */
export function validateProfileForm(values: ProfileValues): FieldErrors {
  const errors: FieldErrors = {};
  for (const f of PROFILE_FIELD_DEFS) {
    const raw = values[f.key] ?? "";
    if (raw.trim().length > f.max) {
      errors[f.key] = `${f.label} must be ${f.max} characters or fewer.`;
    }
  }
  if (!errors.primary_email && (values.primary_email ?? "").trim() && !emailValid(values.primary_email)) {
    errors.primary_email = "Enter a valid email address.";
  }
  if (!errors.website && !websiteValid(values.website ?? "")) {
    errors.website = "Enter a full web address starting with http:// or https://.";
  }
  if (!errors.primary_phone && !telephoneValid(values.primary_phone ?? "")) {
    errors.primary_phone = "Enter a valid telephone number.";
  }
  return errors;
}

/** Validate the legal-company-name field (the one field that lives on the organisation, not profile). */
export function validateLegalName(value: string): string | null {
  const t = (value ?? "").trim();
  if (t.length === 0) return "Legal company name is required.";
  if (t.length > 500) return "Legal company name must be 500 characters or fewer.";
  return null;
}

export interface InvitationFormValues {
  firstName: string;
  lastName: string;
  email: string;
  role: string;
}

/** Validate the create/edit-invitation form. Returns {} when it may be submitted. */
export function validateInvitationForm(values: InvitationFormValues): FieldErrors {
  const errors: FieldErrors = {};
  if (!(values.firstName ?? "").trim()) errors.firstName = "First name is required.";
  else if (values.firstName.trim().length > 500) errors.firstName = "First name is too long.";
  if (!(values.lastName ?? "").trim()) errors.lastName = "Last name is required.";
  else if (values.lastName.trim().length > 500) errors.lastName = "Last name is too long.";
  if (!(values.email ?? "").trim()) errors.email = "Email is required.";
  else if (!emailValid(values.email)) errors.email = "Enter a valid email address.";
  if (!isPartnerUserRole(values.role ?? "")) errors.role = "Choose a role.";
  return errors;
}

/** A reason is required on every audited mutation; this is the shared inline-error form of it. */
export function reasonError(reason: string): string | null {
  const t = (reason ?? "").trim();
  if (t.length === 0) return "A reason is required — it is recorded in the audit trail.";
  if (t.length > 2000) return "A reason must be 2000 characters or fewer.";
  return null;
}

/** True when the form may be submitted: no field errors AND a valid reason. */
export function canSubmit(errors: FieldErrors, reason: string, pending: boolean): boolean {
  return !pending && Object.keys(errors).length === 0 && reasonError(reason) === null;
}

// ---- Dirty tracking / before-after diff -----------------------------------------------------------

export interface FieldChange {
  key: string;
  label: string;
  before: string;
  after: string;
}

/**
 * The fields that actually changed, for the confirmation summary and the audit reason context.
 * Trimmed comparison: whitespace-only edits are not changes and must not create an audit row.
 */
export function diffProfile(before: ProfileValues, after: ProfileValues): FieldChange[] {
  const out: FieldChange[] = [];
  for (const f of PROFILE_FIELD_DEFS) {
    const b = (before[f.key] ?? "").trim();
    const a = (after[f.key] ?? "").trim();
    if (b !== a) out.push({ key: f.key, label: f.label, before: b, after: a });
  }
  return out;
}

/** Whether an editor has unsaved edits (drives the navigate-away warning). */
export function isDirty(before: ProfileValues, after: ProfileValues): boolean {
  return diffProfile(before, after).length > 0;
}

/** Human rendering of an empty value in a before/after table. */
export const EMPTY_VALUE_LABEL = "(empty)";
export function displayValue(v: string): string {
  return (v ?? "").trim() === "" ? EMPTY_VALUE_LABEL : v.trim();
}

// ---- Duplicate detection --------------------------------------------------------------------------

export type DuplicateKind = "email" | "legal_name" | "trading_name" | "postcode" | "phone";

export interface DuplicateMatch {
  kind: DuplicateKind;
  partnerId: string;
  partnerName: string;
  value: string;
}

export const DUPLICATE_LABELS: Record<DuplicateKind, string> = {
  email: "the same contact email",
  legal_name: "the same legal company name",
  trading_name: "the same trading name",
  postcode: "the same postcode",
  phone: "the same telephone number",
};

/**
 * Severity split. An email collision on a PARTNER USER is a hard stop — the server enforces it with a
 * unique check inside the invite transaction and will reject the write, so the UI must not present it
 * as an overridable warning. Everything else is a soft warning: two genuine shops can share a postcode
 * (a high street), a phone (a franchise head office) or even a trading name in different regions.
 */
export function isBlockingDuplicate(kind: DuplicateKind): boolean {
  return kind === "email";
}

export function blockingDuplicates(matches: readonly DuplicateMatch[]): DuplicateMatch[] {
  return matches.filter((m) => isBlockingDuplicate(m.kind));
}

export function overridableDuplicates(matches: readonly DuplicateMatch[]): DuplicateMatch[] {
  return matches.filter((m) => !isBlockingDuplicate(m.kind));
}

/** One-line human summary for a duplicate warning banner. */
export function duplicateSummary(m: DuplicateMatch): string {
  return `${m.partnerName} already has ${DUPLICATE_LABELS[m.kind]} (${m.value}).`;
}

/**
 * Creation is permitted when nothing blocks, and every soft warning has been explicitly acknowledged.
 * Acknowledgement is recorded in the create reason so the override is visible in the audit trail.
 */
export function canCreateDespiteDuplicates(
  matches: readonly DuplicateMatch[],
  acknowledged: boolean
): { allowed: boolean; requiresAcknowledgement: boolean } {
  if (blockingDuplicates(matches).length > 0) return { allowed: false, requiresAcknowledgement: false };
  const soft = overridableDuplicates(matches);
  if (soft.length === 0) return { allowed: true, requiresAcknowledgement: false };
  return { allowed: acknowledged, requiresAcknowledgement: true };
}

/** Audit-trail suffix appended to the reason when an admin overrides soft duplicate warnings. */
export function duplicateOverrideNote(matches: readonly DuplicateMatch[]): string {
  const soft = overridableDuplicates(matches);
  if (soft.length === 0) return "";
  const kinds = Array.from(new Set(soft.map((m) => m.kind)))
    .sort()
    .join(", ");
  return ` [duplicate override acknowledged: ${kinds}]`;
}

// ---- Setup checklist ------------------------------------------------------------------------------

export interface ChecklistInput {
  companyCreated: boolean;
  /** An OWNER-role user row exists. NOTE: an INVITED owner has no login yet — see the label. */
  hasOwner: boolean;
  /** An invitation exists AND was not a delivery failure. */
  hasInvitation: boolean;
  locationCount: number;
  hasBranding: boolean;
  hasProfileDetail: boolean;
  ownerMfaConfigured: boolean;
  walletConfigured: boolean;
  creditAvailable: boolean;
  publicListingConfigured: boolean;
  publicProfileConfigured: boolean;
  coordinatesConfigured: boolean;
}

export type ChecklistState = "done" | "todo" | "unavailable";

export interface ChecklistItemView {
  key: string;
  label: string;
  state: ChecklistState;
  hint?: string;
}

/**
 * The setup checklist.
 *
 * HONESTY RULE 1: an item ticks only when the thing it names is actually true. "Owner invited" is
 * not "owner login created" (an INVITED user cannot log in), and "Invitation sent" must not tick for
 * a DELIVERY_FAILED invitation. The caller is responsible for feeding those distinctions in.
 *
 * HONESTY RULE 2: MFA, wallet/credit and public-listing inputs are server-derived from their existing
 * authoritative sources. Device/station and scanner readiness still have no source, so those two
 * items remain unavailable and are excluded from completion. A progress bar that can never complete
 * is a bug, not a motivator; a bar that calls unavailable data complete is worse.
 */
export function computeChecklist(input: ChecklistInput): ChecklistItemView[] {
  const b = (v: boolean): ChecklistState => (v ? "done" : "todo");
  return [
    { key: "company", label: "Company created", state: b(input.companyCreated) },
    { key: "owner", label: "Owner invited", state: b(input.hasOwner) },
    { key: "invitation", label: "Invitation sent", state: b(input.hasInvitation) },
    { key: "location", label: "Grading location", state: b(input.locationCount > 0) },
    { key: "profile", label: "Company profile completed", state: b(input.hasProfileDetail) },
    { key: "branding", label: "Branding configured", state: b(input.hasBranding) },
    { key: "owner-mfa", label: "Owner MFA configured", state: b(input.ownerMfaConfigured) },
    { key: "wallet", label: "Partner wallet opened", state: b(input.walletConfigured) },
    { key: "credits", label: "Grading credits available", state: b(input.creditAvailable) },
    { key: "public-listing", label: "Public listing created", state: b(input.publicListingConfigured) },
    { key: "public-profile", label: "Public profile fields added", state: b(input.publicProfileConfigured) },
    { key: "coordinates", label: "Public map coordinates approved", state: b(input.coordinatesConfigured) },
    { key: "device", label: "Device configured", state: "unavailable", hint: "Device enrolment is not built yet." },
    {
      key: "scanner",
      label: "Scanner readiness",
      state: "unavailable",
      hint: "No tenant-linked scanner telemetry source exists yet.",
    },
  ];
}

/** Percentage complete over the ACHIEVABLE items only. Returns 0-100, integer. */
export function checklistPercent(items: readonly ChecklistItemView[]): number {
  const achievable = items.filter((i) => i.state !== "unavailable");
  if (achievable.length === 0) return 0;
  const done = achievable.filter((i) => i.state === "done").length;
  return Math.round((done / achievable.length) * 100);
}

/** Whether the profile carries enough detail to count as "completed" on the checklist. */
export function profileHasDetail(row: Record<string, unknown> | null | undefined): boolean {
  if (!row) return false;
  const filled = (k: string) => typeof row[k] === "string" && (row[k] as string).trim().length > 0;
  return filled("trading_name") && (filled("primary_email") || filled("primary_phone")) && filled("address_postcode");
}

// ---- Invitation lifecycle -------------------------------------------------------------------------

export const INVITATION_OPEN_STATUSES = ["PENDING", "SENT", "DELIVERY_FAILED"] as const;
export const INVITATION_CLOSED_STATUSES = ["CONSUMED", "REVOKED", "EXPIRED"] as const;

/** An invitation is editable only while it is still open — an accepted one is history, not a draft. */
export function invitationEditable(status: string): boolean {
  return (INVITATION_OPEN_STATUSES as readonly string[]).includes(status);
}

/** A partner user whose invitation has been accepted is managed through role/status, not the invite. */
export function userInvitationReadOnly(userStatus: string): boolean {
  return userStatus !== "INVITED";
}

export interface InvitationActionAvailability {
  canEdit: boolean;
  canResend: boolean;
  canRevoke: boolean;
}

/**
 * Which invitation actions the UI may offer. Availability is advisory — every one of these is
 * re-authorised and re-validated server-side; this only stops the UI offering a button that is
 * guaranteed to fail.
 */
export function invitationActions(userStatus: string, invitationStatus: string | null): InvitationActionAvailability {
  const open = userStatus === "INVITED" && !!invitationStatus && invitationEditable(invitationStatus);
  return { canEdit: open, canResend: open, canRevoke: open };
}

// ---- Submission state (double-submit prevention) ---------------------------------------------------

export type SubmitState = "idle" | "submitting" | "success" | "error";

/** A submit handler must be inert unless idle or previously errored — this is the double-submit gate. */
export function submitAllowed(state: SubmitState): boolean {
  return state === "idle" || state === "error";
}

export function submitLabel(state: SubmitState, idle: string, busy: string): string {
  return state === "submitting" ? busy : idle;
}

// ---- Server error surfacing -------------------------------------------------------------------------

/**
 * Map a server error envelope to something a human can act on. The G5 routers answer
 * `{ error: { code, message } }`; the older partner routers answer `{ error, code }`. Both shapes are
 * handled, and an unrecognised shape yields a generic line rather than "[object Object]".
 */
export function serverErrorMessage(payload: unknown, fallback = "Something went wrong. Nothing was saved."): string {
  const p = payload as { error?: unknown; code?: unknown } | null | undefined;
  if (!p) return fallback;
  const err = p.error;
  if (typeof err === "string" && err.trim()) return friendlyCode(String(p.code ?? "")) ?? err;
  if (err && typeof err === "object") {
    const e = err as { code?: unknown; message?: unknown };
    const friendly = friendlyCode(String(e.code ?? ""));
    if (friendly) return friendly;
    if (typeof e.message === "string" && e.message.trim()) return e.message;
  }
  return fallback;
}

/** Plain-English rewrites of the codes an admin can actually hit. Unknown codes fall through. */
function friendlyCode(code: string): string | null {
  switch (code) {
    case "DUPLICATE_PARTNER_USER":
      return "A partner user with this email address already exists. Use a different address, or find the existing user.";
    case "VERSION_CONFLICT":
      return "Someone else changed this partner while you were editing. Reload the page and reapply your changes.";
    case "INVALID_STATUS_TRANSITION":
      return "That status change is not allowed from the current status.";
    case "PARTNER_UNAVAILABLE":
      return "This partner is suspended or revoked, so it cannot be changed.";
    case "PARTNER_ADMIN_CAPABILITY_UNAVAILABLE":
      return "Partner management is not ready on this environment. This is a deployment problem, not your input.";
    case "RATE_LIMITED":
      return "Too many operations in a short time. Wait a moment and try again.";
    case "VALIDATION_ERROR":
    case "BAD_REQUEST":
      return null;
    default:
      return null;
  }
}

/**
 * Turn the server's invitation `deliveryStatus` into a sentence that does not overstate what
 * happened.
 *
 * The amend/invite endpoints answer HTTP 200 even when no email was sent: `DELIVERY_NOT_CONFIGURED`
 * when no transport is configured, `DELIVERY_FAILED` when the provider threw. Reporting "sent" in
 * either case is the exact silent-failure class this project keeps being bitten by — the operator
 * stops chasing an invitation that does not exist.
 *
 * The revocation half of an amendment is unconditionally true (it commits inside the transaction),
 * so it is stated regardless of delivery.
 */
export function deliveryBanner(deliveryStatus: string | undefined, createdPrefix?: string): string {
  const amending = createdPrefix === undefined;
  const revoked = amending ? " The previous invitation link no longer works." : "";
  const lead = createdPrefix ?? "Invitation updated.";
  switch (deliveryStatus) {
    case "SENT":
      return amending ? `Invitation updated and re-sent.${revoked}` : `${lead} The email has been sent.`;
    case "DELIVERY_FAILED":
      return `${lead} THE EMAIL COULD NOT BE SENT — the recipient has not received a link. Use Resend once the email problem is fixed.${revoked}`;
    case "DELIVERY_NOT_CONFIGURED":
      return `${lead} No email was sent because email delivery is not configured on this environment.${revoked}`;
    default:
      // Unknown/absent status: say what is certain and nothing more.
      return `${lead} Delivery status is unconfirmed — check the invitation status in the table below.${revoked}`;
  }
}
