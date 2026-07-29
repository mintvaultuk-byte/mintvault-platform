/**
 * G5 Super-Admin partner-management — service layer (the only place G5 orchestration lives).
 *
 * Reads: deterministic, bounded, parameterised, secret-free projections via the privileged admin pool
 * (partnerAdminQuery), each scoped by an EXPLICIT WHERE tenant_id = $1 (the admin pool sets no RLS
 * context). Mutations: G5 does its own domain writes (a single atomic UPDATE/INSERT per aggregate),
 * each wrapped in the append-only admin-action audit (attempt row before, terminal row after) with an
 * idempotency-key short-circuit — mirroring the G4 pattern. Versioned aggregates use optimistic
 * locking (WHERE version = $expected). No connector/wallet/slot/billing/grading logic here; no secret
 * is ever read or written; the actor is always server-derived.
 */
import { partnerAdminQuery, withPartnerAdminTransaction } from "./db";
import { G5RequestError, canTransitionStatus, isPartnerStatus, type PartnerStatus } from "./partner-management-errors";
import { hashPassword, MIN_PASSWORD_LEN, MAX_PASSWORD_LEN } from "./auth";
import { deliverInvitationToken, invitationDeliveryConfigured } from "./delivery";
import { APP_BASE_URL } from "../app-url";
import crypto from "node:crypto";

export interface ActorContext {
  actorUserId: string;
  actorEmail: string;
  requestId: string;
  idempotencyKey?: string;
}

type AuditAction =
  | "partner_created"
  | "profile_updated"
  | "status_changed"
  | "contact_added"
  | "contact_updated"
  | "contact_deactivated"
  | "branding_updated"
  | "note_added"
  | "partner_user_invited"
  | "partner_invitation_resent"
  | "partner_invitation_revoked"
  | "partner_invitation_accepted"
  | "partner_user_role_changed"
  | "partner_user_suspended"
  | "partner_user_reactivated"
  | "partner_user_password_reset_initiated"
  | "partner_user_sessions_revoked"
  | "partner_user_membership_removed";

// ---------------------------------------------------------------------------
// Partner + profile lookups (admin pool, explicit tenant scoping).
// ---------------------------------------------------------------------------
interface OrgRow {
  id: string;
  legal_name: string;
  status: string;
  accreditation_level: string;
  health: string;
  created_at: string;
}

async function loadPartner(partnerId: string): Promise<OrgRow> {
  const { rows } = await partnerAdminQuery<OrgRow>(
    `SELECT id, legal_name, status, accreditation_level, health, created_at
       FROM partner_organisations WHERE id = $1`,
    [partnerId]
  );
  if (rows.length === 0) throw new G5RequestError("PARTNER_NOT_FOUND", "Partner organisation not found.");
  return rows[0];
}

/** The partner aggregate version (partner_profiles.version); ensures a profile row exists. */
async function loadOrInitProfileVersion(tenantId: string): Promise<number> {
  const { rows } = await partnerAdminQuery<{ version: number }>(
    `SELECT version FROM partner_profiles WHERE tenant_id = $1`,
    [tenantId]
  );
  if (rows.length > 0) return rows[0].version;
  await partnerAdminQuery(`INSERT INTO partner_profiles (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING`, [
    tenantId,
  ]);
  return 1;
}

// ---------------------------------------------------------------------------
// Append-only audit (partner_management_audit) — attempt row, then terminal row.
// ---------------------------------------------------------------------------
async function recordAttempt(
  actor: ActorContext,
  tenantId: string,
  action: AuditAction,
  entityType: string | null,
  entityId: string | null,
  beforeState: unknown
): Promise<void> {
  await partnerAdminQuery(
    `INSERT INTO partner_management_audit
       (tenant_id, action_type, actor_user_id, actor_email, request_id, idempotency_key, entity_type, entity_id, before_state, reason, result)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'attempted')`,
    [
      tenantId,
      action,
      actor.actorUserId,
      actor.actorEmail,
      actor.requestId,
      actor.idempotencyKey ?? null,
      entityType,
      entityId,
      beforeState == null ? null : JSON.stringify(beforeState),
      "__attempt__",
    ]
  );
}

