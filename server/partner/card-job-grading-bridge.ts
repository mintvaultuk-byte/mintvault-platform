/**
 * THE CARD JOB → CANONICAL GRADING BRIDGE.
 *
 * WHAT WAS BROKEN. Scanner NEW (P6) mints a Partner Card Job, a certificate and an MV in one
 * transaction, and deliberately does NOT enter the connector import path (OD-7: a walk-in card has
 * no customer, so `customer_missing` would block its validation gate for ever). Partner grading, by
 * contrast, resolved ownership ENTIRELY through `partner_connector_imports` — the loader, the queue,
 * the write guard and both submit statements each carried the same five-table connector JOIN chain.
 *
 * A Scanner Card Job matches ZERO rows in that chain. So the card a shop had just paid a Grading
 * Credit for could be captured, and then could not be graded at all: it never appeared in the queue,
 * the loader returned 404 for it, and the write guard matched nothing — surfacing as
 * "Card status changed; refresh and try again", which is a misleading answer to "this card has no
 * connector lineage and never will".
 *
 * THE ARCHITECTURE, AS DECIDED. Scanner NEW → Partner Card Job is the canonical Partner intake
 * spine. The connector path remains fully supported for legacy and imported Partner work. Both
 * lineages travel the SAME grading workstation, the SAME QA system and the SAME output system —
 * there is no second queue, no second workstation, no Dashboard V2. Where a Card Job exists, Card
 * Job lineage is authoritative for that work item.
 *
 * WHY THE LEASE IS THE ASSIGNMENT AUTHORITY. `authorizeAssignedPartnerCert` required
 * `certificates.assigned_grader_id = principal.userId`. Scanner NEW assigns no grader — there is no
 * step in the walk-in flow at which anybody could, because the card is graded by whoever picks it up
 * next. Requiring a pre-assignment would mean inventing an assignment ceremony that the shop floor
 * does not have. The lease already answers exactly the question assignment was being used to answer
 * ("who may write to this card right now"), it is enforced by a partial UNIQUE index rather than a
 * column comparison, and it expires. So for Card Job lineage the lease IS the authority, and
 * `assigned_grader_id` is written as a RECORD of who took the card — never required as a
 * precondition.
 *
 * WHY THE SUBMIT EDGE IS ONE TRANSACTION HERE. grading-lease-service.ts records an honest MEDIUM:
 * the lease lives on the restricted partner-admin pool while the HQ grader writes `certificates` on
 * the Drizzle pool, so the two could not be joined into one transaction without restructuring the
 * grading engine. That is still true of the incremental DRAFT saves, which remain on the HQ engine
 * untouched. It is NOT true of the submit edge: `assertPartnerAccountingDatabaseTopology()` requires
 * every accounting URL to resolve to the SAME database identity, and the certificate write at submit
 * is a single self-contained statement this module owns. So for Card Job lineage the lifecycle
 * transition, the certificate hand-off to QA and the Grading Credit settlement all commit TOGETHER —
 * which is what makes "never double-settle on retry" a property of the database rather than of how
 * the client behaved.
 *
 * THE MVGS ENGINE IS NOT TOUCHED. Nothing here scores, publishes, or computes a grade. The
 * authoritative grade remains whatever the server-side MVGS engine produced; this module moves
 * lifecycle state, settles a credit through the canonical engine, and audits.
 */
import type { PoolClient } from "pg";
import { withPartnerAdminTenantTransaction } from "./db";
import {
  CARD_JOB_STATUS,
  CardJobTransitionError,
  findCardJobForCertificate,
  lockCardJob,
  transitionCardJob,
  type CardJobRow,
} from "./card-job-lifecycle";
import { consumeReservedCreditInTransaction, CreditReservationError } from "./partner-credit-reservation-service";
import type { PartnerPrincipal } from "./session";

/**
 * Which intake road a Partner work item travelled.
 *
 * `card_job` — Scanner NEW / canonical Partner intake. Authority is tenant + location + permission
 *              + grading lease + Card Job lifecycle state.
 * `connector` — legacy/imported Partner work. Authority is the existing connector mapping plus
 *              assigned-grader binding, preserved exactly as it was.
 */
