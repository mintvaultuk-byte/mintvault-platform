/**
 * Partner Portal — emergency controls (Phase 1). Enforced on EVERY relevant request, not only at
 * login. A frozen scope (partner / location / user / login / sensitive / view-only / global) blocks
 * the matching operation immediately, even for an already-authenticated session.
 */
import type { PoolClient } from "pg";

// Portal-wide ("global") stop is handled via the global feature flag `partner_emergency_stop`
// (enforced in the app factory), NOT via this per-tenant table — partner_emergency_controls.tenant_id
// is NOT NULL, so a tenant-agnostic row cannot be stored here.
export type EmergencyScope =
  | "partner" // whole tenant frozen
  | "location" // a location frozen
  | "login" // login disabled
  | "sensitive" // sensitive ops disabled
  | "view_only"; // writes disabled

export interface EmergencyState {
  partnerFrozen: boolean;
  locationFrozen: boolean;
  loginDisabled: boolean;
  sensitiveDisabled: boolean;
  viewOnly: boolean;
}

/** Read the effective emergency state for a tenant/location within a tenant transaction. */
export async function readEmergencyState(
  client: PoolClient,
  ctx: { tenantId: string; locationId?: string | null },
): Promise<EmergencyState> {
  const { rows } = await client.query<{ scope: string; frozen: boolean; location_id: string | null }>(
    `SELECT scope, frozen, location_id FROM partner_emergency_controls WHERE frozen = true`,
  );
  const st: EmergencyState = {
    partnerFrozen: false, locationFrozen: false, loginDisabled: false, sensitiveDisabled: false, viewOnly: false,
  };
  for (const r of rows) {
    const appliesToLocation = r.location_id == null || r.location_id === ctx.locationId;
    if (!appliesToLocation) continue;
    switch (r.scope) {
      case "partner": st.partnerFrozen = true; break;
      case "location": if (r.location_id === ctx.locationId) st.locationFrozen = true; break;
      case "login": st.loginDisabled = true; break;
      case "sensitive": st.sensitiveDisabled = true; break;
      case "view_only": st.viewOnly = true; break;
    }
  }
  return st;
}

/** Is any hard-stop active (partner/location frozen)? Such a principal must not operate at all. */
export function isHardStopped(st: EmergencyState): boolean {
  return st.partnerFrozen || st.locationFrozen;
}
