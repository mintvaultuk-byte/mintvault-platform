/**
 * Partner Master Dashboard — cross-tenant READ visibility precondition (fail closed).
 *
 * WHY THIS EXISTS
 * ---------------
 * Every tenant-scoped partner table is created with ENABLE + **FORCE** ROW LEVEL SECURITY
 * (migrations/0001_partner_foundation.sql, 0016_partner_wallet_ledger.sql,
 * 0017_partner_credit_reservations.sql). `FORCE` means the policy applies to the table OWNER as
 * well — only a superuser or a role carrying the BYPASSRLS attribute is exempt. The dashboard's
 * pool (`partnerAdminQuery`) deliberately sets no tenant context, because a Super Admin read is
 * cross-tenant by definition.
 *
 * If the configured role can neither bypass RLS nor supply a tenant context, EVERY partner query
 * returns zero rows. That is indistinguishable, at the SQL level, from a genuinely empty network:
 * `SELECT count(*)` still returns one row containing 0, and `SUM(...)` still returns one row
 * containing NULL→0. Rendering that as "0 shops / 0 credits / no alerts" would be a confident lie
 * on a surface used to make credit and risk decisions.
 *
 * So the dashboard asks the CATALOGUE — not the data — whether the current role is actually able
 * to see partner rows, and fails closed with a typed reason when it cannot.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 *   - does not weaken, disable or bypass RLS
 *   - does not set `app.tenant_id` to fabricate a tenant context
 *   - does not create a SECURITY DEFINER function
 *   - does not GRANT anything
 * Provisioning an approved cross-tenant read role stays a deployment concern (see
 * migrations/0006_partner_definer_role.sql, which refuses to run without elevated authority).
 */
import { partnerAdminQuery } from "./db";

/** Typed reasons the dashboard can be unavailable. Surfaced to the client verbatim. */
export type VisibilityFailureCode = "PARTNER_ADMIN_RLS_VISIBILITY_UNAVAILABLE" | "PARTNER_ADMIN_SCHEMA_UNAVAILABLE";

export type PartnerReadVisibility =
  | { ok: true; walletSchema: boolean }
  | { ok: false; code: VisibilityFailureCode; message: string };

export type PartnerStationReadVisibility =
  | { ok: true; profileRevisionSchema: boolean }
  | { ok: false; code: VisibilityFailureCode };

/**
 * Relations the dashboard cannot work without. If one is missing the deployment is mid-migration
 * (or pointed at the wrong database) and zeros would again be a lie.
 */
export const REQUIRED_RELATIONS = [
  "partner_organisations",
  "partner_profiles",
  "partner_locations",
  "partner_users",
  "partner_user_roles",
  "partner_roles",
  "partner_sessions",
  "partner_submissions",
  "partner_connector_records",
  "partner_connector_admin_actions",
  "partner_security_events",
  "partner_emergency_controls",
  "partner_audit_events",
  "partner_management_audit",
] as const;

/**
 * Wallet relations (0016/0017). OPTIONAL: an environment without them still gets a fully working
 * dashboard, with wallet figures reported as unavailable rather than as zero.
 */
export const WALLET_RELATIONS = [
  "partner_wallets",
  "partner_credit_ledger",
  "partner_credit_reservations",
  "partner_credit_availability",
] as const;

interface RelRow {
  relname: string;
  relkind: string;
  relrowsecurity: boolean;
  relforcerowsecurity: boolean;
  owner: string;
  profile_revision_schema?: boolean;
}

interface RoleRow {
  role_name: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
}

/**
 * Postgres' own rule, restated: row security is applied to the current role for relation `r` when
 * RLS is enabled on it, the role is neither superuser nor BYPASSRLS, and either the role does not
 * own the table or the table is FORCE'd (which removes the owner exemption).
 *
 * Views are excluded: `partner_credit_availability` is `security_invoker = true`, so its access is
 * governed by the RLS of the base tables, which are checked in their own right.
 */
export function rlsBlocks(rel: RelRow, role: RoleRow): boolean {
  if (rel.relkind !== "r" && rel.relkind !== "p") return false;
  if (!rel.relrowsecurity) return false;
  if (role.rolsuper || role.rolbypassrls) return false;
  return rel.relforcerowsecurity || rel.owner !== role.role_name;
}