export type PartnerCertLineage = "card_job" | "connector";

export class CardJobGradingError extends Error {
  constructor(
    public code:
      | "CARD_JOB_NOT_FOUND"
      | "NOT_GRADING"
      | "ALREADY_SUBMITTED"
      | "CERTIFICATE_NOT_WRITABLE"
      | "NOT_LEASE_HOLDER"
      | "CREDIT_SETTLEMENT_FAILED",
    message: string,
    public detail?: Record<string, unknown>
  ) {
    super(message);
  }
}

/** The operator's email, for the credit ledger's actor columns. Null is acceptable and recorded. */
async function actorEmailFor(client: PoolClient, tenantId: string, userId: string): Promise<string | null> {
  const { rows } = await client.query<{ email: string | null }>(
    `SELECT email FROM partner_users WHERE id = $1 AND tenant_id = $2`,
    [userId, tenantId]
  );
  return rows[0]?.email ?? null;
}

/**
 * Stamp the certificate with the grader who now holds the card.
 *
 * NOT AN AUTHORITY — a RECORD. The authority to grade this card was already established by the
 * lease; this exists so the HQ side of the system (Super Admin QA, the return-to-grader path, the
 * dashboards, `graded_by` attribution) can answer "who is grading this?" without reaching into
 * Partner lease tables it has no business knowing about.
 *
 * `grader_status` moves `unassigned` → `assigned`, which is the state the existing grading engine and
 * the existing Super Admin review queue already understand. There is no DB trigger on
 * `certificates.grader_status` (the only status trigger in the repository is on `submissions.status`),
 * so this is a plain guarded UPDATE and not a fight with a state machine.
 *
 * Deliberately scoped `grade_approved_at IS NULL`: a published certificate is never re-assigned by a
 * lease acquire. Correction Mode is the only path into a published grade and it is not this.
 */
async function stampGraderOnCertificate(
  client: PoolClient,
  job: CardJobRow,
  principal: PartnerPrincipal
): Promise<void> {
  if (job.certificateId === null) return;
  /*
   * Guarded by to_regclass, matching the convention 0080 and card-job-authority.ts already use:
   * `certificates` is a CORE table, and a partner-only disposable database does not have one (which
   * is exactly why 0080 attaches its certificate foreign key conditionally). Where the table is
   * absent there is no HQ record to stamp and the lease is the whole authority; where it EXISTS the
   * stamp is mandatory.
   */
  const present = await client.query<{ present: boolean }>(
    `SELECT to_regclass('public.certificates') IS NOT NULL AS present`
  );
  if (!present.rows[0]?.present) return;
  await client.query(
    `UPDATE certificates
        SET assigned_grader_id = $2,
            assigned_at = COALESCE(assigned_at, NOW()),
            grader_status = CASE WHEN grader_status = 'unassigned' THEN 'assigned' ELSE grader_status END,
            updated_at = NOW()
      WHERE id = $1
        AND deleted_at IS NULL
        AND grade_approved_at IS NULL
        AND origin_type = 'PARTNER'
        AND origin_partner_id = $3
        AND grader_status IN ('unassigned', 'assigned')`,
    [job.certificateId, principal.userId, job.tenantId]
  );
}

export interface BeginGradingResult {
  job: CardJobRow;
  /** True when this call moved READY_TO_GRADE → GRADING rather than finding it already open. */
  started: boolean;
}

/**
 * Open a Card Job for grading — the transition the lease acquire performs.
 *
 * IDEMPOTENT BY DESIGN. A grader who refreshes, or who reacquires an expired lease on a card already
 * in GRADING, must not be refused: `READY_TO_GRADE → GRADING` happens once and every later acquire
 * finds GRADING and simply re-stamps. That is why `idempotent` is set — a job already at GRADING is a
 * success here, not a state error.
 *
 * Runs inside the LEASE's transaction, so a grader cannot end up holding a lease on a card whose job
 * never opened, nor open a job whose lease was refused.
 */
