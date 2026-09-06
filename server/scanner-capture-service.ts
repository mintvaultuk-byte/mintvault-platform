/**
 * Server-owned capture sessions for a physical workstation.  The Electron app
 * never receives a free-form certificate/side target: it can only claim one
 * short-lived session that the workstation created first.
 */
import { randomUUID } from "node:crypto";
import { pool } from "./db";
import { hashLockKey } from "./lib/advisory-lock";
import { CaptureGeometryError, type AcquisitionRegionMm } from "./lib/lide400-capture-authority";
import {
  withScannerCaptureOperationalAuthority,
  type ScannerCaptureMainAnchor,
  type ScannerCaptureOperationalAuthority,
} from "./partner/operational-authority";

/**
 * A station was asked to arm a card while it is already holding a live target for a DIFFERENT one.
 *
 * Typed so the HTTP boundary can answer 409 with the blocking card NAMED, instead of letting
 * migration 0075's raw unique violation fall through to a generic 500. It carries no internal detail
 * — just the card and side an operator has to deal with before this one can be armed.
 */
export class ScannerCaptureConflictError extends Error {
  readonly code = "station_holds_another_card" as const;
  constructor(
    message: string,
    readonly holdingCertificateNumber: string,
    readonly holdingSide: string
  ) {
    super(message);
    this.name = "ScannerCaptureConflictError";
  }
}

export type CaptureSide = "front" | "back";
export type ScannerCaptureSession = {
  id: string;
  certificateId: number;
  certificateNumber: string;
  cardId: number | null;
  submissionItemId: number | null;
  submissionId: number | null;
  stationId: string | null;
  actorId: string | null;
  side: CaptureSide;
  workstationId: string;
  scannerProfileVersion: string;
  /** The calibration this session was armed under. Provenance; never re-resolved later. */
  calibrationId: string | null;
  /** THE authoritative capture window, snapshotted at arm time. Evidence is validated against this. */
  acquisitionRegion: AcquisitionRegionMm | null;
  state: "armed" | "claimed" | "capturing" | "captured" | "failed" | "expired" | "cancelled";
  /**
   * True after the physical TIFF is durably accepted locally and the server has minted this
   * session's staging upload task. The row still owns the side and its retries, but no longer
   * occupies the single physical Canon target.
   */
  physicalReleased: boolean;
  expiresAt: Date;
  recapture: boolean;
  failureReason: string | null;
};

const SESSION_TTL_MS = 5 * 60_000;

function cleanStationId(value: unknown): string {
  const station = typeof value === "string" ? value.trim() : "";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/.test(station)) {
    throw new Error("A valid workstation ID is required");
  }
  return station;
}

function cleanSide(value: unknown): CaptureSide {
  if (value === "front" || value === "back") return value;
  throw new Error("Capture side must be front or back");
}

function mapRow(row: Record<string, unknown>): ScannerCaptureSession {
  return {
    id: String(row.id),
    certificateId: Number(row.certificate_id),
    certificateNumber: String(row.certificate_number),
    cardId: row.card_id == null ? null : Number(row.card_id),
    submissionItemId: row.submission_item_id == null ? null : Number(row.submission_item_id),
    submissionId: row.submission_id == null ? null : Number(row.submission_id),
    stationId: row.station_id == null ? null : String(row.station_id),
    actorId: row.actor_id == null ? null : String(row.actor_id),
    side: row.side === "back" ? "back" : "front",
    workstationId: String(row.workstation_id),
    scannerProfileVersion: String(row.scanner_profile_version),
    state: row.state as ScannerCaptureSession["state"],
    physicalReleased: row.physical_released === true,
    expiresAt: new Date(String(row.expires_at)),
    recapture: row.recapture === true,
    failureReason: row.failure_reason == null ? null : String(row.failure_reason),
    /*
     * The SERVER-OWNED capture window this session was armed under. Carried on every mapped session
     * so the evidence path never has to go and ask again — and so it cannot be tempted to ask the
     * station instead.
     */
    calibrationId: row.calibration_id == null ? null : String(row.calibration_id),
    acquisitionRegion: row.acquisition_region == null ? null : (row.acquisition_region as AcquisitionRegionMm),
  };
}

