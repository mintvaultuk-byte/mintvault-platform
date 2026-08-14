/**
 * THE CANONICAL PARTNER CARD JOB LIFECYCLE.
 *
 * THE DEFECT THIS CLOSES. Migration 0080 shipped the complete legal state graph as a database
 * trigger — READY_TO_GRADE → GRADING → SUBMITTED → QA_REVIEW → APPROVED → PRINTABLE → COMPLETED,
 * with FIX and cancellation arms. NOTHING EVER DROVE IT. A repository-wide search for writers of
 * `partner_card_jobs.status` returned exactly one: `fix-authority.ts` setting FIX_REQUIRED. Every
 * other edge in that graph was unreachable, so a Scanner-created Card Job was born NEEDS_SCAN and
 * stayed NEEDS_SCAN for ever — never gradeable (the lease's own `loadGradableJob` refuses anything
 * outside READY_TO_GRADE/GRADING), never submittable, never reviewable, never printable.
 *
 * The graph was not wrong. It was simply not connected to anything.
 *
 * WHY ONE AUTHORITY RATHER THAN AN UPDATE AT EACH SITE. Seven call sites each writing their own
 * `UPDATE partner_card_jobs SET status = ...` is precisely the shape 0080's own header criticises in
 * submission-service.ts ("ad-hoc guard clauses duplicated across seven call sites, with the legal
 * graph existing solely as a doc comment"). One authority means one place where a transition is
 * checked, one place where it is audited, and one place to read to know what can happen to a job.
 *
 * THE DATABASE REMAINS THE FLOOR. This module does not replace 0080's trigger and must never be
 * trusted instead of it — the trigger is ENABLE ALWAYS and runs even in replication mode. What this
 * adds on top is the half a trigger cannot give: a caller-declared expected `from` state (so a
 * losing racer is refused rather than silently performing a legal-but-wrong hop), an audit row, and
 * an intelligible error instead of a raw `restrict_violation`.
 *
 * CONCURRENCY. The row is taken `FOR UPDATE` before its state is read, and the UPDATE itself
 * re-asserts `status = ANY(from)`. Two concurrent submits therefore serialise: the first moves
 * GRADING → SUBMITTED, the second finds GRADING no longer true and is refused WRONG_STATE rather
 * than performing a second transition. That is what makes retry-safety a property of the database
 * and not of how fast the two requests happened to arrive.
 *
 * WHICH POOL. Card Jobs live on the restricted partner-admin pool, like the lease. The HQ grading
 * engine writes `certificates` on the Drizzle pool. Those are two different connections and this
 * module deliberately does not pretend otherwise — see the transaction-scope note in
 * grading-lease-service.ts, which documents the same boundary honestly.
 */
import type { PoolClient } from "pg";
import { withPartnerAdminTenantTransaction, withPartnerAdminTransaction } from "./db";
import { writePartnerAudit } from "./audit";

/**
 * The status domain, mirroring `chk_partner_card_jobs_status` in migration 0080 exactly.
 *
 * Kept as a const object rather than a bare union so a typo in a caller is a compile error and the
 * runtime can still validate a value that arrived from the database.
 */
export const CARD_JOB_STATUS = {
  CREDIT_RESERVED: "CREDIT_RESERVED",
  NEEDS_SCAN: "NEEDS_SCAN",
  CAPTURING: "CAPTURING",
  FIX_REQUIRED: "FIX_REQUIRED",
  READY_TO_GRADE: "READY_TO_GRADE",
  GRADING: "GRADING",
  SUBMITTED: "SUBMITTED",
  QA_REVIEW: "QA_REVIEW",
  APPROVED: "APPROVED",
  PRINTABLE: "PRINTABLE",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
} as const;

export type CardJobStatus = (typeof CARD_JOB_STATUS)[keyof typeof CARD_JOB_STATUS];