export async function beginCardJobGrading(
  client: PoolClient,
  principal: PartnerPrincipal,
  cardJobId: string
): Promise<BeginGradingResult> {
  const current = await lockCardJob(client, principal.tenantId, cardJobId);
  if (current.status === CARD_JOB_STATUS.GRADING) {
    await stampGraderOnCertificate(client, current, principal);
    return { job: current, started: false };
  }
  const result = await transitionCardJob(client, {
    tenantId: principal.tenantId,
    cardJobId,
    from: [CARD_JOB_STATUS.READY_TO_GRADE],
    to: CARD_JOB_STATUS.GRADING,
    idempotent: true,
    actorUserId: principal.userId,
    sessionId: principal.sessionId,
    action: "partner_card_job_grading_started",
    reason: "A grader took the editing lease on this card.",
  });
  await stampGraderOnCertificate(client, result.job, principal);
  return { job: result.job, started: result.changed };
}

/**
 * Hand the card back — the transition a lease RELEASE performs.
 *
 * `GRADING → READY_TO_GRADE` is 0080's "grader released the card" edge. A job that is no longer in
 * GRADING (already submitted, sent to FIX, cancelled) is left exactly where it is: releasing a lease
 * must never drag a submitted card back onto the shop floor, so this is silent rather than an error.
 */
export async function releaseCardJobGrading(
  client: PoolClient,
  principal: PartnerPrincipal,
  cardJobId: string
): Promise<void> {
  const current = await lockCardJob(client, principal.tenantId, cardJobId);
  if (current.status !== CARD_JOB_STATUS.GRADING) return;
  await transitionCardJob(client, {
    tenantId: principal.tenantId,
    cardJobId,
    from: [CARD_JOB_STATUS.GRADING],
    to: CARD_JOB_STATUS.READY_TO_GRADE,
    actorUserId: principal.userId,
    sessionId: principal.sessionId,
    action: "partner_card_job_grading_released",
    reason: "The grader released the editing lease on this card.",
  });
}

export interface SubmitCardJobResult {
  cardJobId: string;
  certificateId: number;
  mvNumber: string | null;
  status: string;
  /** True when this call performed the submit; false when it replayed one already performed. */
  submitted: boolean;
  /** True when the Grading Credit was consumed by THIS call. False on a replay. */
  creditSettled: boolean;
  reservationId: string | null;
}

/**
 * SUBMIT a Card Job for Super Admin QA, settling its Grading Credit exactly once.
 *
 * ONE TRANSACTION covers all five effects:
 *   1. the Card Job moves GRADING → SUBMITTED;
 *   2. the certificate is handed to QA (`grader_status = 'pending_review'`, `review_required`);
 *   3. the Grading Credit is CONSUMED through the canonical reservation engine;
 *   4. the Card Job moves SUBMITTED → QA_REVIEW;
 *   5. the whole thing is audited.
 *
 * Migration 0080 names the SUBMITTED state "credit consumed exactly once at this edge". This is that
 * edge, and it had no implementation: `settlePartnerCreditForDestinationStatus` — the only existing
 * settlement path — is keyed on a DESTINATION SUBMISSION and returns null without a
 * `partner_connector_imports` link, so a Scanner Card Job could never settle through it. Rather than
 * manufacture a fake connector row to reach that function (explicitly forbidden, and it would make a
 * lie referentially permanent), this settles the reservation the Card Job already carries.
 *
 * EXACTLY-ONCE IS ENFORCED TWICE, INDEPENDENTLY:
 *   - the Card Job row is taken FOR UPDATE and must be in GRADING, so a second concurrent submit
 *     finds SUBMITTED/QA_REVIEW and replays instead of transitioning again; and
 *   - the consume carries the deterministic idempotency key `partner-card-job-submit:<jobId>`, and
 *     the reservation engine's own `(tenant_id, source, idempotency_key)` uniqueness on
 *     `partner_credit_reservation_events` refuses a second debit even if the first floor were
 *     somehow bypassed.
 *
 * A RETRY IS A REPLAY, NOT A SECOND SUBMIT. It re-reads the same job, reports the same answer, writes
 * no certificate, consumes nothing and emits no duplicate audit — which is what makes a dropped
 * response safe for a shop that has been charged real money.
 */