async function recordTerminal(
  actor: ActorContext,
  tenantId: string,
  action: AuditAction,
  entityType: string | null,
  entityId: string | null,
  afterState: unknown,
  reason: string,
  result: "succeeded" | "failed" | "no_op",
  error?: { code: string; summary: string }
): Promise<void> {
  await partnerAdminQuery(
    `INSERT INTO partner_management_audit
       (tenant_id, action_type, actor_user_id, actor_email, request_id, idempotency_key, entity_type, entity_id, after_state, reason, result, error_code, error_summary)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      tenantId,
      action,
      actor.actorUserId,
      actor.actorEmail,
      actor.requestId,
      actor.idempotencyKey ?? null,
      entityType,
      entityId,
      afterState == null ? null : JSON.stringify(afterState),
      reason,
      result,
      error?.code ?? null,
      error?.summary ?? null,
    ]
  );
}

async function priorSuccess(idempotencyKey: string | undefined): Promise<boolean> {
  if (!idempotencyKey) return false;
  const { rows } = await partnerAdminQuery(
    `SELECT 1 FROM partner_management_audit WHERE idempotency_key = $1 AND result = 'succeeded' LIMIT 1`,
    [idempotencyKey]
  );
  return rows.length > 0;
}

interface DelegateResult<T> {
  result: T;
  entityType: string | null;
  entityId: string | null;
  afterState: unknown;
}

/**
 * Wrap a mutation: idempotency check → attempt row → domain write → terminal row. A pg unique-violation
 * (23505) — the concurrent-idempotency race or a domain uniqueness collision the delegate did not
 * pre-map — is surfaced to the caller; the caller pre-checks so a friendly code is returned first.
 */
async function withAudit<T>(
  actor: ActorContext,
  tenantId: string,
  action: AuditAction,
  reason: string,
  beforeState: unknown,
  delegate: () => Promise<DelegateResult<T>>
): Promise<{ result: T; alreadyCompleted: boolean } | { result: null; alreadyCompleted: true }> {
  if (await priorSuccess(actor.idempotencyKey)) return { result: null, alreadyCompleted: true };
  await recordAttempt(actor, tenantId, action, null, null, beforeState);
  try {
    const d = await delegate();
    await recordTerminal(actor, tenantId, action, d.entityType, d.entityId, d.afterState, reason, "succeeded");
    return { result: d.result, alreadyCompleted: false };
  } catch (err) {
    // Only the AUDIT idempotency-key collision means "another same-key request already recorded
    // success" → an idempotent replay. A domain unique-violation (e.g. uq_partner_contacts_primary)
    // must NOT be swallowed as alreadyCompleted — it falls through to toG5Error which maps it to the
    // friendly DUPLICATE_PRIMARY_CONTACT and records a terminal 'failed' row.
    const pg = err as { code?: string; constraint?: string };
    if (pg?.code === "23505" && pg.constraint === "uq_partner_management_audit_idem" && actor.idempotencyKey) {
      return { result: null, alreadyCompleted: true };
    }
    const { toG5Error } = await import("./partner-management-errors");
    const g5 = toG5Error(err);
    await recordTerminal(actor, tenantId, action, null, null, null, reason, "failed", {
      code: g5.code,
      summary: g5.message,
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// MUTATIONS
// ---------------------------------------------------------------------------
export async function createPartner(
  actor: ActorContext,
  input: { legalName: string; profile?: Record<string, unknown> },
  reason: string
) {
  // Idempotency for create: the org INSERT below has no natural unique key, so a same-key retry would
  // otherwise create a duplicate org before withAudit's own priorSuccess check. Short-circuit here,
  // BEFORE any write, when a prior succeeded action already used this key (create's key namespace is
  // pre-tenant, so this pre-check is global — matching the ledger's global idempotency namespace).
  if (await priorSuccess(actor.idempotencyKey)) return { result: null, alreadyCompleted: true };
  // create the org (super-admin only) then its 1:1 profile
  const org = await partnerAdminQuery<{ id: string }>(
    `INSERT INTO partner_organisations (legal_name, status) VALUES ($1,'PENDING') RETURNING id`,
    [input.legalName]
  );
  const tenantId = org.rows[0].id;
  return withAudit(actor, tenantId, "partner_created", reason, null, async () => {
    await partnerAdminQuery(`INSERT INTO partner_profiles (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING`, [
      tenantId,
    ]);
    return {
      result: { partnerId: tenantId },
      entityType: "partner",
      entityId: tenantId,
      afterState: { status: "PENDING" },
    };
  });
}

const PROFILE_FIELDS = [
  "trading_name",
  "organisation_kind",
  "company_number",
  "vat_number",
  "website",
  "primary_email",
  "primary_phone",
  "address_line1",
  "address_line2",
  "address_city",
  "address_postcode",
  "address_country",
  "onboarding_date",
  "internal_tier",
  "health_note",
] as const;

export async function updateProfile(
  actor: ActorContext,
  partnerId: string,
  fields: Record<string, unknown>,
  expectedVersion: number,
  reason: string
) {
  const org = await loadPartner(partnerId);
  await loadOrInitProfileVersion(org.id);
  return withAudit(actor, org.id, "profile_updated", reason, { fields: Object.keys(fields) }, async () => {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const f of PROFILE_FIELDS) {
      if (f in fields) {
        params.push(fields[f] === "" ? null : fields[f]);
        sets.push(`${f} = $${params.length}`);
      }
    }
    params.push(org.id, expectedVersion);
    const r = await partnerAdminQuery(
      `UPDATE partner_profiles SET ${sets.length ? sets.join(", ") + "," : ""} version = version + 1, updated_at = now()
         WHERE tenant_id = $${params.length - 1} AND version = $${params.length}`,
      params
    );
    if (r.rowCount === 0)
      throw new G5RequestError("VERSION_CONFLICT", "The profile was modified by someone else; reload and retry.");
    return {
      result: { updated: true },
      entityType: "profile",
      entityId: org.id,
      afterState: { fields: Object.keys(fields) },
    };
  });
}

export async function changeStatus(
  actor: ActorContext,
  partnerId: string,
  toStatus: string,
  expectedVersion: number,
  reason: string
) {
  const org = await loadPartner(partnerId);
  if (!isPartnerStatus(toStatus)) throw new G5RequestError("INVALID_PARTNER_STATUS", "Unknown partner status.");
  if (!canTransitionStatus(org.status, toStatus)) {
    throw new G5RequestError("INVALID_STATUS_TRANSITION", `Cannot move a partner from ${org.status} to ${toStatus}.`);
  }
  await loadOrInitProfileVersion(org.id);
  return withAudit(actor, org.id, "status_changed", reason, { from: org.status }, async () => {
    // Bump the aggregate version under optimistic lock AND set the status in ONE data-modifying-CTE
    // statement, so the two writes are atomic (no "version bumped but status unchanged" window) without
    // a transaction helper. If the version no longer matches, the CTE yields no rows and the org UPDATE
    // affects 0 rows → VERSION_CONFLICT. Business-label only — no flags, portal, wallet, slots, users,
    // devices, or sessions are touched.
    const r = await partnerAdminQuery(
      `WITH bumped AS (
         UPDATE partner_profiles SET version = version + 1, updated_at = now()
           WHERE tenant_id = $1 AND version = $2 RETURNING tenant_id
       )
       UPDATE partner_organisations o SET status = $3, updated_at = now()
         FROM bumped WHERE o.id = bumped.tenant_id`,
      [org.id, expectedVersion, toStatus]
    );
    if (r.rowCount === 0)
      throw new G5RequestError("VERSION_CONFLICT", "The partner was modified by someone else; reload and retry.");
    return {
      result: { status: toStatus as PartnerStatus },
      entityType: "partner",
      entityId: org.id,
      afterState: { from: org.status, to: toStatus },
    };
  });
}

export async function addContact(
  actor: ActorContext,
  partnerId: string,
  input: {
    fullName: string;
    contactType: string;
    email: string | null;
    phone: string | null;
    title: string | null;
    isPrimary: boolean;
  },
  reason: string
) {
  const org = await loadPartner(partnerId);
  if (input.isPrimary) {
    const dup = await partnerAdminQuery(
      `SELECT 1 FROM partner_contacts WHERE tenant_id = $1 AND is_primary AND active LIMIT 1`,
      [org.id]
    );
    if (dup.rows.length > 0)
      throw new G5RequestError(
        "DUPLICATE_PRIMARY_CONTACT",
        "An active primary contact already exists for this partner."
      );
  }
  return withAudit(actor, org.id, "contact_added", reason, null, async () => {
    const r = await partnerAdminQuery<{ id: string }>(
      `INSERT INTO partner_contacts (tenant_id, full_name, title, email, phone, contact_type, is_primary, created_by_user_id, created_by_email)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        org.id,
        input.fullName,
        input.title,
        input.email,
        input.phone,
        input.contactType,
        input.isPrimary,
        actor.actorUserId,
        actor.actorEmail,
      ]
    );
    return {
      result: { contactId: r.rows[0].id },
      entityType: "contact",
      entityId: r.rows[0].id,
      afterState: { contactType: input.contactType, isPrimary: input.isPrimary },
    };
  });
}

