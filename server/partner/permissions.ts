/**
 * Partner Portal — RBAC (Phase 1). Granular permissions, not role-name checks.
 *
 * Roles + permissions + role→permission mappings live in the global reference tables
 * (partner_roles / partner_permissions / partner_role_permissions), seeded idempotently from the
 * canonical maps below (super-admin-managed; the partner runtime has SELECT only). A user's
 * effective permissions are the union over its assigned roles (partner_user_roles).
 */
import type { PoolClient } from "pg";
import { partnerAdminQuery } from "./db";
import { PARTNER_ROLE_CODES, type PartnerRoleCode } from "../../shared/partner-schema";

/** Minimum Phase 1 permission set. Later phases extend this. */
export const PARTNER_PERMISSIONS = [
  "partner.dashboard.view",
  "partner.organisation.view",
  "partner.location.view",
  "partner.users.view",
  "partner.users.manage",
  "partner.sessions.revoke",
  "partner.documents.view",
  "partner.training.view",
  "partner.credits.view",
  "partner.orders.view",
  "partner.orders.create",
  "partner.orders.edit",
  "partner.orders.submit",
  "partner.orders.cancel",
  "partner.cards.view",
  "partner.cards.receive",
  "partner.cards.scan",
  "partner.cards.assess",
  "partner.grading.view",
  "partner.certificates.view",
  "partner.corrections.view",
  "partner.corrections.respond",
  "partner.purchases.view",
  "partner.purchases.create",
  "partner.onboarding.view",
  "partner.support.view",
  "partner.support.create",
  "partner.invitations.manage",
  "partner.members.manage",
] as const;
export type PartnerPermission = (typeof PARTNER_PERMISSIONS)[number];

/** Canonical role → permission grants. Trainee is deliberately view-only (no live processing). */
export const ROLE_PERMISSIONS: Record<PartnerRoleCode, PartnerPermission[]> = {
  PARTNER_OWNER: [...PARTNER_PERMISSIONS],
  PARTNER_MANAGER: [
    "partner.dashboard.view",
    "partner.organisation.view",
    "partner.location.view",
    "partner.users.view",
    "partner.users.manage",
    "partner.sessions.revoke",
    "partner.documents.view",
    "partner.training.view",
    "partner.credits.view",
    "partner.orders.view",
    "partner.orders.create",
    "partner.orders.edit",
    "partner.orders.submit",
    "partner.orders.cancel",
    "partner.cards.view",
    "partner.cards.receive",
    "partner.cards.scan",
    "partner.cards.assess",
    "partner.grading.view",
    "partner.certificates.view",
    "partner.corrections.view",
    "partner.corrections.respond",
    "partner.purchases.view",
    "partner.purchases.create",
    "partner.onboarding.view",
    "partner.support.view",
    "partner.support.create",
    "partner.invitations.manage",
    "partner.members.manage",
  ],
  MVGS_ASSESSMENT_TECHNICIAN: [
    "partner.dashboard.view",
    "partner.location.view",
    "partner.documents.view",
    "partner.training.view",
    "partner.cards.view",
    "partner.cards.receive",
    "partner.cards.scan",
    "partner.cards.assess",
    "partner.grading.view",
    "partner.certificates.view",
    "partner.corrections.view",
    "partner.corrections.respond",
    "partner.support.view",
    "partner.support.create",
  ],
  PARTNER_RECEPTION: [
    "partner.dashboard.view",
    "partner.location.view",
    "partner.orders.view",
    "partner.orders.create",
    "partner.orders.edit",
    "partner.orders.submit",
    "partner.cards.view",
    "partner.cards.receive",
    "partner.certificates.view",
    "partner.corrections.view",
    "partner.corrections.respond",
    "partner.onboarding.view",
    "partner.support.view",
    "partner.support.create",
  ],
  PARTNER_FINANCE_VIEWER: [
    "partner.dashboard.view",
    "partner.organisation.view",
    "partner.credits.view",
    "partner.purchases.view",
    "partner.orders.view",
  ],
  PARTNER_TRAINEE: [
    "partner.dashboard.view",
    "partner.location.view",
    "partner.training.view",
    "partner.cards.view",
    "partner.documents.view",
    "partner.certificates.view",
    "partner.onboarding.view",
    "partner.support.view",
  ],
};

/**
 * Canonical database role labels. MVGS_ASSESSMENT_TECHNICIAN is intentionally retained for every
 * persisted value, permission check and audit record; the user-facing label is Partner Grader.
 */