/**
 * The legal graph, mirroring `partner_card_jobs_enforce_transition()` in migration 0080.
 *
 * DUPLICATED DELIBERATELY, and it must stay in step — `databaseTransitionGraphSource` below reads the
 * trigger body straight out of `pg_proc`, and the bridge suite diffs this table against it (AT-B23b),
 * so a migration that widens the graph without updating this module fails a test rather than a
 * production request. The duplicate exists so
 * an illegal transition is refused with a cause the caller can act on BEFORE a transaction is opened
 * and a row is locked, rather than surfacing as a PostgreSQL exception from inside somebody else's
 * transaction and rolling their work back with it.
 */
const LEGAL_TRANSITIONS: ReadonlyArray<readonly [CardJobStatus, CardJobStatus]> = [
  ["CREDIT_RESERVED", "NEEDS_SCAN"],
  ["NEEDS_SCAN", "CAPTURING"],
  ["CAPTURING", "READY_TO_GRADE"],
  ["CAPTURING", "NEEDS_SCAN"],
  ["NEEDS_SCAN", "FIX_REQUIRED"],
  ["CAPTURING", "FIX_REQUIRED"],
  ["READY_TO_GRADE", "FIX_REQUIRED"],
  ["GRADING", "FIX_REQUIRED"],
  ["FIX_REQUIRED", "CAPTURING"],
  ["READY_TO_GRADE", "GRADING"],
  ["GRADING", "READY_TO_GRADE"],
  ["GRADING", "SUBMITTED"],
  ["SUBMITTED", "QA_REVIEW"],
  ["QA_REVIEW", "GRADING"],
  ["QA_REVIEW", "APPROVED"],
  ["APPROVED", "PRINTABLE"],
  ["PRINTABLE", "COMPLETED"],
  ["CREDIT_RESERVED", "CANCELLED"],
  ["NEEDS_SCAN", "CANCELLED"],
  ["CAPTURING", "CANCELLED"],
];

const LEGAL = new Set(LEGAL_TRANSITIONS.map(([from, to]) => `${from}>${to}`));

export function isLegalCardJobTransition(from: CardJobStatus, to: CardJobStatus): boolean {
  return LEGAL.has(`${from}>${to}`);
}

/** The transitions the database considers legal, for a suite that wants to diff them. */
export function legalCardJobTransitions(): ReadonlyArray<readonly [CardJobStatus, CardJobStatus]> {
  return LEGAL_TRANSITIONS;
}

export class CardJobTransitionError extends Error {
  constructor(
    public code: "CARD_JOB_NOT_FOUND" | "ILLEGAL_TRANSITION" | "WRONG_STATE" | "IDENTITY_REQUIRED" | "FORBIDDEN",
    message: string,
    public detail?: { status?: string; expected?: readonly string[]; to?: string }
  ) {
    super(message);
  }
}

export interface CardJobRow {
  id: string;
  tenantId: string;
  status: CardJobStatus;
  locationId: string | null;
  certificateId: number | null;
  mvNumber: string | null;
  submissionId: string;
  cardId: string;
  createdBy: string | null;
}

interface RawJobRow {
  id: string;
  tenant_id: string;
  status: CardJobStatus;
  location_id: string | null;
  certificate_id: number | null;
  mv_number: string | null;
  submission_id: string;
  card_id: string;
  created_by: string | null;
}

function mapJob(row: RawJobRow): CardJobRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    status: row.status,
    locationId: row.location_id,
    certificateId: row.certificate_id === null ? null : Number(row.certificate_id),
    mvNumber: row.mv_number,
    submissionId: row.submission_id,
    cardId: row.card_id,
    createdBy: row.created_by,
  };
}

const JOB_COLUMNS = `id, tenant_id, status, location_id, certificate_id, mv_number,
                     submission_id, card_id, created_by`;

/**
 * Load a Card Job and hold its row for the rest of the transaction.
 *
 * The tenant predicate is in the SQL, not applied afterwards in TypeScript: a row that belongs to
 * another partner must never be read at all, so a later `if (row.tenantId !== ...)` cannot be the
 * control. Cross-tenant therefore resolves to CARD_JOB_NOT_FOUND — the same answer an absent id
 * gets, because a distinct refusal would confirm the id is real and belongs to somebody.
 */
