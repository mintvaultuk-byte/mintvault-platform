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
  "partner.support.view",
  "partner.support.create",
] as const;
export type PartnerPermission = (typeof PARTNER_PERMISSIONS)[number];

/** Canonical role → permission grants. Trainee is deliberately view-only (no live processing). */
export const ROLE_PERMISSIONS: Record<PartnerRoleCode, PartnerPermission[]> = {
  PARTNER_OWNER: [...PARTNER_PERMISSIONS],
  PARTNER_MANAGER: [
    "partner.dashboard.view", "partner.organisation.view", "partner.location.view",
    "partner.users.view", "partner.users.manage", "partner.sessions.revoke", "partner.documents.view",
    "partner.training.view", "partner.credits.view", "partner.orders.view", "partner.orders.create",
    "partner.orders.edit", "partner.orders.submit", "partner.orders.cancel",
    "partner.cards.view", "partner.cards.receive", "partner.cards.scan", "partner.cards.assess",
    "partner.support.view", "partner.support.create",
  ],
  MVGS_ASSESSMENT_TECHNICIAN: [
    "partner.dashboard.view", "partner.location.view", "partner.documents.view", "partner.training.view",
    "partner.cards.view", "partner.cards.receive", "partner.cards.scan", "partner.cards.assess",
    "partner.support.view", "partner.support.create",
  ],
  PARTNER_RECEPTION: [
    "partner.dashboard.view", "partner.location.view", "partner.orders.view", "partner.orders.create",
    "partner.orders.edit", "partner.orders.submit",
    "partner.cards.view", "partner.cards.receive", "partner.support.view", "partner.support.create",
  ],
  PARTNER_FINANCE_VIEWER: [
    "partner.dashboard.view", "partner.organisation.view", "partner.credits.view", "partner.orders.view",
  ],
  PARTNER_TRAINEE: [
    "partner.dashboard.view", "partner.location.view", "partner.training.view", "partner.cards.view",
    "partner.documents.view", "partner.support.view",
  ],
};

const ROLE_LABELS: Record<PartnerRoleCode, string> = {
  PARTNER_OWNER: "Partner Owner",
  PARTNER_MANAGER: "Partner Manager",
  MVGS_ASSESSMENT_TECHNICIAN: "MVGS Assessment Technician",
  PARTNER_RECEPTION: "Reception",
  PARTNER_FINANCE_VIEWER: "Finance Viewer",
  PARTNER_TRAINEE: "Trainee",
};

/**
 * Idempotently seed the global reference tables (super-admin managed). Runs on the privileged
 * admin connection, not the tenant runtime. Safe to call repeatedly.
 */
export async function seedPartnerRbac(): Promise<void> {
  for (const code of PARTNER_ROLE_CODES) {
    await partnerAdminQuery(
      `INSERT INTO partner_roles (code, label) VALUES ($1,$2)
       ON CONFLICT (code) DO NOTHING`,
      [code, ROLE_LABELS[code]],
    );
  }
  for (const perm of PARTNER_PERMISSIONS) {
    await partnerAdminQuery(
      `INSERT INTO partner_permissions (code, label) VALUES ($1,$1)
       ON CONFLICT (code) DO NOTHING`,
      [perm],
    );
  }
  for (const code of PARTNER_ROLE_CODES) {
    for (const perm of ROLE_PERMISSIONS[code]) {
      await partnerAdminQuery(
        `INSERT INTO partner_role_permissions (role_id, permission_id)
         SELECT r.id, p.id FROM partner_roles r, partner_permissions p
         WHERE r.code=$1 AND p.code=$2
         ON CONFLICT DO NOTHING`,
        [code, perm],
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
    [userId],
  );
  return new Set(rows.map((r) => r.code));
}

/** Roles for a user (for display / policy). */
export async function getUserRoles(client: PoolClient, userId: string): Promise<string[]> {
  const { rows } = await client.query<{ code: string }>(
    `SELECT r.code FROM partner_user_roles ur JOIN partner_roles r ON r.id = ur.role_id WHERE ur.user_id=$1`,
    [userId],
  );
  return rows.map((r) => r.code);
}
