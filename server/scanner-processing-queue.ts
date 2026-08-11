import { randomUUID } from "node:crypto";
import { pool } from "./db";

export type ScannerProcessingJob = {
  id: string;
  certificateId: number;
  stationId: string | null;
  attemptCount: number;
  maxAttempts: number;
  leaseToken: string;
};

const LEASE_MS = 45 * 60_000;

function mapClaim(row: Record<string, unknown>): ScannerProcessingJob {
  return {
    id: String(row.id),
    certificateId: Number(row.certificate_id),
    stationId: row.station_id == null ? null : String(row.station_id),
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    leaseToken: String(row.lease_token),
  };
}

/**
 * Coalesce derivative work by certificate. The immutable ledger remains the
 * source of truth; a recapture while work is running requests one fresh pass
 * over whichever revision is current when the worker next claims it.
 */
export async function enqueueScannerProcessing(certificateId: number, stationId: string | null): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO scanner_processing_jobs (certificate_id, station_id, job_kind, state, available_at)
       VALUES ($1,$2,'scanner_derivatives','queued',NOW())
       ON CONFLICT (certificate_id, job_kind) WHERE state IN ('queued','running','retry')
       DO UPDATE SET
         station_id = COALESCE(EXCLUDED.station_id, scanner_processing_jobs.station_id),
         rerun_requested = scanner_processing_jobs.rerun_requested OR scanner_processing_jobs.state = 'running',
         state = CASE WHEN scanner_processing_jobs.state = 'running' THEN 'running' ELSE 'queued' END,
         available_at = CASE WHEN scanner_processing_jobs.state = 'running' THEN scanner_processing_jobs.available_at ELSE NOW() END,
         updated_at = NOW(),
         last_error = CASE WHEN scanner_processing_jobs.state = 'running' THEN scanner_processing_jobs.last_error ELSE NULL END`,
      [certificateId, stationId]
    );
  } finally {
    client.release();
  }
}

/** Claim a single queued/retry job or a truly abandoned lease across replicas. */
export async function claimScannerProcessing(_workerId: string): Promise<ScannerProcessingJob | null> {
  const token = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claimed = await client.query(
      `WITH candidate AS (
         SELECT id
           FROM scanner_processing_jobs
          WHERE (state IN ('queued','retry') AND available_at <= NOW())
             OR (state = 'running' AND lease_until < NOW())
          ORDER BY available_at, created_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE scanner_processing_jobs j
          SET state='running', attempt_count=j.attempt_count+1,
              lease_token=$1, lease_until=NOW() + ($2::bigint * INTERVAL '1 millisecond'),
              updated_at=NOW(), last_error=CASE WHEN j.state='running' THEN 'worker lease expired' ELSE j.last_error END
         FROM candidate
        WHERE j.id=candidate.id
        RETURNING j.*`,
      [token, LEASE_MS]
    );
    await client.query("COMMIT");
    const row = claimed.rows[0] as Record<string, unknown> | undefined;
    return row ? mapClaim(row) : null;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function completeScannerProcessing(job: ScannerProcessingJob): Promise<void> {
  const client = await pool.connect();
  try {
    const updated = await client.query(
      `UPDATE scanner_processing_jobs
          SET state=CASE WHEN rerun_requested THEN 'queued' ELSE 'complete' END,
              rerun_requested=false,
              available_at=CASE WHEN rerun_requested THEN NOW() ELSE available_at END,
              lease_token=NULL, lease_until=NULL,
              completed_at=CASE WHEN rerun_requested THEN NULL ELSE NOW() END,
              updated_at=NOW(), last_error=NULL
        WHERE id=$1 AND state='running' AND lease_token=$2`,
      [job.id, job.leaseToken]
    );
    if (updated.rowCount !== 1) throw new Error("Scanner processing lease was lost before completion");
  } finally {
    client.release();
  }
}

export async function failScannerProcessing(job: ScannerProcessingJob, error: unknown): Promise<void> {
  const message = String(error instanceof Error ? error.message : error).slice(0, 1000);
  const client = await pool.connect();
  try {
    const backoffMs = Math.min(5 * 60_000, 5_000 * 2 ** Math.min(job.attemptCount, 6));
    const updated = await client.query(
      `UPDATE scanner_processing_jobs
          SET state=CASE WHEN attempt_count >= max_attempts THEN 'failed' ELSE 'retry' END,
              available_at=CASE WHEN attempt_count >= max_attempts THEN available_at ELSE NOW() + ($3::bigint * INTERVAL '1 millisecond') END,
              lease_token=NULL, lease_until=NULL, last_error=$4, updated_at=NOW()
        WHERE id=$1 AND state='running' AND lease_token=$2`,
      [job.id, job.leaseToken, backoffMs, message]
    );
    if (updated.rowCount !== 1) throw new Error("Scanner processing lease was lost before failure handling");
  } finally {
    client.release();
  }
}

/** Process at most one job. Callers may run this concurrently on many replicas. */
export async function runOneScannerProcessingJob(workerId: string): Promise<boolean> {
  const job = await claimScannerProcessing(workerId);
  if (!job) return false;
  try {
    const { processCurrentScannerEvidenceInBackground } = await import("./scan-ingest-service");
    const certificate = await pool.query<{ certificate_number: string }>(
      "SELECT certificate_number FROM certificates WHERE id=$1 AND deleted_at IS NULL",
      [job.certificateId]
    );
    const certId = certificate.rows[0]?.certificate_number;
    if (!certId) throw new Error("Certificate is unavailable for scanner processing");
    await processCurrentScannerEvidenceInBackground(
      { id: job.certificateId, certId },
      { skipAi: true, throwOnFailure: true }
    );
    await completeScannerProcessing(job);
    return true;
  } catch (error) {
    await failScannerProcessing(job, error);
    throw error;
  }
}
