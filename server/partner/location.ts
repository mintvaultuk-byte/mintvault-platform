/**
 * Partner Portal — secure location assignment + switching (Phase 1, Item 2).
 *
 * A user may operate only at locations explicitly assigned via partner_user_locations. Owner/Manager
 * get NO implicit access to all locations. The switch validates everything server-side from the
 * authenticated session; the requested location id is the ONLY client input honoured (a submitted
 * partner/tenant id is ignored — tenant comes from the session). The selected location is recorded in
 * trusted server-side session state (partner_sessions.location_id) and audited.
 */
import { withTenant } from "./db";
import { writePartnerAudit } from "./audit";
import type { PartnerPrincipal } from "./session";

export type SwitchResult = { ok: true } | { ok: false; reason: "not_assigned" | "not_found" | "not_active" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function switchLocation(principal: PartnerPrincipal, requestedLocationId: string): Promise<SwitchResult> {
  if (typeof requestedLocationId !== "string" || !UUID_RE.test(requestedLocationId)) {
    return { ok: false, reason: "not_found" };
  }
  return withTenant({ tenantId: principal.tenantId }, async (c) => {
    // location must belong to this tenant (RLS enforces tenant scope) and be ACTIVE
    const loc = await c.query<{ status: string }>("SELECT status FROM partner_locations WHERE id=$1", [requestedLocationId]);
    if (loc.rowCount !== 1) return { ok: false, reason: "not_found" };
    if (loc.rows[0].status !== "ACTIVE") return { ok: false, reason: "not_active" };
    // user must be explicitly assigned to that location
    const assigned = await c.query(
      "SELECT 1 FROM partner_user_locations WHERE user_id=$1 AND location_id=$2",
      [principal.userId, requestedLocationId],
    );
    if (assigned.rowCount !== 1) return { ok: false, reason: "not_assigned" };
    // record the selected location in trusted server-side session state
    const upd = await c.query("UPDATE partner_sessions SET location_id=$2 WHERE id=$1 AND revoked_at IS NULL", [principal.sessionId, requestedLocationId]);
    if ((upd.rowCount ?? 0) !== 1) return { ok: false, reason: "not_found" }; // session gone/revoked — do not report success
    await writePartnerAudit(c, {
      tenantId: principal.tenantId, actorUserId: principal.userId, sessionId: principal.sessionId,
      action: "partner_location_switch", recordType: "partner_location", recordId: requestedLocationId,
    });
    return { ok: true };
  });
}