export const PARTNER_ROLE_LABELS: Record<PartnerRoleCode, string> = {
  PARTNER_OWNER: "Partner Owner",
  PARTNER_MANAGER: "Partner Manager",
  MVGS_ASSESSMENT_TECHNICIAN: "Partner Grader",
  PARTNER_RECEPTION: "Reception",
  PARTNER_FINANCE_VIEWER: "Finance Viewer",
  PARTNER_TRAINEE: "Trainee",
};

/**
 * Separate authority hierarchy for assigning roles. Operational permissions are deliberately not
 * reused as an assignment hierarchy: a user may operate a workflow without gaining the ability to
 * grant it. Super Admin assignment bypasses this table in the dedicated Super Admin route only.
 */
export const ROLE_ASSIGNMENT_RULES: Record<PartnerRoleCode, readonly PartnerRoleCode[]> = {
  PARTNER_OWNER: [
    "PARTNER_MANAGER",
    "MVGS_ASSESSMENT_TECHNICIAN",
    "PARTNER_RECEPTION",
    "PARTNER_FINANCE_VIEWER",
    "PARTNER_TRAINEE",
  ],
  PARTNER_MANAGER: ["MVGS_ASSESSMENT_TECHNICIAN", "PARTNER_RECEPTION", "PARTNER_TRAINEE"],
  MVGS_ASSESSMENT_TECHNICIAN: [],
  PARTNER_RECEPTION: [],
  PARTNER_FINANCE_VIEWER: [],
  PARTNER_TRAINEE: [],
};

export function canAssignPartnerRole(assignerRoles: readonly string[], targetRole: PartnerRoleCode): boolean {
  return (
    assignerRoles.some((role): role is PartnerRoleCode => PARTNER_ROLE_CODES.includes(role as PartnerRoleCode)) &&
    assignerRoles.some((role) => {
      if (!PARTNER_ROLE_CODES.includes(role as PartnerRoleCode)) return false;
      return ROLE_ASSIGNMENT_RULES[role as PartnerRoleCode].includes(targetRole);
    })
  );
}

/**
 * Central future-route guard for Partner-scoped staff management. Assignment hierarchy is separate
 * from operational permissions, and no Partner user may change their own role.
 */
export function canManagePartnerRoleAssignment(input: {
  actorUserId: string;
  targetUserId: string;
  actorRoles: readonly string[];
  requestedRole: PartnerRoleCode;
}): boolean {
  if (input.actorUserId === input.targetUserId) return false;
  return canAssignPartnerRole(input.actorRoles, input.requestedRole);
}

/**
 * Idempotently seed the global reference tables (super-admin managed). Runs on the privileged
 * admin connection, not the tenant runtime. Safe to call repeatedly.
 */
export async function seedPartnerRbac(): Promise<void> {
  for (const code of PARTNER_ROLE_CODES) {
    await partnerAdminQuery(
      `INSERT INTO partner_roles (code, label) VALUES ($1,$2)
       ON CONFLICT (code) DO NOTHING`,
      [code, PARTNER_ROLE_LABELS[code]]
    );
  }
  for (const perm of PARTNER_PERMISSIONS) {
    await partnerAdminQuery(
      `INSERT INTO partner_permissions (code, label) VALUES ($1,$1)
       ON CONFLICT (code) DO NOTHING`,
      [perm]
    );
  }
  for (const code of PARTNER_ROLE_CODES) {
    for (const perm of ROLE_PERMISSIONS[code]) {
      await partnerAdminQuery(
        `INSERT INTO partner_role_permissions (role_id, permission_id)
         SELECT r.id, p.id FROM partner_roles r, partner_permissions p
         WHERE r.code=$1 AND p.code=$2
         ON CONFLICT DO NOTHING`,
        [code, perm]
      );
    }
  }
}

/** Effective permissions for a user, resolved from DB (union over assigned roles). */
export async function getUserPermissions(client: PoolClient, userId: string): Promise<Set<string>> {
  const { rows } = await client.query<{ code: string }>(
    `SELECT DISTINCT p.code
       FROM partner_user_roles ur
       JOIN partner_role_permissions rp ON rp.role_id = ur.role_id
       JOIN partner_permissions p ON p.id = rp.permission_id
      WHERE ur.user_id = $1`,
    [userId]
  );
  return new Set(rows.map((r) => r.code));
}

/** Roles for a user (for display / policy). */
export async function getUserRoles(client: PoolClient, userId: string): Promise<string[]> {
  const { rows } = await client.query<{ code: string }>(
    `SELECT r.code FROM partner_user_roles ur JOIN partner_roles r ON r.id = ur.role_id WHERE ur.user_id=$1`,
    [userId]
  );
  return rows.map((r) => r.code);
}