/**
 * ONE CARD, ONE RECTANGLE — the invariant that was asserted in comments and implemented nowhere.
 *
 * A certificate whose FRONT and BACK were acquired from two different physical rectangles is not one
 * piece of evidence: the two faces are framed differently, and any measurement that spans them is
 * meaningless. The session snapshot (migration 0091) protects a side already armed, but it cannot see
 * across two sessions of one card — capture FRONT under window A, recalibrate, capture BACK under
 * window B, and both uploads agree with their own snapshot.
 *
 * READ FROM THE EVIDENCE, NOT THE SESSION, AND THAT IS LOAD-BEARING. The proven geometry of a
 * completed side lives in `certificate_image_evidence.capture_metadata->'scanAreaMm'`, written from
 * the provenance of the master that was actually accepted. The session row is the wrong source: it
 * is `NULL` for every side captured before 0091 existed, so pairing on it would refuse a BACK for
 * every pre-0091 card — including MV272, whose FRONT is preserved, authoritative, and records
 * `{x:0, y:0, width:100, height:130}` right there in its evidence row. Pairing on the evidence lets
 * that card finish at its own proven rectangle, which is the entire point.
 *
 * Silent when the other side has no recorded geometry at all: that is an unknown, and refusing on an
 * unknown would strand cards for a fact nobody can establish. The 4 mm floor still applies to every
 * master independently.
 */
/**
 * The same invariant, re-checked when evidence is COMMITTED rather than when a side is armed.
 *
 * The arm-time check is necessary but not sufficient: at arm, the other side may be armed and not
 * yet uploaded, so there is no evidence row to compare against and the check passes silently. Two
 * stations calibrated differently can therefore hold the two sides of one card at once, and each
 * upload then agrees with its OWN session snapshot. Checking again at commit closes that window,
 * because by then the first side's evidence exists.
 *
 * Exported and called from BOTH evidence paths. A check that lives on only one of them is a check
 * with a way around it.
 */
export async function assertCommittedSidesShareOneRectangle(
  certificateId: number,
  side: string,
  region: AcquisitionRegionMm
): Promise<void> {
  const client = await pool.connect();
  try {
    await assertSidesShareOneRectangle(client as never, certificateId, side, region);
  } finally {
    client.release();
  }
}

async function assertSidesShareOneRectangle(
  client: { query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  certificateId: number,
  side: string,
  region: AcquisitionRegionMm
): Promise<void> {
  const other = await client.query(
    `SELECT capture_metadata -> 'scanAreaMm' AS scan_area
       FROM certificate_image_evidence
      WHERE certificate_id = $1 AND side <> $2 AND is_current = true
      LIMIT 1`,
    [certificateId, side]
  );
  const recorded = other.rows[0]?.scan_area;
  if (!recorded) return;
  const proven = finiteRegionOrNull(recorded);
  if (!proven) return;
  const differs = (["x", "y", "width", "height"] as const).some(
    (key) => Math.abs(proven[key] - region[key]) > REGION_AGREEMENT_TOLERANCE_MM
  );
  if (differs) {
    throw new CaptureGeometryError(
      "sides_disagree_on_capture_window",
      `This card's other side was captured at ${proven.width} x ${proven.height} mm at ${proven.x}, ${proven.y}, ` +
        `but this station is now calibrated to ${region.width} x ${region.height} mm at ${region.x}, ${region.y}. ` +
        `Both sides of one card must come from the same capture window — restore the previous window or start a new card.`
    );
  }
}

/** The same 0.5 mm agreement tolerance the declared-region check uses. */
const REGION_AGREEMENT_TOLERANCE_MM = 0.5;

function finiteRegionOrNull(value: unknown): AcquisitionRegionMm | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const key of ["x", "y", "width", "height"]) {
    const number = Number(source[key]);
    if (!Number.isFinite(number)) return null;
    out[key] = number;
  }
  return out as AcquisitionRegionMm;
}

type CreateScannerCaptureInput = {
  certificateId: number;
  side: unknown;
  workstationId: unknown;
  stationId?: string | null;
  actorId: string | null;
  recapture: boolean;
  scannerProfileVersion: string;
};

export async function createScannerCaptureSession(input: CreateScannerCaptureInput): Promise<ScannerCaptureSession> {
  const side = cleanSide(input.side);
  const workstationId = cleanStationId(input.workstationId);
  if (!input.stationId) {
    return createScannerCaptureSessionOnMain(input, side, workstationId, null, null);
  }
  const anchorResult = await pool.query(
    `SELECT c.id, c.card_id, c.submission_item_id,
            COALESCE(card.submission_id, item.submission_id) AS destination_submission_id,
            c.origin_type, c.origin_partner_id, c.origin_location_id
       FROM certificates c
       LEFT JOIN cards card ON card.id=c.card_id
       LEFT JOIN submission_items item ON item.id=c.submission_item_id
      WHERE c.id=$1 AND c.deleted_at IS NULL
      LIMIT 1`,
    [input.certificateId]
  );
  const row = anchorResult.rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new Error("Certificate not found or inactive");
  const anchor: ScannerCaptureMainAnchor = {
    certificateId: Number(row.id),
    cardId: row.card_id == null ? null : Number(row.card_id),
    submissionItemId: row.submission_item_id == null ? null : Number(row.submission_item_id),
    destinationSubmissionId: row.destination_submission_id == null ? null : Number(row.destination_submission_id),
    originType: row.origin_type == null ? null : String(row.origin_type),
    originPartnerId: row.origin_partner_id == null ? null : String(row.origin_partner_id),
    originLocationId: row.origin_location_id == null ? null : String(row.origin_location_id),
  };
  return withScannerCaptureOperationalAuthority(
    {
      stationId: input.stationId,
      workstationId,
      scannerProfileVersion: input.scannerProfileVersion,
      anchor,
    },
    (authority) => createScannerCaptureSessionOnMain(input, side, workstationId, authority, anchor)
  );
}