export async function updateContact(
  actor: ActorContext,
  partnerId: string,
  contactId: string,
  fields: {
    fullName?: string;
    title?: string | null;
    email?: string | null;
    phone?: string | null;
    contactType?: string;
    isPrimary?: boolean;
  },
  expectedVersion: number,
  reason: string
) {
  const org = await loadPartner(partnerId);
  const existing = await partnerAdminQuery<{ id: string; is_primary: boolean }>(
    `SELECT id, is_primary FROM partner_contacts WHERE id = $1 AND tenant_id = $2`,
    [contactId, org.id]
  );
  if (existing.rows.length === 0) throw new G5RequestError("CONTACT_NOT_FOUND", "Contact not found for this partner.");
  if (fields.isPrimary === true && !existing.rows[0].is_primary) {
    const dup = await partnerAdminQuery(
      `SELECT 1 FROM partner_contacts WHERE tenant_id = $1 AND is_primary AND active AND id <> $2 LIMIT 1`,
      [org.id, contactId]
    );
    if (dup.rows.length > 0)
      throw new G5RequestError(
        "DUPLICATE_PRIMARY_CONTACT",
        "An active primary contact already exists for this partner."
      );
  }
  return withAudit(actor, org.id, "contact_updated", reason, null, async () => {
    const map: Record<string, unknown> = {};
    if (fields.fullName !== undefined) map.full_name = fields.fullName;
    if (fields.title !== undefined) map.title = fields.title;
    if (fields.email !== undefined) map.email = fields.email;
    if (fields.phone !== undefined) map.phone = fields.phone;
    if (fields.contactType !== undefined) map.contact_type = fields.contactType;
    if (fields.isPrimary !== undefined) map.is_primary = fields.isPrimary;
    const cols = Object.keys(map);
    const params: unknown[] = cols.map((c) => map[c]);
    const sets = cols.map((c, i) => `${c} = $${i + 1}`);
    params.push(contactId, org.id, expectedVersion);
    const r = await partnerAdminQuery(
      `UPDATE partner_contacts SET ${sets.length ? sets.join(", ") + "," : ""} version = version + 1, updated_at = now()
         WHERE id = $${params.length - 2} AND tenant_id = $${params.length - 1} AND version = $${params.length}`,
      params
    );
    if (r.rowCount === 0)
      throw new G5RequestError("VERSION_CONFLICT", "The contact was modified by someone else; reload and retry.");
    return { result: { updated: true }, entityType: "contact", entityId: contactId, afterState: { fields: cols } };
  });
}

export async function deactivateContact(actor: ActorContext, partnerId: string, contactId: string, reason: string) {
  const org = await loadPartner(partnerId);
  const existing = await partnerAdminQuery(`SELECT 1 FROM partner_contacts WHERE id = $1 AND tenant_id = $2`, [
    contactId,
    org.id,
  ]);
  if (existing.rows.length === 0) throw new G5RequestError("CONTACT_NOT_FOUND", "Contact not found for this partner.");
  return withAudit(actor, org.id, "contact_deactivated", reason, null, async () => {
    // soft deactivation (never DELETE) — clears the primary flag so a new primary can be set.
    await partnerAdminQuery(
      `UPDATE partner_contacts SET active = false, is_primary = false, version = version + 1, updated_at = now() WHERE id = $1 AND tenant_id = $2`,
      [contactId, org.id]
    );
    return { result: { deactivated: true }, entityType: "contact", entityId: contactId, afterState: { active: false } };
  });
}

