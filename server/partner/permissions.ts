/**
 * Partner Portal — RBAC (Phase 1). Granular permissions, not role-name checks.
 *
 * Roles + permissions + role→permission mappings live in the global reference tables
 * (partner_roles / partner_permissions / partner_role_permissions), seeded idempotently from the
 * canonical maps below (super-admin-managed; the partner runtime has SELECT only). A user's
 * effective permissions are the union over its assigned roles (partner_user_roles).
 */
import type { PoolClient } from "pg";
import { partnerAdminQuery, partnerAdminDbConfigured } from "./db";
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
    "partner.support.view",
    "partner.support.create",
  ],
  PARTNER_FINANCE_VIEWER: [
    "partner.dashboard.view",
    "partner.organisation.view",
    "partner.credits.view",
    "partner.orders.view",
  ],
  PARTNER_TRAINEE: [
    "partner.dashboard.view",
    "partner.location.view",
    "partner.training.view",
    "partner.cards.view",
    "partner.documents.view",
    "partner.support.view",
  ],
};

/**
 * Human labels for each role. Exported so migrations/0034_partner_rbac_seed.sql can be pinned
 * against this map by tests/partner-rbac-parity.test.ts — the seed SQL and this module are two
 * renderings of ONE canonical definition, and that parity test is what keeps them one.
 */
export const ROLE_LABELS: Record<PartnerRoleCode, string> = {
  PARTNER_OWNER: "Partner Owner",
  PARTNER_MANAGER: "Partner Manager",
  MVGS_ASSESSMENT_TECHNICIAN: "MVGS Assessment Technician",
  PARTNER_RECEPTION: "Reception",
  PARTNER_FINANCE_VIEWER: "Finance Viewer",
  PARTNER_TRAINEE: "Trainee",
};

/**
 * TEST-ONLY. Idempotently seed the global reference tables.
 *
 * ⚠️ THIS MUST NEVER BE CALLED FROM PRODUCTION CODE. ⚠️
 *
 * The canonical initial catalogue is seeded by migrations/0034_partner_rbac_seed.sql, under the
 * numbered migration runner. Application startup performs READ-ONLY validation only
 * (validatePartnerRbac). Runtime application identities do not mutate the Partner security
 * catalogue — on production the only available identity is `neondb_owner`, which owns these tables
 * and holds BYPASSRLS, so seeding through it would let the app rewrite its own authorisation data.
 *
 * This helper survives ONLY because ~13 test suites build a catalogue in their fixtures. It is
 * retained for those fixtures and is guarded below so a production call site cannot be added by
 * accident. See docs/partner-rbac-change-policy.md.
 */
export async function seedPartnerRbac(): Promise<void> {
  // Fail closed if this is ever reached outside a test runner. `vitest` sets VITEST; NODE_ENV is
  // "test" under the suite. Throwing here converts "someone re-wired the seed into boot" from a
  // silent security-catalogue write into an immediate, loud failure.
  if (process.env.NODE_ENV === "production" || (!process.env.VITEST && process.env.NODE_ENV !== "test")) {
    throw new Error(
      "seedPartnerRbac() is test-only. The Partner RBAC catalogue is seeded by migration 0034; " +
        "production startup validates read-only via validatePartnerRbac(). See docs/partner-rbac-change-policy.md."
    );
  }
  return seedPartnerRbacUnguarded();
}

