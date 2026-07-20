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
import { partnerAdminQuery } from "./db";
import { G5RequestError, canTransitionStatus, isPartnerStatus, type PartnerStatus } from "./partner-management-errors";

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
  | "note_added";

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
    if ((err as { code?: string })?.code === "23505" && actor.idempotencyKey) {
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
    // bump the aggregate version under optimistic lock, then set the status (business-label only — no
    // flags, portal, wallet, slots, users, devices, or sessions are touched).
    const v = await partnerAdminQuery(
      `UPDATE partner_profiles SET version = version + 1, updated_at = now() WHERE tenant_id = $1 AND version = $2`,
      [org.id, expectedVersion]
    );
    if (v.rowCount === 0)
      throw new G5RequestError("VERSION_CONFLICT", "The partner was modified by someone else; reload and retry.");
    await partnerAdminQuery(`UPDATE partner_organisations SET status = $2, updated_at = now() WHERE id = $1`, [
      org.id,
      toStatus,
    ]);
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
       FROM partner_contacts WHERE tenant_id = $1 ORDER BY is_primary DESC, active DESC, full_name ASC, id ASC`,
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