export async function upsertBranding(
  actor: ActorContext,
  partnerId: string,
  fields: Record<string, unknown>,
  expectedVersion: number | null,
  reason: string
) {
  const org = await loadPartner(partnerId);
  const BRANDING_FIELDS = [
    "display_name",
    "logo_r2_key",
    "primary_colour",
    "secondary_colour",
    "accent_colour",
    "support_email",
    "support_website",
    "custom_domain",
    "branding_status",
  ];
  return withAudit(actor, org.id, "branding_updated", reason, null, async () => {
    const existing = await partnerAdminQuery<{ version: number }>(
      `SELECT version FROM partner_branding WHERE tenant_id = $1`,
      [org.id]
    );
    if (existing.rows.length === 0) {
      const cols = BRANDING_FIELDS.filter((f) => f in fields);
      const vals = cols.map((c) => (fields[c] === "" ? null : fields[c]));
      const placeholders = cols.map((_, i) => `$${i + 2}`);
      await partnerAdminQuery(
        `INSERT INTO partner_branding (tenant_id${cols.length ? ", " + cols.join(", ") : ""}) VALUES ($1${placeholders.length ? ", " + placeholders.join(", ") : ""})`,
        [org.id, ...vals]
      );
      return { result: { ok: true as const }, entityType: "branding", entityId: org.id, afterState: { fields: cols } };
    }
    if (expectedVersion !== null && existing.rows[0].version !== expectedVersion) {
      throw new G5RequestError("VERSION_CONFLICT", "The branding was modified by someone else; reload and retry.");
    }
    const cols = BRANDING_FIELDS.filter((f) => f in fields);
    const params: unknown[] = cols.map((c) => (fields[c] === "" ? null : fields[c]));
    const sets = cols.map((c, i) => `${c} = $${i + 1}`);
    params.push(org.id, existing.rows[0].version);
    const r = await partnerAdminQuery(
      `UPDATE partner_branding SET ${sets.length ? sets.join(", ") + "," : ""} version = version + 1, updated_at = now()
         WHERE tenant_id = $${params.length - 1} AND version = $${params.length}`,
      params
    );
    if (r.rowCount === 0)
      throw new G5RequestError("VERSION_CONFLICT", "The branding was modified by someone else; reload and retry.");
    return { result: { ok: true as const }, entityType: "branding", entityId: org.id, afterState: { fields: cols } };
  });
}