async function seedPartnerRbacUnguarded(): Promise<void> {
  for (const code of PARTNER_ROLE_CODES) {
    await partnerAdminQuery(
      `INSERT INTO partner_roles (code, label) VALUES ($1,$2)
       ON CONFLICT (code) DO NOTHING`,
      [code, ROLE_LABELS[code]]
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

/**
 * Partner RBAC state, as observed by READ-ONLY validation.
 *
 * `state` semantics:
 *   not_configured — no partner admin database configured at all. NOT automatically healthy: see
 *                    partnerRbacBlocksReadiness(), which treats it as a fault whenever any Partner
 *                    flag is enabled, because a live Partner surface with no catalogue cannot work.
 *   pending        — boot ran, the first validation has not completed yet
 *   ready          — the catalogue is COMPLETE: every canonical role, permission and mapping present
 *   incomplete     — the catalogue exists but is missing required entries; the fix is to apply the
 *                    pending Partner RBAC migration (0034)
 *   unavailable    — the database could not be reached or read; detail is logged server-side only
 */
export type PartnerRbacState = "not_configured" | "pending" | "ready" | "incomplete" | "unavailable";

/**
 * Fixed, non-leaking failure codes. These are the ONLY values that reach an HTTP response, so no raw
 * database error text, schema detail or secret can escape through the readiness surface.
 */
export type PartnerRbacFailureCode = "PARTNER_RBAC_NOT_SEEDED" | "PARTNER_RBAC_UNAVAILABLE" | null;

export interface PartnerRbacStatus {
  state: PartnerRbacState;
  /** Fixed enum, safe to return over HTTP. */
  failureCode: PartnerRbacFailureCode;
  /** Operator-facing remedy. Static strings only — never interpolated with database output. */
  remedy: string | null;
  /** Counts of MISSING canonical entries. Zero-valued when ready; null when not measurable. */
  missing: { roles: number; permissions: number; mappings: number } | null;
  /** Catalogue rows present but unknown to the canonical map. Reported, never removed. */
  unexpected: { roles: number; permissions: number } | null;
  checkedAt: string | null;
}

let rbacState: PartnerRbacStatus = {
  state: "pending",
  failureCode: null,
  remedy: null,
  missing: null,
  unexpected: null,
  checkedAt: null,
};

/** Read-only snapshot for the readiness endpoint. Never throws. */
export function getPartnerRbacStatus(): PartnerRbacStatus {
  return { ...rbacState };
}

const REMEDY_NOT_SEEDED = "Apply the pending Partner RBAC migration (0034_partner_rbac_seed.sql).";
const REMEDY_UNAVAILABLE = "Partner RBAC database is unreachable. Check the partner admin database configuration.";

/**
 * READ-ONLY validation of the Partner RBAC catalogue. Never inserts, updates, deletes, reconciles,
 * revokes or repairs anything — a runtime application identity must not mutate the Partner security
 * catalogue (owner decision, 2026-07-31). Production's only identity is `neondb_owner`, which owns
 * these tables and holds BYPASSRLS; letting boot code write through it would let the application
 * rewrite its own authorisation data.
 *
 * Every canonical role, permission AND mapping is checked — not merely PARTNER_OWNER's existence.
 * A catalogue holding the role but missing its grants would resolve the first invitation and then
 * silently under-grant every permission check, which is the harder failure to notice.
 *
 * The whole check is ONE round trip against the canonical maps passed as arrays, so it costs a
 * single query per probe. Never throws: on any failure it records `unavailable` and returns.
 */
export async function validatePartnerRbac(): Promise<PartnerRbacStatus> {
  const now = () => new Date().toISOString();

  // MUST match partnerAdminQuery's own resolution (PARTNER_ADMIN_DATABASE_URL || MINTVAULT_DATABASE_URL).
  // Gating on the pinned URL alone reported "not configured" for a documented, working configuration
  // in which invitations run but RBAC was never seeded.
  if (!partnerAdminDbConfigured()) {
    rbacState = {
      state: "not_configured",
      failureCode: null,
      remedy: null,
      missing: null,
      unexpected: null,
      checkedAt: now(),
    };
    return getPartnerRbacStatus();
  }

  const roleCodes = [...PARTNER_ROLE_CODES];
  const roleLabels = roleCodes.map((c) => ROLE_LABELS[c]);
  const permCodes = [...PARTNER_PERMISSIONS];
  const mapRoles: string[] = [];
  const mapPerms: string[] = [];
  for (const code of roleCodes) {
    for (const perm of ROLE_PERMISSIONS[code]) {
      mapRoles.push(code);
      mapPerms.push(perm);
    }
  }

  try {
    const { rows } = await partnerAdminQuery<{
      missing_roles: string;
      missing_permissions: string;
      missing_mappings: string;
      unexpected_roles: string;
      unexpected_permissions: string;
    }>(
      `WITH want_roles AS (SELECT * FROM unnest($1::text[], $2::text[]) AS t(code, label)),
            want_perms AS (SELECT * FROM unnest($3::text[]) AS t(code)),
            want_maps  AS (SELECT * FROM unnest($4::text[], $5::text[]) AS t(role_code, permission_code))
       SELECT
         (SELECT count(*) FROM want_roles w
           WHERE NOT EXISTS (SELECT 1 FROM partner_roles r WHERE r.code = w.code AND r.label = w.label)
         )::text AS missing_roles,
         (SELECT count(*) FROM want_perms w
           WHERE NOT EXISTS (SELECT 1 FROM partner_permissions p WHERE p.code = w.code)
         )::text AS missing_permissions,
         (SELECT count(*) FROM want_maps w
           WHERE NOT EXISTS (
             SELECT 1 FROM partner_role_permissions rp
               JOIN partner_roles r ON r.id = rp.role_id
               JOIN partner_permissions p ON p.id = rp.permission_id
              WHERE r.code = w.role_code AND p.code = w.permission_code)
         )::text AS missing_mappings,
         (SELECT count(*) FROM partner_roles r
           WHERE NOT EXISTS (SELECT 1 FROM want_roles w WHERE w.code = r.code)
         )::text AS unexpected_roles,
         (SELECT count(*) FROM partner_permissions p
           WHERE NOT EXISTS (SELECT 1 FROM want_perms w WHERE w.code = p.code)
         )::text AS unexpected_permissions`,
      [roleCodes, roleLabels, permCodes, mapRoles, mapPerms]
    );

    const missing = {
      roles: Number(rows[0]?.missing_roles ?? "0"),
      permissions: Number(rows[0]?.missing_permissions ?? "0"),
      mappings: Number(rows[0]?.missing_mappings ?? "0"),
    };
    const unexpected = {
      roles: Number(rows[0]?.unexpected_roles ?? "0"),
      permissions: Number(rows[0]?.unexpected_permissions ?? "0"),
    };
    const complete = missing.roles === 0 && missing.permissions === 0 && missing.mappings === 0;

    rbacState = {
      state: complete ? "ready" : "incomplete",
      failureCode: complete ? null : "PARTNER_RBAC_NOT_SEEDED",
      remedy: complete ? null : REMEDY_NOT_SEEDED,
      missing,
      unexpected,
      checkedAt: now(),
    };

    if (!complete) {
      console.error(
        `[partner-rbac] CATALOGUE INCOMPLETE — missing ${missing.roles} role(s), ${missing.permissions} permission(s), ` +
          `${missing.mappings} mapping(s). Partner invitations and permission checks will misbehave until ` +
          "migration 0034_partner_rbac_seed.sql is applied."
      );
    } else if (unexpected.roles > 0 || unexpected.permissions > 0) {
      // Reported, never removed. Revocation is a deliberate act and belongs in a numbered migration.
      console.warn(
        `[partner-rbac] catalogue complete, but ${unexpected.roles} unexpected role(s) and ` +
          `${unexpected.permissions} unexpected permission(s) are present. Left untouched by design.`
      );
    }
  } catch (err) {
    // Detail is logged SERVER-SIDE ONLY. The HTTP surface gets a fixed code and a static remedy, so
    // no database error text, schema detail or connection string can leak through readiness.
    rbacState = {
      state: "unavailable",
      failureCode: "PARTNER_RBAC_UNAVAILABLE",
      remedy: REMEDY_UNAVAILABLE,
      missing: null,
      unexpected: null,
      checkedAt: now(),
    };
    console.error(
      "[partner-rbac] validation could not read the catalogue:",
      (err as { message?: string })?.message ?? err
    );
  }

  return getPartnerRbacStatus();
}

/**
 * Should the current RBAC state fail the PARTNER-SPECIFIC readiness probe?
 *
 * `not_configured` is healthy ONLY while the Partner surface is entirely switched off. Once any of
 * the Partner flags is enabled, an absent catalogue is a fault: the product is advertising a Partner
 * surface it cannot actually serve. Treating not_configured as unconditionally healthy is precisely
 * how the original blocker stayed invisible.
 *
 * The core /ready probe is deliberately unaffected by any of this — a Partner reference-data fault
 * must never take grading or certificates out of service.
 */
export function partnerRbacBlocksReadiness(state: PartnerRbacState, partnerSurfaceEnabled: boolean): boolean {
  if (state === "ready") return false;
  if (state === "not_configured") return partnerSurfaceEnabled;
  return true;
}

/**
 * Boot-time READ-ONLY validation. Fire-and-forget; never throws; writes nothing.
 *
 * Mirrors startConnectorRuntime's fail-soft shape — a Partner reference-data problem must never
 * crash or delay the main MintVault app — but unlike the bootstrap it replaced, a bad outcome is
 * visible on the partner readiness endpoint rather than only in a log line.
 */
export function validatePartnerRbacAtBoot(): void {
  void (async () => {
    const status = await validatePartnerRbac();
    if (status.state === "ready") {
      console.log("[partner-rbac] catalogue validated: complete");
    } else if (status.state === "not_configured") {
      console.log("[partner-rbac] no partner admin database configured — validation skipped (partner surface is off)");
    }
    // "incomplete" and "unavailable" already logged loudly inside validatePartnerRbac().
  })();
}
