/**
 * B1 — STATION-INITIATED CAPTURE AUTHORISATION.
 *
 * THE DEFECT THIS CLOSES. A Scanner station could start a walk-in card (`POST /card-jobs`) and
 * could be told which sides a FIX had freed (`POST /card-jobs/:id/fix-authorise`), but nothing it
 * could reach ever ARMED a capture session. The only Partner arming route,
 * `POST /stations/:stationCode/capture-sessions`, authenticates with the browser session cookie,
 * and the only Partner surface that calls it lives inside the opened grading workstation — which
 * the grading queue will only open for a card already in READY_TO_GRADE, a state that by
 * definition requires both sides to be captured already.
 *
 * The result was a closed loop: to photograph a card you needed an armed session, to arm one you
 * needed the grading workstation, and to open that you needed the photographs. Walk-in cards
 * therefore sat in NEEDS_SCAN for ever (eight of them on staging at the time of writing).
 *
 * WHAT THIS IS NOT. It is not a new authority and not a relaxation of an existing one. The
 * certificate is NEVER taken from the request body — it is derived from a Card Job that was itself
 * located by the AUTHENTICATED station's tenant, so there is no id a caller can supply to reach
 * another partner's card. `createScannerCaptureSession` then re-proves the same station↔job
 * tenant/location binding independently against its own pool (see its walk-in branch), so this
 * module is the second of two locks, not the only one.
 *
 * WHY IT LIVES IN THE PARTNER ADMIN POOL. Card Job state, tenant scoping and the audit trail are
 * partner-schema concerns behind RLS. The capture session itself belongs to the HQ scanner tables
 * on a different pool, so it cannot join this transaction — exactly as the browser arming route
 * already works (authorise, then arm). The two steps are independently safe: this one refuses
 * without a valid job, and the arming service refuses without a valid station binding.
 */
import type { PoolClient } from "pg";
import { withPartnerAdminTenantTransaction } from "./db";
import { writePartnerAudit } from "./audit";

export class CaptureAuthorityError extends Error {
  constructor(
    public readonly code:
      | "CARD_JOB_NOT_FOUND"
      | "JOB_NOT_CAPTURABLE"
      | "STATION_NOT_ACTIVE"
      | "SIDE_INVALID"
      | "SIDE_ALREADY_PRESENT"
      | "NOTHING_TO_CAPTURE",
    message: string
  ) {
    super(message);
    this.name = "CaptureAuthorityError";
  }
}

export type CaptureSide = "front" | "back";

/** FRONT first: a bench works front-then-back, so an unqualified request should arm the front. */
const SIDES: readonly CaptureSide[] = ["front", "back"];

function cleanSide(value: unknown): CaptureSide {
  if (value === "front" || value === "back") return value;
  throw new CaptureAuthorityError("SIDE_INVALID", "A capture side must be front or back.");
}

/**
 * Card Job states from which a station may capture.
 *
 * NEEDS_SCAN and CAPTURING are the ordinary first-capture path. FIX_REQUIRED is the repair path,
 * reached only after a deliberate, audited invalidation has emptied a side.
 *
 * READY_TO_GRADE and GRADING are DELIBERATELY EXCLUDED even though `FIXABLE_STATUSES` in
 * fix-authority.ts admits them: both sides are present in those states, so there is nothing to
 * capture, and arming there would be a route to overwriting an accepted image without the
 * invalidation that is supposed to precede it. An operator who genuinely needs to replace a good
 * image invalidates it first, which moves the job to FIX_REQUIRED and back into this set.
 */
const CAPTURABLE_STATUSES = new Set(["NEEDS_SCAN", "CAPTURING", "FIX_REQUIRED"]);

export interface CaptureAuthorisation {
  cardJobId: string;
  mvNumber: string;
  certificateId: number;
  /** The single side this authorisation covers. One session arms one side (migration 0075). */
  side: CaptureSide;
  /** Every side still missing, so the Scanner knows whether another pass follows this one. */
  missingSides: CaptureSide[];
  locationId: string | null;
  status: string;
}

/**
 * Locate the job for THIS tenant.
 *
 * A job belonging to another tenant, a cancelled job, and a job id that does not exist all produce
 * the SAME `CARD_JOB_NOT_FOUND`. Distinguishing them would confirm to a caller that an id is real
 * and belongs to somebody — the same reasoning as `loadFixableJob` in fix-authority.ts.
 */