export async function addNote(
  actor: ActorContext,
  partnerId: string,
  body: string,
  supersedesNoteId: string | null,
  reason: string
) {
  const org = await loadPartner(partnerId);
  return withAudit(actor, org.id, "note_added", reason, null, async () => {
    const r = await partnerAdminQuery<{ id: string }>(
      `INSERT INTO partner_internal_notes (tenant_id, body, author_user_id, author_email, supersedes_note_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [org.id, body, actor.actorUserId, actor.actorEmail, supersedesNoteId]
    );
    return { result: { noteId: r.rows[0].id }, entityType: "note", entityId: r.rows[0].id, afterState: null };
  });
}

// ---------------------------------------------------------------------------
// Partner user management + invitations
// ---------------------------------------------------------------------------
export const ADMIN_ROLE_TO_PARTNER_ROLE = {
  OWNER: "PARTNER_OWNER",
  ADMIN: "PARTNER_MANAGER",
  GRADER: "MVGS_ASSESSMENT_TECHNICIAN",
  STAFF: "PARTNER_RECEPTION",
} as const;
export type AdminPartnerRole = keyof typeof ADMIN_ROLE_TO_PARTNER_ROLE;

const PARTNER_ROLE_TO_ADMIN_ROLE: Record<string, AdminPartnerRole> = {
  PARTNER_OWNER: "OWNER",
  PARTNER_MANAGER: "ADMIN",
  MVGS_ASSESSMENT_TECHNICIAN: "GRADER",
  PARTNER_RECEPTION: "STAFF",
};
const ADMIN_ROLE_PRECEDENCE = [
  "PARTNER_OWNER",
  "PARTNER_MANAGER",
  "MVGS_ASSESSMENT_TECHNICIAN",
  "PARTNER_RECEPTION",
] as const;

export function isAdminPartnerRole(raw: unknown): raw is AdminPartnerRole {
  return typeof raw === "string" && Object.prototype.hasOwnProperty.call(ADMIN_ROLE_TO_PARTNER_ROLE, raw);
}

function displayAdminRole(roleCodes: string[]): AdminPartnerRole | string {
  for (const code of ADMIN_ROLE_PRECEDENCE) {
    if (roleCodes.includes(code)) return PARTNER_ROLE_TO_ADMIN_ROLE[code];
  }
  return roleCodes[0] ?? "UNASSIGNED";
}

const INVITE_HOURS = 72;

function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function inviteLink(token: string): string {
  return `${APP_BASE_URL}/partner/invite?token=${encodeURIComponent(token)}`;
}

async function roleIdFor(code: string): Promise<string> {
  const { rows } = await partnerAdminQuery<{ id: string }>("SELECT id FROM partner_roles WHERE code=$1", [code]);
  if (rows.length !== 1) throw new G5RequestError("PARTNER_ROLE_NOT_CONFIGURED", "Partner role is not configured.");
  return rows[0].id;
}

async function activeOwnerCount(tenantId: string, exceptUserId?: string): Promise<number> {
  const { rows } = await partnerAdminQuery<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM partner_users u
       JOIN partner_user_roles ur ON ur.user_id = u.id
       JOIN partner_roles r ON r.id = ur.role_id
      WHERE u.tenant_id = $1
        AND u.status = 'ACTIVE'
        AND r.code = 'PARTNER_OWNER'
        AND ($2::uuid IS NULL OR u.id <> $2::uuid)`,
    [tenantId, exceptUserId ?? null]
  );
  return rows[0]?.n ?? 0;
}

async function ensureCanRemoveOwner(tenantId: string, userId: string): Promise<void> {
  const { rows } = await partnerAdminQuery<{ is_owner: boolean; status: string }>(
    `SELECT u.status, EXISTS (
       SELECT 1 FROM partner_user_roles ur JOIN partner_roles r ON r.id = ur.role_id
        WHERE ur.user_id = u.id AND r.code = 'PARTNER_OWNER'
     ) AS is_owner
       FROM partner_users u WHERE u.tenant_id=$1 AND u.id=$2`,
    [tenantId, userId]
  );
  if (rows.length !== 1) throw new G5RequestError("PARTNER_USER_NOT_FOUND", "Partner user not found.");
  if (rows[0].status === "ACTIVE" && rows[0].is_owner && (await activeOwnerCount(tenantId, userId)) === 0) {
    throw new G5RequestError("FINAL_OWNER_REQUIRED", "A partner must keep at least one active owner.");
  }
}

async function createInvitationRecord(
  actor: ActorContext,
  tenantId: string,
  userId: string,
  email: string,
  roleCode: string,
  action: AuditAction,
  reason: string
): Promise<{ invitationId: string; deliveryStatus: string; invitationLink?: string }> {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITE_HOURS * 60 * 60 * 1000);
  const previous = await partnerAdminQuery<{ id: string }>(
    `UPDATE partner_invitations
        SET status='REVOKED', revoked_at=now(), updated_at=now()
      WHERE tenant_id=$1 AND user_id=$2 AND status IN ('PENDING','SENT','DELIVERY_FAILED')
      RETURNING id`,
    [tenantId, userId]
  );
  const { rows } = await partnerAdminQuery<{ id: string; partner_name: string }>(
    `WITH ins AS (
       INSERT INTO partner_invitations
         (tenant_id, user_id, email, role_code, token_hash, invited_by_user_id, invited_by_email, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id
     )
     SELECT ins.id, o.legal_name AS partner_name FROM ins, partner_organisations o WHERE o.id=$1`,
    [tenantId, userId, email, roleCode, sha256(token), actor.actorUserId, actor.actorEmail, expiresAt]
  );
  if (previous.rows.length > 0) {
    await partnerAdminQuery("UPDATE partner_invitations SET superseded_by=$1 WHERE id = ANY($2::uuid[])", [
      rows[0].id,
      previous.rows.map((r) => r.id),
    ]);
  }
  let deliveryStatus = "DELIVERY_NOT_CONFIGURED";
  if (invitationDeliveryConfigured()) {
    try {
      await deliverInvitationToken({ email, token, partnerName: rows[0].partner_name, roleCode, expiresAt });
      await partnerAdminQuery(
        "UPDATE partner_invitations SET status='SENT', delivered_at=now(), delivery_error=NULL, updated_at=now() WHERE id=$1",
        [rows[0].id]
      );
      deliveryStatus = "SENT";
    } catch (err) {
      await partnerAdminQuery(
        "UPDATE partner_invitations SET status='DELIVERY_FAILED', delivery_error=$2, updated_at=now() WHERE id=$1",
        [rows[0].id, (err as Error).message.slice(0, 500)]
      );
      deliveryStatus = "DELIVERY_FAILED";
    }
  }
  await recordTerminal(
    actor,
    tenantId,
    action,
    "partner_user",
    userId,
    { invitationId: rows[0].id, roleCode, deliveryStatus },
    reason,
    "succeeded"
  );
  return {
    invitationId: rows[0].id,
    deliveryStatus,
    invitationLink: process.env.PARTNER_INVITE_ALLOW_ADMIN_LINK_COPY === "true" ? inviteLink(token) : undefined,
  };
}

export async function invitePartnerUser(
  actor: ActorContext,
  partnerId: string,
  input: { firstName: string; lastName: string; email: string; role: AdminPartnerRole },
  reason: string
) {
  const org = await loadPartner(partnerId);
  if (org.status === "SUSPENDED" || org.status === "REVOKED") {
    throw new G5RequestError("PARTNER_UNAVAILABLE", "Partner is not available for invitations.");
  }
  const email = normaliseEmail(input.email);
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  if (!firstName || !lastName || !email) throw new G5RequestError("VALIDATION_ERROR", "Name and email are required.");
  const roleCode = ADMIN_ROLE_TO_PARTNER_ROLE[input.role];
  if (
    (await partnerAdminQuery("SELECT 1 FROM partner_users WHERE lower(email)=lower($1) LIMIT 1", [email])).rows.length
  ) {
    throw new G5RequestError("DUPLICATE_PARTNER_USER", "A partner user with this email already exists.");
  }
  await recordAttempt(actor, org.id, "partner_user_invited", "partner_user", null, { email, roleCode });
  const user = await partnerAdminQuery<{ id: string }>(
    `INSERT INTO partner_users (tenant_id, partner_id, email, first_name, last_name, status, created_by)
     VALUES ($1,$1,$2,$3,$4,'INVITED',$5) RETURNING id`,
    [org.id, email, firstName, lastName, actor.actorUserId]
  );
  await partnerAdminQuery("INSERT INTO partner_user_roles (tenant_id, user_id, role_id) VALUES ($1,$2,$3)", [
    org.id,
    user.rows[0].id,
    await roleIdFor(roleCode),
  ]);
  const invite = await createInvitationRecord(
    actor,
    org.id,
    user.rows[0].id,
    email,
    roleCode,
    "partner_user_invited",
    reason
  );
  return { result: { userId: user.rows[0].id, ...invite }, alreadyCompleted: false };
}

export async function listPartnerUsers(partnerId: string) {
  const org = await loadPartner(partnerId);
  const { rows } = await partnerAdminQuery(
    `SELECT u.id, u.first_name, u.last_name, u.email, u.status, u.last_login_at, u.created_at,
            COALESCE(json_agg(r.code ORDER BY r.code) FILTER (WHERE r.code IS NOT NULL), '[]') AS role_codes,
            li.status AS invitation_status, li.expires_at AS invitation_expires_at, li.delivered_at AS invitation_delivered_at
       FROM partner_users u
       LEFT JOIN partner_user_roles ur ON ur.user_id = u.id
       LEFT JOIN partner_roles r ON r.id = ur.role_id
       LEFT JOIN LATERAL (
         SELECT status, expires_at, delivered_at FROM partner_invitations i
          WHERE i.tenant_id = u.tenant_id AND i.user_id = u.id
          ORDER BY i.created_at DESC LIMIT 1
       ) li ON true
      WHERE u.tenant_id = $1
      GROUP BY u.id, li.status, li.expires_at, li.delivered_at
      ORDER BY u.created_at DESC, u.email ASC
      LIMIT 500`,
    [org.id]
  );
  return {
    users: rows.map((u: any) => ({
      ...u,
      role: displayAdminRole(u.role_codes ?? []),
      role_codes: undefined,
    })),
  };
}

export async function resendPartnerInvitation(actor: ActorContext, partnerId: string, userId: string, reason: string) {
  const org = await loadPartner(partnerId);
  const { rows } = await partnerAdminQuery<{ email: string; role_code: string; status: string }>(
    `SELECT u.email, r.code AS role_code, u.status
       FROM partner_users u
       JOIN partner_user_roles ur ON ur.user_id = u.id
       JOIN partner_roles r ON r.id = ur.role_id
      WHERE u.tenant_id=$1 AND u.id=$2
      ORDER BY r.code LIMIT 1`,
    [org.id, userId]
  );
  if (rows.length !== 1) throw new G5RequestError("PARTNER_USER_NOT_FOUND", "Partner user not found.");
  if (org.status === "SUSPENDED" || org.status === "REVOKED" || rows[0].status !== "INVITED") {
    throw new G5RequestError("PARTNER_UNAVAILABLE", "Setup invitations are only available for invited accounts.");
  }
  await recordAttempt(actor, org.id, "partner_invitation_resent", "partner_user", userId, { email: rows[0].email });
  const invite = await createInvitationRecord(
    actor,
    org.id,
    userId,
    rows[0].email,
    rows[0].role_code,
    "partner_invitation_resent",
    reason
  );
  return { result: invite, alreadyCompleted: false };
}

export async function revokePartnerInvitation(actor: ActorContext, partnerId: string, userId: string, reason: string) {
  const org = await loadPartner(partnerId);
  return withAudit(actor, org.id, "partner_invitation_revoked", reason, { userId }, async () => {
    const exists = await partnerAdminQuery("SELECT 1 FROM partner_users WHERE tenant_id=$1 AND id=$2", [
      org.id,
      userId,
    ]);
    if (exists.rows.length !== 1) throw new G5RequestError("PARTNER_USER_NOT_FOUND", "Partner user not found.");
    const r = await partnerAdminQuery(
      `UPDATE partner_invitations
          SET status='REVOKED', revoked_at=now(), updated_at=now()
        WHERE tenant_id=$1 AND user_id=$2 AND status IN ('PENDING','SENT','DELIVERY_FAILED')`,
      [org.id, userId]
    );
    return {
      result: { revoked: r.rowCount ?? 0 },
      entityType: "partner_user",
      entityId: userId,
      afterState: { revokedInvitations: r.rowCount ?? 0 },
    };
  });
}

export async function changePartnerUserRole(
  actor: ActorContext,
  partnerId: string,
  userId: string,
  role: AdminPartnerRole,
  reason: string
) {
  const org = await loadPartner(partnerId);
  const roleCode = ADMIN_ROLE_TO_PARTNER_ROLE[role];
  return withPartnerAdminTransaction(async (client) => {
    const exists = await client.query("SELECT 1 FROM partner_users WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
      org.id,
      userId,
    ]);
    if (exists.rows.length !== 1) throw new G5RequestError("PARTNER_USER_NOT_FOUND", "Partner user not found.");
    if (roleCode !== "PARTNER_OWNER") {
      const ownerCheck = await client.query<{ blocked: boolean }>(
        `SELECT (
           u.status='ACTIVE'
           AND EXISTS (
             SELECT 1 FROM partner_user_roles ur JOIN partner_roles r ON r.id = ur.role_id
              WHERE ur.user_id = u.id AND r.code = 'PARTNER_OWNER'
           )
           AND NOT EXISTS (
             SELECT 1 FROM partner_users other
              JOIN partner_user_roles our ON our.user_id = other.id
              JOIN partner_roles rr ON rr.id = our.role_id
             WHERE other.tenant_id=$1 AND other.id<>$2 AND other.status='ACTIVE' AND rr.code='PARTNER_OWNER'
           )
         ) AS blocked
          FROM partner_users u WHERE u.tenant_id=$1 AND u.id=$2`,
        [org.id, userId]
      );
      if (ownerCheck.rows[0]?.blocked) {
        throw new G5RequestError("FINAL_OWNER_REQUIRED", "A partner must keep at least one active owner.");
      }
    }
    const roleRow = await client.query<{ id: string }>("SELECT id FROM partner_roles WHERE code=$1", [roleCode]);
    if (roleRow.rows.length !== 1) {
      throw new G5RequestError("PARTNER_ROLE_NOT_CONFIGURED", "Partner role is not configured.");
    }
    await client.query("DELETE FROM partner_user_roles WHERE tenant_id=$1 AND user_id=$2", [org.id, userId]);
    await client.query("INSERT INTO partner_user_roles (tenant_id, user_id, role_id) VALUES ($1,$2,$3)", [
      org.id,
      userId,
      roleRow.rows[0].id,
    ]);
    await client.query(
      "UPDATE partner_users SET credential_version=credential_version+1, updated_at=now() WHERE id=$1",
      [userId]
    );
    await client.query(
      "UPDATE partner_sessions SET revoked_at=now() WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL",
      [org.id, userId]
    );
    await client.query(
      `INSERT INTO partner_management_audit
         (tenant_id, action_type, actor_user_id, actor_email, request_id, entity_type, entity_id, after_state, reason, result)
       VALUES ($1,'partner_user_role_changed',$2,$3,$4,'partner_user',$5,$6,$7,'succeeded')`,
      [org.id, actor.actorUserId, actor.actorEmail, actor.requestId, userId, JSON.stringify({ roleCode }), reason]
    );
    return { result: { ok: true }, alreadyCompleted: false };
  });
}