export async function lockCardJob(client: PoolClient, tenantId: string, cardJobId: string): Promise<CardJobRow> {
  const { rows } = await client.query<RawJobRow>(
    `SELECT ${JOB_COLUMNS} FROM partner_card_jobs
      WHERE id = $1 AND tenant_id = $2
      FOR UPDATE`,
    [cardJobId, tenantId]
  );
  const row = rows[0];
  if (!row) throw new CardJobTransitionError("CARD_JOB_NOT_FOUND", "That card was not found for this partner.");
  return mapJob(row);
}

/**
 * Resolve the Card Job behind a certificate, scoped by tenant and — for a location-bound user — by
 * location, so naming a certificate cannot reach a job on another shop floor.
 *
 * `partner_card_jobs.certificate_id` is uniquely indexed where non-null (0080) and immutable once
 * stamped, so at most one job answers and it cannot drift.
 *
 * NULL IS A LEGITIMATE ANSWER: a connector-imported certificate has no Card Job and never will.
 */
export async function findCardJobForCertificate(
  client: PoolClient,
  scope: { tenantId: string; locationId: string | null },
  certificateId: number
): Promise<CardJobRow | null> {
  if (!Number.isSafeInteger(certificateId) || certificateId <= 0) return null;
  const { rows } = await client.query<RawJobRow>(
    `SELECT ${JOB_COLUMNS} FROM partner_card_jobs
      WHERE certificate_id = $1 AND tenant_id = $2 AND cancelled_at IS NULL
        AND ($3::uuid IS NULL OR location_id = $3::uuid)`,
    [certificateId, scope.tenantId, scope.locationId]
  );
  return rows[0] ? mapJob(rows[0]) : null;
}

export interface TransitionInput {
  tenantId: string;
  cardJobId: string;
  /** The states the caller is willing to move out of. A job in any other state is refused. */
  from: readonly CardJobStatus[];
  to: CardJobStatus;
  /**
   * When true, a job ALREADY at `to` is a success rather than a refusal.
   *
   * This is what makes a retried submit safe: the second attempt finds SUBMITTED, reports "no
   * change" and the caller returns the same answer it gave the first time. It is deliberately
   * opt-in — a silent no-op on a transition the caller believed it performed is exactly how a
   * double-settlement gets hidden, so a caller must say it expects retries.
   */
  idempotent?: boolean;
  actorUserId?: string | null;
  sessionId?: string | null;
  deviceId?: string | null;
  reason?: string | null;
  correlationId?: string | null;
  /** Extra fact recorded in the audit `after` payload. Never a secret; passed through the redactor. */
  audit?: Record<string, unknown>;
  /** Audit action name. Defaults to a derived `partner_card_job_<to lowercased>`. */
  action?: string;
}

export interface TransitionResult {
  job: CardJobRow;
  /** False when the job was already at `to` and `idempotent` was set. */
  changed: boolean;
  previousStatus: CardJobStatus;
}

/**
 * Move one Card Job along the legal graph, inside the CALLER's transaction, and audit it.
 *
 * ORDER OF CHECKS IS DELIBERATE:
 *   1. lock the row, so nothing below races another writer;
 *   2. answer an idempotent replay BEFORE the `from` check, because a retry legitimately finds the
 *      job already moved and is not a state error;
 *   3. refuse a wrong `from` — the caller's belief about the world was incorrect;
 *   4. refuse an illegal edge before touching the row, with a cause rather than a trigger exception;
 *   5. UPDATE re-asserting `status = ANY(from)`, so the lock is not the only serialisation.
 */
