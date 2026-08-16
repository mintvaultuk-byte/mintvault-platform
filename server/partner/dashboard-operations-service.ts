/**
 * P8 — THE OPERATIONAL READ BEHIND THE EXISTING PARTNER DASHBOARD.
 *
 * WHAT THIS IS. One tenant-scoped query set that answers the questions a shop actually asks when it
 * walks up to the console: how many cards are waiting to be scanned, how many need an image
 * replaced, how many are ready to grade, which Macs are alive, which shop floors exist, and whether
 * this organisation is actually set up. Nothing here is new authority — every number is derived
 * from records the proven P4/P6/P7 paths already write.
 *
 * WHY IT IS ONE SERVICE AND NOT SEVEN ENDPOINTS. The dashboard renders these together, and seven
 * round trips from a shop's browser over a shop's broadband is how a console starts feeling broken.
 * More importantly, seven endpoints means seven places to get the tenant predicate right; one
 * service means one place, and the negative tests only have to hold one thing true.
 *
 * SCOPING IS SERVER-SIDE AND NON-NEGOTIABLE. Every query carries `tenant_id = $1` from the
 * authenticated session — never a request parameter — and location-scoped users additionally carry
 * their own location. There is no argument by which a caller can widen either. A partner who knows
 * another partner's MV number, Card Job id or station code gains nothing from it here, because the
 * predicate is applied in SQL before anything is counted.
 *
 * ORG-WIDE VS LOCATION-SCOPED. OWNER / MANAGER / FINANCE_VIEWER see the whole estate; everyone else
 * sees the shop floor they are assigned to. That is the same rule `findSoleEligibleLocation` and
 * `switchLocation` already enforce, and this module reads `principal.orgWide` rather than deciding
 * it — there is one definition of who is org-wide and it is not here.
 */
import { withPartnerAdminTenantTransaction } from "./db";
import type { PartnerPrincipal } from "./session";

/**
 * The Card Job lifecycle, grouped the way an operator thinks about it rather than the way the
 * database stores it.
 *
 * `reservedInProgress` deliberately counts CREDIT_RESERVED only: a card that has been paid for but
 * has not yet reached the scanner. Once it needs scanning it is a different job of work, and
 * conflating the two is how a shop ends up believing it has nothing to do.
 */
export interface PartnerOperationsCounts {
  reservedInProgress: number;
  needsScan: number;
  fixRequired: number;
  readyToGrade: number;
  inReview: number;
  completed: number;
}

export interface PartnerStationRow {
  stationCode: string;
  locationId: string | null;
  locationName: string | null;
  status: string;
  lastSeenAt: string | null;
  appVersion: string | null;
  calibrationStatus: string | null;
  scannerConnected: boolean | null;
  /** Server-derived: ACTIVE, seen recently, and calibrated. Never computed in the browser. */
  ready: boolean;
}

export interface PartnerLocationRow {
  id: string;
  name: string;
  status: string;
  stationCount: number;
}

export interface PartnerOperationsView {
  counts: PartnerOperationsCounts;
  stations: PartnerStationRow[];
  locations: PartnerLocationRow[];
  /** True when this principal's view is confined to one shop floor. */
  locationScoped: boolean;
  scopedLocationId: string | null;
}

/**
 * A station counts as OFFLINE beyond this. The Scanner heartbeats every 60s, so five minutes is
 * roughly five missed beats — long enough that a single lost request or a brief network blip does
 * not make a working Mac look dead on the shop's own console.
 */
const STATION_STALE_MINUTES = 5;

/**
 * Card Job statuses grouped into the operator-facing buckets.
 *
 * Kept as explicit lists rather than a range or a prefix match: migration 0080's CHECK constraint is
 * the authority on what a status may be, and a future status must be placed here DELIBERATELY. A
 * clever pattern match would silently absorb it into the wrong bucket, and a shop would be told it
 * has less work than it does.
 */
const STATUS_BUCKETS = {
  reservedInProgress: ["CREDIT_RESERVED"],
  needsScan: ["NEEDS_SCAN", "CAPTURING"],
  fixRequired: ["FIX_REQUIRED"],
  readyToGrade: ["READY_TO_GRADE"],
  inReview: ["GRADING", "SUBMITTED", "QA_REVIEW"],
  completed: ["APPROVED", "PRINTABLE", "COMPLETED"],
} as const;

