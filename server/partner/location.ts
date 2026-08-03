/**
 * Partner Portal — secure location assignment + switching (Phase 1, Item 2).
 *
 * Location-scoped users may operate only at locations explicitly assigned via partner_user_locations.
 * Organisation-wide roles may switch to any ACTIVE same-tenant location. The switch validates
 * everything server-side from the
 * authenticated session; the requested location id is the ONLY client input honoured (a submitted
 * partner/tenant id is ignored — tenant comes from the session). The selected location is recorded in
 * trusted server-side session state (partner_sessions.location_id) and audited.
 */
import type { PoolClient } from "pg";
import { withTenant } from "./db";
import { writePartnerAudit } from "./audit";
import type { PartnerPrincipal } from "./session";

export type SwitchResult = { ok: true } | { ok: false; reason: "not_assigned" | "not_found" | "not_active" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The set of locations this principal may operate at, resolved with EXACTLY the rule switchLocation
 * enforces below: org-wide roles get every ACTIVE tenant location; everyone else gets only their
 * explicit partner_user_locations assignments (intersected with ACTIVE).
 *
 * Returns the sole eligible location id, or null when the set is empty OR has more than one member.
 *
 * Both null cases are deliberate and must not be collapsed:
 *  - size 0 → the user is permitted NOWHERE. Returning a location here would convert the
 *    fail-closed guard in submission-service (`ids.length === 0 → "FALSE"`) into a fail-OPEN one.
 *    Every non-org-wide staging user is currently in this state (partner_user_locations is empty),
 *    so this is a live path, not a theoretical one.
 *  - size >1 → the operator must choose explicitly; picking for them would silently bind work to
 *    the wrong shop floor.
 *
 * LIMIT 2 is sufficient to tell "exactly one" from "more than one" without counting the whole set.
 */
export async function findSoleEligibleLocation(
  c: PoolClient,
  args: { tenantId: string; userId: string; orgWide: boolean },
): Promise<string | null> {
  const { rows } = args.orgWide
    ? await c.query<{ id: string }>(
        "SELECT id FROM partner_locations WHERE tenant_id=$1 AND status='ACTIVE' ORDER BY id LIMIT 2",
        [args.tenantId],
      )
    : await c.query<{ id: string }>(
        `SELECT l.id FROM partner_locations l
           JOIN partner_user_locations pul ON pul.location_id = l.id
          WHERE l.tenant_id=$1 AND l.status='ACTIVE' AND pul.user_id=$2
          ORDER BY l.id LIMIT 2`,
        [args.tenantId, args.userId],
      );
  return rows.length === 1 ? rows[0].id : null;
}

export async function switchLocation(principal: PartnerPrincipal, requestedLocationId: string): Promise<SwitchResult> {
  if (typeof requestedLocationId !== "string" || !UUID_RE.test(requestedLocationId)) {
    return { ok: false, reason: "not_found" };
  }
  return withTenant({ tenantId: principal.tenantId }, async (c) => {
    // location must belong to this tenant and be ACTIVE; never trust a caller-supplied tenant id
    const loc = await c.query<{ status: string }>("SELECT status FROM partner_locations WHERE id=$1 AND tenant_id=$2", [
      requestedLocationId,
      principal.tenantId,
    ]);
    if (loc.rowCount !== 1) return { ok: false, reason: "not_found" };
    if (loc.rows[0].status !== "ACTIVE") return { ok: false, reason: "not_active" };
    // org-wide roles operate across ACTIVE tenant locations; location-scoped roles need assignment
    if (!principal.orgWide) {
      const assigned = await c.query("SELECT 1 FROM partner_user_locations WHERE user_id=$1 AND location_id=$2", [
        principal.userId,
        requestedLocationId,
      ]);
      if (assigned.rowCount !== 1) return { ok: false, reason: "not_assigned" };
    }
    // record the selected location in trusted server-side session state
    const upd = await c.query("UPDATE partner_sessions SET location_id=$2 WHERE id=$1 AND revoked_at IS NULL", [
      principal.sessionId,
      requestedLocationId,
    ]);
    if ((upd.rowCount ?? 0) !== 1) return { ok: false, reason: "not_found" }; // session gone/revoked — do not report success
    await writePartnerAudit(c, {
      tenantId: principal.tenantId,
      actorUserId: principal.userId,
      sessionId: principal.sessionId,
      action: "partner_location_switch",
      recordType: "partner_location",
      recordId: requestedLocationId,
    });
    return { ok: true };
  });
}
