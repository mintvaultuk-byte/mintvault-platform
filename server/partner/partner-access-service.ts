/**
 * Partner access-management domain service.
 *
 * This is intentionally separate from the G5 partner-management service: every entry point is
 * reached through requireSuperAdmin, derives its actor from the admin session, uses explicit tenant
 * predicates on the privileged connection, and appends immutable access-audit evidence in the same
 * transaction as the state change.
 */
import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { PARTNER_ROLE_CODES, type PartnerRoleCode } from "../../shared/partner-schema";
import { PARTNER_ROLE_LABELS } from "./permissions";
import { withPartnerAdminTransaction } from "./db";
import { deliverPartnerInvitation } from "./invitation-delivery";

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PartnerAccessError extends Error {
  constructor(
    readonly code: "bad_request" | "not_found" | "conflict" | "invalid_state" | "delivery_failed",
    message: string
  ) {
    super(message);
  }
}

export interface SuperAdminActor {
  userId: string;
  email: string;
  correlationId: string;
}

interface RoleRow {
  id: string;
  code: PartnerRoleCode;
}

interface InvitationRow {
  id: string;
  tenant_id: string;
  invited_email: string;
  role_id: string;
  expires_at: Date;
  status: string;
  delivery_status: string;
}

interface DeliveryBoundary {
  invitationId: string;
  email: string;
  token: string;
  expiresAt: Date;
  roleLabel: string;
}

export interface CreateInvitationInput {
  email: string;
  role: PartnerRoleCode;
  locationIds: string[];
  idempotencyKey?: string;
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!email || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new PartnerAccessError("bad_request", "A valid invitation email is required.");
  }
  return email;
}

function normalizedLocationIds(ids: string[]): string[] {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new PartnerAccessError("bad_request", "At least one active location is required.");
  }
  const unique = [...new Set(ids)];
  if (unique.length !== ids.length || unique.some((id) => !UUID_RE.test(id))) {
    throw new PartnerAccessError("bad_request", "Location selection is invalid.");
  }
  return unique;
}

function assertRole(role: string): asserts role is PartnerRoleCode {
  if (!PARTNER_ROLE_CODES.includes(role as PartnerRoleCode)) {
    throw new PartnerAccessError("bad_request", "The requested Partner role is not recognised.");
  }
}

function newToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function getPartnerOrThrow(client: PoolClient, tenantId: string): Promise<void> {
  if (!UUID_RE.test(tenantId)) throw new PartnerAccessError("not_found", "Partner not found.");
  const row = await client.query<{ id: string }>("SELECT id FROM partner_organisations WHERE id=$1", [tenantId]);
  if (row.rowCount !== 1) throw new PartnerAccessError("not_found", "Partner not found.");
}

async function getRole(client: PoolClient, role: PartnerRoleCode): Promise<RoleRow> {
  const result = await client.query<RoleRow>("SELECT id, code FROM partner_roles WHERE code=$1", [role]);
  if (result.rowCount !== 1) throw new PartnerAccessError("invalid_state", "Partner roles have not been provisioned.");
  return result.rows[0];
}

async function assertLocations(client: PoolClient, tenantId: string, locationIds: string[]): Promise<void> {
  const result = await client.query<{ id: string }>(
    "SELECT id FROM partner_locations WHERE tenant_id=$1 AND status='ACTIVE' AND id = ANY($2::uuid[])",
    [tenantId, locationIds]
  );
  if (result.rows.length !== locationIds.length) {
    throw new PartnerAccessError("bad_request", "Every selected location must be active and belong to this Partner.");
  }
}