export async function transitionCardJob(client: PoolClient, input: TransitionInput): Promise<TransitionResult> {
  const job = await lockCardJob(client, input.tenantId, input.cardJobId);

  if (job.status === input.to) {
    if (input.idempotent) return { job, changed: false, previousStatus: job.status };
    throw new CardJobTransitionError("WRONG_STATE", `This card is already ${input.to}.`, {
      status: job.status,
      expected: input.from,
      to: input.to,
    });
  }

  if (!input.from.includes(job.status)) {
    throw new CardJobTransitionError(
      "WRONG_STATE",
      `This card is ${job.status}, which is not a state it can leave for ${input.to}.`,
      { status: job.status, expected: input.from, to: input.to }
    );
  }

  if (!isLegalCardJobTransition(job.status, input.to)) {
    throw new CardJobTransitionError("ILLEGAL_TRANSITION", `A card cannot move from ${job.status} to ${input.to}.`, {
      status: job.status,
      to: input.to,
    });
  }

  // 0080 asserts this too, and its exception is the real floor. Checked here so the caller gets a
  // cause it can render instead of a restrict_violation raised from inside its own transaction.
  if (input.to === CARD_JOB_STATUS.READY_TO_GRADE && job.certificateId === null) {
    throw new CardJobTransitionError(
      "IDENTITY_REQUIRED",
      "This card has no allocated certificate, so it cannot become ready to grade."
    );
  }

  /*
   * The terminal timestamps are set in the SAME statement as the status.
   * `chk_partner_card_jobs_terminal_times` requires cancelled_at on CANCELLED and completed_at on
   * COMPLETED, so a two-statement version would violate the constraint in between.
   */
  const { rows, rowCount } = await client.query<RawJobRow>(
    `UPDATE partner_card_jobs
        SET status = $3,
            cancelled_at = CASE WHEN $3 = 'CANCELLED' THEN now() ELSE cancelled_at END,
            cancelled_reason = CASE WHEN $3 = 'CANCELLED' THEN $5 ELSE cancelled_reason END,
            completed_at = CASE WHEN $3 = 'COMPLETED' THEN now() ELSE completed_at END
      WHERE id = $1 AND tenant_id = $2 AND status = ANY($4::text[])
      RETURNING ${JOB_COLUMNS}`,
    [input.cardJobId, input.tenantId, input.to, [...input.from], input.reason ?? null]
  );
  if (rowCount !== 1) {
    // Lost the race between the lock and the write. Refusing is correct: the caller's precondition
    // is no longer true, and performing the transition anyway would overwrite whatever won.
    throw new CardJobTransitionError("WRONG_STATE", "This card changed while it was being updated.", {
      status: job.status,
      expected: input.from,
      to: input.to,
    });
  }

  const updated = mapJob(rows[0]);

  await writePartnerAudit(client, {
    tenantId: input.tenantId,
    locationId: job.locationId,
    actorUserId: input.actorUserId ?? null,
    deviceId: input.deviceId ?? null,
    action: input.action ?? `partner_card_job_${input.to.toLowerCase()}`,
    recordType: "partner_card_job",
    recordId: job.id,
    before: { status: job.status },
    after: {
      status: updated.status,
      certificateId: updated.certificateId,
      mvNumber: updated.mvNumber,
      ...(input.audit ?? {}),
    },
    sessionId: input.sessionId ?? null,
    reason: input.reason ?? null,
  });

  return { job: updated, changed: true, previousStatus: job.status };
}

/** Open a tenant transaction just to perform one transition. */
export async function transitionCardJobInOwnTxn(
  input: TransitionInput & { locationId?: string | null }
): Promise<TransitionResult> {
  return withPartnerAdminTenantTransaction(
    { tenantId: input.tenantId, locationId: input.locationId ?? null },
    (client) => transitionCardJob(client, input)
  );
}

/**
 * Transition the Card Job behind a certificate, if there is one.
 *
 * Returns null when the certificate has no Card Job — a connector-imported card, whose grading path
 * has no Card Job lifecycle and must be left exactly as it was. A null here means "this lineage does
 * not apply", never "the transition failed".
 */
export async function transitionCardJobForCertificate(
  client: PoolClient,
  scope: { tenantId: string; locationId: string | null },
  certificateId: number,
  input: Omit<TransitionInput, "tenantId" | "cardJobId">
): Promise<TransitionResult | null> {
  const job = await findCardJobForCertificate(client, scope, certificateId);
  if (!job) return null;
  return transitionCardJob(client, { ...input, tenantId: scope.tenantId, cardJobId: job.id });
}

/**
 * Both sides of this card are accepted, immutable, station-bound scanner masters.
 *
 * The SAME predicate the grading queue and `requireBothImages` use: each side must be the CURRENT
 * immutable TIFF master, linked to a TERMINAL capture session, on an ACTIVE station belonging to this
 * Card Job's own tenant AND location. A mutable path, an intake upload or a session that never
 * completed is not proof of a physical capture.
 */
