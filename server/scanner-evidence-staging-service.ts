import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "./db";
import { hashLockKey } from "./lib/advisory-lock";
import { mapScannerCaptureRow, type ScannerCaptureSession } from "./scanner-capture-service";
import { validateScannerEvidenceBinding, type ScannerEvidenceBinding } from "./scanner-evidence-binding";

const STAGING_TTL_MS = 15 * 60_000;
const FINALISATION_STALE_MS = 15 * 60_000;

export type ScannerEvidenceStaging = {
  id: string;
  captureSessionId: string;
  stationId: string | null;
  objectKey: string;
  expectedSha256: string;
  expectedBytes: number;
  provenance: unknown;
  state: "granted" | "finalizing" | "accepted" | "failed" | "expired";
  expiresAt: Date;
  immutableBinding: ScannerEvidenceBinding | null;
};

type StagingRow = Record<string, unknown>;

function mapStaging(row: StagingRow): ScannerEvidenceStaging {
  return {
    id: String(row.id),
    captureSessionId: String(row.capture_session_id),
    stationId: row.station_id == null ? null : String(row.station_id),
    objectKey: String(row.object_key),
    expectedSha256: String(row.expected_sha256),
    expectedBytes: Number(row.expected_bytes),
    provenance: row.capture_provenance,
    state: row.state as ScannerEvidenceStaging["state"],
    expiresAt: new Date(String(row.expires_at)),
    immutableBinding: (row.immutable_binding as ScannerEvidenceBinding | null) ?? null,
  };
}

function validExpected(input: { sha256: unknown; byteLength: unknown }): { sha256: string; byteLength: number } {
  const sha256 = typeof input.sha256 === "string" ? input.sha256.trim().toLowerCase() : "";
  const byteLength = typeof input.byteLength === "number" ? input.byteLength : Number(input.byteLength);
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Expected TIFF hash is invalid");
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength > 128 * 1024 * 1024) {
    throw new Error("Expected TIFF byte length is invalid");
  }
  return { sha256, byteLength };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

function stableProvenance(value: unknown): string {
  const encoded = canonicalJson(value);
  if (!encoded || encoded.length > 24_000) throw new Error("Capture provenance is invalid");
  return encoded;
}

async function lockSession(client: PoolClient, sessionId: string, deviceId: string) {
  await client.query("SELECT pg_advisory_xact_lock($1)", [hashLockKey(`capture-session:${sessionId}`)]);
  const result = await client.query(
    `SELECT s.*, c.certificate_number
       FROM scanner_capture_sessions s
       JOIN certificates c ON c.id=s.certificate_id
      WHERE s.id=$1 AND s.claimed_by_device_id=$2
      FOR UPDATE`,
    [sessionId, deviceId]
  );
  const row = result.rows[0] as StagingRow | undefined;
  if (!row) throw new Error("Capture session not found for this station");
  return row;
}

/**
 * Return the one active, opaque staging object for an already-claimed target.
 * A retry receives the same object key, never a new target or evidence slot.
 */
