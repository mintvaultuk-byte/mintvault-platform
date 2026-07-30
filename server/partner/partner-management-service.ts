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
import type { PoolClient } from "pg";
import crypto from "node:crypto";

export interface ActorContext {
  actorUserId: string;
  actorEmail: string;
  requestId: string;
  idempotencyKey?: string;
}

type CreatePartnerFailurePoint = "after_org_insert" | "after_default_location_insert";
type InvitePartnerFailurePoint =
  | "after_user_insert"
  | "after_role_assignment"
  | "before_invitation_insert"
  | "before_invitation_audit";

interface InviteBarrier {
  point: "after_duplicate_check";
  parties: number;
  arrived: number;
  waiters: Array<() => void>;
}

interface AcceptBarrier {
  point: "before_invitation_lock";
  parties: number;
  arrived: number;
  waiters: Array<() => void>;
}

let createPartnerFailurePointForTest: CreatePartnerFailurePoint | null = null;
let invitePartnerFailurePointForTest: InvitePartnerFailurePoint | null = null;
let inviteBarrierForTest: InviteBarrier | null = null;
let acceptBarrierForTest: AcceptBarrier | null = null;

function testHooksAllowed(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return process.env.NODE_ENV === "test" || process.env.VITEST === "true";
}

function requireTestHooksAllowed(): void {
  if (!testHooksAllowed()) {
    throw new Error("partner management test hooks are only available under the test runner.");
  }
}

export function __setCreatePartnerFailurePointForTest(point: CreatePartnerFailurePoint | null): void {
  requireTestHooksAllowed();
  createPartnerFailurePointForTest = point;
}

export function __setInvitePartnerFailurePointForTest(point: InvitePartnerFailurePoint | null): void {
  requireTestHooksAllowed();
  invitePartnerFailurePointForTest = point;
}

export function __setInvitePartnerBarrierForTest(
  barrier: { point: "after_duplicate_check"; parties: number } | null
): void {
  requireTestHooksAllowed();
  inviteBarrierForTest = barrier ? { point: barrier.point, parties: barrier.parties, arrived: 0, waiters: [] } : null;
}

export function __setAcceptPartnerBarrierForTest(
  barrier: { point: "before_invitation_lock"; parties: number } | null
): void {
  requireTestHooksAllowed();
  acceptBarrierForTest = barrier ? { point: barrier.point, parties: barrier.parties, arrived: 0, waiters: [] } : null;
}

function maybeFailCreatePartnerForTest(point: CreatePartnerFailurePoint): void {
  if (testHooksAllowed() && createPartnerFailurePointForTest === point) {
    throw new Error(`synthetic_create_partner_${point}`);
  }
}

function maybeFailInvitePartnerForTest(point: InvitePartnerFailurePoint): void {
  if (testHooksAllowed() && invitePartnerFailurePointForTest === point) {
    throw new Error(`synthetic_invite_partner_${point}`);
  }
}

async function maybeWaitInviteBarrierForTest(point: "after_duplicate_check"): Promise<void> {
  if (!testHooksAllowed() || inviteBarrierForTest?.point !== point) return;
  const barrier = inviteBarrierForTest;
  barrier.arrived += 1;
  if (barrier.arrived >= barrier.parties) {
    const waiters = barrier.waiters.splice(0);
    inviteBarrierForTest = null;
    for (const release of waiters) release();
    return;
  }
  await new Promise<void>((resolve) => barrier.waiters.push(resolve));
}