async function probe(): Promise<PartnerReadVisibility> {
  const names = [...REQUIRED_RELATIONS, ...WALLET_RELATIONS];

  const [roleRes, relRes] = await Promise.all([
    partnerAdminQuery<RoleRow>(
      `SELECT current_user::text AS role_name,
              COALESCE(rolsuper, false)     AS rolsuper,
              COALESCE(rolbypassrls, false) AS rolbypassrls
         FROM pg_roles WHERE rolname = current_user`
    ),
    partnerAdminQuery<RelRow>(
      `SELECT c.relname::text                        AS relname,
              c.relkind::text                        AS relkind,
              COALESCE(c.relrowsecurity, false)      AS relrowsecurity,
              COALESCE(c.relforcerowsecurity, false) AS relforcerowsecurity,
              pg_get_userbyid(c.relowner)::text      AS owner
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
      [names]
    ),
  ]);

  // A role that cannot even read pg_roles for itself is too broken to trust with a zero.
  const role = roleRes.rows[0] ?? { role_name: "unknown", rolsuper: false, rolbypassrls: false };
  const byName = new Map(relRes.rows.map((r) => [r.relname, r]));

  const missingRequired = REQUIRED_RELATIONS.filter((n) => !byName.has(n));
  if (missingRequired.length > 0) {
    return {
      ok: false,
      code: "PARTNER_ADMIN_SCHEMA_UNAVAILABLE",
      message:
        "Partner data is unavailable: the partner network schema is not fully present in the " +
        "configured database. Required tables are missing, so no partner figures can be shown.",
    };
  }

  // Only the REQUIRED set gates the dashboard. Wallet relations degrade independently.
  const blockedRequired = REQUIRED_RELATIONS.filter((n) => {
    const rel = byName.get(n);
    return rel ? rlsBlocks(rel, role) : false;
  });

  if (blockedRequired.length > 0) {
    return {
      ok: false,
      code: "PARTNER_ADMIN_RLS_VISIBILITY_UNAVAILABLE",
      message:
        "Partner data is unavailable: the configured admin database role cannot perform " +
        "cross-tenant reads of the partner tables, so every query would return an empty result " +
        "that is indistinguishable from a genuinely empty network. No figures are shown rather " +
        "than showing zeros that may be wrong. This is a deployment configuration issue.",
    };
  }

  const walletSchema =
    WALLET_RELATIONS.every((n) => byName.has(n)) &&
    !WALLET_RELATIONS.some((n) => {
      const rel = byName.get(n);
      return rel ? rlsBlocks(rel, role) : false;
    });

  return { ok: true, walletSchema };
}

// ---------------------------------------------------------------------------
// Caching. The catalogue does not change at runtime, so a success is cached for a while; a
// failure is cached only briefly so that fixing the deployment role recovers without a restart.
// ---------------------------------------------------------------------------

const OK_TTL_MS = 5 * 60_000;
const FAIL_TTL_MS = 10_000;

let cached: { value: PartnerReadVisibility; expiresAt: number } | null = null;
let inFlight: Promise<PartnerReadVisibility> | null = null;

/** Test seam — clears the memoised probe so a suite can re-evaluate under a different role. */
export function resetPartnerReadVisibilityCache(): void {
  cached = null;
  inFlight = null;
}

/**
 * Resolve (and memoise) whether the configured role can perform the dashboard's cross-tenant
 * reads. A genuine connection/query failure is allowed to THROW: that is a 500, not a silent
 * "unavailable", and must not be cached.
 */
export async function getPartnerReadVisibility(): Promise<PartnerReadVisibility> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;
  if (inFlight) return inFlight;

  inFlight = probe()
    .then((value) => {
      cached = { value, expiresAt: Date.now() + (value.ok ? OK_TTL_MS : FAIL_TTL_MS) };
      return value;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/**
 * Station lifecycle is intentionally an independent optional dashboard source.
 * The main Partner dashboard predates stations and must not be made unavailable
 * by an absent station migration; Command Centre nevertheless must prove this
 * FORCE-RLS table is readable before an aggregate zero can be trusted.
 */
export async function getPartnerStationReadVisibility(): Promise<PartnerStationReadVisibility> {
  const [roleRes, relationRes] = await Promise.all([
    partnerAdminQuery<RoleRow>(
      `SELECT current_user::text AS role_name,
              COALESCE(rolsuper, false) AS rolsuper,
              COALESCE(rolbypassrls, false) AS rolbypassrls
         FROM pg_roles WHERE rolname = current_user`,
    ),
    partnerAdminQuery<RelRow>(
      `SELECT c.relname::text AS relname, c.relkind::text AS relkind,
              COALESCE(c.relrowsecurity, false) AS relrowsecurity,
              COALESCE(c.relforcerowsecurity, false) AS relforcerowsecurity,
              pg_get_userbyid(c.relowner)::text AS owner,
              EXISTS (
                SELECT 1 FROM pg_attribute a
                 WHERE a.attrelid = c.oid
                   AND a.attname = 'current_profile_revision_id'
                   AND a.attnum > 0
                   AND NOT a.attisdropped
              ) AS profile_revision_schema
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'partner_stations'`,
    ),
  ]);
  const relation = relationRes.rows[0];
  if (!relation) return { ok: false, code: "PARTNER_ADMIN_SCHEMA_UNAVAILABLE" };
  const role = roleRes.rows[0] ?? { role_name: "unknown", rolsuper: false, rolbypassrls: false };
  return rlsBlocks(relation, role)
    ? { ok: false, code: "PARTNER_ADMIN_RLS_VISIBILITY_UNAVAILABLE" }
    : { ok: true, profileRevisionSchema: relation.profile_revision_schema === true };
}