export async function setPartnerUserStatus(
  actor: ActorContext,
  partnerId: string,
  userId: string,
  status: "ACTIVE" | "SUSPENDED" | "REVOKED",
  reason: string
) {
  const org = await loadPartner(partnerId);
  const current = await partnerAdminQuery<{ status: string }>(
    "SELECT status FROM partner_users WHERE tenant_id=$1 AND id=$2",
    [org.id, userId]
  );
  if (current.rows.length !== 1) throw new G5RequestError("PARTNER_USER_NOT_FOUND", "Partner user not found.");
  const from = current.rows[0].status;
  const allowed =
    from === status ||
    (from === "INVITED" && status === "REVOKED") ||
    (from === "ACTIVE" && (status === "SUSPENDED" || status === "REVOKED")) ||
    (from === "SUSPENDED" && (status === "ACTIVE" || status === "REVOKED"));
  if (!allowed || from === "REVOKED") {
    throw new G5RequestError("INVALID_STATUS_TRANSITION", "Team member status transition is not allowed.");
  }
  if (status !== "ACTIVE") await ensureCanRemoveOwner(org.id, userId);
  const action: AuditAction =
    status === "ACTIVE"
      ? "partner_user_reactivated"
      : status === "SUSPENDED"
        ? "partner_user_suspended"
        : "partner_user_membership_removed";
  return withAudit(actor, org.id, action, reason, { userId, status }, async () => {
    const r = await partnerAdminQuery(
      `UPDATE partner_users
          SET status=$3, credential_version=credential_version+1, updated_at=now()
        WHERE tenant_id=$1 AND id=$2`,
      [org.id, userId, status]
    );
    if (r.rowCount !== 1) throw new G5RequestError("PARTNER_USER_NOT_FOUND", "Partner user not found.");
    await partnerAdminQuery(
      "UPDATE partner_sessions SET revoked_at=now() WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL",
      [org.id, userId]
    );
    return { result: { ok: true }, entityType: "partner_user", entityId: userId, afterState: { status } };
  });
}