export async function getPartnerOperations(principal: PartnerPrincipal): Promise<PartnerOperationsView> {
  /*
   * Location scoping resolved ONCE, here, from the authenticated principal. Passing it as a single
   * nullable parameter into every query below means a future query cannot forget it by omission —
   * it either uses the parameter or it does not compile with the right shape.
   */
  const scopedLocationId = principal.orgWide ? null : principal.locationId;

  return withPartnerAdminTenantTransaction(
    { tenantId: principal.tenantId, locationId: principal.locationId ?? null },
    async (client) => {
      const counts = await client.query<{ status: string; n: string }>(
        `SELECT status, count(*)::text AS n
           FROM partner_card_jobs
          WHERE tenant_id = $1
            AND cancelled_at IS NULL
            AND ($2::uuid IS NULL OR location_id = $2::uuid)
          GROUP BY status`,
        [principal.tenantId, scopedLocationId]
      );

      const byStatus = new Map(counts.rows.map((r) => [r.status, Number(r.n)]));
      const bucket = (statuses: readonly string[]): number =>
        statuses.reduce((total, status) => total + (byStatus.get(status) ?? 0), 0);

      /*
       * Every station of this tenant, INCLUDING pending, suspended and revoked ones.
       * `listPartnerCaptureStations` deliberately returns only ACTIVE stations because it feeds an
       * arming picker — offering a revoked Mac there would be a bug. A fleet view has the opposite
       * requirement: a shop needs to see the Mac that stopped working, and its status is the answer.
       */
      const stations = await client.query<{
        station_code: string;
        location_id: string | null;
        location_name: string | null;
        status: string;
        last_seen_at: string | null;
        app_version: string | null;
        calibration_status: string | null;
        scanner_connected: boolean | null;
        fresh: boolean;
      }>(
        `SELECT s.station_code, s.location_id, l.name AS location_name, s.status,
                s.last_seen_at, s.app_version, s.calibration_status, s.scanner_connected,
                (s.last_seen_at IS NOT NULL
                 AND s.last_seen_at > now() - ($3 || ' minutes')::interval) AS fresh
           FROM partner_stations s
           LEFT JOIN partner_locations l ON l.id = s.location_id AND l.tenant_id = s.tenant_id
          WHERE s.tenant_id = $1
            AND ($2::uuid IS NULL OR s.location_id = $2::uuid)
          ORDER BY l.name NULLS LAST, s.station_code`,
        [principal.tenantId, scopedLocationId, String(STATION_STALE_MINUTES)]
      );

      /*
       * Locations, with the station count an operator needs before asking anyone to suspend one.
       * A location-scoped user sees only their own, which keeps the shop-floor console honest about
       * what that person can actually act on.
       */
      const locations = await client.query<{
        id: string;
        name: string;
        status: string;
        station_count: string;
      }>(
        `SELECT l.id, l.name, l.status,
                COALESCE((SELECT count(*) FROM partner_stations s
                           WHERE s.location_id = l.id AND s.tenant_id = l.tenant_id
                             AND s.status <> 'REVOKED'), 0)::text AS station_count
           FROM partner_locations l
          WHERE l.tenant_id = $1
            AND ($2::uuid IS NULL OR l.id = $2::uuid)
          ORDER BY (l.status = 'ACTIVE') DESC, l.name`,
        [principal.tenantId, scopedLocationId]
      );

      return {
        counts: {
          reservedInProgress: bucket(STATUS_BUCKETS.reservedInProgress),
          needsScan: bucket(STATUS_BUCKETS.needsScan),
          fixRequired: bucket(STATUS_BUCKETS.fixRequired),
          readyToGrade: bucket(STATUS_BUCKETS.readyToGrade),
          inReview: bucket(STATUS_BUCKETS.inReview),
          completed: bucket(STATUS_BUCKETS.completed),
        },
        stations: stations.rows.map((r) => ({
          stationCode: r.station_code,
          locationId: r.location_id,
          locationName: r.location_name,
          status: r.status,
          lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null,
          appVersion: r.app_version,
          calibrationStatus: r.calibration_status,
          scannerConnected: r.scanner_connected,
          // Readiness is the SERVER's verdict, so the console and the Scanner cannot disagree about
          // whether a Mac can work.
          ready: r.status === "ACTIVE" && r.fresh === true && r.calibration_status === "VALID",
        })),
        locations: locations.rows.map((r) => ({
          id: r.id,
          name: r.name,
          status: r.status,
          stationCount: Number(r.station_count),
        })),
        locationScoped: scopedLocationId !== null,
        scopedLocationId,
      };
    }
  );
}
