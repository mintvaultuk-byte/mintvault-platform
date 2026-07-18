/**
 * Partner Portal — feature flags (Phase 1, fail-closed).
 *
 * Resolution precedence (most specific wins): location-specific → partner(tenant)-specific → global.
 * If no row matches, the flag is DISABLED (fail closed). Partner users may only READ flags; only
 * MintVault super-admin controls may change them (RLS blocks a tenant writing a global flag, and
 * the runtime is never given a write path to flags in the control shell).
 */
import type { PoolClient } from "pg";
import { partnerRuntimeQuery } from "./db";

/** Sensitive flags that gate live behaviour; all default OFF until explicitly enabled. */
export const PARTNER_FLAGS = [
  "partner_portal_enabled",
  "partner_login_enabled",
  "partner_onboarding_enabled",
  "partner_evidence_capture_enabled",
  "partner_payments_enabled",
  "partner_grading_enabled",
  "partner_device_enforcement_enabled",
  "partner_emergency_stop",
] as const;
export type PartnerFlag = (typeof PARTNER_FLAGS)[number];

/**
 * Resolve a flag's effective value for the current tenant/location. Runs inside a tenant
 * transaction (RLS already scopes visible rows to this tenant + globals).
 */
export async function resolveFlag(
  client: PoolClient,
  flag: string,
  ctx: { tenantId: string; locationId?: string | null },
): Promise<boolean> {
  const { rows } = await client.query<{ enabled: boolean; specificity: number }>(
    `SELECT enabled,
            CASE WHEN location_id IS NOT NULL THEN 2
                 WHEN tenant_id IS NOT NULL THEN 1
                 ELSE 0 END AS specificity
       FROM partner_feature_flags
      WHERE flag = $1
        AND (location_id IS NULL OR location_id = $2)
      ORDER BY specificity DESC, updated_at DESC, id DESC
      LIMIT 1`,
    [flag, ctx.locationId ?? null],
  );
  if (rows.length === 0) return false; // fail closed
  return rows[0].enabled === true;
}

/**
 * Resolve a GLOBAL (tenant-agnostic) flag on the restricted runtime pool WITHOUT tenant context —
 * global rows (tenant_id IS NULL) are readable under RLS with no context. Fail closed on any error
 * or absence. Used for the portal-wide kill switches (partner_portal_enabled, partner_emergency_stop).
 */
export async function resolveGlobalFlag(flag: string): Promise<boolean> {
  try {
    const { rows } = await partnerRuntimeQuery<{ enabled: boolean }>(
      "SELECT enabled FROM partner_feature_flags WHERE flag=$1 AND tenant_id IS NULL AND location_id IS NULL ORDER BY updated_at DESC, id DESC LIMIT 1",
      [flag],
    );
    return rows.length === 1 && rows[0].enabled === true;
  } catch {
    return false; // fail closed
  }
}