async function bothSidesCaptured(client: PoolClient, job: CardJobRow): Promise<boolean> {
  const { rows } = await client.query<{ side: string }>(
    `SELECT evidence.side
       FROM certificate_image_evidence evidence
       JOIN scanner_capture_sessions session
         ON session.id = evidence.capture_metadata ->> 'captureSessionId'
        AND session.certificate_id = evidence.certificate_id
        AND session.side = evidence.side
        AND session.state = 'captured'
       JOIN partner_stations station
         ON station.id = session.station_id
        AND station.status = 'ACTIVE'
        AND station.tenant_id = $2::uuid
        AND station.location_id = $3::uuid
      WHERE evidence.certificate_id = $1
        AND evidence.is_current = true
        AND evidence.evidence_class = 'NEW_IMMUTABLE_MASTER'
        AND evidence.format = 'tiff'
      GROUP BY evidence.side`,
    [job.certificateId, job.tenantId, job.locationId]
  );
  const sides = new Set(rows.map((row) => row.side));
  return sides.has("front") && sides.has("back");
}

export interface CaptureAdvanceResult {
  cardJobId: string;
  status: CardJobStatus;
  /** True when this call moved the job to READY_TO_GRADE. */
  readyToGrade: boolean;
}

/**
 * ADVANCE A CARD JOB'S LIFECYCLE AFTER A SIDE IS ACCEPTED — the edge that did not exist.
 *
 * THE DEFECT. Scanner NEW creates a Card Job in NEEDS_SCAN. The capture services then wrote
 * `scanner_capture_sessions`, `scanner_evidence_staging` and `certificate_image_evidence` — and never
 * touched `partner_card_jobs.status`. So a fully captured Scanner card stayed in NEEDS_SCAN for ever,
 * and the lease's own `loadGradableJob` (READY_TO_GRADE or GRADING only) correctly refused to open it.
 * The card could be paid for, photographed on both sides, and still be ungradeable.
 *
 * TWO EDGES, IN ONE CALL, BECAUSE THEY ARE ONE EVENT:
 *   NEEDS_SCAN / FIX_REQUIRED → CAPTURING   — the first accepted side means capture is under way;
 *   CAPTURING → READY_TO_GRADE              — once BOTH sides are proven accepted.
 * 0080's graph has no NEEDS_SCAN → READY_TO_GRADE edge, so the intermediate hop is mandatory rather
 * than cosmetic.
 *
 * IDEMPOTENT AND SAFE TO CALL ON EVERY ACCEPT. A recapture of one side on an already-READY card, a
 * retried finalisation, or a second accept of the same side all find the job where it should be and
 * change nothing. `readyToGrade` reports whether THIS call performed the promotion.
 *
 * NULL FOR A NON-CARD-JOB CERTIFICATE. A connector-imported or HQ certificate has no Card Job; that
 * is not a failure and the capture path continues exactly as before.
 *
 * NEVER THROWS INTO THE CAPTURE PATH — see `advanceCardJobAfterCaptureSafely`. Immutable evidence has
 * already been written and acknowledged to the station by the time this runs; a lifecycle hiccup must
 * not turn an accepted capture into an error the operator has to re-shoot.
 */
