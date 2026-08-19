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
  // Cross-domain Super Admin kill switch. It deliberately lives in this
  // established global Pilot Flags store so navigation, route and API share
  // one persisted, audited state rather than introducing another flag system.
  "super_admin_command_centre_enabled",
  "partner_portal_enabled",
  "partner_login_enabled",
  "partner_onboarding_enabled",
  "partner_evidence_capture_enabled",
  "partner_payments_enabled",
  "partner_grading_enabled",
  "partner_device_enforcement_enabled",
  "partner_emergency_stop",
  "partner_connector_enabled",
  /**
   * B2 — the portal submission wizard's ability to SUBMIT (and therefore to reserve credits).
   *
   * OFF EVERYWHERE UNTIL THE LIFECYCLE IS CLOSED. Submitting a portal draft reserves one credit per
   * card and creates each Card Job in CREDIT_RESERVED, but no code path performs
   * CREDIT_RESERVED → NEEDS_SCAN: the edge is declared legal in migration 0080 and in
   * card-job-lifecycle.ts, yet the only writer of NEEDS_SCAN is the Scanner's own INSERT. A portal
   * card therefore holds a credit it can never spend and can never reach grading.
   *
   * Reading, drafting and cancelling are untouched — only the reserving step is gated — so no
   * existing submission becomes unreachable and nothing already reserved is stranded further.
   * Turning this on is a deliberate act that should follow, not precede, a real continuation path.
   */
  "partner_submission_intake_enabled",
] as const;
export type PartnerFlag = (typeof PARTNER_FLAGS)[number];

/**
 * Resolve a flag's effective value for the current tenant/location. Runs inside a tenant
 * transaction (RLS already scopes visible rows to this tenant + globals).
 */
export async function resolveFlag(
  client: PoolClient,
  flag: string,
  ctx: { tenantId: string; locationId?: string | null }
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
    [flag, ctx.locationId ?? null]
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
      [flag]
    );
    return rows.length === 1 && rows[0].enabled === true;
  } catch {
    return false; // fail closed
  }
}