export async function submitCardJobForReview(
  principal: PartnerPrincipal,
  certificateId: number
): Promise<SubmitCardJobResult> {
  return withPartnerAdminTenantTransaction(
    { tenantId: principal.tenantId, locationId: principal.locationId ?? null },
    async (client) => {
      const found = await findCardJobForCertificate(
        client,
        { tenantId: principal.tenantId, locationId: principal.orgWide ? null : principal.locationId },
        certificateId
      );
      if (!found) {
        throw new CardJobGradingError("CARD_JOB_NOT_FOUND", "That card was not found for this partner.");
      }
      const job = await lockCardJob(client, principal.tenantId, found.id);

      /*
       * REPLAY, answered before anything is written or spent.
       *
       * A job already past the submit edge returns the answer the first call gave. This is checked
       * on the LOCKED row, so it is not a read-then-act race: a concurrent first submit either has
       * not committed (this call waits on the lock, then sees SUBMITTED/QA_REVIEW) or has (same).
       */
      if (job.status === CARD_JOB_STATUS.SUBMITTED || job.status === CARD_JOB_STATUS.QA_REVIEW) {
        return {
          cardJobId: job.id,
          certificateId: job.certificateId as number,
          mvNumber: job.mvNumber,
          status: job.status,
          submitted: false,
          creditSettled: false,
          reservationId: null,
        };
      }
      if (job.status !== CARD_JOB_STATUS.GRADING) {
        throw new CardJobGradingError(
          "NOT_GRADING",
          `This card is ${job.status}, so it cannot be submitted for review.`,
          { status: job.status }
        );
      }

      /*
       * ONLY THE LEASE HOLDER MAY SUBMIT — asserted HERE, in the same transaction as the transition
       * and the settlement, not merely at the route.
       *
       * The route does call `requireLeaseForCertificateWrite` first, and that check includes the
       * revision. But it commits in its OWN transaction, so between it and this one the lease could
       * be taken by an audited takeover — and, more importantly, any future caller of this function
       * that forgot the route's check would be able to submit somebody else's card and spend their
       * Grading Credit. A settlement that consumes real money must not depend on a caller having
       * remembered to ask permission.
       *
       * The revision is deliberately NOT re-checked here: the route already bumped it, so demanding
       * the pre-bump value would refuse the very call that just earned the authority.
       */
      const lease = await client.query<{ holder_user_id: string }>(
        `SELECT holder_user_id
           FROM partner_grading_leases
          WHERE tenant_id = $1 AND card_job_id = $2
            AND released_at IS NULL AND expires_at > now()
          FOR UPDATE`,
        [principal.tenantId, job.id]
      );
      if (lease.rows[0]?.holder_user_id !== principal.userId) {
        throw new CardJobGradingError(
          "NOT_LEASE_HOLDER",
          "You do not hold this card for editing, so it cannot be submitted."
        );
      }

      // ---- 1. GRADING → SUBMITTED --------------------------------------------------------------
      await transitionCardJob(client, {
        tenantId: principal.tenantId,
        cardJobId: job.id,
        from: [CARD_JOB_STATUS.GRADING],
        to: CARD_JOB_STATUS.SUBMITTED,
        actorUserId: principal.userId,
        sessionId: principal.sessionId,
        action: "partner_card_job_submitted",
        reason: "Grader submitted this card for Super Admin QA.",
      });

      // ---- 2. Hand the certificate to QA -------------------------------------------------------
      // `operator_grade`/`operator_subgrades` snapshot what the PARTNER asserted, so a later QA
      // approval or correction can always be compared against the grader's own submission. The
      // authoritative grade itself is the MVGS engine's and is not recomputed here.
      const handed = await client.query<{ id: number }>(
        `UPDATE certificates SET
             grader_status = 'pending_review',
             review_required = true,
             graded_at = NOW(),
             graded_by = $2,
             assigned_grader_id = COALESCE(assigned_grader_id, $2),
             operator_grade = grade,
             operator_subgrades = jsonb_build_object(
               'centering', centering_score,
               'corners', corners_score,
               'edges', edges_score,
               'surface', surface_score
             ),
             updated_at = NOW()
           WHERE id = $1
             AND deleted_at IS NULL
             AND grade_approved_at IS NULL
             AND origin_type = 'PARTNER'
             AND origin_partner_id = $3
             AND grader_status IN ('unassigned', 'assigned')
           RETURNING id`,
        [job.certificateId, principal.userId, principal.tenantId]
      );
      if (handed.rowCount !== 1) {
        // Rolls the whole transaction back, including the transition above. A card whose certificate
        // could not be handed to QA must not be left recorded as SUBMITTED.
        throw new CardJobGradingError(
          "CERTIFICATE_NOT_WRITABLE",
          "This card's certificate is not in a state that can be submitted for review."
        );
      }

      // ---- 3. Consume exactly one Grading Credit, through the CANONICAL engine ------------------
      let creditSettled = false;
      if (job.certificateId !== null) {
        const { rows } = await client.query<{ reservation_id: string | null }>(
          `SELECT reservation_id FROM partner_card_jobs WHERE id = $1 AND tenant_id = $2`,
          [job.id, principal.tenantId]
        );
        const reservationId = rows[0]?.reservation_id ?? null;
        if (reservationId) {
          try {
            const settlement = await consumeReservedCreditInTransaction(
              client,
              {
                actorUserId: principal.userId,
                actorEmail: await actorEmailFor(client, principal.tenantId, principal.userId),
              },
              {
                tenantId: principal.tenantId,
                reservationId,
                // Deterministic and derived from the job, never from the client: this is what makes
                // the engine's own uniqueness the second, independent floor under exactly-once.
                idempotencyKey: `partner-card-job-submit:${job.id}`,
                source: "portal",
                reason: "Consumed one Grading Credit when the Card Job was submitted for QA review.",
                actorType: "partner_user",
                metadata: {
                  partner_card_job_id: job.id,
                  certificate_id: job.certificateId,
                  mv_number: job.mvNumber,
                  edge: "card_job_submitted",
                },
              }
            );
            creditSettled = !settlement.alreadyApplied;
          } catch (err) {
            if (err instanceof CreditReservationError) {
              throw new CardJobGradingError(
                "CREDIT_SETTLEMENT_FAILED",
                "This card's Grading Credit could not be settled, so it was not submitted.",
                { creditCode: err.code }
              );
            }
            throw err;
          }
        }
      }

      // ---- 4. SUBMITTED → QA_REVIEW ------------------------------------------------------------
      // A separate edge rather than one hop, because 0080's graph models them separately and the
      // credit settles between them. Both commit together, so no state exists in which a card is
      // SUBMITTED but never queued for QA.
      const queued = await transitionCardJob(client, {
        tenantId: principal.tenantId,
        cardJobId: job.id,
        from: [CARD_JOB_STATUS.SUBMITTED],
        to: CARD_JOB_STATUS.QA_REVIEW,
        actorUserId: principal.userId,
        sessionId: principal.sessionId,
        action: "partner_card_job_qa_review",
        reason: "Card entered Super Admin QA review.",
        audit: { creditSettled },
      });

      return {
        cardJobId: job.id,
        certificateId: job.certificateId as number,
        mvNumber: job.mvNumber,
        status: queued.job.status,
        submitted: true,
        creditSettled,
        reservationId: null,
      };
    }
  );
}

/**
 * Map a bridge/lifecycle failure onto an HTTP status a workstation can act on.
 *
 * A cross-tenant or cross-location Card Job resolves to 404 — the same answer an absent id gets,
 * because a distinct 403 would confirm the id is real and belongs to somebody.
 */
export function cardJobErrorStatus(error: unknown): number | null {
  if (error instanceof CardJobGradingError) {
    switch (error.code) {
      case "CARD_JOB_NOT_FOUND":
        return 404;
      case "NOT_GRADING":
      case "ALREADY_SUBMITTED":
      case "CERTIFICATE_NOT_WRITABLE":
        return 409;
      case "NOT_LEASE_HOLDER":
        // 410, matching the lease service: your editing session is gone, not merely conflicted.
        return 410;
      case "CREDIT_SETTLEMENT_FAILED":
        return 409;
    }
  }
  if (error instanceof CardJobTransitionError) {
    switch (error.code) {
      case "CARD_JOB_NOT_FOUND":
        return 404;
      case "FORBIDDEN":
        return 403;
      default:
        return 409;
    }
  }
  return null;
}
