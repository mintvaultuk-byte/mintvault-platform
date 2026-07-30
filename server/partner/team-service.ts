import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { writePartnerAudit } from "./audit";
import { deliverInvitationToken, invitationDeliveryConfigured } from "./delivery";
import { G5RequestError } from "./partner-management-errors";
import type { PartnerPrincipal } from "./session";
import { withTenant } from "./db";

export const PORTAL_ROLE_TO_PARTNER_ROLE = {
  OWNER: "PARTNER_OWNER",
  ADMIN: "PARTNER_MANAGER",
  GRADER: "MVGS_ASSESSMENT_TECHNICIAN",
  STAFF: "PARTNER_RECEPTION",
} as const;

export type PortalTeamRole = keyof typeof PORTAL_ROLE_TO_PARTNER_ROLE;

const PARTNER_ROLE_TO_PORTAL_ROLE: Record<string, PortalTeamRole> = {
  PARTNER_OWNER: "OWNER",
  PARTNER_MANAGER: "ADMIN",
  MVGS_ASSESSMENT_TECHNICIAN: "GRADER",
  PARTNER_RECEPTION: "STAFF",
};
const PORTAL_ROLE_PRECEDENCE = [
  "PARTNER_OWNER",
  "PARTNER_MANAGER",
  "MVGS_ASSESSMENT_TECHNICIAN",
  "PARTNER_RECEPTION",
] as const;

const UNSUPPORTED_ROLE_LABELS: Record<string, string> = {
  PARTNER_FINANCE_VIEWER: "FINANCE_VIEWER",
  PARTNER_TRAINEE: "TRAINEE",
};

const INVITE_HOURS = 72;
const ACTIVE_INVITE_STATUSES = ["PENDING", "SENT", "DELIVERY_FAILED"];

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function requirePortalTeamRole(raw: unknown): PortalTeamRole {
  if (typeof raw !== "string" || !Object.prototype.hasOwnProperty.call(PORTAL_ROLE_TO_PARTNER_ROLE, raw)) {
    throw new G5RequestError("VALIDATION_ERROR", "Unknown team role.");
  }
  return raw as PortalTeamRole;
}

function displayPortalRole(roleCodes: string[]): string {
  for (const code of PORTAL_ROLE_PRECEDENCE) {
    if (roleCodes.includes(code)) return PARTNER_ROLE_TO_PORTAL_ROLE[code];
  }
  for (const code of roleCodes) {
    if (UNSUPPORTED_ROLE_LABELS[code]) return UNSUPPORTED_ROLE_LABELS[code];
  }
  return "UNASSIGNED";
}

function forbidForeignPartnerIds(input: unknown, tenantId: string): void {
  const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  for (const key of ["tenantId", "tenant_id", "partnerId", "partner_id"]) {
    if (typeof body[key] === "string" && body[key] !== tenantId) {
      throw new G5RequestError("FORBIDDEN", "You can only manage your own partner account.");
    }
  }
}

async function actorRoles(c: PoolClient, actorUserId: string): Promise<Set<string>> {
  const { rows } = await c.query<{ code: string }>(
    `SELECT r.code
       FROM partner_user_roles ur
       JOIN partner_roles r ON r.id = ur.role_id
      WHERE ur.user_id=$1`,
    [actorUserId]
  );
  return new Set(rows.map((r) => r.code));
}

async function roleIdFor(c: PoolClient, roleCode: string): Promise<string> {
  const { rows } = await c.query<{ id: string }>("SELECT id FROM partner_roles WHERE code=$1", [roleCode]);
  if (rows.length !== 1) throw new G5RequestError("PARTNER_ROLE_NOT_CONFIGURED", "Partner role is not configured.");
  return rows[0].id;
}