export async function grantScannerEvidenceStaging(input: {
  sessionId: string;
  deviceId: string;
  authenticatedStationId?: string | null;
  expectedSha256: unknown;
  expectedBytes: unknown;
  provenance: unknown;
  immutableBinding: unknown;
}): Promise<{ staging: ScannerEvidenceStaging; session: ScannerCaptureSession }> {
  const expected = validExpected({ sha256: input.expectedSha256, byteLength: input.expectedBytes });
  const provenance = stableProvenance(input.provenance);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sessionRow = await lockSession(client, input.sessionId, input.deviceId);
    if (input.authenticatedStationId && String(sessionRow.station_id ?? "") !== input.authenticatedStationId) {
      throw new Error("Capture session is not bound to this authenticated station");
    }
    if (sessionRow.state !== "claimed") throw new Error("Capture session is not awaiting scanner acceptance");
    if (new Date(String(sessionRow.expires_at)).getTime() <= Date.now()) {
      await client.query("UPDATE scanner_capture_sessions SET state='expired' WHERE id=$1 AND state='claimed'", [
        input.sessionId,
      ]);
      throw new Error("Capture session expired");
    }
    const session = mapScannerCaptureRow(sessionRow);
    const immutableBinding = validateScannerEvidenceBinding(session, input.immutableBinding);
    if (immutableBinding.sha256 !== expected.sha256 || immutableBinding.byte_length !== expected.byteLength) {
      throw new Error("Evidence binding digest or byte length does not match the staged candidate");
    }
    const existing = await client.query(
      `SELECT * FROM scanner_evidence_staging
        WHERE capture_session_id=$1 AND state='granted' AND expires_at > NOW()
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [input.sessionId]
    );
    let stagingRow = existing.rows[0] as StagingRow | undefined;
    const expiresAt = new Date(Date.now() + STAGING_TTL_MS);
    if (stagingRow) {
      const storedProvenance = stableProvenance(stagingRow.capture_provenance);
      if (
        String(stagingRow.expected_sha256) !== expected.sha256 ||
        Number(stagingRow.expected_bytes) !== expected.byteLength ||
        storedProvenance !== provenance ||
        canonicalJson(stagingRow.immutable_binding) !== canonicalJson(immutableBinding)
      ) {
        throw new Error("A different TIFF candidate cannot reuse this armed capture session");
      }
    }
    if (!stagingRow) {
      const id = randomUUID();
      const objectKey = `evidence/staging/${String(sessionRow.station_id ?? "legacy")}/${input.sessionId}/${id}.tif`;
      const inserted = await client.query(
        `INSERT INTO scanner_evidence_staging
         (id,capture_session_id,station_id,object_key,expected_sha256,expected_bytes,capture_provenance,expires_at,immutable_binding)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb)
         RETURNING *`,
        [
          id,
          input.sessionId,
          sessionRow.station_id ?? null,
          objectKey,
          expected.sha256,
          expected.byteLength,
          provenance,
          expiresAt,
          canonicalJson(immutableBinding),
        ]
      );
      stagingRow = inserted.rows[0] as StagingRow;
    }
    await client.query(
      `UPDATE scanner_capture_sessions
          SET expires_at=GREATEST(expires_at, $2::timestamptz)
        WHERE id=$1 AND state='claimed'`,
      [input.sessionId, expiresAt]
    );
    await client.query("COMMIT");
    const { getScannerCaptureStatus } = await import("./scanner-capture-service");
    const resolved = await getScannerCaptureStatus(input.sessionId, input.deviceId);
    return { staging: mapStaging(stagingRow), session: resolved.session };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Atomically reserve a staged object for one server finalisation attempt. */
export async function beginScannerEvidenceFinalisation(input: {
  sessionId: string;
  stagingId: string;
  deviceId: string;
  authenticatedStationId?: string | null;
  immutableBinding?: unknown;
}): Promise<{ staging: ScannerEvidenceStaging; alreadyAccepted: boolean }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sessionRow = await lockSession(client, input.sessionId, input.deviceId);
    if (input.authenticatedStationId && String(sessionRow.station_id ?? "") !== input.authenticatedStationId) {
      throw new Error("Capture session is not bound to this authenticated station");
    }
    const found = await client.query(
      `SELECT * FROM scanner_evidence_staging
        WHERE id=$1 AND capture_session_id=$2 FOR UPDATE`,
      [input.stagingId, input.sessionId]
    );
    const row = found.rows[0] as StagingRow | undefined;
    if (!row) throw new Error("Staged TIFF is not available for this capture session");
    if (input.immutableBinding != null) {
      const verified = validateScannerEvidenceBinding(mapScannerCaptureRow(sessionRow), input.immutableBinding);
      if (canonicalJson(verified) !== canonicalJson(row.immutable_binding)) {
        throw new Error("Finalisation evidence binding does not match its staged grant");
      }
    }
    const evidence = await client.query(
      `SELECT 1 FROM certificate_image_evidence e
        WHERE e.certificate_id=$1 AND e.side=$2
          AND e.capture_metadata ->> 'captureSessionId'=$3
        LIMIT 1`,
      [sessionRow.certificate_id, sessionRow.side, input.sessionId]
    );
    if (evidence.rows.length) {
      await client.query(
        `UPDATE scanner_evidence_staging SET state='accepted', accepted_at=COALESCE(accepted_at,NOW()),
             updated_at=NOW(), failure_reason=NULL WHERE id=$1`,
        [input.stagingId]
      );
      await client.query(
        `UPDATE scanner_capture_sessions SET state='captured', captured_at=COALESCE(captured_at,NOW()), failure_reason=NULL
          WHERE id=$1`,
        [input.sessionId]
      );
      await client.query("COMMIT");
      return { staging: mapStaging({ ...row, state: "accepted" }), alreadyAccepted: true };
    }
    if (row.state === "accepted") {
      await client.query("COMMIT");
      return { staging: mapStaging(row), alreadyAccepted: true };
    }
    if (row.state === "finalizing") {
      const started = new Date(String(row.finalizing_at ?? row.updated_at)).getTime();
      if (started + FINALISATION_STALE_MS > Date.now()) {
        throw new Error("Staged TIFF is already being finalised");
      }
      // A worker/server died before it could persist immutable evidence. Return
      // only this exact staging object to retry; the target itself never changes.
      await client.query(
        `UPDATE scanner_evidence_staging SET state='granted', finalizing_at=NULL,
             failure_reason='Previous finalisation lease expired', updated_at=NOW()
           WHERE id=$1`,
        [input.stagingId]
      );
      await client.query(
        `UPDATE scanner_capture_sessions
            SET state='claimed', expires_at=NOW() + ($2::bigint * INTERVAL '1 millisecond')
          WHERE id=$1 AND state='capturing'`,
        [input.sessionId, STAGING_TTL_MS]
      );
    }
    if (row.state === "failed" || row.state === "expired") throw new Error("Staged TIFF is no longer valid");
    if (new Date(String(row.expires_at)).getTime() <= Date.now()) {
      await client.query("UPDATE scanner_evidence_staging SET state='expired', updated_at=NOW() WHERE id=$1", [
        input.stagingId,
      ]);
      throw new Error("Staged TIFF upload grant expired");
    }
    await client.query(
      `UPDATE scanner_evidence_staging SET state='finalizing', finalizing_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [input.stagingId]
    );
    await client.query("COMMIT");
    return { staging: mapStaging({ ...row, state: "finalizing" }), alreadyAccepted: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function completeScannerEvidenceFinalisation(stagingId: string): Promise<void> {
  await pool.query(
    `UPDATE scanner_evidence_staging
        SET state='accepted', accepted_at=NOW(), updated_at=NOW(), failure_reason=NULL
      WHERE id=$1 AND state='finalizing'`,
    [stagingId]
  );
}

export async function failScannerEvidenceFinalisation(
  stagingId: string,
  reason: string,
  retryable: boolean
): Promise<void> {
  await pool.query(
    `UPDATE scanner_evidence_staging
        SET state=CASE WHEN $3 THEN 'granted' ELSE 'failed' END,
            finalizing_at=NULL, failure_reason=LEFT($2,1000), updated_at=NOW()
      WHERE id=$1 AND state='finalizing'`,
    [stagingId, reason, retryable]
  );
}

/** Return a bounded batch of non-authoritative objects safe to delete from R2. */
export async function claimScannerEvidenceStagingCleanup(
  limit = 20
): Promise<Array<{ id: string; objectKey: string }>> {
  const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `WITH expired AS (
         SELECT id FROM scanner_evidence_staging
          WHERE state='granted' AND expires_at <= NOW()
          ORDER BY expires_at, id FOR UPDATE SKIP LOCKED LIMIT $1
       )
       UPDATE scanner_evidence_staging s
          SET state='expired', updated_at=NOW(), failure_reason=COALESCE(s.failure_reason,'Staging upload grant expired')
         FROM expired WHERE s.id=expired.id`,
      [bounded]
    );
    const rows = await client.query(
      `WITH candidates AS (
         SELECT id FROM scanner_evidence_staging
          WHERE state IN ('accepted','expired','failed') AND staging_deleted_at IS NULL
            AND (cleanup_claimed_at IS NULL OR cleanup_claimed_at < NOW() - INTERVAL '15 minutes')
          ORDER BY updated_at, id FOR UPDATE SKIP LOCKED LIMIT $1
       )
       UPDATE scanner_evidence_staging s
          SET cleanup_claimed_at=NOW(), updated_at=NOW()
         FROM candidates WHERE s.id=candidates.id
       RETURNING s.id, s.object_key`,
      [bounded]
    );
    await client.query("COMMIT");
    return rows.rows.map((row) => ({ id: String(row.id), objectKey: String(row.object_key) }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function markScannerEvidenceStagingDeleted(stagingId: string): Promise<void> {
  await pool.query(
    `UPDATE scanner_evidence_staging
        SET staging_deleted_at=COALESCE(staging_deleted_at,NOW()), cleanup_claimed_at=NULL, updated_at=NOW()
      WHERE id=$1 AND state IN ('accepted','expired','failed')`,
    [stagingId]
  );
}
