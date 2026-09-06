/**
 * P12 — PARTNER CARD JOB RECONCILIATION.
 *
 * THE DOCUMENTED MEDIUM THIS CLOSES.
 *
 * Super Admin QA approval publishes the certificate through the HQ grader on the Drizzle pool, then
 * transitions the Card Job on the restricted partner-admin pool. Those are two different connections
 * and cannot be one transaction without restructuring protected HQ grading infrastructure — which
 * this programme will not do to prove a concurrency point.
 *
 * So a crash, a deploy or a transient pool failure in between leaves:
 *
 *     certificates.grade_approved_at IS NOT NULL   (the grade IS published)
 *     partner_card_jobs.status = 'QA_REVIEW'       (the Card Job never advanced)
 *
 * THE CURRENT FAILURE MODE IS FAIL-CLOSED, WHICH IS WHY THIS IS A MEDIUM AND NOT A BLOCKER.
 * `card_job_valid` in print-eligibility.ts permits output only from APPROVED/PRINTABLE/COMPLETED, so
 * a drifted card is simply refused output. Nothing publishes early, no credit moves, no identity is
 * minted. The card waits — silently, for ever, until somebody notices.
 *
 * "Silently, for ever" is the actual defect. This module makes the condition VISIBLE and REPAIRABLE.
 *
 * WHAT A REDRIVE IS ALLOWED TO DO — and this list is the whole contract:
 *   - perform the ONE legal transition the approval should have performed (QA_REVIEW → APPROVED);
 *   - only after re-proving the certificate really is approved and really belongs to that Card Job;
 *   - idempotently, so a second redrive is a no-op rather than a second anything;
 *   - with an audit row naming it as a repair rather than an ordinary approval.
 *
 * WHAT IT MUST NEVER DO:
 *   - settle or re-settle a Grading Credit (settlement happened at SUBMIT and is keyed by its own
 *     idempotency key; this path never touches a wallet, ledger or reservation);
 *   - mint an MV number or a certificate;
 *   - write, recompute or approve a GRADE — it moves lifecycle state and nothing else;
 *   - repair a row whose lineage does not hold up, in which case it stays fail-closed and reports.
 *
 * WHY DETECTION AND REPAIR ARE SEPARATE FUNCTIONS. Detection is safe to run everywhere, on a
 * schedule, and to expose read-only. Repair mutates. Keeping them apart means the alert can be wired
 * before anybody decides repair should be automatic, and means a human can always look first.
 */
import type { PoolClient } from "pg";
import { withPartnerAdminTransaction } from "./db";
import { writePartnerAudit } from "./audit";
import { CARD_JOB_STATUS, transitionCardJob } from "./card-job-lifecycle";
import { advanceCardJobAfterCapture } from "./card-job-lifecycle";

/** One work item whose certificate is approved but whose Card Job never advanced. */
export interface QaCardJobDrift {
  cardJobId: string;
  tenantId: string;
  locationId: string | null;
  certificateId: number;
  mvNumber: string | null;
  /** The Card Job's current state. Always 'QA_REVIEW' for a genuine drift item. */
  status: string;
  approvedAt: string;
  approvedBy: string | null;
}

export interface DriftScan<T> {
  /** False when the check could not run at all (e.g. a database without `certificates`). */
  ran: boolean;
  items: T[];
  skippedReason?: string;
}

/**
 * Is this database able to answer the question at all?
 *
 * A partner-only database has no `certificates` table, so the join below is unanswerable. Reporting
 * "could not check" is honest; reporting "no drift" would be exactly the lie this job exists to
 * prevent — the same discipline the credit reconciliation job already applies.
 */
async function certificatesPresent(client: PoolClient): Promise<boolean> {
  const { rows } = await client.query<{ present: boolean }>(
    `SELECT to_regclass('public.certificates') IS NOT NULL AS present`
  );
  return rows[0]?.present === true;
}

async function captureEvidenceTablesPresent(client: PoolClient): Promise<boolean> {
  const { rows } = await client.query<{ present: boolean }>(
    `SELECT to_regclass('public.certificate_image_evidence') IS NOT NULL
            AND to_regclass('public.scanner_capture_sessions') IS NOT NULL
            AND to_regclass('public.partner_stations') IS NOT NULL AS present`
  );
  return rows[0]?.present === true;
}