export async function revokePartnerUserSessions(
  actor: ActorContext,
  partnerId: string,
  userId: string,
  reason: string
) {
  const org = await loadPartner(partnerId);
  return withAudit(actor, org.id, "partner_user_sessions_revoked", reason, { userId }, async () => {
    const exists = await partnerAdminQuery("SELECT 1 FROM partner_users WHERE tenant_id=$1 AND id=$2", [
      org.id,
      userId,
    ]);
    if (exists.rows.length !== 1) throw new G5RequestError("PARTNER_USER_NOT_FOUND", "Partner user not found.");
    const r = await partnerAdminQuery(
      "UPDATE partner_sessions SET revoked_at=now() WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL",
      [org.id, userId]
    );
    return {
      result: { revoked: r.rowCount ?? 0 },
      entityType: "partner_user",
      entityId: userId,
      afterState: { revoked: r.rowCount ?? 0 },
    };
  });
}

export async function acceptPartnerInvitation(token: string, password: string) {
  if (
    typeof token !== "string" ||
    token.length < 20 ||
    typeof password !== "string" ||
    password.length < MIN_PASSWORD_LEN ||
    password.length > MAX_PASSWORD_LEN
  ) {
    return { ok: false as const, reason: "invalid" as const };
  }
  const tokenHash = sha256(token);
  const pwHash = await hashPassword(password);
  return withPartnerAdminTransaction(async (client) => {
    const { rows } = await client.query<{
      id: string;
      tenant_id: string;
      user_id: string;
      email: string;
      role_code: string;
      status: string;
      expires_at: string;
      user_status: string;
      org_status: string;
    }>(
      `SELECT i.id, i.tenant_id, i.user_id, i.email, i.role_code, i.status, i.expires_at,
              u.status AS user_status, o.status AS org_status
         FROM partner_invitations i
         JOIN partner_users u ON u.id = i.user_id AND u.tenant_id = i.tenant_id
         JOIN partner_organisations o ON o.id = i.tenant_id
        WHERE i.token_hash = $1
        FOR UPDATE OF i, u`,
      [tokenHash]
    );
    if (rows.length !== 1) return { ok: false as const, reason: "invalid" as const };
    const inv = rows[0];
    if (
      !["PENDING", "SENT", "DELIVERY_FAILED"].includes(inv.status) ||
      inv.user_status !== "INVITED" ||
      inv.org_status === "SUSPENDED" ||
      inv.org_status === "REVOKED" ||
      new Date(inv.expires_at).getTime() <= Date.now()
    ) {
      if (new Date(inv.expires_at).getTime() <= Date.now() && inv.status !== "EXPIRED") {
        await client.query("UPDATE partner_invitations SET status='EXPIRED', updated_at=now() WHERE id=$1", [inv.id]);
      }
      return { ok: false as const, reason: "invalid" as const };
    }
    await client.query(
      `UPDATE partner_users
          SET password_hash=$2, status='ACTIVE', failed_login_count=0, locked_until=NULL,
              credential_version=credential_version+1, updated_at=now()
        WHERE id=$1 AND tenant_id=$3`,
      [inv.user_id, pwHash, inv.tenant_id]
    );
    await client.query(
      `UPDATE partner_invitations
          SET status='REVOKED', revoked_at=now(), updated_at=now()
        WHERE tenant_id=$1 AND user_id=$2 AND id<>$3 AND status IN ('PENDING','SENT','DELIVERY_FAILED')`,
      [inv.tenant_id, inv.user_id, inv.id]
    );
    await client.query(
      "UPDATE partner_invitations SET status='CONSUMED', consumed_at=now(), updated_at=now() WHERE id=$1",
      [inv.id]
    );
    await client.query(
      `INSERT INTO partner_management_audit
         (tenant_id, action_type, actor_user_id, actor_email, request_id, entity_type, entity_id, after_state, reason, result)
       VALUES ($1,'partner_invitation_accepted',$2,$3,$4,'partner_user',$5,$6,'invitation accepted','succeeded')`,
      [
        inv.tenant_id,
        inv.user_id,
        inv.email,
        `partner-invite-${Date.now()}`,
        inv.user_id,
        JSON.stringify({ invitationId: inv.id, roleCode: inv.role_code }),
      ]
    );
    return { ok: true as const, email: inv.email };
  });
}