async function createScannerCaptureSessionOnMain(
  input: CreateScannerCaptureInput,
  side: CaptureSide,
  workstationId: string,
  operationalAuthority: ScannerCaptureOperationalAuthority | null,
  anchor: ScannerCaptureMainAnchor | null
): Promise<ScannerCaptureSession> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [
      hashLockKey(`scanner-capture-certificate:${input.certificateId}`),
    ]);
    // A station-target expiry must be made terminal in the SAME transaction as
    // the next arm. Otherwise an expired `armed` row can indefinitely occupy
    // the station's partial-unique slot until a background sweeper happens to
    // visit it.
    if (input.stationId) {
      const invariant = await client.query<{ index_name: string | null }>(
        "SELECT to_regclass('public.uq_scanner_capture_one_active_station')::text AS index_name"
      );
      if (!invariant.rows[0]?.index_name) {
        throw new Error("Partner station capture is unavailable until its one-active-target invariant is installed");
      }
      await client.query(
        `UPDATE scanner_capture_sessions
            SET state='expired'
          WHERE station_id=$1
            AND state IN ('armed','claimed')
            AND physical_released = false
            AND expires_at <= NOW()`,
        [input.stationId]
      );
    }
    const cert = await client.query(
      `
      SELECT c.id, c.certificate_number, c.card_id, c.submission_item_id,
             COALESCE(card.submission_id, item.submission_id) AS submission_id,
             c.origin_type, c.origin_partner_id, c.origin_location_id
        FROM certificates c
        LEFT JOIN cards card ON card.id = c.card_id
        LEFT JOIN submission_items item ON item.id = c.submission_item_id
       WHERE c.id = $1 AND c.deleted_at IS NULL
       LIMIT 1
    `,
      [input.certificateId]
    );
    const row = cert.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error("Certificate not found or inactive");
    if (input.stationId) {
      if (!operationalAuthority || !anchor || operationalAuthority.stationId !== input.stationId) {
        throw new Error("Partner station authority is unavailable");
      }
      if (
        Number(row.id) !== anchor.certificateId ||
        (row.card_id == null ? null : Number(row.card_id)) !== anchor.cardId ||
        (row.submission_item_id == null ? null : Number(row.submission_item_id)) !== anchor.submissionItemId ||
        (row.submission_id == null ? null : Number(row.submission_id)) !== anchor.destinationSubmissionId ||
        String(row.origin_type ?? "") !== "PARTNER" ||
        String(row.origin_partner_id ?? "") !== operationalAuthority.tenantId ||
        String(row.origin_location_id ?? "") !== operationalAuthority.locationId
      ) {
        throw new Error("Certificate binding changed while scanner capture was being armed");
      }
    }
    /*
     * WALK-IN (P6) CARD JOB PATH, checked FIRST (AT-23 §B, 2026-08-14). A counter-started
     * certificate is minted directly inside the NEW transaction — it has no legacy cards /
     * submission_items rows, so the card/submission binding gates below can never hold for it.
     * The walk-in branch further down was written for exactly this case, but those gates threw
     * before it could run, so on a real host every Scanner-started card was refused at the moment
     * the operator tried to capture the card that had just been paid for. The walk-in binding is
     * equally strict, just through the Card Job: the certificate must belong to a job whose
     * tenant_id AND location_id equal this ACTIVE station's. Partner A's station still cannot arm
     * Partner B's certificate, and a station cannot reach another location's job.
     */
    const walkInStationBound =
      input.stationId != null &&
      operationalAuthority?.lineage === "card_job" &&
      row.card_id == null &&
      row.submission_item_id == null;
    if (!walkInStationBound) {
      if (row.card_id == null && row.submission_item_id == null) {
        throw new Error("Certificate must be bound to a selected card or submission item before scanner capture");
      }
      if (row.submission_id == null) {
        throw new Error("Selected card has no submission binding; scanner capture is refused");
      }
    }
    if (input.stationId && !operationalAuthority) {
      throw new Error("Certificate is not bound to this station's tenant and location");
    }
    if (!input.recapture) {
      const evidence = await client.query(
        `SELECT 1 FROM certificate_image_evidence WHERE certificate_id = $1 AND side = $2 AND is_current = true LIMIT 1`,
        [input.certificateId, side]
      );
      if (evidence.rows.length) throw new Error(`${side} already has a current master; use controlled recapture`);
    } else if (input.stationId) {
      const sameSideOwner = await client.query<{ station_id: string | null }>(
        `SELECT COALESCE(capture_metadata ->> 'stationId', capture_metadata ->> 'station_id') AS station_id
           FROM certificate_image_evidence
          WHERE certificate_id = $1 AND side = $2 AND is_current = true
          LIMIT 1`,
        [input.certificateId, side]
      );
      const sameSideStationId = sameSideOwner.rows[0]?.station_id ?? null;
      if (sameSideStationId && sameSideStationId !== input.stationId) {
        throw new ScannerCaptureConflictError(
          `${String(row.certificate_number)} ${side} was captured on another approved station. Use that station or deliberately invalidate the side before continuing.`,
          String(row.certificate_number),
          side
        );
      }
    }
    const oppositeSide: CaptureSide = side === "front" ? "back" : "front";
    const oppositeEvidence = await client.query<{ station_id: string | null }>(
      `SELECT COALESCE(capture_metadata ->> 'stationId', capture_metadata ->> 'station_id') AS station_id
         FROM certificate_image_evidence
        WHERE certificate_id = $1 AND side = $2 AND is_current = true
        LIMIT 1`,
      [input.certificateId, oppositeSide]
    );
    const oppositeReleased = await client.query<{ station_id: string | null }>(
      `SELECT station_id
         FROM scanner_capture_sessions
        WHERE certificate_id = $1
          AND side = $2
          AND state IN ('claimed','capturing')
          AND physical_released = true
        ORDER BY created_at
        LIMIT 1`,
      [input.certificateId, oppositeSide]
    );
    if (side === "back" && !oppositeEvidence.rows.length && !oppositeReleased.rows.length) {
      throw new Error("Scan the front before arming the back.");
    }
    const oppositeStationId = oppositeReleased.rows[0]?.station_id ?? oppositeEvidence.rows[0]?.station_id ?? null;
    if (input.stationId && oppositeStationId && oppositeStationId !== input.stationId) {
      throw new ScannerCaptureConflictError(
        `${String(row.certificate_number)} ${oppositeSide} was captured on another approved station. Use that station or deliberately invalidate the ${oppositeSide} before continuing.`,
        String(row.certificate_number),
        oppositeSide
      );
    }
    if (input.stationId) {
      const releasedOwner = await client.query(
        `SELECT s.*, c.certificate_number
           FROM scanner_capture_sessions s
           JOIN certificates c ON c.id = s.certificate_id
          WHERE s.certificate_id = $1
            AND s.state IN ('claimed','capturing')
            AND s.physical_released = true
          ORDER BY s.created_at
          FOR UPDATE
          LIMIT 1`,
        [input.certificateId]
      );
      const owner = releasedOwner.rows[0] as Record<string, unknown> | undefined;
      if (owner) {
        if (String(owner.station_id ?? "") !== input.stationId) {
          throw new ScannerCaptureConflictError(
            `${String(owner.certificate_number)} is already being finished on another approved station. Finish or cancel it there before continuing.`,
            String(owner.certificate_number),
            String(owner.side)
          );
        }
        if (String(owner.side) === side) {
          throw new ScannerCaptureConflictError(
            `${String(owner.certificate_number)} ${side} is already captured locally and queued for MintVault validation.`,
            String(owner.certificate_number),
            String(owner.side)
          );
        }
      }
    }
    /*
     * RE-ARMING A STATION THAT ALREADY HOLDS A LIVE TARGET IS A REPLAY, NOT A SECOND SESSION.
     *
     * THE DEFECT THIS CLOSES (staging, MV272, 17 Aug 10:46 and 10:52). Migration 0075 puts a partial
     * unique index on `station_id` for state IN ('armed','claimed','capturing'), so a second INSERT
     * for a station that already holds a live target raises a raw unique violation. That is not a
     * typed error, so it fell past the `CaptureAuthorityError` arm of the route's catch, reached the
     * generic handler, and became `500 internal_error / "Station request could not be completed"` —
     * a message that names nothing and suggests nothing.
     *
     * The trap it created was worse than the message. The Scanner's keepalive RENEWS the session it
     * holds, so the expiry sweep above can never reclaim the slot, and the operator's only visible
     * recovery — RETRY SCANNER — was guaranteed to fail for as long as the app kept the card alive.
     * Retry could not work, by construction, and said nothing about why.
     *
     * Returning the session the station already holds is the correct answer to "arm this card":
     * SAME certificate, SAME side, SAME station, so the caller's request is already satisfied. It
     * costs nothing, creates nothing and mints nothing — this branch cannot reach the INSERT below.
     *
     * SFAP-015 splits that physical hold from a background upload task. Once the scanner has
     * durably accepted a TIFF and MintVault has granted its staging task, that row still owns the
     * certificate side and its retries, but no longer blocks the glass from moving to the SAME
     * card's remaining side. It still blocks a DIFFERENT card: release is not permission to start
     * another paid unit while this one is unresolved.
     */
    if (input.stationId) {
      const held = await client.query(
        `SELECT s.*, c.certificate_number
           FROM scanner_capture_sessions s
           JOIN certificates c ON c.id = s.certificate_id
          WHERE s.station_id = $1
            AND s.state IN ('armed','claimed','capturing')
            AND (
              (s.physical_released = false AND s.expires_at > NOW())
              OR (s.physical_released = true AND s.certificate_id <> $2)
            )
          LIMIT 1`,
        [input.stationId, input.certificateId]
      );
      const live = held.rows[0] as Record<string, unknown> | undefined;
      if (live) {
        if (Number(live.certificate_id) === input.certificateId && live.side === side) {
          await client.query("COMMIT");
          return mapRow(live);
        }
        /*
         * A live target for a DIFFERENT card. Refused with a cause the operator can act on and with
         * the blocking card NAMED — "finish or cancel MV999 first" is a sentence someone at a bench
         * can follow; "Station request could not be completed" is not. Typed, so the route can map
         * it to a 409 rather than letting it fall through to the generic 500.
         */
        throw new ScannerCaptureConflictError(
          `This station is already holding ${String(live.certificate_number)} (${String(live.side)}). Finish or cancel that card before arming another.`,
          String(live.certificate_number),
          String(live.side)
        );
      }
    }

    const id = randomUUID();
    const expires = new Date(Date.now() + SESSION_TTL_MS);
    /*
     * SNAPSHOT THE AUTHORITATIVE CAPTURE WINDOW AT ARM TIME.
     *
     * Resolved from this station's current VALID calibration and frozen onto the session, so the
     * upload is judged against the geometry the card was armed under. A recalibration after this
     * point applies to LATER sessions and cannot re-interpret a scan that has already happened.
     *
     * Fails closed: a station with no valid calibration cannot arm a card at all, which is the
     * correct outcome — it has no verified idea where on the platen it is scanning. Enforced only
     * for station-bound sessions; the legacy admin workstation path has no station calibration and
     * is unchanged.
     */
    let calibrationId: string | null = null;
    let acquisitionRegion: AcquisitionRegionMm | null = null;
    if (input.stationId) {
      if (!operationalAuthority) throw new Error("Partner station calibration authority is unavailable");
      calibrationId = operationalAuthority.calibrationId;
      acquisitionRegion = operationalAuthority.acquisitionRegion;
      await assertSidesShareOneRectangle(client, input.certificateId, side, acquisitionRegion);
    }
    const inserted = await client.query(
      `INSERT INTO scanner_capture_sessions
       (id, certificate_id, card_id, submission_item_id, submission_id, side, workstation_id, station_id,
        scanner_profile_version, actor_id, state, recapture, expires_at, calibration_id, acquisition_region)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'armed',$11,$12,$13,$14::jsonb)
       RETURNING *, (SELECT certificate_number FROM certificates WHERE id = certificate_id) AS certificate_number`,
      [
        id,
        input.certificateId,
        row.card_id ?? null,
        row.submission_item_id ?? null,
        row.submission_id ?? null,
        side,
        workstationId,
        input.stationId ?? null,
        input.scannerProfileVersion,
        input.actorId,
        input.recapture,
        expires,
        calibrationId,
        acquisitionRegion ? JSON.stringify(acquisitionRegion) : null,
      ]
    );
    await client.query("COMMIT");
    return mapRow(inserted.rows[0] as Record<string, unknown>);
  } catch (error: any) {
    await client.query("ROLLBACK").catch(() => {});
    if (error?.code === "23505" || error?.cause?.code === "23505") {
      if (error?.constraint === "uq_scanner_capture_one_active_station") {
        throw new Error("This station already has an active capture target");
      }
      throw new Error(`A ${side} capture is already active for this certificate`);
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Atomically claim the next station-owned session.  No filenames participate. */
export async function claimNextScannerCapture(
  workstationIdInput: unknown,
  deviceIdInput: unknown,
  stationIdInput?: string | null
): Promise<ScannerCaptureSession | null> {
  const workstationId = cleanStationId(workstationIdInput);
  const deviceId = cleanStationId(deviceIdInput);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Bound expiry work to this station/session namespace. A separate periodic
    // sweep owns global cleanup; a 5k-station poll must never UPDATE every
    // expired target in the estate before claiming one row.
    if (stationIdInput) {
      await client.query(
        `WITH expired AS (
           SELECT id FROM scanner_capture_sessions
            WHERE station_id = $1 AND state IN ('armed','claimed') AND physical_released = false AND expires_at <= NOW()
            ORDER BY expires_at, id FOR UPDATE SKIP LOCKED LIMIT 50
         )
         UPDATE scanner_capture_sessions s SET state = 'expired'
          FROM expired WHERE s.id = expired.id`,
        [stationIdInput]
      );
    } else {
      await client.query(
        `WITH expired AS (
           SELECT id FROM scanner_capture_sessions
            WHERE workstation_id = $1 AND state IN ('armed','claimed') AND physical_released = false AND expires_at <= NOW()
            ORDER BY expires_at, id FOR UPDATE SKIP LOCKED LIMIT 50
         )
         UPDATE scanner_capture_sessions s SET state = 'expired'
          FROM expired WHERE s.id = expired.id`,
        [workstationId]
      );
    }
    /*
     * Station-scoped claim binds ONE parameter (AT-23 §B, 2026-08-14). The previous shape put the
     * station id at $2 while nothing referenced $1, so PostgreSQL refused the query outright
     * ("could not determine data type of parameter $1") — the signed-station claim path had never
     * executed. The station principal supersedes the client-supplied workstation string entirely,
     * exactly as the route comment promises.
     */
    const stationWhere = stationIdInput ? "AND s.station_id = $1" : "AND s.workstation_id = $1";
    const params = stationIdInput ? [stationIdInput] : [workstationId];
    const selected = await client.query(
      `SELECT s.*, c.certificate_number
         FROM scanner_capture_sessions s
         JOIN certificates c ON c.id = s.certificate_id
        WHERE s.state = 'armed' AND s.expires_at > NOW() ${stationWhere}
        ORDER BY s.created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
      params
    );
    const row = selected.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      await client.query("COMMIT");
      return null;
    }
    await client.query(
      `UPDATE scanner_capture_sessions SET state = 'claimed', claimed_by_device_id = $1, claimed_at = NOW() WHERE id = $2`,
      [deviceId, row.id]
    );
    await client.query("COMMIT");
    return mapRow({ ...row, state: "claimed" });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Bounded global housekeeping; never call this from a station poll. */
export async function expireScannerCaptureSessions(limit = 100): Promise<number> {
  const bounded = Math.max(1, Math.min(1_000, Math.trunc(limit)));
  const result = await pool.query(
    `WITH expired AS (
       SELECT id FROM scanner_capture_sessions
        WHERE state IN ('armed','claimed') AND physical_released = false AND expires_at <= NOW()
        ORDER BY expires_at, id FOR UPDATE SKIP LOCKED LIMIT $1
     )
     UPDATE scanner_capture_sessions s SET state='expired'
      FROM expired WHERE s.id=expired.id
     RETURNING s.id`,
    [bounded]
  );
  return result.rowCount ?? 0;
}

/**
 * Keep a station-claimed target alive while the operator positions a card or
 * reviews its local derivative.  It deliberately cannot revive an expired,
 * failed, capturing, or captured session, and never changes the target.
 */
export async function renewScannerCapture(sessionId: string, deviceIdInput: unknown): Promise<ScannerCaptureSession> {
  const deviceId = cleanStationId(deviceIdInput);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [hashLockKey(`capture-session:${sessionId}`)]);
    const found = await client.query(
      `SELECT s.*, c.certificate_number
         FROM scanner_capture_sessions s
         JOIN certificates c ON c.id = s.certificate_id
        WHERE s.id = $1 AND s.claimed_by_device_id = $2
        FOR UPDATE`,
      [sessionId, deviceId]
    );
    const row = found.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error("Capture session not found for this scanner");
    if (row.physical_released !== true && new Date(String(row.expires_at)).getTime() <= Date.now()) {
      await client.query(`UPDATE scanner_capture_sessions SET state = 'expired' WHERE id = $1 AND state = 'claimed'`, [
        sessionId,
      ]);
      // Persist the terminal state before reporting it. Throwing while the
      // transaction is still open would roll this update back and leave a
      // stale preview queue repeatedly attempting to renew the same target.
      await client.query("COMMIT");
      throw new Error("Capture session expired");
    }
    if (row.state !== "claimed") throw new Error("Capture session is not awaiting scanner acceptance");
    const renewed = await client.query(
      `UPDATE scanner_capture_sessions
          SET expires_at = NOW() + ($3::bigint * INTERVAL '1 millisecond')
        WHERE id = $1 AND claimed_by_device_id = $2 AND state = 'claimed'
        RETURNING *, (SELECT certificate_number FROM certificates WHERE id = certificate_id) AS certificate_number`,
      [sessionId, deviceId, SESSION_TTL_MS]
    );
    await client.query("COMMIT");
    return mapRow(renewed.rows[0] as Record<string, unknown>);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** One session can transition to capture exactly once; replay and stale jobs fail closed. */
export async function beginScannerCapture(sessionId: string, deviceIdInput: unknown): Promise<ScannerCaptureSession> {
  const deviceId = cleanStationId(deviceIdInput);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query("SELECT pg_advisory_xact_lock($1)", [
      hashLockKey(`capture-session:${sessionId}`),
    ]);
    void locked;
    const found = await client.query(
      `SELECT s.*, c.certificate_number FROM scanner_capture_sessions s
        JOIN certificates c ON c.id = s.certificate_id WHERE s.id = $1 FOR UPDATE`,
      [sessionId]
    );
    const row = found.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error("Capture session not found");
    if (row.physical_released !== true && new Date(String(row.expires_at)).getTime() <= Date.now()) {
      await client.query("UPDATE scanner_capture_sessions SET state = 'expired' WHERE id = $1", [sessionId]);
      // The expiry itself is an audit-relevant terminal transition; preserve
      // it before returning the fail-closed response to a late Accept.
      await client.query("COMMIT");
      throw new Error("Capture session expired");
    }
    if (row.state !== "claimed" || row.claimed_by_device_id !== deviceId)
      throw new Error("Capture session is not claimed by this station");
    await client.query("UPDATE scanner_capture_sessions SET state = 'capturing' WHERE id = $1", [sessionId]);
    await client.query("COMMIT");
    return mapRow({ ...row, state: "capturing" });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function finishScannerCapture(
  sessionId: string,
  ok: boolean,
  reason?: string,
  retryable = false
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE scanner_capture_sessions
        SET state = CASE WHEN $4 THEN 'claimed' ELSE $2 END,
            expires_at = CASE
              WHEN $4 THEN NOW() + (${SESSION_TTL_MS}::bigint * INTERVAL '1 millisecond')
              ELSE expires_at
            END,
            captured_at = CASE WHEN $2 = 'captured' THEN NOW() ELSE captured_at END,
            failure_reason = CASE WHEN $2 = 'failed' THEN LEFT($3, 1000) ELSE failure_reason END
      WHERE id = $1 AND state = 'capturing'`,
      [sessionId, ok ? "captured" : "failed", reason ?? null, retryable]
    );
  } finally {
    client.release();
  }
}

/**
 * A card is scanner-registered only when the database has terminal,
 * target-bound captures for both sides. This is presentation state for the
 * station hand-off, not an authority to grade or print.
 */
export async function isScannerCaptureCardRegistered(certificateId: number): Promise<boolean> {
  const result = await pool.query<{ card_registered: boolean }>(
    `SELECT
       EXISTS (
         SELECT 1 FROM scanner_capture_sessions
          WHERE certificate_id=$1 AND side='front' AND state='captured'
       )
       AND EXISTS (
         SELECT 1 FROM scanner_capture_sessions
          WHERE certificate_id=$1 AND side='back' AND state='captured'
       ) AS card_registered`,
    [certificateId]
  );
  return result.rows[0]?.card_registered === true;
}

/**
 * Read the terminal truth for a claimed station session.  Evidence carries the
 * session UUID in its immutable provenance, so this also heals the narrow
 * response-loss window where evidence was accepted but the client never
 * received the HTTP 201.  It deliberately does not infer success from a
 * certificate-side alone: a recapture may coexist with an earlier revision.
 */
export async function getScannerCaptureStatus(
  sessionId: string,
  deviceIdInput: unknown
): Promise<{ session: ScannerCaptureSession; accepted: boolean; cardRegistered: boolean }> {
  const deviceId = cleanStationId(deviceIdInput);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query(
      `SELECT s.*, c.certificate_number,
              EXISTS (
                SELECT 1
                  FROM certificate_image_evidence e
                 WHERE e.certificate_id = s.certificate_id
                   AND e.side = s.side
                   AND e.capture_metadata ->> 'captureSessionId' = s.id
              ) AS evidence_accepted,
              EXISTS (
                SELECT 1 FROM scanner_capture_sessions paired
                 WHERE paired.certificate_id=s.certificate_id
                   AND paired.side='front'
                   AND paired.state='captured'
              )
              AND EXISTS (
                SELECT 1 FROM scanner_capture_sessions paired
                 WHERE paired.certificate_id=s.certificate_id
                   AND paired.side='back'
                   AND paired.state='captured'
              ) AS card_registered
         FROM scanner_capture_sessions s
         JOIN certificates c ON c.id = s.certificate_id
        WHERE s.id = $1 AND s.claimed_by_device_id = $2
        FOR UPDATE`,
      [sessionId, deviceId]
    );
    const row = found.rows[0] as
      (Record<string, unknown> & { evidence_accepted?: boolean; card_registered?: boolean }) | undefined;
    if (!row) throw new Error("Capture session not found for this scanner");
    if (
      (row.state === "armed" || row.state === "claimed") &&
      row.physical_released !== true &&
      new Date(String(row.expires_at)).getTime() <= Date.now()
    ) {
      await client.query(
        `UPDATE scanner_capture_sessions SET state = 'expired' WHERE id = $1 AND state IN ('armed', 'claimed')`,
        [sessionId]
      );
      row.state = "expired";
    }
    const accepted = row.evidence_accepted === true;
    if (accepted && row.state !== "captured") {
      await client.query(
        `UPDATE scanner_capture_sessions
            SET state = 'captured', captured_at = COALESCE(captured_at, NOW()), failure_reason = NULL
          WHERE id = $1`,
        [sessionId]
      );
      row.state = "captured";
      row.failure_reason = null;
    }
    await client.query("COMMIT");
    const cardRegistered =
      row.card_registered === true || (accepted && (await isScannerCaptureCardRegistered(Number(row.certificate_id))));
    return { session: mapRow(row), accepted, cardRegistered };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Fail a claimed station session only while no immutable evidence exists for it. */
export async function failScannerCapture(
  sessionId: string,
  deviceIdInput: unknown,
  reason: string
): Promise<{ terminalized: boolean; accepted: boolean; state: string; reason?: string }> {
  const deviceId = cleanStationId(deviceIdInput);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query<Record<string, unknown> & { evidence_accepted?: boolean }>(
      `SELECT s.*, c.certificate_number,
              EXISTS (
                SELECT 1
                  FROM certificate_image_evidence e
                 WHERE e.certificate_id = s.certificate_id
                   AND e.side = s.side
                   AND e.capture_metadata ->> 'captureSessionId' = s.id
              ) AS evidence_accepted
         FROM scanner_capture_sessions s
         JOIN certificates c ON c.id = s.certificate_id
        WHERE s.id = $1
          AND s.claimed_by_device_id = $2
        FOR UPDATE`,
      [sessionId, deviceId]
    );
    const row = found.rows[0];
    if (!row) throw new Error("Capture session not found for this scanner");
    if (row.evidence_accepted === true) {
      await client.query(
        `UPDATE scanner_capture_sessions
            SET state='captured', captured_at=COALESCE(captured_at, NOW()), failure_reason=NULL
          WHERE id=$1`,
        [sessionId]
      );
      await client.query("COMMIT");
      return { terminalized: true, accepted: true, state: "captured" };
    }
    if (row.state === "claimed") {
      await client.query(
        `UPDATE scanner_capture_sessions
            SET state = 'failed', failure_reason = LEFT($3, 1000)
          WHERE id = $1
            AND claimed_by_device_id = $2
            AND state = 'claimed'
            AND NOT EXISTS (
            SELECT 1
              FROM certificate_image_evidence e
             WHERE e.certificate_id = scanner_capture_sessions.certificate_id
               AND e.side = scanner_capture_sessions.side
               AND e.capture_metadata ->> 'captureSessionId' = scanner_capture_sessions.id
            )`,
        [sessionId, deviceId, reason]
      );
      await client.query("COMMIT");
      return { terminalized: true, accepted: false, state: "failed" };
    }
    if (row.state === "failed" || row.state === "expired" || row.state === "cancelled" || row.state === "captured") {
      await client.query("COMMIT");
      return { terminalized: true, accepted: row.state === "captured", state: String(row.state) };
    }
    await client.query("COMMIT");
    return {
      terminalized: false,
      accepted: false,
      state: String(row.state),
      reason: "Capture session is in server finalisation; keep the local recovery record and retry.",
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