export async function advanceCardJobAfterCapture(certificateId: number): Promise<CaptureAdvanceResult | null> {
  if (!Number.isSafeInteger(certificateId) || certificateId <= 0) return null;
  return withPartnerAdminTransaction(async (client) => {
    /*
     * The tenant is DISCOVERED here, not supplied: a station accept carries no PartnerPrincipal. That
     * is safe because the capture session was already bound to this certificate through the station's
     * own tenant AND location (scanner-capture-service.ts), so reaching this point already proves the
     * station was entitled to capture this card. The tenant GUC is then set transaction-locally, so
     * every read and write below is inside the correct RLS scope.
     */
    const found = await client.query<RawJobRow>(
      `SELECT ${JOB_COLUMNS} FROM partner_card_jobs
        WHERE certificate_id = $1 AND cancelled_at IS NULL`,
      [certificateId]
    );
    if (!found.rows[0]) return null;
    const discovered = mapJob(found.rows[0]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [discovered.tenantId]);
    await client.query("SELECT set_config('app.location_id', $1, true)", [discovered.locationId ?? ""]);

    const job = await lockCardJob(client, discovered.tenantId, discovered.id);

    // A job past capture (GRADING, SUBMITTED, QA_REVIEW, APPROVED…) must not be dragged backwards by
    // a late or retried accept. Only the pre-grading states participate.
    const CAPTURE_STATES: readonly CardJobStatus[] = [
      CARD_JOB_STATUS.NEEDS_SCAN,
      CARD_JOB_STATUS.CAPTURING,
      CARD_JOB_STATUS.FIX_REQUIRED,
    ];
    if (!CAPTURE_STATES.includes(job.status)) {
      return { cardJobId: job.id, status: job.status, readyToGrade: false };
    }

    let status = job.status;
    if (status === CARD_JOB_STATUS.NEEDS_SCAN || status === CARD_JOB_STATUS.FIX_REQUIRED) {
      const moved = await transitionCardJob(client, {
        tenantId: job.tenantId,
        cardJobId: job.id,
        from: [status],
        to: CARD_JOB_STATUS.CAPTURING,
        idempotent: true,
        actorUserId: job.createdBy,
        action: "partner_card_job_capturing",
        reason: "A scanner capture was accepted for this card.",
      });
      status = moved.job.status;
    }

    if (status === CARD_JOB_STATUS.CAPTURING && (await bothSidesCaptured(client, job))) {
      const ready = await transitionCardJob(client, {
        tenantId: job.tenantId,
        cardJobId: job.id,
        from: [CARD_JOB_STATUS.CAPTURING],
        to: CARD_JOB_STATUS.READY_TO_GRADE,
        idempotent: true,
        actorUserId: job.createdBy,
        action: "partner_card_job_ready_to_grade",
        reason: "Front and back masters are accepted on an approved station.",
        audit: { certificateId: job.certificateId, mvNumber: job.mvNumber },
      });
      return { cardJobId: job.id, status: ready.job.status, readyToGrade: ready.changed };
    }

    return { cardJobId: job.id, status, readyToGrade: false };
  });
}

/**
 * `advanceCardJobAfterCapture` with the failure swallowed and logged.
 *
 * WHY THIS SHAPE. By the time it runs, the immutable master has been written and the station has been
 * told the side was accepted. Throwing would report a failed capture for a capture that genuinely
 * succeeded, and would invite the operator to re-shoot a card whose evidence is already permanent.
 *
 * The state is RECOVERABLE without this call: `bothSidesCaptured` is derived from the evidence
 * ledger, so the next accepted side, a recapture, or the reconciliation sweep re-evaluates it from
 * scratch. Nothing here is the sole record of anything — which is what makes swallowing honest rather
 * than convenient.
 */