async function loadTarget(c: PoolClient, userId: string) {
  const { rows } = await c.query<{
    id: string;
    email: string;
    status: string;
    role_codes: string[];
  }>(
    `SELECT u.id, u.email, u.status,
            COALESCE(array_agg(r.code ORDER BY r.code) FILTER (WHERE r.code IS NOT NULL), ARRAY[]::text[]) AS role_codes
       FROM partner_users u
       LEFT JOIN partner_user_roles ur ON ur.user_id = u.id
       LEFT JOIN partner_roles r ON r.id = ur.role_id
      WHERE u.id=$1
      GROUP BY u.id`,
    [userId]
  );
  if (rows.length !== 1) throw new G5RequestError("PARTNER_USER_NOT_FOUND", "Team member not found.");
  return rows[0];
}

async function activeOwnerCount(c: PoolClient, exceptUserId?: string): Promise<number> {
  const { rows } = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM partner_users u
       JOIN partner_user_roles ur ON ur.user_id = u.id
       JOIN partner_roles r ON r.id = ur.role_id
      WHERE u.status='ACTIVE'
        AND r.code='PARTNER_OWNER'
        AND ($1::uuid IS NULL OR u.id <> $1::uuid)`,
    [exceptUserId ?? null]
  );
  return rows[0]?.n ?? 0;
}

async function ensureCanRemoveOwner(c: PoolClient, targetId: string): Promise<void> {
  const target = await loadTarget(c, targetId);
  if (
    target.status === "ACTIVE" &&
    target.role_codes.includes("PARTNER_OWNER") &&
    (await activeOwnerCount(c, targetId)) === 0
  ) {
    throw new G5RequestError("FINAL_OWNER_REQUIRED", "A partner must keep at least one active owner.");
  }
}

async function assertActorMayManageTarget(
  c: PoolClient,
  actor: PartnerPrincipal,
  targetId: string,
  opts: { newRoleCode?: string; status?: string } = {}
): Promise<void> {
  const roles = await actorRoles(c, actor.userId);
  const isOwner = roles.has("PARTNER_OWNER");
  const isAdmin = roles.has("PARTNER_MANAGER");
  if (!isOwner && !isAdmin) throw new G5RequestError("FORBIDDEN", "You cannot manage team members.");
  const target = await loadTarget(c, targetId);
  const targetIsOwner = target.role_codes.includes("PARTNER_OWNER");
  if (opts.newRoleCode === "PARTNER_OWNER" && targetId === actor.userId) {
    throw new G5RequestError("FORBIDDEN", "You cannot promote yourself.");
  }
  if (!isOwner) {
    if (opts.newRoleCode === "PARTNER_OWNER")
      throw new G5RequestError("FORBIDDEN", "Admins cannot grant owner access.");
    if (targetIsOwner) throw new G5RequestError("FORBIDDEN", "Admins cannot modify owners.");
  }
  if (opts.newRoleCode && opts.newRoleCode !== "PARTNER_OWNER") await ensureCanRemoveOwner(c, targetId);
  if (opts.status && opts.status !== "ACTIVE") await ensureCanRemoveOwner(c, targetId);
}

interface PendingInvitationDelivery {
  email: string;
  token: string;
  partnerName: string;
  roleCode: string;
  expiresAt: Date;
}

async function createInvitationRecord(
  c: PoolClient,
  actor: PartnerPrincipal,
  userId: string,
  email: string,
  roleCode: string,
  action: string,
  reason: string
): Promise<{
  invitationId: string;
  deliveryStatus: string;
  delivery: PendingInvitationDelivery | null;
}> {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITE_HOURS * 60 * 60 * 1000);
  const previous = await c.query<{ id: string }>(
    `UPDATE partner_invitations
        SET status='REVOKED', revoked_at=now(), updated_at=now()
      WHERE user_id=$1 AND status = ANY($2::text[])
      RETURNING id`,
    [userId, ACTIVE_INVITE_STATUSES]
  );
  const inserted = await c.query<{ id: string; partner_name: string }>(
    `WITH ins AS (
       INSERT INTO partner_invitations
         (tenant_id, user_id, email, role_code, token_hash, invited_by_user_id, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id
     )
     SELECT ins.id, o.legal_name AS partner_name
       FROM ins, partner_organisations o
      WHERE o.id=$1`,
    [actor.tenantId, userId, email, roleCode, sha256(token), actor.userId, expiresAt]
  );
  if (previous.rows.length > 0) {
    await c.query("UPDATE partner_invitations SET superseded_by=$1 WHERE id = ANY($2::uuid[])", [
      inserted.rows[0].id,
      previous.rows.map((r) => r.id),
    ]);
  }
  const deliveryStatus = invitationDeliveryConfigured() ? "PENDING_DELIVERY" : "DELIVERY_NOT_CONFIGURED";
  await writePartnerAudit(c, {
    tenantId: actor.tenantId,
    actorUserId: actor.userId,
    sessionId: actor.sessionId,
    action,
    recordType: "partner_user",
    recordId: userId,
    after: { invitationId: inserted.rows[0].id, roleCode, deliveryStatus },
    reason,
  });
  return {
    invitationId: inserted.rows[0].id,
    deliveryStatus,
    delivery: invitationDeliveryConfigured()
      ? { email, token, partnerName: inserted.rows[0].partner_name, roleCode, expiresAt }
      : null,
  };
}

export async function deliverTeamInvitationAfterCommit(
  tenantId: string,
  invitationId: string,
  delivery: PendingInvitationDelivery | null
): Promise<void> {
  if (!delivery) return;
  try {
    await deliverInvitationToken(delivery);
    await withTenant({ tenantId }, (c) =>
      c.query(
        "UPDATE partner_invitations SET status='SENT', delivered_at=now(), delivery_error=NULL, updated_at=now() WHERE id=$1 AND status='PENDING'",
        [invitationId]
      )
    );
  } catch (err) {
    await withTenant({ tenantId }, (c) =>
      c.query(
        "UPDATE partner_invitations SET status='DELIVERY_FAILED', delivery_error=$2, updated_at=now() WHERE id=$1 AND status='PENDING'",
        [invitationId, (err as Error).message.slice(0, 500)]
      )
    );
  }
}

export async function listTeamMembers(c: PoolClient) {
  const { rows } = await c.query<{
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string;
    status: string;
    last_login_at: string | null;
    created_at: string;
    role_codes: string[];
    invitation_status: string | null;
    invitation_expires_at: string | null;
    invitation_delivered_at: string | null;
  }>(
    `SELECT u.id, u.first_name, u.last_name, u.email, u.status, u.last_login_at, u.created_at,
            COALESCE(json_agg(r.code ORDER BY r.code) FILTER (WHERE r.code IS NOT NULL), '[]') AS role_codes,
            li.status AS invitation_status, li.expires_at AS invitation_expires_at, li.delivered_at AS invitation_delivered_at
       FROM partner_users u
       LEFT JOIN partner_user_roles ur ON ur.user_id = u.id
       LEFT JOIN partner_roles r ON r.id = ur.role_id
       LEFT JOIN LATERAL (
         SELECT status, expires_at, delivered_at FROM partner_invitations i
          WHERE i.user_id = u.id
          ORDER BY i.created_at DESC LIMIT 1
       ) li ON true
      GROUP BY u.id, li.status, li.expires_at, li.delivered_at
      ORDER BY u.created_at DESC, u.email ASC
      LIMIT 500`
  );
  return rows.map((u) => ({
    id: u.id,
    firstName: u.first_name ?? "",
    lastName: u.last_name ?? "",
    email: u.email,
    status: u.status,
    role: displayPortalRole(u.role_codes ?? []),
    invitationStatus: u.invitation_status,
    invitationExpiresAt: u.invitation_expires_at,
    invitationDeliveredAt: u.invitation_delivered_at,
    lastLoginAt: u.last_login_at,
    createdAt: u.created_at,
  }));
}

export async function inviteTeamMember(c: PoolClient, actor: PartnerPrincipal, input: unknown, reason: string) {
  forbidForeignPartnerIds(input, actor.tenantId);
  const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const role = requirePortalTeamRole(body.role);
  const roleCode = PORTAL_ROLE_TO_PARTNER_ROLE[role];
  await assertActorMayManageTargetForInvite(c, actor, roleCode);
  const firstName = typeof body.firstName === "string" ? body.firstName.trim() : "";
  const lastName = typeof body.lastName === "string" ? body.lastName.trim() : "";
  const email = typeof body.email === "string" ? normaliseEmail(body.email) : "";
  if (!firstName || !lastName || !email) throw new G5RequestError("VALIDATION_ERROR", "Name and email are required.");
  const exists = await c.query("SELECT 1 FROM partner_users WHERE lower(email)=lower($1) LIMIT 1", [email]);
  if ((exists.rowCount ?? 0) > 0) {
    await writePartnerAudit(c, {
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      sessionId: actor.sessionId,
      action: "partner_user_invite_denied",
      recordType: "partner_user",
      reason: "ineligible email",
    });
    throw new G5RequestError("DUPLICATE_PARTNER_USER", "That team member cannot be invited.");
  }
  await writePartnerAudit(c, {
    tenantId: actor.tenantId,
    actorUserId: actor.userId,
    sessionId: actor.sessionId,
    action: "partner_user_invited",
    recordType: "partner_user",
    after: { email, roleCode },
    reason,
  });
  const user = await c.query<{ id: string }>(
    `INSERT INTO partner_users (tenant_id, partner_id, email, first_name, last_name, status, created_by)
     VALUES ($1,$1,$2,$3,$4,'INVITED',$5)
     RETURNING id`,
    [actor.tenantId, email, firstName, lastName, actor.userId]
  );
  await c.query("INSERT INTO partner_user_roles (tenant_id, user_id, role_id) VALUES ($1,$2,$3)", [
    actor.tenantId,
    user.rows[0].id,
    await roleIdFor(c, roleCode),
  ]);
  return {
    userId: user.rows[0].id,
    ...(await createInvitationRecord(c, actor, user.rows[0].id, email, roleCode, "partner_user_invited", reason)),
  };
}

async function assertActorMayManageTargetForInvite(c: PoolClient, actor: PartnerPrincipal, roleCode: string) {
  const roles = await actorRoles(c, actor.userId);
  if (!roles.has("PARTNER_OWNER") && !roles.has("PARTNER_MANAGER")) {
    throw new G5RequestError("FORBIDDEN", "You cannot invite team members.");
  }
  if (!roles.has("PARTNER_OWNER") && roleCode === "PARTNER_OWNER") {
    throw new G5RequestError("FORBIDDEN", "Admins cannot grant owner access.");
  }
}

export async function resendTeamInvitation(c: PoolClient, actor: PartnerPrincipal, userId: string, reason: string) {
  await assertActorMayManageTarget(c, actor, userId);
  const target = await loadTarget(c, userId);
  if (target.status !== "INVITED") {
    throw new G5RequestError("PARTNER_UNAVAILABLE", "Setup invitations are only available for invited accounts.");
  }
  const roleCode =
    PORTAL_ROLE_PRECEDENCE.find((code) => target.role_codes.includes(code)) ??
    target.role_codes[0] ??
    "PARTNER_RECEPTION";
  return createInvitationRecord(c, actor, target.id, target.email, roleCode, "partner_invitation_resent", reason);
}

export async function revokeTeamInvitation(c: PoolClient, actor: PartnerPrincipal, userId: string, reason: string) {
  await assertActorMayManageTarget(c, actor, userId);
  const target = await loadTarget(c, userId);
  const r = await c.query(
    `UPDATE partner_invitations
        SET status='REVOKED', revoked_at=now(), updated_at=now()
      WHERE user_id=$1 AND status = ANY($2::text[])`,
    [target.id, ACTIVE_INVITE_STATUSES]
  );
  await writePartnerAudit(c, {
    tenantId: actor.tenantId,
    actorUserId: actor.userId,
    sessionId: actor.sessionId,
    action: "partner_invitation_revoked",
    recordType: "partner_user",
    recordId: target.id,
    after: { revoked: r.rowCount ?? 0 },
    reason,
  });
  return { revoked: r.rowCount ?? 0 };
}

export async function changeTeamMemberRole(
  c: PoolClient,
  actor: PartnerPrincipal,
  userId: string,
  role: PortalTeamRole,
  reason: string
) {
  const roleCode = PORTAL_ROLE_TO_PARTNER_ROLE[role];
  await assertActorMayManageTarget(c, actor, userId, { newRoleCode: roleCode });
  await c.query("DELETE FROM partner_user_roles WHERE user_id=$1", [userId]);
  await c.query("INSERT INTO partner_user_roles (tenant_id, user_id, role_id) VALUES ($1,$2,$3)", [
    actor.tenantId,
    userId,
    await roleIdFor(c, roleCode),
  ]);
  await c.query("UPDATE partner_users SET credential_version=credential_version+1, updated_at=now() WHERE id=$1", [
    userId,
  ]);
  await c.query("UPDATE partner_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [userId]);
  await writePartnerAudit(c, {
    tenantId: actor.tenantId,
    actorUserId: actor.userId,
    sessionId: actor.sessionId,
    action: "partner_user_role_changed",
    recordType: "partner_user",
    recordId: userId,
    after: { roleCode },
    reason,
  });
  return { ok: true };
}

export async function setTeamMemberStatus(
  c: PoolClient,
  actor: PartnerPrincipal,
  userId: string,
  status: "ACTIVE" | "SUSPENDED" | "REVOKED",
  reason: string
) {
  const target = await loadTarget(c, userId);
  const allowed =
    target.status === status ||
    (target.status === "INVITED" && status === "REVOKED") ||
    (target.status === "ACTIVE" && (status === "SUSPENDED" || status === "REVOKED")) ||
    (target.status === "SUSPENDED" && (status === "ACTIVE" || status === "REVOKED"));
  if (!allowed || target.status === "REVOKED") {
    throw new G5RequestError("INVALID_STATUS_TRANSITION", "Team member status transition is not allowed.");
  }
  await assertActorMayManageTarget(c, actor, userId, { status });
  const r = await c.query(
    `UPDATE partner_users
        SET status=$2, credential_version=credential_version+1, updated_at=now()
      WHERE id=$1`,
    [userId, status]
  );
  if (r.rowCount !== 1) throw new G5RequestError("PARTNER_USER_NOT_FOUND", "Team member not found.");
  await c.query("UPDATE partner_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [userId]);
  const action =
    status === "ACTIVE"
      ? "partner_user_reactivated"
      : status === "SUSPENDED"
        ? "partner_user_suspended"
        : "partner_user_membership_removed";
  await writePartnerAudit(c, {
    tenantId: actor.tenantId,
    actorUserId: actor.userId,
    sessionId: actor.sessionId,
    action,
    recordType: "partner_user",
    recordId: userId,
    after: { status },
    reason,
  });
  return { ok: true };
}

export async function revokeTeamMemberSessions(c: PoolClient, actor: PartnerPrincipal, userId: string, reason: string) {
  await assertActorMayManageTarget(c, actor, userId);
  const target = await loadTarget(c, userId);
  const r = await c.query("UPDATE partner_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [
    target.id,
  ]);
  await writePartnerAudit(c, {
    tenantId: actor.tenantId,
    actorUserId: actor.userId,
    sessionId: actor.sessionId,
    action: "partner_user_sessions_revoked",
    recordType: "partner_user",
    recordId: target.id,
    after: { revoked: r.rowCount ?? 0 },
    reason,
  });
  return { revoked: r.rowCount ?? 0 };
}