// ---------------------------------------------------------------------------
// READS (deterministic, bounded, secret-free)
// ---------------------------------------------------------------------------
export async function listPartners(
  filters: { search?: string; status?: string; kind?: string },
  offset: number,
  limit: number
) {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, val: unknown) => {
    params.push(val);
    clauses.push(sql.replace("$?", `$${params.length}`));
  };
  if (filters.status) add("o.status = $?", filters.status);
  if (filters.kind) add("p.organisation_kind = $?", filters.kind);
  if (filters.search) {
    params.push(`%${filters.search}%`);
    const p = `$${params.length}`;
    clauses.push(`(o.legal_name ILIKE ${p} OR p.trading_name ILIKE ${p} OR p.primary_email ILIKE ${p})`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(limit, offset);
  const { rows } = await partnerAdminQuery(
    `SELECT o.id, o.legal_name, o.status, o.accreditation_level, o.health, o.created_at,
            p.trading_name, p.organisation_kind, p.primary_email,
            (SELECT full_name FROM partner_contacts c WHERE c.tenant_id = o.id AND c.is_primary AND c.active LIMIT 1) AS primary_contact_name,
            (SELECT count(*)::int FROM partner_locations l WHERE l.tenant_id = o.id) AS location_count,
            (SELECT count(*)::int FROM partner_users u WHERE u.tenant_id = o.id) AS user_count,
            (SELECT count(*)::int FROM partner_connector_records r WHERE r.tenant_id = o.id) AS connector_total,
            (SELECT max(r.updated_at) FROM partner_connector_records r WHERE r.tenant_id = o.id) AS last_connector_activity
       FROM partner_organisations o
       LEFT JOIN partner_profiles p ON p.tenant_id = o.id
       ${where}
      ORDER BY o.created_at DESC, o.id ASC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const countParams = params.slice(0, params.length - 2);
  const total = await partnerAdminQuery<{ n: number }>(
    `SELECT count(*)::int AS n FROM partner_organisations o LEFT JOIN partner_profiles p ON p.tenant_id = o.id ${where}`,
    countParams
  );
  return { rows, total: total.rows[0].n };
}

export async function getPartnerDetail(partnerId: string) {
  const org = await loadPartner(partnerId);
  const profile = await partnerAdminQuery(`SELECT * FROM partner_profiles WHERE tenant_id = $1`, [org.id]);
  const primaryContact = await partnerAdminQuery(
    `SELECT id, full_name, title, email, phone, contact_type FROM partner_contacts WHERE tenant_id = $1 AND is_primary AND active LIMIT 1`,
    [org.id]
  );
  return { organisation: org, profile: profile.rows[0] ?? null, primaryContact: primaryContact.rows[0] ?? null };
}

export async function listContacts(partnerId: string) {
  const org = await loadPartner(partnerId);
  const { rows } = await partnerAdminQuery(
    `SELECT id, full_name, title, email, phone, contact_type, is_primary, active, version, created_at, updated_at
       FROM partner_contacts WHERE tenant_id = $1 ORDER BY is_primary DESC, active DESC, full_name ASC, id ASC
      LIMIT 500`,
    [org.id]
  );
  return { contacts: rows };
}

export async function getBranding(partnerId: string) {
  const org = await loadPartner(partnerId);
  const { rows } = await partnerAdminQuery(`SELECT * FROM partner_branding WHERE tenant_id = $1`, [org.id]);
  return { branding: rows[0] ?? null };
}

export async function listNotes(partnerId: string, offset: number, limit: number) {
  const org = await loadPartner(partnerId);
  const { rows } = await partnerAdminQuery(
    `SELECT id, body, author_email, supersedes_note_id, created_at FROM partner_internal_notes
       WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
    [org.id, limit, offset]
  );
  return { notes: rows };
}

export async function getActivity(partnerId: string, offset: number, limit: number) {
  const org = await loadPartner(partnerId);
  const { rows } = await partnerAdminQuery(
    `SELECT * FROM (
        SELECT created_at, 'audit'::text AS source, action AS kind, reason AS detail FROM partner_audit_events WHERE tenant_id = $1
        UNION ALL
        SELECT created_at, 'security'::text AS source, kind AS kind, NULL::text AS detail FROM partner_security_events WHERE tenant_id = $1
        UNION ALL
        SELECT created_at, 'management'::text AS source, action_type AS kind, reason AS detail FROM partner_management_audit WHERE tenant_id = $1 AND result = 'succeeded'
     ) feed
     ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [org.id, limit, offset]
  );
  return { activity: rows };
}

export async function getStatistics(partnerId: string) {
  const org = await loadPartner(partnerId);
  const counts = await partnerAdminQuery<{ locations: number; users: number; submissions: number }>(
    `SELECT
        (SELECT count(*)::int FROM partner_locations WHERE tenant_id = $1) AS locations,
        (SELECT count(*)::int FROM partner_users WHERE tenant_id = $1) AS users,
        (SELECT count(*)::int FROM partner_submissions WHERE tenant_id = $1) AS submissions`,
    [org.id]
  );
  const byState = await partnerAdminQuery<{ state: string; n: number }>(
    `SELECT state, count(*)::int AS n FROM partner_connector_records WHERE tenant_id = $1 GROUP BY state`,
    [org.id]
  );
  const last = await partnerAdminQuery<{ last: string | null }>(
    `SELECT max(updated_at) AS last FROM partner_connector_records WHERE tenant_id = $1`,
    [org.id]
  );
  const connectorCountsByState: Record<string, number> = {};
  for (const r of byState.rows) connectorCountsByState[r.state] = r.n;
  return {
    locationCount: counts.rows[0].locations,
    userCount: counts.rows[0].users,
    submissionCount: counts.rows[0].submissions,
    connectorCountsByState,
    lastConnectorActivityAt: last.rows[0].last,
    // No tenant-linked source for MintVault certificates/grading (Phase-1 rule) — explicitly unavailable.
    certificatesCount: null,
    gradedCount: null,
    unavailable: ["certificatesCount", "gradedCount"],
  };
}

export async function getPartnerAudit(partnerId: string, offset: number, limit: number) {
  const org = await loadPartner(partnerId);
  const { rows } = await partnerAdminQuery(
    `SELECT id, action_type, actor_email, request_id, entity_type, entity_id, reason, result, error_code, created_at
       FROM partner_management_audit WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
    [org.id, limit, offset]
  );
  return { audit: rows };
}