async function accessAudit(
  client: PoolClient,
  actor: SuperAdminActor,
  tenantId: string,
  action: string,
  targetType: string,
  targetId: string | null,
  input: { reason?: string | null; before?: unknown; after?: unknown; metadata?: unknown } = {}
): Promise<void> {
  await client.query(
    `INSERT INTO partner_access_audit_events
       (tenant_id, actor_type, actor_user_id, actor_email, target_type, target_id, action,
        reason, correlation_id, before_value, after_value, metadata)
     VALUES ($1,'SUPER_ADMIN',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      tenantId,
      actor.userId,
      actor.email,
      targetType,
      targetId,
      action,
      input.reason ?? null,
      actor.correlationId,
      input.before === undefined ? null : JSON.stringify(input.before),
      input.after === undefined ? null : JSON.stringify(input.after),
      JSON.stringify(input.metadata ?? {}),
    ]
  );
}

async function createInvitationInTransaction(
  client: PoolClient,
  actor: SuperAdminActor,
  tenantId: string,
  input: CreateInvitationInput,
  resendOfId: string | null = null
): Promise<{ invitation: InvitationRow; delivery: DeliveryBoundary; alreadyCompleted: boolean }> {
  await getPartnerOrThrow(client, tenantId);
  const email = normalizeEmail(input.email);
  assertRole(input.role);
  const locationIds = normalizedLocationIds(input.locationIds);
  await assertLocations(client, tenantId, locationIds);

  const idempotencyScope = resendOfId ? `resend:${resendOfId}` : "create";
  if (input.idempotencyKey) {
    const previous = await client.query<InvitationRow>(
      `SELECT id, tenant_id, invited_email, role_id, expires_at, status, delivery_status
         FROM partner_invitations
        WHERE tenant_id=$1 AND idempotency_scope=$2 AND idempotency_key=$3`,
      [tenantId, idempotencyScope, input.idempotencyKey]
    );
    if (previous.rowCount === 1) {
      return {
        invitation: previous.rows[0],
        // A replay never reconstitutes or returns the raw token; it is a completed no-op.
        delivery: {
          invitationId: previous.rows[0].id,
          email,
          token: "",
          expiresAt: previous.rows[0].expires_at,
          roleLabel: "",
        },
        alreadyCompleted: true,
      };
    }
  }

  const role = await getRole(client, input.role);
  const token = newToken();
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
  let invitation: InvitationRow;
  try {
    const result = await client.query<InvitationRow>(
      `INSERT INTO partner_invitations
         (tenant_id, invited_email, role_id, token_hash, expires_at, created_by_user_id, created_by_email,
          idempotency_key, idempotency_scope, resend_of_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (tenant_id, idempotency_scope, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id, tenant_id, invited_email, role_id, expires_at, status, delivery_status`,
      [
        tenantId,
        email,
        role.id,
        tokenHash(token),
        expiresAt,
        actor.userId,
        actor.email,
        input.idempotencyKey ?? null,
        idempotencyScope,
        resendOfId,
      ]
    );
    if (result.rowCount === 0) {
      // A concurrent request committed the same source-scoped key after our initial lookup. In
      // READ COMMITTED this follow-up sees that completed request and preserves one delivery only.
      const replay = await client.query<InvitationRow>(
        `SELECT id, tenant_id, invited_email, role_id, expires_at, status, delivery_status
           FROM partner_invitations
          WHERE tenant_id=$1 AND idempotency_scope=$2 AND idempotency_key=$3`,
        [tenantId, idempotencyScope, input.idempotencyKey]
      );
      if (replay.rowCount === 1) {
        return {
          invitation: replay.rows[0],
          delivery: {
            invitationId: replay.rows[0].id,
            email,
            token: "",
            expiresAt: replay.rows[0].expires_at,
            roleLabel: "",
          },
          alreadyCompleted: true,
        };
      }
      throw new PartnerAccessError("conflict", "Invitation idempotency could not be resolved safely.");
    }
    invitation = result.rows[0];
  } catch (error) {
    const pg = error as { code?: string; constraint?: string };
    if (pg.code === "23505" && pg.constraint === "uq_partner_invitations_pending_email") {
      throw new PartnerAccessError("conflict", "A pending invitation already exists for this email and Partner.");
    }
    throw error;
  }
  for (const locationId of locationIds) {
    await client.query(
      "INSERT INTO partner_invitation_locations (invitation_id, tenant_id, location_id) VALUES ($1,$2,$3)",
      [invitation.id, tenantId, locationId]
    );
  }
  await accessAudit(client, actor, tenantId, "invitation_created", "partner_invitation", invitation.id, {
    after: { email, role: input.role, locationIds, resendOfId },
  });
  return {
    invitation,
    delivery: { invitationId: invitation.id, email, token, expiresAt, roleLabel: PARTNER_ROLE_LABELS[role.code] },
    alreadyCompleted: false,
  };
}

async function recordDelivery(
  actor: SuperAdminActor,
  tenantId: string,
  delivery: DeliveryBoundary
): Promise<"SENT" | "FAILED" | "SUPPRESSED"> {
  try {
    const sent = await deliverPartnerInvitation(delivery);
    const deliveryStatus = sent.suppressed ? "SUPPRESSED" : "SENT";
    await withPartnerAdminTransaction(async (client) => {
      await client.query(
        `UPDATE partner_invitations
            SET delivery_status=$2, delivery_attempts=delivery_attempts+1, last_delivery_at=now(),
                delivery_metadata=jsonb_build_object('providerMessageId',$3::text), updated_at=now()
          WHERE id=$1 AND tenant_id=$4`,
        [delivery.invitationId, deliveryStatus, sent.providerMessageId ?? null, tenantId]
      );
      await accessAudit(
        client,
        actor,
        tenantId,
        deliveryStatus === "SUPPRESSED" ? "invitation_delivery_suppressed" : "invitation_delivery_sent",
        "partner_invitation",
        delivery.invitationId,
        {
          metadata: { providerMessageId: sent.providerMessageId ?? null, deliveryStatus },
        }
      );
    });
    return deliveryStatus;
  } catch {
    await withPartnerAdminTransaction(async (client) => {
      await client.query(
        `UPDATE partner_invitations
            SET delivery_status='FAILED', delivery_attempts=delivery_attempts+1, last_delivery_at=now(), updated_at=now()
          WHERE id=$1 AND tenant_id=$2`,
        [delivery.invitationId, tenantId]
      );
      await accessAudit(
        client,
        actor,
        tenantId,
        "invitation_delivery_failed",
        "partner_invitation",
        delivery.invitationId,
        {
          metadata: { reason: "provider_unavailable_or_rejected" },
        }
      );
    });
    return "FAILED";
  }
}

export async function createInvitation(actor: SuperAdminActor, tenantId: string, input: CreateInvitationInput) {
  const created = await withPartnerAdminTransaction((client) =>
    createInvitationInTransaction(client, actor, tenantId, input)
  );
  if (created.alreadyCompleted)
    return {
      invitation: created.invitation,
      deliveryStatus: created.invitation.delivery_status,
      alreadyCompleted: true,
    };
  const deliveryStatus = await recordDelivery(actor, tenantId, created.delivery);
  return { invitation: created.invitation, deliveryStatus, alreadyCompleted: false };
}

export async function resendInvitation(
  actor: SuperAdminActor,
  tenantId: string,
  invitationId: string,
  idempotencyKey?: string
) {
  const created = await withPartnerAdminTransaction(async (client) => {
    await getPartnerOrThrow(client, tenantId);
    const idempotencyScope = `resend:${invitationId}`;
    // Check before and after locking the predecessor. The second check makes a concurrent retry
    // replay the already-created successor instead of seeing SUPERSEDED and incorrectly failing.
    const replay = async () => {
      if (!idempotencyKey) return null;
      const result = await client.query<InvitationRow>(
        `SELECT id, tenant_id, invited_email, role_id, expires_at, status, delivery_status
           FROM partner_invitations
          WHERE tenant_id=$1 AND idempotency_scope=$2 AND idempotency_key=$3`,
        [tenantId, idempotencyScope, idempotencyKey]
      );
      if (result.rowCount !== 1) return null;
      return {
        invitation: result.rows[0],
        delivery: {
          invitationId: result.rows[0].id,
          email: result.rows[0].invited_email,
          token: "",
          expiresAt: result.rows[0].expires_at,
          roleLabel: "",
        },
        alreadyCompleted: true,
      };
    };
    const existingReplay = await replay();
    if (existingReplay) return existingReplay;
    const old = await client.query<InvitationRow>(
      `SELECT id, tenant_id, invited_email, role_id, expires_at, status, delivery_status
         FROM partner_invitations WHERE id=$1 AND tenant_id=$2 FOR UPDATE`,
      [invitationId, tenantId]
    );
    if (old.rowCount !== 1) throw new PartnerAccessError("not_found", "Invitation not found.");
    const lockedReplay = await replay();
    if (lockedReplay) return lockedReplay;
    if (old.rows[0].status !== "PENDING")
      throw new PartnerAccessError("invalid_state", "Only a pending invitation may be resent.");
    const role = await client.query<{ code: PartnerRoleCode }>("SELECT code FROM partner_roles WHERE id=$1", [
      old.rows[0].role_id,
    ]);
    const locations = await client.query<{ location_id: string }>(
      "SELECT location_id FROM partner_invitation_locations WHERE invitation_id=$1 AND tenant_id=$2 ORDER BY location_id",
      [invitationId, tenantId]
    );
    await client.query(
      "UPDATE partner_invitations SET status='SUPERSEDED', superseded_at=now(), updated_at=now() WHERE id=$1",
      [invitationId]
    );
    await accessAudit(client, actor, tenantId, "invitation_superseded", "partner_invitation", invitationId, {
      after: { superseded: true },
    });
    return createInvitationInTransaction(
      client,
      actor,
      tenantId,
      {
        email: old.rows[0].invited_email,
        role: role.rows[0].code,
        locationIds: locations.rows.map((row) => row.location_id),
        idempotencyKey,
      },
      invitationId
    );
  });
  if (created.alreadyCompleted)
    return {
      invitation: created.invitation,
      deliveryStatus: created.invitation.delivery_status,
      alreadyCompleted: true,
    };
  const deliveryStatus = await recordDelivery(actor, tenantId, created.delivery);
  return { invitation: created.invitation, deliveryStatus, alreadyCompleted: false };
}

export async function revokeInvitation(actor: SuperAdminActor, tenantId: string, invitationId: string, reason: string) {
  return withPartnerAdminTransaction(async (client) => {
    const result = await client.query<InvitationRow>(
      `UPDATE partner_invitations
          SET status='REVOKED', revoked_at=now(), revoked_by_user_id=$3, revoked_by_email=$4, updated_at=now()
        WHERE id=$1 AND tenant_id=$2 AND status='PENDING'
      RETURNING id, tenant_id, invited_email, role_id, expires_at, status, delivery_status`,
      [invitationId, tenantId, actor.userId, actor.email]
    );
    if (result.rowCount !== 1) throw new PartnerAccessError("invalid_state", "Invitation is not pending.");
    await accessAudit(client, actor, tenantId, "invitation_revoked", "partner_invitation", invitationId, { reason });
    return result.rows[0];
  });
}

export async function listInvitations(tenantId: string) {
  return withPartnerAdminTransaction(async (client) => {
    await getPartnerOrThrow(client, tenantId);
    const result = await client.query(
      `SELECT i.id, i.invited_email, r.code AS role, i.status, i.expires_at, i.created_at, i.accepted_at,
              i.revoked_at, i.superseded_at, i.delivery_status, i.delivery_attempts,
              COALESCE(array_agg(il.location_id) FILTER (WHERE il.location_id IS NOT NULL), '{}') AS location_ids
         FROM partner_invitations i
         JOIN partner_roles r ON r.id=i.role_id
         LEFT JOIN partner_invitation_locations il ON il.invitation_id=i.id
        WHERE i.tenant_id=$1
        GROUP BY i.id, r.code
        ORDER BY i.created_at DESC, i.id DESC LIMIT 500`,
      [tenantId]
    );
    return result.rows;
  });
}

export async function listMembers(tenantId: string) {
  return withPartnerAdminTransaction(async (client) => {
    await getPartnerOrThrow(client, tenantId);
    const result = await client.query(
      `SELECT u.id, u.email, u.status, u.created_at, u.last_login_at,
              COALESCE(array_agg(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS roles,
              COALESCE(array_agg(DISTINCT ul.location_id) FILTER (WHERE ul.location_id IS NOT NULL), '{}') AS location_ids
         FROM partner_users u
         LEFT JOIN partner_user_roles ur ON ur.user_id=u.id AND ur.tenant_id=u.tenant_id
         LEFT JOIN partner_roles r ON r.id=ur.role_id
         LEFT JOIN partner_user_locations ul ON ul.user_id=u.id AND ul.tenant_id=u.tenant_id
        WHERE u.tenant_id=$1
        GROUP BY u.id
        ORDER BY u.email LIMIT 500`,
      [tenantId]
    );
    return result.rows;
  });
}

export async function listPartnerLocationsForAccess(tenantId: string) {
  return withPartnerAdminTransaction(async (client) => {
    await getPartnerOrThrow(client, tenantId);
    const result = await client.query(
      "SELECT id, name, status FROM partner_locations WHERE tenant_id=$1 ORDER BY name, id LIMIT 500",
      [tenantId]
    );
    return result.rows;
  });
}

export async function changeMemberRole(
  actor: SuperAdminActor,
  tenantId: string,
  userId: string,
  role: PartnerRoleCode,
  reason: string
) {
  assertRole(role);
  return withPartnerAdminTransaction(async (client) => {
    const member = await client.query<{ id: string }>(
      "SELECT id FROM partner_users WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
      [userId, tenantId]
    );
    if (member.rowCount !== 1) throw new PartnerAccessError("not_found", "Partner member not found.");
    const before = await client.query<{ code: string }>(
      "SELECT r.code FROM partner_user_roles ur JOIN partner_roles r ON r.id=ur.role_id WHERE ur.user_id=$1",
      [userId]
    );
    const target = await getRole(client, role);
    await client.query("DELETE FROM partner_user_roles WHERE user_id=$1 AND tenant_id=$2", [userId, tenantId]);
    await client.query("INSERT INTO partner_user_roles (tenant_id, user_id, role_id) VALUES ($1,$2,$3)", [
      tenantId,
      userId,
      target.id,
    ]);
    await client.query(
      "UPDATE partner_sessions SET revoked_at=now() WHERE user_id=$1 AND tenant_id=$2 AND revoked_at IS NULL",
      [userId, tenantId]
    );
    await accessAudit(client, actor, tenantId, "role_changed", "partner_user", userId, {
      reason,
      before: { roles: before.rows.map((row) => row.code) },
      after: { role },
    });
    await accessAudit(client, actor, tenantId, "session_revoked", "partner_user", userId, { reason: "role changed" });
    return { userId, role };
  });
}

export async function changeMemberLocations(
  actor: SuperAdminActor,
  tenantId: string,
  userId: string,
  locationIds: string[],
  reason: string
) {
  const normalized = normalizedLocationIds(locationIds);
  return withPartnerAdminTransaction(async (client) => {
    const member = await client.query<{ id: string }>(
      "SELECT id FROM partner_users WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
      [userId, tenantId]
    );
    if (member.rowCount !== 1) throw new PartnerAccessError("not_found", "Partner member not found.");
    await assertLocations(client, tenantId, normalized);
    const before = await client.query<{ location_id: string }>(
      "SELECT location_id FROM partner_user_locations WHERE user_id=$1 AND tenant_id=$2",
      [userId, tenantId]
    );
    await client.query("DELETE FROM partner_user_locations WHERE user_id=$1 AND tenant_id=$2", [userId, tenantId]);
    for (const locationId of normalized) {
      await client.query("INSERT INTO partner_user_locations (tenant_id, user_id, location_id) VALUES ($1,$2,$3)", [
        tenantId,
        userId,
        locationId,
      ]);
    }
    await client.query(
      "UPDATE partner_sessions SET revoked_at=now() WHERE user_id=$1 AND tenant_id=$2 AND revoked_at IS NULL",
      [userId, tenantId]
    );
    await accessAudit(client, actor, tenantId, "location_scope_changed", "partner_user", userId, {
      reason,
      before: { locationIds: before.rows.map((row) => row.location_id) },
      after: { locationIds: normalized },
    });
    await accessAudit(client, actor, tenantId, "session_revoked", "partner_user", userId, {
      reason: "location scope changed",
    });
    return { userId, locationIds: normalized };
  });
}

export async function setMemberStatus(
  actor: SuperAdminActor,
  tenantId: string,
  userId: string,
  active: boolean,
  reason: string
) {
  return withPartnerAdminTransaction(async (client) => {
    const result = await client.query<{ id: string; status: string }>(
      `UPDATE partner_users SET status=$3, credential_version=credential_version+1, updated_at=now()
        WHERE id=$1 AND tenant_id=$2 RETURNING id, status`,
      [userId, tenantId, active ? "ACTIVE" : "SUSPENDED"]
    );
    if (result.rowCount !== 1) throw new PartnerAccessError("not_found", "Partner member not found.");
    await client.query(
      "UPDATE partner_sessions SET revoked_at=now() WHERE user_id=$1 AND tenant_id=$2 AND revoked_at IS NULL",
      [userId, tenantId]
    );
    await accessAudit(
      client,
      actor,
      tenantId,
      active ? "member_reactivated" : "member_suspended",
      "partner_user",
      userId,
      { reason }
    );
    await accessAudit(client, actor, tenantId, "session_revoked", "partner_user", userId, {
      reason: active ? "member reactivated" : "member suspended",
    });
    return result.rows[0];
  });
}

export async function revokeMemberSessions(actor: SuperAdminActor, tenantId: string, userId: string, reason: string) {
  return withPartnerAdminTransaction(async (client) => {
    const member = await client.query<{ id: string }>(
      "SELECT id FROM partner_users WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
      [userId, tenantId]
    );
    if (member.rowCount !== 1) throw new PartnerAccessError("not_found", "Partner member not found.");
    const result = await client.query(
      "UPDATE partner_sessions SET revoked_at=now() WHERE user_id=$1 AND tenant_id=$2 AND revoked_at IS NULL",
      [userId, tenantId]
    );
    await accessAudit(client, actor, tenantId, "session_revoked", "partner_user", userId, {
      reason,
      after: { count: result.rowCount ?? 0 },
    });
    return result.rowCount ?? 0;
  });
}

export async function setPartnerStatus(actor: SuperAdminActor, tenantId: string, active: boolean, reason: string) {
  return withPartnerAdminTransaction(async (client) => {
    const result = await client.query<{ id: string; status: string }>(
      "UPDATE partner_organisations SET status=$2, updated_at=now() WHERE id=$1 RETURNING id, status",
      [tenantId, active ? "ACTIVE" : "SUSPENDED"]
    );
    if (result.rowCount !== 1) throw new PartnerAccessError("not_found", "Partner not found.");
    const sessions = await client.query(
      "UPDATE partner_sessions SET revoked_at=now() WHERE tenant_id=$1 AND revoked_at IS NULL",
      [tenantId]
    );
    await accessAudit(
      client,
      actor,
      tenantId,
      active ? "partner_reactivated" : "partner_suspended",
      "partner_organisation",
      tenantId,
      { reason }
    );
    await accessAudit(client, actor, tenantId, "session_revoked", "partner_organisation", tenantId, {
      reason,
      after: { count: sessions.rowCount ?? 0 },
    });
    return result.rows[0];
  });
}

export async function listAccessAudit(tenantId: string) {
  return withPartnerAdminTransaction(async (client) => {
    await getPartnerOrThrow(client, tenantId);
    const result = await client.query(
      `SELECT id, actor_type, actor_user_id, actor_email, target_type, target_id, action, reason,
              correlation_id, before_value, after_value, metadata, created_at
         FROM partner_access_audit_events WHERE tenant_id=$1 ORDER BY created_at DESC, id DESC LIMIT 500`,
      [tenantId]
    );
    return result.rows;
  });
}