/** A Card Job whose accepted scanner truth is ahead of its lifecycle state. */
export interface CaptureCardJobDrift {
  cardJobId: string;
  tenantId: string;
  locationId: string | null;
  certificateId: number;
  status: string;
  acceptedSides: number;
  lastEvidenceAt: string;
}

/**
 * Find only mechanically-repairable capture drift.
 *
 * NEEDS_SCAN/FIX_REQUIRED is drifted once one accepted side exists. CAPTURING is
 * drifted only when both sides satisfy the same session/station/evidence
 * predicate as the lifecycle authority. A legitimate one-sided CAPTURING job is
 * therefore never churned by the scheduler.
 */
export async function detectCaptureCardJobDrift(limit = 500): Promise<DriftScan<CaptureCardJobDrift>> {
  return withPartnerAdminTransaction(async (client) => {
    if (!(await certificatesPresent(client)) || !(await captureEvidenceTablesPresent(client))) {
      return { ran: false, items: [], skippedReason: "scanner evidence tables absent on this database" };
    }
    const { rows } = await client.query<{
      card_job_id: string;
      tenant_id: string;
      location_id: string | null;
      certificate_id: number;
      status: string;
      accepted_sides: number;
      last_evidence_at: string;
    }>(
      `WITH accepted AS (
         SELECT job.id AS card_job_id,
                count(DISTINCT evidence.side)::int AS accepted_sides,
                max(evidence.created_at) AS last_evidence_at
           FROM partner_card_jobs job
           JOIN certificates cert
             ON cert.id=job.certificate_id AND cert.deleted_at IS NULL
           JOIN certificate_image_evidence evidence
             ON evidence.certificate_id=job.certificate_id
            AND evidence.is_current=true
            AND evidence.evidence_class='NEW_IMMUTABLE_MASTER'
            AND evidence.format='tiff'
           JOIN scanner_capture_sessions session
             ON session.id=evidence.capture_metadata ->> 'captureSessionId'
            AND session.certificate_id=evidence.certificate_id
            AND session.side=evidence.side
            AND session.state='captured'
           JOIN partner_stations station
             ON station.id=session.station_id
            AND station.status='ACTIVE'
            AND station.tenant_id=job.tenant_id
            AND station.location_id IS NOT DISTINCT FROM job.location_id
          WHERE job.cancelled_at IS NULL
            AND job.status IN ('NEEDS_SCAN','CAPTURING','FIX_REQUIRED')
          GROUP BY job.id
       )
       SELECT job.id AS card_job_id,job.tenant_id,job.location_id,job.certificate_id,job.status,
              accepted.accepted_sides,accepted.last_evidence_at
         FROM accepted
         JOIN partner_card_jobs job ON job.id=accepted.card_job_id
        WHERE (job.status IN ('NEEDS_SCAN','FIX_REQUIRED') AND accepted.accepted_sides >= 1)
           OR (job.status='CAPTURING' AND accepted.accepted_sides >= 2)
        ORDER BY accepted.last_evidence_at ASC
        LIMIT $1`,
      [limit]
    );
    return {
      ran: true,
      items: rows.map((row) => ({
        cardJobId: row.card_job_id,
        tenantId: row.tenant_id,
        locationId: row.location_id,
        certificateId: Number(row.certificate_id),
        status: row.status,
        acceptedSides: Number(row.accepted_sides),
        lastEvidenceAt: new Date(row.last_evidence_at).toISOString(),
      })),
    };
  });
}

export interface CaptureRedriveResult {
  cardJobId: string;
  outcome: RedriveOutcome;
  status?: string;
  reason?: string;
}

export interface CaptureRedriveSummary {
  ran: boolean;
  repaired: number;
  alreadyAdvanced: number;
  refused: number;
  results: CaptureRedriveResult[];
  skippedReason?: string;
}