async function loadCapturableJob(
  client: PoolClient,
  tenantId: string,
  cardJobId: string
): Promise<{ id: string; certificate_id: number; mv_number: string; status: string; location_id: string | null }> {
  const { rows } = await client.query<{
    id: string;
    certificate_id: number | null;
    mv_number: string | null;
    status: string;
    location_id: string | null;
  }>(
    `SELECT id, certificate_id, mv_number, status, location_id
       FROM partner_card_jobs
      WHERE id = $1 AND tenant_id = $2 AND cancelled_at IS NULL`,
    [cardJobId, tenantId]
  );
  const row = rows[0];
  // A job with no certificate cannot be captured against: `scanner_capture_sessions.certificate_id`
  // is NOT NULL. On the walk-in path the certificate is minted inside the NEW transaction, so this
  // only excludes the portal/connector lineage whose allocation is still pending.
  if (!row || row.certificate_id === null || row.mv_number === null) {
    throw new CaptureAuthorityError("CARD_JOB_NOT_FOUND", "That card was not found for this partner.");
  }
  if (!CAPTURABLE_STATUSES.has(row.status)) {
    throw new CaptureAuthorityError(
      "JOB_NOT_CAPTURABLE",
      `A card in ${row.status} is not waiting for a photograph. Remove an image from grading first if it needs replacing.`
    );
  }
  return {
    id: row.id,
    certificate_id: row.certificate_id,
    mv_number: row.mv_number,
    status: row.status,
    location_id: row.location_id,
  };
}

/**
 * Authorise ONE side of ONE card for capture by ONE approved station.
 *
 * SPENDS NOTHING AND MINTS NOTHING. There is no wallet call, no allocator call and no insert into
 * `partner_card_jobs` in this file. It answers a single question — may this station photograph this
 * side of this card right now — and records that it was asked. It therefore behaves identically at
 * a zero balance, which matters: a card already paid for must always be finishable.
 */
export async function authoriseStationCapture(input: {
  tenantId: string;
  locationId: string | null;
  cardJobId: string;
  stationId: string;
  actorUserId: string;
  /** Optional narrowing. Omitted means "the first side still missing". */
  requestedSide?: unknown;
}): Promise<CaptureAuthorisation> {
  return withPartnerAdminTenantTransaction(
    { tenantId: input.tenantId, locationId: input.locationId ?? null },
    async (client) => {
      const job = await loadCapturableJob(client, input.tenantId, input.cardJobId);

      // A revoked or suspended station must not capture, even for a card it started itself.
      const station = await client.query<{ status: string; location_id: string }>(
        `SELECT status, location_id FROM partner_stations WHERE id = $1 AND tenant_id = $2`,
        [input.stationId, input.tenantId]
      );
      const stationRow = station.rows[0];
      if (!stationRow || stationRow.status !== "ACTIVE") {
        throw new CaptureAuthorityError("STATION_NOT_ACTIVE", "This station is not approved to capture cards.");
      }
      // A Mac stands on one shop floor and may only photograph cards taken at that floor. Reported
      // as NOT_FOUND, not FORBIDDEN, for the same non-confirmation reason as the tenant check.
      if (job.location_id && stationRow.location_id !== job.location_id) {
        throw new CaptureAuthorityError("CARD_JOB_NOT_FOUND", "That card was not found for this partner.");
      }

      // Which sides are genuinely outstanding, read from the evidence ledger rather than inferred
      // from the job status — the ledger is what `bothSidesCaptured` and the grading loader read.
      const current = await client.query<{ side: string }>(
        `SELECT side FROM certificate_image_evidence
          WHERE certificate_id = $1 AND is_current = true`,
        [job.certificate_id]
      );
      const present = new Set(current.rows.map((r) => r.side));
      const missing = SIDES.filter((s) => !present.has(s));

      if (missing.length === 0) {
        throw new CaptureAuthorityError(
          "NOTHING_TO_CAPTURE",
          `${job.mv_number} already has both images. Remove the one that is wrong before re-scanning it.`
        );
      }

      let side = missing[0];
      if (input.requestedSide !== undefined && input.requestedSide !== null) {
        const requested = cleanSide(input.requestedSide);
        // Narrowing only. Asking for a side that is already present is refused outright rather than
        // quietly redirected — silently arming a different side than was asked for is how an
        // operator ends up overwriting the image they meant to keep.
        if (!missing.includes(requested)) {
          throw new CaptureAuthorityError(
            "SIDE_ALREADY_PRESENT",
            `The ${requested} image of ${job.mv_number} is already present. Remove it from grading first if it is wrong.`
          );
        }
        side = requested;
      }

      await writePartnerAudit(client, {
        tenantId: input.tenantId,
        locationId: input.locationId ?? job.location_id ?? null,
        actorUserId: input.actorUserId,
        deviceId: input.stationId,
        action: "partner_station_capture_authorised",
        recordType: "partner_card_job",
        recordId: job.id,
        after: { mvNumber: job.mv_number, side, missingSides: missing, status: job.status },
        reason: "Authorised a station capture session for an outstanding side. No Grading Credit is consumed.",
      });

      return {
        cardJobId: job.id,
        mvNumber: job.mv_number,
        certificateId: job.certificate_id,
        side,
        missingSides: missing,
        locationId: job.location_id,
        status: job.status,
      };
    }
  );
}
