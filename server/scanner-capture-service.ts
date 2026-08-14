/**
 * Server-owned capture sessions for a physical workstation.  The Electron app
 * never receives a free-form certificate/side target: it can only claim one
 * short-lived session that the workstation created first.
 */
import { randomUUID } from "node:crypto";
import { pool } from "./db";
import { hashLockKey } from "./lib/advisory-lock";

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
  state: "armed" | "claimed" | "capturing" | "captured" | "failed" | "expired" | "cancelled";
  expiresAt: Date;
  recapture: boolean;
  failureReason: string | null;
  captureAuthorisationId: string | null;
  semanticOperationId: string | null;
  cardJobId: string | null;
  profileRevisionId: string | null;
  profileDigestSha256: string | null;
  tenantId: string | null;
  locationId: string | null;
  originalOperatorId: string | null;
  originalOperatorRole: string | null;
  capturePurpose: string | null;
  revision: number | null;
  authorisationIssuedAt: Date | null;
  authorisationExpiresAt: Date | null;
  cancelEligible: boolean;
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

export function mapScannerCaptureRow(row: Record<string, unknown>): ScannerCaptureSession {
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
    captureAuthorisationId: row.capture_authorisation_id == null ? null : String(row.capture_authorisation_id),
    semanticOperationId: row.semantic_operation_id == null ? null : String(row.semantic_operation_id),
    cardJobId: row.card_job_id == null ? null : String(row.card_job_id),
    profileRevisionId: row.profile_revision_id == null ? null : String(row.profile_revision_id),
    profileDigestSha256: row.profile_digest_sha256 == null ? null : String(row.profile_digest_sha256),
    tenantId: row.tenant_id == null ? null : String(row.tenant_id),
    locationId: row.location_id == null ? null : String(row.location_id),
    originalOperatorId: row.original_operator_id == null ? null : String(row.original_operator_id),
    originalOperatorRole: row.original_operator_role == null ? null : String(row.original_operator_role),
    capturePurpose: row.capture_purpose == null ? null : String(row.capture_purpose),
    revision: row.evidence_revision == null ? null : Number(row.evidence_revision),
    authorisationIssuedAt: row.authorisation_issued_at == null ? null : new Date(String(row.authorisation_issued_at)),
    authorisationExpiresAt: row.authorisation_expires_at == null ? null : new Date(String(row.authorisation_expires_at)),
    cancelEligible:
      row.side === "front" &&
      ["armed", "claimed"].includes(String(row.state)) &&
      row.capture_authorisation_id != null,
  };
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
  originalOperatorRole?: string | null;
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
    const id = randomUUID();
    const issuedAt = new Date();
    const expires = new Date(issuedAt.getTime() + SESSION_TTL_MS);
    let authority: {
      captureAuthorisationId: string;
      semanticOperationId: string;
      cardJobId: string;
      profileRevisionId: string;
      profileDigestSha256: string;
      tenantId: string;
      locationId: string;
      originalOperatorId: string;
      originalOperatorRole: string;
      capturePurpose: string;
      evidenceRevision: number;
    } | null = null;
    if (input.stationId) {
      const bound = await client.query<{
        card_job_id: string;
        profile_revision_id: string | null;
        profile_digest_sha256: string | null;
        tenant_id: string;
        location_id: string;
        evidence_revision: number;
      }>(
        `SELECT job.id AS card_job_id,station.current_profile_revision_id AS profile_revision_id,
                profile.profile_digest_sha256,
                station.tenant_id,station.location_id,
                (SELECT count(*)::integer+1 FROM certificate_image_evidence e
                  WHERE e.certificate_id=$2 AND e.side=$3) AS evidence_revision
           FROM partner_stations station
           JOIN partner_card_jobs job
             ON job.tenant_id=station.tenant_id AND job.location_id=station.location_id
            AND job.certificate_id=$2 AND job.cancelled_at IS NULL
           LEFT JOIN partner_station_profile_revisions profile ON profile.id=station.current_profile_revision_id
          WHERE station.id=$1 AND station.status='ACTIVE'
          LIMIT 1`,
        [input.stationId, input.certificateId, side]
      );
      const exact = bound.rows[0];
      if (!exact || !exact.profile_revision_id || !exact.profile_digest_sha256 || !input.actorId) {
        throw new Error("Station capture requires an exact Card Job, operator and locked profile revision");
      }
      authority = {
        captureAuthorisationId: randomUUID(),
        semanticOperationId: randomUUID(),
        cardJobId: exact.card_job_id,
        profileRevisionId: exact.profile_revision_id,
        profileDigestSha256: exact.profile_digest_sha256,
        tenantId: exact.tenant_id,
        locationId: exact.location_id,
        originalOperatorId: input.actorId,
        originalOperatorRole: input.originalOperatorRole || "SCANNER_OPERATOR",
        capturePurpose: "AUTHORITATIVE_CARD_CAPTURE",
        evidenceRevision: Number(exact.evidence_revision),
      };
    }
    const inserted = await client.query(
      `INSERT INTO scanner_capture_sessions
       (id, certificate_id, card_id, submission_item_id, submission_id, side, workstation_id, station_id,
        scanner_profile_version, actor_id, state, recapture, expires_at,
        capture_authorisation_id,semantic_operation_id,card_job_id,profile_revision_id,profile_digest_sha256,tenant_id,location_id,
        original_operator_id,original_operator_role,capture_purpose,evidence_revision,
        authorisation_issued_at,authorisation_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'armed',$11,$12,
               $13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
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
        authority?.captureAuthorisationId ?? null,
        authority?.semanticOperationId ?? null,
        authority?.cardJobId ?? null,
        authority?.profileRevisionId ?? null,
        authority?.profileDigestSha256 ?? null,
        authority?.tenantId ?? null,
        authority?.locationId ?? null,
        authority?.originalOperatorId ?? null,
        authority?.originalOperatorRole ?? null,
        authority?.capturePurpose ?? null,
        authority?.evidenceRevision ?? null,
        authority ? issuedAt : null,
        authority ? expires : null,
      ]
    );
    await client.query("COMMIT");
    return mapScannerCaptureRow(inserted.rows[0] as Record<string, unknown>);
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

/** Ensure the exact next FRONT-before-BACK target exists for one paid Card Job. */
export async function ensureNextCardJobCaptureSession(input: {
  cardJobId: string;
  stationId: string;
  actorId: string;
  originalOperatorRole?: string;
  recapture?: boolean;
}): Promise<ScannerCaptureSession | null> {
  const target = await pool.query<{
    certificate_id: number;
    station_code: string;
    scanner_profile_version: string;
    has_front: boolean;
    has_back: boolean;
  }>(
    `SELECT job.certificate_id,station.station_code,station.scanner_profile_version,
            EXISTS (SELECT 1 FROM certificate_image_evidence e
                     WHERE e.certificate_id=job.certificate_id AND e.side='front' AND e.is_current) AS has_front,
            EXISTS (SELECT 1 FROM certificate_image_evidence e
                     WHERE e.certificate_id=job.certificate_id AND e.side='back' AND e.is_current) AS has_back
       FROM partner_card_jobs job
       JOIN partner_stations station
         ON station.id=$2 AND station.tenant_id=job.tenant_id AND station.location_id=job.location_id
      WHERE job.id=$1 AND job.cancelled_at IS NULL AND station.status='ACTIVE'`,
    [input.cardJobId, input.stationId]
  );
  const row = target.rows[0];
  if (!row || row.certificate_id == null || !row.scanner_profile_version) {
    throw new Error("Card Job cannot be armed for this station");
  }
  if (row.has_front && row.has_back) return null;
  const side: CaptureSide = row.has_front ? "back" : "front";
  const existing = await pool.query(
    `SELECT s.*,c.certificate_number FROM scanner_capture_sessions s
      JOIN certificates c ON c.id=s.certificate_id
     WHERE s.card_job_id=$1 AND s.station_id=$2 AND s.side=$3
       AND s.state IN ('armed','claimed','capturing') AND s.expires_at>now()
     ORDER BY s.created_at DESC LIMIT 1`,
    [input.cardJobId, input.stationId, side]
  );
  if (existing.rows[0]) return mapScannerCaptureRow(existing.rows[0]);
  try {
    return await createScannerCaptureSession({
      certificateId: row.certificate_id,
      side,
      workstationId: row.station_code,
      stationId: input.stationId,
      actorId: input.actorId,
      originalOperatorRole: input.originalOperatorRole || "SCANNER_OPERATOR",
      recapture: input.recapture === true,
      scannerProfileVersion: row.scanner_profile_version,
    });
  } catch (error) {
    const raced = await pool.query(
      `SELECT s.*,c.certificate_number FROM scanner_capture_sessions s
        JOIN certificates c ON c.id=s.certificate_id
       WHERE s.card_job_id=$1 AND s.station_id=$2 AND s.side=$3
         AND s.state IN ('armed','claimed','capturing') AND s.expires_at>now()
       ORDER BY s.created_at DESC LIMIT 1`,
      [input.cardJobId, input.stationId, side]
    );
    if (raced.rows[0]) return mapScannerCaptureRow(raced.rows[0]);
    throw error;
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
    return mapScannerCaptureRow({ ...row, state: "claimed" });
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
    if (row.authorisation_expires_at == null || new Date(String(row.authorisation_expires_at)).getTime() <= Date.now()) {
      await client.query(`UPDATE scanner_capture_sessions SET state='expired' WHERE id=$1 AND state='claimed'`, [sessionId]);
      await client.query("COMMIT");
      throw new Error("Capture authorisation expired");
    }
    const renewed = await client.query(
      `UPDATE scanner_capture_sessions
          SET expires_at = LEAST(authorisation_expires_at, NOW() + ($3::bigint * INTERVAL '1 millisecond'))
        WHERE id = $1 AND claimed_by_device_id = $2 AND state = 'claimed'
        RETURNING *, (SELECT certificate_number FROM certificates WHERE id = certificate_id) AS certificate_number`,
      [sessionId, deviceId, SESSION_TTL_MS]
    );
    await client.query("COMMIT");
    return mapScannerCaptureRow(renewed.rows[0] as Record<string, unknown>);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function issueScannerRescanAuthorisation(input: {
  sessionId: string;
  deviceId: unknown;
  stationId: string | null;
  priorCaptureAuthorisationId: unknown;
  requestOperationId: unknown;
}): Promise<ScannerCaptureSession> {
  const deviceId = cleanStationId(input.deviceId);
  const prior = String(input.priorCaptureAuthorisationId || "").toLowerCase();
  const requestOperationId = String(input.requestOperationId || "").toLowerCase();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (!uuid.test(prior) || !uuid.test(requestOperationId) || !input.stationId) {
    throw new Error("Rescan authorisation request is invalid");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [hashLockKey(`capture-session:${input.sessionId}`)]);
    const replay = await client.query<{
      station_id: string;
      capture_session_id: string;
      prior_capture_authorisation_id: string;
      result: Record<string, unknown>;
    }>(
      `SELECT station_id,capture_session_id,prior_capture_authorisation_id,result
         FROM scanner_capture_rescan_operations
        WHERE request_operation_id=$1`,
      [requestOperationId]
    );
    if (replay.rows[0]) {
      if (
        replay.rows[0].station_id !== input.stationId ||
        replay.rows[0].capture_session_id !== input.sessionId ||
        replay.rows[0].prior_capture_authorisation_id !== prior
      ) {
        throw new Error("Rescan operation idempotency conflict");
      }
      await client.query("COMMIT");
      return replay.rows[0].result as unknown as ScannerCaptureSession;
    }
    const found = await client.query(
      `SELECT s.*,c.certificate_number FROM scanner_capture_sessions s
        JOIN certificates c ON c.id=s.certificate_id
       WHERE s.id=$1 AND s.station_id=$2 AND s.claimed_by_device_id=$3
       FOR UPDATE`,
      [input.sessionId, input.stationId, deviceId]
    );
    const row = found.rows[0] as Record<string, unknown> | undefined;
    if (!row || row.state !== "claimed" || String(row.capture_authorisation_id) !== prior) {
      throw new Error("Rescan target is not the exact current claimed authorisation");
    }
    const staged = await client.query(
      `SELECT 1 FROM scanner_evidence_staging WHERE capture_session_id=$1 LIMIT 1`,
      [input.sessionId]
    );
    if (staged.rowCount) throw new Error("Rescan is unavailable after evidence upload staging begins");
    const now = new Date();
    const expires = new Date(now.getTime() + SESSION_TTL_MS);
    const advanced = await client.query(
      `UPDATE scanner_capture_sessions
          SET capture_authorisation_id=$2,semantic_operation_id=$3,
              evidence_revision=evidence_revision+1,
              authorisation_issued_at=$4,authorisation_expires_at=$5,expires_at=$5,
              failure_reason=NULL
        WHERE id=$1 AND capture_authorisation_id=$6 AND state='claimed'
        RETURNING *, (SELECT certificate_number FROM certificates WHERE id=certificate_id) AS certificate_number`,
      [input.sessionId, randomUUID(), randomUUID(), now, expires, prior]
    );
    if (advanced.rowCount !== 1) throw new Error("Rescan authorisation lost its target race");
    const capture = mapScannerCaptureRow(advanced.rows[0]);
    await client.query(
      `INSERT INTO scanner_capture_rescan_operations
         (capture_session_id,station_id,request_operation_id,prior_capture_authorisation_id,result)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [input.sessionId, input.stationId, requestOperationId, prior, JSON.stringify(capture)]
    );
    await client.query("COMMIT");
    return capture;
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
    return mapScannerCaptureRow({ ...row, state: "capturing" });
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
): Promise<{
  session: ScannerCaptureSession;
  accepted: boolean;
  cardRegistered: boolean;
  disposition: "ACCEPTED" | "STILL_REQUIRED" | "CANCELLED" | "INVALID_TARGET" | "REQUIRES_FIX" | null;
  dispositionBinding: unknown;
}> {
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
      | (Record<string, unknown> & { evidence_accepted?: boolean; card_registered?: boolean })
      | undefined;
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
    const binding = await client.query<{ immutable_binding: unknown }>(
      `SELECT immutable_binding FROM scanner_evidence_staging
        WHERE capture_session_id=$1 AND immutable_binding IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`,
      [sessionId]
    );
    const state = String(row.state);
    const disposition = accepted
      ? "ACCEPTED"
      : state === "cancelled"
        ? "CANCELLED"
        : state === "expired"
          ? "INVALID_TARGET"
          : state === "failed"
            ? "REQUIRES_FIX"
            : binding.rows[0]
              ? "STILL_REQUIRED"
              : null;
    return {
      session: mapScannerCaptureRow(row),
      accepted,
      cardRegistered,
      disposition,
      dispositionBinding: binding.rows[0]?.immutable_binding ?? null,
    };
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