/** Re-drive the canonical capture authority from durable accepted evidence. */
export async function redriveCaptureCardJobDrift(
  options: { limit?: number; actor?: string } = {}
): Promise<CaptureRedriveSummary> {
  const { limit = 500, actor = "system:card-job-reconciliation" } = options;
  const scan = await detectCaptureCardJobDrift(limit);
  if (!scan.ran) {
    return {
      ran: false,
      repaired: 0,
      alreadyAdvanced: 0,
      refused: 0,
      results: [],
      skippedReason: scan.skippedReason,
    };
  }
  const results: CaptureRedriveResult[] = [];
  for (const item of scan.items) {
    try {
      const result = await advanceCardJobAfterCapture(item.certificateId, { reconciliationActor: actor });
      if (!result) {
        results.push({ cardJobId: item.cardJobId, outcome: "refused", reason: "Card Job no longer exists" });
      } else {
        results.push({
          cardJobId: item.cardJobId,
          outcome: result.changed ? "repaired" : "already_advanced",
          status: result.status,
        });
      }
    } catch (error) {
      results.push({
        cardJobId: item.cardJobId,
        outcome: "refused",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    ran: true,
    repaired: results.filter((result) => result.outcome === "repaired").length,
    alreadyAdvanced: results.filter((result) => result.outcome === "already_advanced").length,
    refused: results.filter((result) => result.outcome === "refused").length,
    results,
  };
}

/**
 * THE DETECTION QUERY — exactly the condition documented as the residual window.
 *
 * Deliberately narrow. It does NOT sweep every Card Job that looks behind; it names the one
 * inconsistency whose cause is understood, so an unrelated fault can never be silently "repaired"
 * into a state nobody reasoned about.
 */
export async function detectQaCardJobDrift(limit = 500): Promise<DriftScan<QaCardJobDrift>> {
  return withPartnerAdminTransaction(async (client) => {
    if (!(await certificatesPresent(client))) {
      return { ran: false, items: [], skippedReason: "certificates table absent on this database" };
    }
    const { rows } = await client.query<{
      card_job_id: string;
      tenant_id: string;
      location_id: string | null;
      certificate_id: number;
      mv_number: string | null;
      status: string;
      approved_at: string;
      approved_by: string | null;
    }>(
      `SELECT job.id AS card_job_id, job.tenant_id, job.location_id,
              job.certificate_id, job.mv_number, job.status,
              cert.grade_approved_at AS approved_at, cert.grade_approved_by AS approved_by
         FROM partner_card_jobs job
         JOIN certificates cert ON cert.id = job.certificate_id
        WHERE job.status = 'QA_REVIEW'
          AND job.cancelled_at IS NULL
          AND cert.grade_approved_at IS NOT NULL
          AND cert.deleted_at IS NULL
        ORDER BY cert.grade_approved_at ASC
        LIMIT $1`,
      [limit]
    );
    return {
      ran: true,
      items: rows.map((r) => ({
        cardJobId: r.card_job_id,
        tenantId: r.tenant_id,
        locationId: r.location_id,
        certificateId: Number(r.certificate_id),
        mvNumber: r.mv_number,
        status: r.status,
        approvedAt: new Date(r.approved_at).toISOString(),
        approvedBy: r.approved_by,
      })),
    };
  });
}

export type RedriveOutcome =
  /** The transition was performed by THIS call. */
  | "repaired"
  /** Already correct — a second redrive, or the original approval landing late. */
  | "already_advanced"
  /** Lineage or approval did not hold up on re-check. Left alone, fail-closed, reported. */
  | "refused";

export interface RedriveResult {
  cardJobId: string;
  outcome: RedriveOutcome;
  /** Present when refused: which invariant did not hold. */
  reason?: string;
}

/**
 * Repair ONE drifted Card Job, re-proving everything inside a single locked transaction.
 *
 * EVERY FACT IS RE-READ HERE, under `FOR UPDATE`, rather than trusted from the scan. A detection
 * pass and a repair pass are separated by time, and in that time the original approval may finally
 * have landed, a QA reviewer may have returned the card, or the certificate may have been corrected.
 * Acting on a stale scan is precisely how a "repair" becomes a corruption.
 */
async function redriveOne(client: PoolClient, item: QaCardJobDrift, actor: string): Promise<RedriveResult> {
  const { rows } = await client.query<{
    status: string;
    certificate_id: number | null;
    mv_number: string | null;
    approved_at: string | null;
    grader_status: string | null;
    origin_partner_id: string | null;
  }>(
    `SELECT job.status, job.certificate_id, job.mv_number,
            cert.grade_approved_at AS approved_at, cert.grader_status, cert.origin_partner_id::text
       FROM partner_card_jobs job
       JOIN certificates cert ON cert.id = job.certificate_id
      WHERE job.id = $1 AND job.tenant_id = $2 AND job.cancelled_at IS NULL
      FOR UPDATE OF job`,
    [item.cardJobId, item.tenantId]
  );
  const row = rows[0];
  if (!row) return { cardJobId: item.cardJobId, outcome: "refused", reason: "card job or certificate not found" };

  // The original approval landed after the scan, or a previous redrive already repaired it.
  if (row.status !== CARD_JOB_STATUS.QA_REVIEW) {
    return { cardJobId: item.cardJobId, outcome: "already_advanced" };
  }

  /*
   * FAIL CLOSED ON ANY INCONSISTENCY.
   *
   * A redrive is only ever legitimate when the certificate genuinely IS approved and genuinely IS
   * this partner's. If the grade was un-approved, the card was returned to a grader, or the origin
   * does not match the job's tenant, then the premise of the repair is false — and advancing the Card
   * Job would assert an approval that does not exist. Refusing leaves the card exactly where it is,
   * which is the state that already blocks output.
   */
  if (row.approved_at === null) {
    return { cardJobId: item.cardJobId, outcome: "refused", reason: "certificate is no longer approved" };
  }
  if (row.grader_status !== "approved") {
    return {
      cardJobId: item.cardJobId,
      outcome: "refused",
      reason: `certificate grader_status is '${row.grader_status}', not 'approved'`,
    };
  }
  if (row.origin_partner_id !== item.tenantId) {
    return {
      cardJobId: item.cardJobId,
      outcome: "refused",
      reason: "certificate origin does not match the Card Job tenant",
    };
  }
  if (row.certificate_id === null || row.mv_number === null) {
    return { cardJobId: item.cardJobId, outcome: "refused", reason: "Card Job has no bound certificate identity" };
  }

  /*
   * The ONE legal transition, through the canonical authority — not a direct UPDATE.
   *
   * That matters: the authority re-asserts the `from` state in its own UPDATE, respects 0080's
   * ENABLE ALWAYS trigger, and writes the audit row. A hand-rolled repair statement would bypass
   * every one of those and would be the least-reviewed write in the system.
   */
  await transitionCardJob(client, {
    tenantId: item.tenantId,
    cardJobId: item.cardJobId,
    from: [CARD_JOB_STATUS.QA_REVIEW],
    to: CARD_JOB_STATUS.APPROVED,
    idempotent: true,
    action: "partner_card_job_qa_approved_redrive",
    reason: "Reconciliation redrive: the certificate was approved but the Card Job transition did not land.",
    audit: { redrivenBy: actor, approvedAt: item.approvedAt, approvedBy: item.approvedBy },
  });

  /*
   * A SECOND audit row, naming this as a REPAIR.
   *
   * The transition's own row says the card became APPROVED. This one says a reconciliation moved it,
   * and why. Without it, a repair is indistinguishable in the trail from an ordinary QA approval —
   * and the whole point of recording drift is that somebody can later ask how often it happened.
   */
  await writePartnerAudit(client, {
    tenantId: item.tenantId,
    locationId: item.locationId,
    actorUserId: null,
    action: "partner_card_job_drift_repaired",
    recordType: "partner_card_job",
    recordId: item.cardJobId,
    before: { status: CARD_JOB_STATUS.QA_REVIEW, certificateApprovedAt: item.approvedAt },
    after: { status: CARD_JOB_STATUS.APPROVED, certificateId: item.certificateId, mvNumber: item.mvNumber },
    reason: `Split-transaction drift repaired by ${actor}.`,
  });

  return { cardJobId: item.cardJobId, outcome: "repaired" };
}

export interface RedriveSummary {
  ran: boolean;
  repaired: number;
  alreadyAdvanced: number;
  refused: number;
  results: RedriveResult[];
  skippedReason?: string;
}

/**
 * Detect and repair QA/Card Job drift.
 *
 * Each item is repaired in its OWN transaction. One refused or failing item must not roll back the
 * repairs that already succeeded, and a systemic fault must not turn into an all-or-nothing batch
 * that never completes.
 */
export async function redriveQaCardJobDrift(options: { limit?: number; actor?: string } = {}): Promise<RedriveSummary> {
  const { limit = 500, actor = "system:card-job-reconciliation" } = options;
  const scan = await detectQaCardJobDrift(limit);
  if (!scan.ran) {
    return { ran: false, repaired: 0, alreadyAdvanced: 0, refused: 0, results: [], skippedReason: scan.skippedReason };
  }

  const results: RedriveResult[] = [];
  for (const item of scan.items) {
    try {
      const result = await withPartnerAdminTransaction(async (client) => {
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [item.tenantId]);
        await client.query("SELECT set_config('app.location_id', $1, true)", [item.locationId ?? ""]);
        return redriveOne(client, item, actor);
      });
      results.push(result);
    } catch (error) {
      results.push({
        cardJobId: item.cardJobId,
        outcome: "refused",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    ran: true,
    repaired: results.filter((r) => r.outcome === "repaired").length,
    alreadyAdvanced: results.filter((r) => r.outcome === "already_advanced").length,
    refused: results.filter((r) => r.outcome === "refused").length,
    results,
  };
}

/** A Card Job that has sat in one non-terminal state longer than a shop floor would tolerate. */
export interface StuckCardJob {
  cardJobId: string;
  tenantId: string;
  locationId: string | null;
  status: string;
  mvNumber: string | null;
  updatedAt: string;
  hoursStuck: number;
}

/**
 * Card Jobs stuck in a working state.
 *
 * REPORT ONLY, NEVER REPAIRED. Unlike QA drift — whose cause is understood and whose correct
 * resolution is a single known transition — a card sitting in GRADING for two days has many possible
 * causes (an operator went home, a station broke, the customer never came back) and no single safe
 * answer. Guessing one would move real work without a human deciding to. So this surfaces the queue
 * and stops.
 */
export async function detectStuckCardJobs(
  options: { hours?: number; limit?: number } = {}
): Promise<DriftScan<StuckCardJob>> {
  const { hours = 48, limit = 500 } = options;
  return withPartnerAdminTransaction(async (client) => {
    const { rows } = await client.query<{
      id: string;
      tenant_id: string;
      location_id: string | null;
      status: string;
      mv_number: string | null;
      updated_at: string;
      hours_stuck: string;
    }>(
      `SELECT id, tenant_id, location_id, status, mv_number, updated_at,
              EXTRACT(EPOCH FROM (now() - updated_at)) / 3600 AS hours_stuck
         FROM partner_card_jobs
        WHERE cancelled_at IS NULL
          AND status IN ('CREDIT_RESERVED','NEEDS_SCAN','CAPTURING','FIX_REQUIRED','READY_TO_GRADE',
                         'GRADING','SUBMITTED','QA_REVIEW','APPROVED','PRINTABLE')
          AND updated_at < now() - ($1 || ' hours')::interval
        ORDER BY updated_at ASC
        LIMIT $2`,
      [String(hours), limit]
    );
    return {
      ran: true,
      items: rows.map((r) => ({
        cardJobId: r.id,
        tenantId: r.tenant_id,
        locationId: r.location_id,
        status: r.status,
        mvNumber: r.mv_number,
        updatedAt: new Date(r.updated_at).toISOString(),
        hoursStuck: Math.round(Number(r.hours_stuck)),
      })),
    };
  });
}

/**
 * Grading leases that expired without being released.
 *
 * Also report-only. Correctness never depended on these being swept — `acquireLease` releases an
 * expired lease inside its own transaction before taking a new one, which is the whole design. An
 * accumulating pile of them is an operational signal (graders closing laptops mid-card, a flaky
 * network killing heartbeats), not a fault to repair.
 */
export async function detectStaleLeases(
  limit = 500
): Promise<DriftScan<{ cardJobId: string; tenantId: string; expiredAt: string }>> {
  return withPartnerAdminTransaction(async (client) => {
    const { rows } = await client.query<{ card_job_id: string; tenant_id: string; expires_at: string }>(
      `SELECT card_job_id, tenant_id, expires_at
         FROM partner_grading_leases
        WHERE released_at IS NULL AND expires_at <= now()
        ORDER BY expires_at ASC
        LIMIT $1`,
      [limit]
    );
    return {
      ran: true,
      items: rows.map((r) => ({
        cardJobId: r.card_job_id,
        tenantId: r.tenant_id,
        expiredAt: new Date(r.expires_at).toISOString(),
      })),
    };
  });
}
