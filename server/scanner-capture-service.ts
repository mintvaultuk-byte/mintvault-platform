/**
 * Server-owned capture sessions for a physical workstation.  The Electron app
 * never receives a free-form certificate/side target: it can only claim one
 * short-lived session that the workstation created first.
 */
import { randomUUID } from "node:crypto";
import { pool } from "./db";
import { hashLockKey } from "./lib/advisory-lock";
import { resolveAuthoritativeAcquisitionRegion, type AcquisitionRegionMm } from "./lib/lide400-capture-authority";

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
 * Resolve the station's current VALID calibration and return the rectangle to snapshot.
 *
 * Runs inside the arming transaction, on a row the arm already has the station id for, so it costs
 * one indexed join at arm time and NOTHING in the evidence hot path — the region travels on the
 * session row that path already loads.
 */
async function resolveArmedAcquisitionRegion(
  client: { query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  stationId: string,
  scannerProfileVersion: string
): Promise<{ calibrationId: string; region: AcquisitionRegionMm }> {
  const found = await client.query(
    `SELECT k.id, k.station_id, k.health_status, k.scanner_profile_version, k.calibration_version, k.acquisition_region
       FROM partner_stations s
       JOIN partner_station_calibrations k ON k.id = s.current_calibration_id
      WHERE s.id = $1
      LIMIT 1`,
    [stationId]
  );
  const row = found.rows[0];
  const region = resolveAuthoritativeAcquisitionRegion(
    row
      ? {
          id: row.id == null ? null : String(row.id),
          stationId: row.station_id == null ? null : String(row.station_id),
          healthStatus: row.health_status == null ? null : String(row.health_status),
          scannerProfileVersion: row.scanner_profile_version == null ? null : String(row.scanner_profile_version),
          calibrationVersion: row.calibration_version == null ? null : String(row.calibration_version),
          acquisitionRegion: row.acquisition_region,
        }
      : null,
    { stationId, scannerProfileVersion }
  );
  return { calibrationId: String(row!.id), region };
}

export async function ensureScannerCaptureSchema(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
    CREATE TABLE IF NOT EXISTS scanner_capture_sessions (
      id TEXT PRIMARY KEY,
      certificate_id INTEGER NOT NULL REFERENCES certificates(id) ON DELETE RESTRICT,
      card_id INTEGER,
      submission_item_id INTEGER,
      submission_id INTEGER,
      side VARCHAR(5) NOT NULL CHECK (side IN ('front', 'back')),
      workstation_id TEXT NOT NULL,
      station_id UUID,
      scanner_profile_version TEXT NOT NULL,
      actor_id TEXT,
      state VARCHAR(16) NOT NULL CHECK (state IN ('armed','claimed','capturing','captured','failed','expired','cancelled')),
      claimed_by_device_id TEXT,
      recapture BOOLEAN NOT NULL DEFAULT false,
      failure_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      claimed_at TIMESTAMPTZ,
      captured_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ NOT NULL
    )
    `);
    await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_scanner_capture_one_active_target
      ON scanner_capture_sessions (certificate_id, side)
      WHERE state IN ('armed', 'claimed', 'capturing')
    `);
    await client.query(`
    CREATE INDEX IF NOT EXISTS idx_scanner_capture_claim
      ON scanner_capture_sessions (state, expires_at, workstation_id, created_at)
    `);
    await client.query(`ALTER TABLE scanner_capture_sessions ADD COLUMN IF NOT EXISTS station_id UUID`);
    /*
     * The server-owned capture window, snapshotted when a side is armed. Mirrored here as idempotent
     * runtime DDL for the same reason `station_id` above is — this table is created by this function
     * on a fresh database — and journalled properly as migration 0091 so a deployed database is not
     * left carrying columns no migration records. Both must exist: runtime DDL alone was how this
     * repo previously ended up reconciling undocumented drift.
     */
    await client.query(`ALTER TABLE scanner_capture_sessions ADD COLUMN IF NOT EXISTS calibration_id UUID`);
    await client.query(`ALTER TABLE scanner_capture_sessions ADD COLUMN IF NOT EXISTS acquisition_region JSONB`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_scanner_capture_station_claim
        ON scanner_capture_sessions (station_id, created_at) WHERE state = 'armed'
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_scanner_capture_expiry
        ON scanner_capture_sessions (expires_at, id) WHERE state IN ('armed','claimed')
    `);
  } finally {
    client.release();
  }
}

export async function createScannerCaptureSession(input: {
  certificateId: number;
  side: unknown;
  workstationId: unknown;
  stationId?: string | null;
  actorId: string | null;
  recapture: boolean;
  scannerProfileVersion: string;
}): Promise<ScannerCaptureSession> {
  const side = cleanSide(input.side);
  const workstationId = cleanStationId(input.workstationId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
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
            AND expires_at <= NOW()`,
        [input.stationId]
      );
    }
    const cert = await client.query(
      `
      SELECT c.id, c.certificate_number, c.card_id, c.submission_item_id,
             COALESCE(card.submission_id, item.submission_id) AS submission_id
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
    let walkInStationBound = false;
    if (input.stationId && row.card_id == null && row.submission_item_id == null) {
      const walkInScope = await client.query(
        `SELECT 1
           FROM partner_stations station
           JOIN partner_card_jobs job
             ON job.tenant_id=station.tenant_id
            AND job.location_id=station.location_id
            AND job.certificate_id=$2
            -- P6c: a CANCELLED Card Job binds nothing. Its credit has been returned, so arming
            -- against its certificate would let a station photograph a card the shop is no longer
            -- paying for. The Card Job authorities all carry this predicate; this is the
            -- independent second lock on the HQ pool, which the browser arming route also reaches.
            AND job.cancelled_at IS NULL
          WHERE station.id=$1
            AND station.status='ACTIVE'
          LIMIT 1`,
        [input.stationId, input.certificateId]
      );
      walkInStationBound = walkInScope.rows.length === 1;
    }
    if (!walkInStationBound) {
      if (row.card_id == null && row.submission_item_id == null) {
        throw new Error("Certificate must be bound to a selected card or submission item before scanner capture");
      }
      if (row.submission_id == null) {
        throw new Error("Selected card has no submission binding; scanner capture is refused");
      }
    }
    if (input.stationId && !walkInStationBound) {
      // A station is scoped to a Partner tenant/location. A matching legacy
      // submission must have crossed the connector bridge for this exact
      // station scope; a caller cannot attach an otherwise-valid card to an
      // arbitrary active Mac in another tenant or location.
      const stationScope = await client.query(
        `SELECT 1
           FROM partner_stations station
           JOIN partner_connector_imports imported
             ON imported.partner_organisation_id=station.tenant_id
            AND imported.partner_location_id=station.location_id
            AND imported.destination_submission_id=$2
          WHERE station.id=$1
            AND station.status='ACTIVE'
            AND imported.state IN ('completed','imported')
          LIMIT 1`,
        [input.stationId, row.submission_id]
      );
      /*
       * SECOND, EQUALLY STRICT BINDING PATH — a Card Job started at the counter (P6).
       *
       * The connector join above proves tenant scope for cards that reached MintVault through a
       * portal submission and the import bridge. A walk-in card never travels that road: its
       * certificate is minted directly in the NEW transaction, so it has no connector import row
       * and the join above can never match it. Without this branch, every Scanner-started card
       * would be refused at the moment the operator tried to capture the card they had just paid
       * for.
       *
       * This is NOT a relaxation. It demands exactly the same three facts through the Card Job
       * instead of the import: the certificate belongs to a job whose tenant_id AND location_id
       * equal this station's, and the station is ACTIVE. Partner A's station still cannot arm
       * Partner B's certificate, and a station cannot reach a job at another of its own tenant's
       * locations.
       */
      let bound = stationScope.rows.length === 1;
      if (!bound) {
        const cardJobScope = await client.query(
          `SELECT 1
             FROM partner_stations station
             JOIN partner_card_jobs job
               ON job.tenant_id=station.tenant_id
              AND job.location_id=station.location_id
              AND job.certificate_id=$2
              -- P6c: same predicate as the walk-in branch above — a cancelled job binds nothing.
              AND job.cancelled_at IS NULL
            WHERE station.id=$1
              AND station.status='ACTIVE'
            LIMIT 1`,
          [input.stationId, input.certificateId]
        );
        bound = cardJobScope.rows.length === 1;
      }
      if (!bound) {
        throw new Error("Certificate is not bound to this station's tenant and location");
      }
    }
    if (!input.recapture) {
      const evidence = await client.query(
        `SELECT 1 FROM certificate_image_evidence WHERE certificate_id = $1 AND side = $2 AND is_current = true LIMIT 1`,
        [input.certificateId, side]
      );
      if (evidence.rows.length) throw new Error(`${side} already has a current master; use controlled recapture`);
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
     */
    if (input.stationId) {
      const held = await client.query(
        `SELECT s.*, c.certificate_number
           FROM scanner_capture_sessions s
           JOIN certificates c ON c.id = s.certificate_id
          WHERE s.station_id = $1
            AND s.state IN ('armed','claimed','capturing')
            AND s.expires_at > NOW()
          LIMIT 1`,
        [input.stationId]
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
      const resolved = await resolveArmedAcquisitionRegion(client, input.stationId, input.scannerProfileVersion);
      calibrationId = resolved.calibrationId;
      acquisitionRegion = resolved.region;
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
            WHERE station_id = $1 AND state IN ('armed','claimed') AND expires_at <= NOW()
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
            WHERE workstation_id = $1 AND state IN ('armed','claimed') AND expires_at <= NOW()
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
        WHERE state IN ('armed','claimed') AND expires_at <= NOW()
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
    if (new Date(String(row.expires_at)).getTime() <= Date.now()) {
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
    if (new Date(String(row.expires_at)).getTime() <= Date.now()) {
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

/** Fail only a claim that could not reach the physical device before upload starts. */
export async function failScannerCapture(sessionId: string, deviceIdInput: unknown, reason: string): Promise<void> {
  const deviceId = cleanStationId(deviceIdInput);
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE scanner_capture_sessions
          SET state = 'failed', failure_reason = LEFT($3, 1000)
        WHERE id = $1 AND claimed_by_device_id = $2 AND state = 'claimed'`,
      [sessionId, deviceId, reason]
    );
  } finally {
    client.release();
  }
}
