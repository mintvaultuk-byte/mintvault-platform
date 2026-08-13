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
  ctx: { tenantId: string; locationId?: string | null }
): Promise<EmergencyState> {
  /*
   * THE `tenant_id = $1` PREDICATE IS LOAD-BEARING, not decoration.
   *
   * This query previously selected every frozen control in the table and relied ENTIRELY on RLS to
   * scope it. That held only because its original callers (session.ts, auth.ts) run on the RLS-scoped
   * partner RUNTIME pool. The moment it is called from a privileged path — the partner ADMIN pool is
   * BYPASSRLS by design, because the credit engine needs the wallet row lock — RLS stops filtering
   * and the function sees EVERY tenant's controls.
   *
   * The consequence was cross-tenant and severe: freezing ONE partner froze ALL partners. It was
   * caught by a P4 test in which an emergency stop applied to one organisation refused new cards for
   * two unrelated organisations.
   *
   * An explicit predicate is what this codebase already requires of itself — submission-service.ts:
   * "carry explicit tenant predicates and cross-table tenant invariants; their app.tenant_id context
   * is observability/defence in depth, never a substitute for RLS." That discipline was simply
   * missing here. With the predicate, the function is correct on ANY pool, privileged or not.
   */
  const { rows } = await client.query<{ scope: string; frozen: boolean; location_id: string | null }>(
    `SELECT scope, frozen, location_id
       FROM partner_emergency_controls
      WHERE frozen = true AND tenant_id = $1`,
    [ctx.tenantId]
  );
  const st: EmergencyState = {
    partnerFrozen: false,
    locationFrozen: false,
    loginDisabled: false,
    sensitiveDisabled: false,
    viewOnly: false,
  };
  for (const r of rows) {
    const appliesToLocation = r.location_id == null || r.location_id === ctx.locationId;
    if (!appliesToLocation) continue;
    switch (r.scope) {
      case "partner":
        st.partnerFrozen = true;
        break;
      case "location":
        if (r.location_id === ctx.locationId) st.locationFrozen = true;
        break;
      case "login":
        st.loginDisabled = true;
        break;
      case "sensitive":
        st.sensitiveDisabled = true;
        break;
      case "view_only":
        st.viewOnly = true;
        break;
    }
  }
  return st;
}

/** Is any hard-stop active (partner/location frozen)? Such a principal must not operate at all. */
export function isHardStopped(st: EmergencyState): boolean {
  return st.partnerFrozen || st.locationFrozen;
}