async function maybeWaitAcceptBarrierForTest(point: "before_invitation_lock"): Promise<void> {
  if (!testHooksAllowed() || acceptBarrierForTest?.point !== point) return;
  const barrier = acceptBarrierForTest;
  barrier.arrived += 1;
  if (barrier.arrived >= barrier.parties) {
    const waiters = barrier.waiters.splice(0);
    acceptBarrierForTest = null;
    for (const release of waiters) release();
    return;
  }
  await new Promise<void>((resolve) => barrier.waiters.push(resolve));
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
  return withPartnerAdminTransaction(async (client) => {
    const org = await client.query<{ id: string }>(
      `INSERT INTO partner_organisations (legal_name, status) VALUES ($1,'PENDING') RETURNING id`,
      [input.legalName]
    );
    const tenantId = org.rows[0].id;
    maybeFailCreatePartnerForTest("after_org_insert");
    await client.query(
      `INSERT INTO partner_management_audit
         (tenant_id, action_type, actor_user_id, actor_email, request_id, idempotency_key, entity_type, entity_id, before_state, reason, result)
       VALUES ($1::uuid,'partner_created',$2,$3,$4,$5,'partner',$1::text,$6,'__attempt__','attempted')`,
      [tenantId, actor.actorUserId, actor.actorEmail, actor.requestId, actor.idempotencyKey ?? null, null]
    );
    await client.query(`INSERT INTO partner_profiles (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING`, [
      tenantId,
    ]);
    await client.query(
      `INSERT INTO partner_locations (tenant_id, partner_id, name, status, created_by)
       VALUES ($1::uuid,$1::uuid,'Main location','ACTIVE',$2)`,
      [tenantId, actor.actorUserId]
    );
    maybeFailCreatePartnerForTest("after_default_location_insert");
    await client.query(
      `INSERT INTO partner_management_audit
         (tenant_id, action_type, actor_user_id, actor_email, request_id, idempotency_key, entity_type, entity_id, after_state, reason, result)
       VALUES ($1::uuid,'partner_created',$2,$3,$4,$5,'partner',$1::text,$6,$7,'succeeded')`,
      [
        tenantId,
        actor.actorUserId,
        actor.actorEmail,
        actor.requestId,
        actor.idempotencyKey ?? null,
        JSON.stringify({ status: "PENDING", defaultLocation: { name: "Main location", status: "ACTIVE" } }),
        reason,
      ]
    );
    return {
      result: { partnerId: tenantId },
      alreadyCompleted: false,
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

/**
 * Rename the organisation (the one identity field that lives on partner_organisations, not on the
 * profile).
 *
 * AUDIT ACTION CHOICE: this records `profile_updated`, an action type the database CHECK constraint
 * `chk_partner_management_audit_action` already permits. A dedicated `legal_name_changed` action
 * would be more precise but would violate that constraint at runtime, and adding it is a migration —
 * deliberately out of scope. The before/after states name `legal_name` explicitly, so the ledger is
 * unambiguous about what changed despite the shared action label.
 *
 * The profile version is used as the optimistic lock for the whole partner aggregate (the same lock
 * updateProfile and changeStatus use), so a rename cannot silently overwrite a concurrent edit.
 */
export async function updatePartnerLegalName(
  actor: ActorContext,
  partnerId: string,
  legalName: string,
  expectedVersion: number,
  reason: string
) {
  const org = await loadPartner(partnerId);
  if (org.status === "REVOKED") {
    throw new G5RequestError("PARTNER_UNAVAILABLE", "A revoked partner cannot be edited.");
  }
  await loadOrInitProfileVersion(org.id);
  return withAudit(actor, org.id, "profile_updated", reason, { legal_name: org.legal_name }, async () => {
    // Bump the aggregate version and rename in ONE data-modifying-CTE statement so the two writes are
    // atomic — no window where the version moved but the name did not. Mirrors changeStatus.
    const r = await partnerAdminQuery(
      `WITH bumped AS (
         UPDATE partner_profiles SET version = version + 1, updated_at = now()
          WHERE tenant_id = $1 AND version = $2
          RETURNING tenant_id
       )
       UPDATE partner_organisations o
          SET legal_name = $3, updated_at = now()
         FROM bumped
        WHERE o.id = bumped.tenant_id`,
      [org.id, expectedVersion, legalName]
    );
    if (r.rowCount === 0) {
      throw new G5RequestError("VERSION_CONFLICT", "The partner was modified by someone else; reload and retry.");
    }
    return {
      result: { legalName },
      entityType: "partner",
      entityId: org.id,
      afterState: { legal_name: legalName },
    };
  });
}

export interface DuplicateCandidate {
  legalName?: string;
  tradingName?: string;
  email?: string;
  postcode?: string;
  phone?: string;
}

export interface DuplicateMatchRow {
  kind: "email" | "legal_name" | "trading_name" | "postcode" | "phone";
  partnerId: string;
  partnerName: string;
  value: string;
}

/**
 * READ-ONLY pre-creation duplicate scan. Writes nothing and audits nothing — it is a lookup the admin
 * performs before deciding, and an audit row for "I typed a name into a box" would be noise.
 *
 * Matching is normalised in SQL (lower/trim for names, digits-only for phone, spaces stripped for
 * postcode) so "ME2 2AA" and "me22aa" collide, which is the whole point. The `email` probe covers BOTH
 * the profile contact address and partner_users, because a user-email collision is the one the invite
 * transaction will actually reject — surfacing it here turns a confusing late failure into an early,
 * explainable one.
 */
export async function findDuplicates(candidate: DuplicateCandidate): Promise<DuplicateMatchRow[]> {
  const out: DuplicateMatchRow[] = [];
  const norm = (s?: string) => (s ?? "").trim();

  const legalName = norm(candidate.legalName);
  const tradingName = norm(candidate.tradingName);
  const email = norm(candidate.email);
  const postcode = norm(candidate.postcode);
  const phone = norm(candidate.phone);

  if (legalName) {
    const { rows } = await partnerAdminQuery<{ id: string; legal_name: string }>(
      `SELECT id, legal_name FROM partner_organisations
        WHERE lower(regexp_replace(legal_name, '\\s+', ' ', 'g')) = lower(regexp_replace($1, '\\s+', ' ', 'g'))
        LIMIT 5`,
      [legalName]
    );
    for (const r of rows) out.push({ kind: "legal_name", partnerId: r.id, partnerName: r.legal_name, value: r.legal_name });
  }

  if (tradingName) {
    const { rows } = await partnerAdminQuery<{ id: string; legal_name: string; trading_name: string }>(
      `SELECT o.id, o.legal_name, p.trading_name
         FROM partner_profiles p JOIN partner_organisations o ON o.id = p.tenant_id
        WHERE p.trading_name IS NOT NULL
          AND lower(regexp_replace(p.trading_name, '\\s+', ' ', 'g')) = lower(regexp_replace($1, '\\s+', ' ', 'g'))
        LIMIT 5`,
      [tradingName]
    );
    for (const r of rows)
      out.push({ kind: "trading_name", partnerId: r.id, partnerName: r.legal_name, value: r.trading_name });
  }

  if (email) {
    const { rows } = await partnerAdminQuery<{ id: string; legal_name: string; email: string }>(
      `SELECT o.id, o.legal_name, p.primary_email AS email
         FROM partner_profiles p JOIN partner_organisations o ON o.id = p.tenant_id
        WHERE p.primary_email IS NOT NULL AND lower(p.primary_email) = lower($1)
       UNION
       SELECT o.id, o.legal_name, u.email
         FROM partner_users u JOIN partner_organisations o ON o.id = u.tenant_id
        WHERE lower(u.email) = lower($1)
        LIMIT 5`,
      [email]
    );
    for (const r of rows) out.push({ kind: "email", partnerId: r.id, partnerName: r.legal_name, value: r.email });
  }

  if (postcode) {
    const { rows } = await partnerAdminQuery<{ id: string; legal_name: string; address_postcode: string }>(
      `SELECT o.id, o.legal_name, p.address_postcode
         FROM partner_profiles p JOIN partner_organisations o ON o.id = p.tenant_id
        WHERE p.address_postcode IS NOT NULL
          AND upper(replace(p.address_postcode, ' ', '')) = upper(replace($1, ' ', ''))
        LIMIT 5`,
      [postcode]
    );
    for (const r of rows)
      out.push({ kind: "postcode", partnerId: r.id, partnerName: r.legal_name, value: r.address_postcode });
  }

  if (phone) {
    const digits = phone.replace(/[^0-9]/g, "");
    if (digits.length >= 7) {
      const { rows } = await partnerAdminQuery<{ id: string; legal_name: string; primary_phone: string }>(
        `SELECT o.id, o.legal_name, p.primary_phone
           FROM partner_profiles p JOIN partner_organisations o ON o.id = p.tenant_id
          WHERE p.primary_phone IS NOT NULL
            AND regexp_replace(p.primary_phone, '[^0-9]', '', 'g') = $1
          LIMIT 5`,
        [digits]
      );
      for (const r of rows)
        out.push({ kind: "phone", partnerId: r.id, partnerName: r.legal_name, value: r.primary_phone });
    }
  }

  // De-duplicate: the same partner matching the same way twice (e.g. two users sharing an address)
  // should be reported once.
  const seen = new Set<string>();
  return out.filter((m) => {
    const k = `${m.kind}:${m.partnerId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

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
  client: PoolClient,
  actor: ActorContext,
  tenantId: string,
  userId: string,
  email: string,
  roleCode: string,
  action: AuditAction,
  reason: string
): Promise<{
  invitationId: string;
  deliveryStatus: string;
  invitationLink?: string;
  delivery: { email: string; token: string; partnerName: string; roleCode: string; expiresAt: Date };
}> {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITE_HOURS * 60 * 60 * 1000);
  const previous = await client.query<{ id: string }>(
    `UPDATE partner_invitations
        SET status='REVOKED', revoked_at=now(), updated_at=now()
      WHERE tenant_id=$1 AND user_id=$2 AND status IN ('PENDING','SENT','DELIVERY_FAILED')
      RETURNING id`,
    [tenantId, userId]
  );
  maybeFailInvitePartnerForTest("before_invitation_insert");
  const { rows } = await client.query<{ id: string; partner_name: string }>(
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
    await client.query("UPDATE partner_invitations SET superseded_by=$1 WHERE id = ANY($2::uuid[])", [
      rows[0].id,
      previous.rows.map((r) => r.id),
    ]);
  }
  maybeFailInvitePartnerForTest("before_invitation_audit");
  await client.query(
    `INSERT INTO partner_management_audit
       (tenant_id, action_type, actor_user_id, actor_email, request_id, idempotency_key, entity_type, entity_id, after_state, reason, result)
     VALUES ($1,$2,$3,$4,$5,$6,'partner_user',$7,$8,$9,'succeeded')`,
    [
      tenantId,
      action,
      actor.actorUserId,
      actor.actorEmail,
      actor.requestId,
      actor.idempotencyKey ?? null,
      userId,
      JSON.stringify({ invitationId: rows[0].id, roleCode, deliveryStatus: "DELIVERY_NOT_CONFIGURED" }),
      reason,
    ]
  );
  return {
    invitationId: rows[0].id,
    deliveryStatus: "DELIVERY_NOT_CONFIGURED",
    delivery: { email, token, partnerName: rows[0].partner_name, roleCode, expiresAt },
    invitationLink: process.env.PARTNER_INVITE_ALLOW_ADMIN_LINK_COPY === "true" ? inviteLink(token) : undefined,
  };
}

async function recordInvitationDelivery(invite: {
  invitationId: string;
  deliveryStatus: string;
  delivery: { email: string; token: string; partnerName: string; roleCode: string; expiresAt: Date };
}): Promise<string> {
  if (!invitationDeliveryConfigured()) return invite.deliveryStatus;
  try {
    await deliverInvitationToken(invite.delivery);
    const delivered = await partnerAdminQuery(
      "UPDATE partner_invitations SET status='SENT', delivered_at=now(), delivery_error=NULL, updated_at=now() WHERE id=$1 AND status='PENDING'",
      [invite.invitationId]
    );
    if ((delivered.rowCount ?? 0) === 0) return invite.deliveryStatus;
    return "SENT";
  } catch (err) {
    const failed = await partnerAdminQuery(
      "UPDATE partner_invitations SET status='DELIVERY_FAILED', delivery_error=$2, updated_at=now() WHERE id=$1 AND status='PENDING'",
      [invite.invitationId, (err as Error).message.slice(0, 500)]
    );
    if ((failed.rowCount ?? 0) === 0) return invite.deliveryStatus;
    return "DELIVERY_FAILED";
  }
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
  const committed = await withPartnerAdminTransaction(async (client) => {
    if ((await client.query("SELECT 1 FROM partner_users WHERE lower(email)=lower($1) LIMIT 1", [email])).rows.length) {
      throw new G5RequestError("DUPLICATE_PARTNER_USER", "A partner user with this email already exists.");
    }
    await maybeWaitInviteBarrierForTest("after_duplicate_check");
    const role = await client.query<{ id: string }>("SELECT id FROM partner_roles WHERE code=$1", [roleCode]);
    if (role.rows.length !== 1) {
      throw new G5RequestError("PARTNER_ROLE_NOT_CONFIGURED", "Partner role is not configured.");
    }
    await client.query(
      `INSERT INTO partner_management_audit
         (tenant_id, action_type, actor_user_id, actor_email, request_id, idempotency_key, entity_type, before_state, reason, result)
       VALUES ($1,'partner_user_invited',$2,$3,$4,$5,'partner_user',$6,'__attempt__','attempted')`,
      [
        org.id,
        actor.actorUserId,
        actor.actorEmail,
        actor.requestId,
        actor.idempotencyKey ?? null,
        JSON.stringify({ email, roleCode }),
      ]
    );
    const user = await client.query<{ id: string }>(
      `INSERT INTO partner_users (tenant_id, partner_id, email, first_name, last_name, status, created_by)
       VALUES ($1,$1,$2,$3,$4,'INVITED',$5) RETURNING id`,
      [org.id, email, firstName, lastName, actor.actorUserId]
    );
    maybeFailInvitePartnerForTest("after_user_insert");
    await client.query("INSERT INTO partner_user_roles (tenant_id, user_id, role_id) VALUES ($1,$2,$3)", [
      org.id,
      user.rows[0].id,
      role.rows[0].id,
    ]);
    maybeFailInvitePartnerForTest("after_role_assignment");
    const invite = await createInvitationRecord(
      client,
      actor,
      org.id,
      user.rows[0].id,
      email,
      roleCode,
      "partner_user_invited",
      reason
    );
    return { userId: user.rows[0].id, invite };
  });
  const { delivery, ...invite } = committed.invite;
  invite.deliveryStatus = await recordInvitationDelivery({ ...invite, delivery });
  return { result: { userId: committed.userId, ...invite }, alreadyCompleted: false };
}

/**
 * Amend a PENDING invitation: correct the name, the email address, or the role, and re-issue it.
 *
 * DESIGN NOTE — why this is "amend and re-issue" rather than "edit in place". An invitation that has
 * already left the building is not a draft: a token addressed to the old inbox is live until it is
 * revoked. Silently changing the recipient column while leaving that token valid would mean a typo'd
 * address keeps a working key to the account — a real security hole dressed up as a convenience
 * feature. So changing the details always revokes the outstanding token and mints a new one for the
 * corrected address. `createInvitationRecord` performs the revoke-then-insert in the same transaction
 * and stamps `superseded_by`, so the chain of who-replaced-what is preserved.
 *
 * AUDIT ACTION CHOICE: recorded as `partner_user_invited` — an action type the CHECK constraint
 * already permits, and an honest description of what physically happens (a fresh invitation is
 * issued). The before-state carries the previous name/email/role so the ledger shows the correction.
 * A distinct `partner_invitation_amended` action would read better but requires a migration.
 *
 * Only INVITED users are amendable. Once an invitation is accepted the person exists, and their
 * details are changed through the role/status controls, not by rewriting history.
 */
export async function amendPendingInvitation(
  actor: ActorContext,
  partnerId: string,
  userId: string,
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

  const committed = await withPartnerAdminTransaction(async (client) => {
    const existing = await client.query<{
      id: string;
      email: string;
      first_name: string;
      last_name: string;
      status: string;
    }>("SELECT id, email, first_name, last_name, status FROM partner_users WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
      org.id,
      userId,
    ]);
    if (existing.rows.length !== 1) throw new G5RequestError("PARTNER_USER_NOT_FOUND", "Partner user not found.");
    const before = existing.rows[0];
    if (before.status !== "INVITED") {
      throw new G5RequestError(
        "INVITATION_NOT_AMENDABLE",
        "This invitation has already been accepted. Change the person's role or status instead."
      );
    }

    // Same duplicate rule the original invite enforces, but scoped to OTHER users — re-saving the
    // form without changing the address must not report the invitation as a duplicate of itself.
    const clash = await client.query("SELECT 1 FROM partner_users WHERE lower(email)=lower($1) AND id<>$2 LIMIT 1", [
      email,
      userId,
    ]);
    if (clash.rows.length) {
      throw new G5RequestError("DUPLICATE_PARTNER_USER", "A partner user with this email already exists.");
    }

    const roleRow = await client.query<{ id: string }>("SELECT id FROM partner_roles WHERE code=$1", [roleCode]);
    if (roleRow.rows.length !== 1) {
      throw new G5RequestError("PARTNER_ROLE_NOT_CONFIGURED", "Partner role is not configured.");
    }

    await client.query(
      "UPDATE partner_users SET email=$1, first_name=$2, last_name=$3, updated_at=now() WHERE id=$4",
      [email, firstName, lastName, userId]
    );
    await client.query("DELETE FROM partner_user_roles WHERE tenant_id=$1 AND user_id=$2", [org.id, userId]);
    await client.query("INSERT INTO partner_user_roles (tenant_id, user_id, role_id) VALUES ($1,$2,$3)", [
      org.id,
      userId,
      roleRow.rows[0].id,
    ]);

    // Revokes the outstanding token and issues a replacement, stamping superseded_by.
    const invite = await createInvitationRecord(
      client,
      actor,
      org.id,
      userId,
      email,
      roleCode,
      "partner_user_invited",
      `${reason} [amended from ${before.first_name} ${before.last_name} <${before.email}>]`
    );
    return { invite };
  });

  const { delivery, ...invite } = committed.invite;
  invite.deliveryStatus = await recordInvitationDelivery({ ...invite, delivery });
  return { result: { userId, ...invite }, alreadyCompleted: false };
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
  const invite = await withPartnerAdminTransaction(async (client) => {
    const { rows } = await client.query<{ email: string; role_code: string; status: string }>(
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
    await client.query(
      `INSERT INTO partner_management_audit
         (tenant_id, action_type, actor_user_id, actor_email, request_id, idempotency_key, entity_type, entity_id, before_state, reason, result)
       VALUES ($1,'partner_invitation_resent',$2,$3,$4,$5,'partner_user',$6,$7,'__attempt__','attempted')`,
      [
        org.id,
        actor.actorUserId,
        actor.actorEmail,
        actor.requestId,
        actor.idempotencyKey ?? null,
        userId,
        JSON.stringify({ email: rows[0].email }),
      ]
    );
    return createInvitationRecord(
      client,
      actor,
      org.id,
      userId,
      rows[0].email,
      rows[0].role_code,
      "partner_invitation_resent",
      reason
    );
  });
  const { delivery, ...publicInvite } = invite;
  publicInvite.deliveryStatus = await recordInvitationDelivery({ ...publicInvite, delivery });
  return { result: publicInvite, alreadyCompleted: false };
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
    if ((r.rowCount ?? 0) < 1) {
      throw new G5RequestError("PARTNER_INVITATION_NOT_FOUND", "No live invitation exists for this team member.");
    }
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
    const activeBefore = await partnerAdminQuery(
      "SELECT 1 FROM partner_sessions WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL LIMIT 1",
      [org.id, userId]
    );
    const r = await partnerAdminQuery(
      "UPDATE partner_sessions SET revoked_at=now() WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL",
      [org.id, userId]
    );
    return {
      result: { revoked: r.rowCount ?? 0, hadSessions: activeBefore.rows.length > 0 },
      entityType: "partner_user",
      entityId: userId,
      afterState: { revoked: r.rowCount ?? 0, hadSessions: activeBefore.rows.length > 0 },
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
    await maybeWaitAcceptBarrierForTest("before_invitation_lock");
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