export async function advanceCardJobAfterCaptureSafely(certificateId: number): Promise<CaptureAdvanceResult | null> {
  try {
    return await advanceCardJobAfterCapture(certificateId);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      "[partner card job] lifecycle advance after capture failed for certificate",
      certificateId,
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

/* =================================================================================================
 * P10 — SUPER ADMIN QA.
 *
 * The pilot is 100% Super Admin QA: a Partner can never self-approve. The Super Admin review surface
 * is HQ-wide over `certificates` and does NOT join through Partner tables, which is why a Scanner
 * Card Job already reaches Pending Review the moment submit sets `grader_status = 'pending_review'`.
 * What it could not do is move the CARD JOB, so an approved Scanner card stayed in QA_REVIEW for ever
 * and output eligibility (which requires APPROVED/PRINTABLE/COMPLETED) blocked it permanently.
 *
 * ON TRANSACTION SCOPE, HONESTLY. The certificate approval is an atomic CAS deep inside the HQ grader
 * engine on the Drizzle pool; the Card Job lives on the restricted partner-admin pool. Joining them
 * into one transaction means restructuring the grading engine, which this pass will not do to a
 * protected system. So the transition runs immediately AFTER a successful approval, and a failure is
 * reported rather than swallowed.
 *
 * THE RESIDUAL WINDOW FAILS CLOSED AND IS RECOVERABLE. If the transition does not land, the
 * certificate is approved while the Card Job is still QA_REVIEW — and `card_job_valid` in
 * print-eligibility.ts refuses output in exactly that state. Nothing is published early; the card
 * simply waits. The condition is a plain query (job.status = 'QA_REVIEW' AND cert.grade_approved_at
 * IS NOT NULL), which is why it is a P12 reconciliation check rather than a silent inconsistency.
 * ============================================================================================== */

/** Move the Card Job behind a certificate, discovering its tenant. Null when there is no Card Job. */
async function transitionCardJobByCertificateAsSystem(
  certificateId: number,
  input: Omit<TransitionInput, "tenantId" | "cardJobId">
): Promise<TransitionResult | null> {
  if (!Number.isSafeInteger(certificateId) || certificateId <= 0) return null;
  return withPartnerAdminTransaction(async (client) => {
    const found = await client.query<RawJobRow>(
      `SELECT ${JOB_COLUMNS} FROM partner_card_jobs
        WHERE certificate_id = $1 AND cancelled_at IS NULL`,
      [certificateId]
    );
    if (!found.rows[0]) return null;
    const job = mapJob(found.rows[0]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [job.tenantId]);
    await client.query("SELECT set_config('app.location_id', $1, true)", [job.locationId ?? ""]);
    return transitionCardJob(client, { ...input, tenantId: job.tenantId, cardJobId: job.id });
  });
}

/**
 * QA APPROVED this card — QA_REVIEW → APPROVED.
 *
 * Idempotent, so a retried approval on an already-APPROVED job succeeds without a second audit row.
 * Returns null for a certificate with no Card Job (connector/HQ), which is not a failure.
 */
export async function approveCardJobForCertificate(
  certificateId: number,
  adminUser: string
): Promise<TransitionResult | null> {
  return transitionCardJobByCertificateAsSystem(certificateId, {
    from: [CARD_JOB_STATUS.QA_REVIEW],
    to: CARD_JOB_STATUS.APPROVED,
    idempotent: true,
    action: "partner_card_job_qa_approved",
    reason: "Super Admin QA approved this card.",
    audit: { approvedBy: adminUser },
  });
}

/**
 * QA RETURNED this card to the grader — QA_REVIEW → GRADING.
 *
 * THE SAME Card Job, the SAME MV and the SAME certificate. 0080's graph models this explicitly
 * ("QA returned it"), and it is the ONLY correction path for Card Job lineage — the Partner
 * self-service `edit-submission` route deliberately refuses this lineage, so a card under review
 * cannot be amended behind the reviewer's back.
 *
 * HISTORY IS PRESERVED, not reset: the certificate keeps its grading revisions and gains
 * `redo_count + 1` and the rejection reason (written by the HQ reject path), the lease revision
 * continues from where it was, and both the return and the re-submission are audited.
 */
export async function returnCardJobToGraderForCertificate(
  certificateId: number,
  adminUser: string,
  reason: string | null
): Promise<TransitionResult | null> {
  return transitionCardJobByCertificateAsSystem(certificateId, {
    from: [CARD_JOB_STATUS.QA_REVIEW],
    to: CARD_JOB_STATUS.GRADING,
    idempotent: true,
    action: "partner_card_job_returned_to_grader",
    reason: reason ?? "Super Admin QA returned this card to the grader.",
    audit: { returnedBy: adminUser },
  });
}

/**
 * Read the transition graph the DATABASE is actually enforcing, by asking it.
 *
 * Exists so the duplicated `LEGAL_TRANSITIONS` above can be PROVEN equal to 0080's trigger rather
 * than asserted equal in a comment. A future migration that widens the graph without updating this
 * module is caught by the suite, not by a production refusal.
 */
export async function databaseTransitionGraphSource(client: PoolClient): Promise<string> {
  const { rows } = await client.query<{ src: string }>(
    `SELECT prosrc AS src FROM pg_proc WHERE proname = 'partner_card_jobs_enforce_transition'`
  );
  if (!rows[0]) throw new Error("partner_card_jobs_enforce_transition() is not installed");
  return rows[0].src;
}
