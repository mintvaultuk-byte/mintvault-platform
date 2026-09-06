import type pg from "pg";
import { partnerAdminQuery, partnerRuntimeQuery } from "./db";

export const PARTNER_ADMIN_CAPABILITY = "partner_admin_bypassrls" as const;
export const PARTNER_RUNTIME_CAPABILITY = "partner_runtime_no_bypassrls" as const;

export type PartnerCapabilityFailureCode =
  | "PARTNER_ADMIN_DB_UNAVAILABLE"
  | "PART_ROLE_LOOKUP_EMPTY"
  | "PARTNER_ADMIN_BYPASSRLS_REQUIRED"
  | "PARTNER_RUNTIME_SUPERUSER_FORBIDDEN"
  | "PARTNER_RUNTIME_BYPASSRLS_FORBIDDEN"
  | "PARTNER_CAPABILITY_TIMEOUT";

export type PartnerCapabilityResult =
  | {
      ok: true;
      checkedAt: string;
      capability: typeof PARTNER_ADMIN_CAPABILITY | typeof PARTNER_RUNTIME_CAPABILITY;
    }
  | {
      ok: false;
      checkedAt: string;
      capability: typeof PARTNER_ADMIN_CAPABILITY | typeof PARTNER_RUNTIME_CAPABILITY;
      code: PartnerCapabilityFailureCode;
    };

type QueryFn = <T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params?: unknown[]
) => Promise<pg.QueryResult<T>>;

interface RoleCapabilityRow extends pg.QueryResultRow {
  has_role: boolean;
  rolsuper: boolean;
  rolbypassrls: boolean;
}

const ROLE_CAPABILITY_SQL = `
  SELECT EXISTS (
           SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user
         ) AS has_role,
         COALESCE((
           SELECT rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = current_user
         ), false) AS rolbypassrls,
         COALESCE((
           SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user
         ), false) AS rolsuper
`;

const DEFAULT_TIMEOUT_MS = 2_000;

let cachedAdminSuccess: PartnerCapabilityResult | null = null;
let lastAdminResult: PartnerCapabilityResult | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function timeoutResult(
  capability: PartnerCapabilityResult["capability"],
  timeoutMs: number
): Promise<PartnerCapabilityResult> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        ok: false,
        checkedAt: nowIso(),
        capability,
        code: "PARTNER_CAPABILITY_TIMEOUT",
      });
    }, timeoutMs).unref?.();
  });
}

async function checkRoleCapability(
  query: QueryFn,
  capability: PartnerCapabilityResult["capability"],
  expectedBypassRls: boolean,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<PartnerCapabilityResult> {
  const work = (async (): Promise<PartnerCapabilityResult> => {
    try {
      const { rows } = await query<RoleCapabilityRow>(ROLE_CAPABILITY_SQL, []);
      const row = rows[0];
      if (!row?.has_role) {
        return { ok: false, checkedAt: nowIso(), capability, code: "PART_ROLE_LOOKUP_EMPTY" };
      }
      if (capability === PARTNER_RUNTIME_CAPABILITY && Boolean(row.rolsuper)) {
        return {
          ok: false,
          checkedAt: nowIso(),
          capability,
          code: "PARTNER_RUNTIME_SUPERUSER_FORBIDDEN",
        };
      }
      if (Boolean(row.rolbypassrls) !== expectedBypassRls) {
        return {
          ok: false,
          checkedAt: nowIso(),
          capability,
          code: expectedBypassRls ? "PARTNER_ADMIN_BYPASSRLS_REQUIRED" : "PARTNER_RUNTIME_BYPASSRLS_FORBIDDEN",
        };
      }
      return { ok: true, checkedAt: nowIso(), capability };
    } catch {
      return { ok: false, checkedAt: nowIso(), capability, code: "PARTNER_ADMIN_DB_UNAVAILABLE" };
    }
  })();
  return Promise.race([work, timeoutResult(capability, timeoutMs)]);
}

export async function probePartnerAdminCapabilityForTest(
  query: QueryFn,
  timeoutMs?: number
): Promise<PartnerCapabilityResult> {
  return checkRoleCapability(query, PARTNER_ADMIN_CAPABILITY, true, timeoutMs);
}

export async function probePartnerRuntimeCapabilityForTest(
  query: QueryFn,
  timeoutMs?: number
): Promise<PartnerCapabilityResult> {
  return checkRoleCapability(query, PARTNER_RUNTIME_CAPABILITY, false, timeoutMs);
}

export function resetPartnerAdminCapabilityCache(): void {
  cachedAdminSuccess = null;
  lastAdminResult = null;
}

export async function getPartnerAdminCapability(): Promise<PartnerCapabilityResult> {
  if (cachedAdminSuccess?.ok) return cachedAdminSuccess;
  const result = await checkRoleCapability(partnerAdminQuery, PARTNER_ADMIN_CAPABILITY, true);
  lastAdminResult = result;
  if (result.ok) cachedAdminSuccess = result;
  return result;
}

export function getLastPartnerAdminCapability(): PartnerCapabilityResult | null {
  return cachedAdminSuccess ?? lastAdminResult;
}

export async function getPartnerRuntimeCapability(): Promise<PartnerCapabilityResult> {
  return checkRoleCapability(partnerRuntimeQuery, PARTNER_RUNTIME_CAPABILITY, false);
}
