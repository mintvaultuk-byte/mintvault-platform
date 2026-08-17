/**
 * P6c — CANCELLING A CARD JOB THAT WAS NEVER PHOTOGRAPHED.
 *
 * THE DEFECT THIS CLOSES. Migration 0080 has shipped `NEEDS_SCAN -> CANCELLED` (and
 * `CREDIT_RESERVED -> CANCELLED`) as legal edges since the day the Card Job table existed, and
 * `card-job-lifecycle.ts` can perform them — but NOTHING EVER CALLED THEM. A card started by mistake
 * at the counter therefore had no way out: its Grading Credit stayed reserved for the full 365-day
 * TTL, the shop's available balance stayed short by one, and the job sat in NEEDS_SCAN for ever.
 *
 * WHY NOT SUBMISSION CANCELLATION. `releasePartnerReservationForPartnerCancellation` exists and does
 * release credits — but it is keyed on a partner SUBMISSION and knows nothing about Card Jobs. Using
 * it here would return the credit while leaving the Card Job stranded in NEEDS_SCAN: a job with no
 * reservation behind it, still listed as work waiting to be done, still offered to the FIX queue, and
 * still capturable. That is strictly worse than the bug it would be fixing, which is why this is a
 * Card-Job-native authority rather than a reuse.
 *
 * THE FOUR THINGS THIS GUARANTEES.
 *   1. THE RESERVATION IS RELEASED EXACTLY ONCE. Through the canonical engine, with a DETERMINISTIC
 *      idempotency key derived from the Card Job id, so a retried cancellation replays the original
 *      event rather than returning a second credit. No balance is ever computed here.
 *   2. THE MV SURVIVES FOR EVER. Nothing in this file touches `certificates`, `mv_number` or
 *      `certificate_id`. A cancelled card keeps its permanent identity and its origin snapshot;
 *      locked rule 1 ("one Card Job = one permanent MV") is about the number never being REUSED, and
 *      deleting it is how it would get reused.
 *   3. NOTHING IS DELETED. The job row stays, stamped CANCELLED with `cancelled_at` and a reason; the
 *      submission, the card unit, the reservation and every reservation event stay; the audit trail
 *      gains a row. The state is readable for ever.
 *   4. A CANCELLED JOB IS INERT. `loadCapturableJob`, `loadFixableJob`, `findCardJobForCertificate`
 *      and the fix queue all carry `cancelled_at IS NULL`, and 0080's trigger refuses to move
 *      anything out of a terminal state, so a cancelled card can neither capture nor grade.
 *
 * WHAT IT REFUSES, AND WHY EACH REFUSAL IS THE SAFE ANSWER.
 *   - A job past NEEDS_SCAN. Once a photograph exists the card is real work with real evidence; the
 *     remedy for a bad image is FIX, and the remedy for a finished card is not cancellation at all.
 *   - A job with ANY current evidence, checked against the ledger rather than inferred from status —
 *     the status could lag, the evidence table cannot.
 *   - A reservation that has already been CONSUMED. That credit is spent; releasing it would hand
 *     back a credit the shop has already had the benefit of.
 *   - A capture session mid-`capturing`. The server is finalising an image at that instant, and
 *     cancelling underneath it would race a write we do not own.
 */
import type { PoolClient } from "pg";
import { withPartnerAdminTenantTransaction } from "./db";
import { releaseReservedCreditInTransaction, CreditReservationError } from "./partner-credit-reservation-service";
import { CARD_JOB_STATUS, lockCardJob, transitionCardJob, type CardJobStatus } from "./card-job-lifecycle";

export class CardJobCancellationError extends Error {
  constructor(
    public readonly code:
      | "CARD_JOB_NOT_FOUND"
      | "JOB_NOT_CANCELLABLE"
      | "JOB_HAS_EVIDENCE"
      // Super-admin void route. Separate codes so a caller can tell "you may not do this here"
      // from "this card is not a candidate", and neither is confused with a station cancellation.
      | "STATION_MAY_NOT_VOID"
      | "JOB_NOT_VOIDABLE"
      | "CAPTURE_IN_PROGRESS"
      | "CREDIT_ALREADY_SETTLED"
      | "STATION_NOT_ACTIVE"
      | "REASON_REQUIRED",
    message: string
  ) {
    super(message);
    this.name = "CardJobCancellationError";
  }
}

/**
 * The ONLY states a card may be cancelled from.
 *
 * A deliberate SUBSET of what 0080's graph permits. The graph also allows `CAPTURING -> CANCELLED`,
 * and that edge is correct at the database level — but CAPTURING means at least one side has already
 * been accepted, and throwing away a photographed card at a station is a decision with evidence
 * consequences that belongs to the dashboard, not to a scanner operator clearing a mis-press.
 * Narrowing here removes that possibility from the station surface without weakening the graph.
 */
const CANCELLABLE_STATUSES: readonly CardJobStatus[] = [CARD_JOB_STATUS.CREDIT_RESERVED, CARD_JOB_STATUS.NEEDS_SCAN];

export interface CancelCardJobInput {
  tenantId: string;
  locationId: string | null;
  cardJobId: string;
  /** Authenticated station, when the cancellation is pressed at a Mac. Never from a request body. */
  stationId?: string | null;
  actorUserId: string;
  actorEmail?: string | null;
  /** Mandatory free text. An unexplained cancellation is indistinguishable from an accident. */
  reason: string;
}

export interface CancelCardJobResult {
  cardJobId: string;
  /** Preserved, always. A cancelled card keeps its number for ever; it is never reissued. */
  mvNumber: string | null;
  certificateId: number | null;
  status: "CANCELLED";
  reservationId: string | null;
  /** True when THIS call returned the credit. False on a replay, or when it was already returned. */
  reservationReleased: boolean;
  /** False when the job was already CANCELLED — a retry, not a second cancellation. */
  changed: boolean;
  /** Armed/claimed capture sessions made terminal so the station cannot photograph a dead card. */
  cancelledCaptureSessions: number;
}

/** True when a table is present on this deployment. Partner-only databases lack the HQ tables. */
async function tablePresent(client: PoolClient, qualified: string): Promise<boolean> {
  const { rows } = await client.query<{ present: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS present`, [
    qualified,
  ]);
  return rows[0]?.present === true;
}

/**
 * A revoked or suspended Mac must not be able to release money, and a Mac may only cancel cards
 * taken at its OWN shop floor.
 *
 * Guarded by `to_regclass` for the same reason `assertStartAllowed` is: `partner_stations` arrives in
 * migration 0045 and is absent from partner-only databases, where the authenticated-station check at
 * the HTTP boundary is the control. Where the table DOES exist the check is mandatory.
 */
async function assertStationMayCancel(
  client: PoolClient,
  input: { tenantId: string; stationId: string; jobLocationId: string | null }
): Promise<void> {
  if (!(await tablePresent(client, "public.partner_stations"))) return;
  const { rows } = await client.query<{ status: string; location_id: string | null }>(
    `SELECT status, location_id FROM partner_stations WHERE id = $1 AND tenant_id = $2`,
    [input.stationId, input.tenantId]
  );
  const station = rows[0];
  if (!station || station.status !== "ACTIVE") {
    throw new CardJobCancellationError("STATION_NOT_ACTIVE", "This station is not approved to cancel cards.");
  }
  // Reported as NOT_FOUND rather than FORBIDDEN, for the same non-confirmation reason the tenant
  // predicate uses: a distinct answer would confirm the id is real and belongs to somebody.
  if (input.jobLocationId && station.location_id !== input.jobLocationId) {
    throw new CardJobCancellationError("CARD_JOB_NOT_FOUND", "That card was not found for this partner.");
  }
}

/**
 * Refuse if this card has ANY image, current or being finalised right now.
 *
 * READ FROM THE EVIDENCE LEDGER, NOT FROM THE JOB STATUS. `advanceCardJobAfterCaptureSafely`
 * deliberately swallows its own failure, so a card CAN legitimately hold an accepted master while its
 * status still reads NEEDS_SCAN. Trusting the status here is exactly how a photographed card would be
 * cancelled and its credit handed back.
 */
async function assertNothingCaptured(
  client: PoolClient,
  input: { certificateId: number | null; mvNumber: string | null }
): Promise<void> {
  if (input.certificateId === null) return;

  if (await tablePresent(client, "public.certificate_image_evidence")) {
    const { rows } = await client.query<{ side: string }>(
      `SELECT side FROM certificate_image_evidence
        WHERE certificate_id = $1 AND is_current = true
        LIMIT 1`,
      [input.certificateId]
    );
    if (rows.length > 0) {
      throw new CardJobCancellationError(
        "JOB_HAS_EVIDENCE",
        `${input.mvNumber ?? "This card"} already has a saved image and cannot be cancelled. Finish it, or remove the image from grading and re-scan it.`
      );
    }
  }

  if (await tablePresent(client, "public.scanner_capture_sessions")) {
    const { rows } = await client.query<{ state: string }>(
      `SELECT state FROM scanner_capture_sessions
        WHERE certificate_id = $1 AND state = 'capturing'
        LIMIT 1`,
      [input.certificateId]
    );
    if (rows.length > 0) {
      throw new CardJobCancellationError(
        "CAPTURE_IN_PROGRESS",
        `${input.mvNumber ?? "This card"} is having an image finalised right now. Wait for that scan to finish or fail, then try again.`
      );
    }
  }
}

/**
 * Make every outstanding target for this card terminal, so the station cannot photograph a dead card.
 *
 * `armed` and `claimed` only. `capturing` was refused above, and the terminal states are already
 * final. The scanner's own watcher treats a `cancelled` session as a hard stop for the side it is
 * holding (`failTargetedCapture`), so a TIFF captured against a session cancelled underneath it is
 * archived locally and never uploaded — no evidence is written for a cancelled job.
 *
 * This also frees the station's `uq_scanner_capture_one_active_station` slot (migration 0075), which
 * is what lets the operator start their NEXT card immediately after cancelling this one.
 */
async function cancelOutstandingCaptureSessions(
  client: PoolClient,
  certificateId: number | null,
  reason: string
): Promise<number> {
  if (certificateId === null) return 0;
  if (!(await tablePresent(client, "public.scanner_capture_sessions"))) return 0;
  const { rowCount } = await client.query(
    `UPDATE scanner_capture_sessions
        SET state = 'cancelled',
            failure_reason = $2
      WHERE certificate_id = $1
        AND state IN ('armed', 'claimed')`,
    [certificateId, reason.slice(0, 200)]
  );
  return rowCount ?? 0;
}

/**
 * Return the reserved Grading Credit, EXACTLY ONCE, through the canonical engine.
 *
 * THE IDEMPOTENCY KEY IS DERIVED FROM THE CARD JOB, NOT GENERATED. `partner-card-job-cancel:<id>` is
 * the same string on every retry of the same cancellation, which is what makes a dropped response,
 * a double-click and an app restart mid-request all replay one release instead of performing two.
 * The engine answers a replay from its own event record before it looks at the reservation at all.
 *
 * A reservation that is ALREADY `released` or `expired` is a success with `released: false` — the
 * credit is back in availability, which is the outcome the caller wanted. A `consumed` reservation is
 * refused: that credit has been spent, and handing it back would be a genuine accounting error.
 */
async function releaseReservationOnce(
  client: PoolClient,
  input: {
    tenantId: string;
    cardJobId: string;
    reservationId: string;
    mvNumber: string | null;
    stationId: string | null;
    actorUserId: string;
    actorEmail: string | null;
    reason: string;
  }
): Promise<boolean> {
  const { rows } = await client.query<{ status: string }>(
    `SELECT status FROM partner_credit_reservations WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [input.reservationId, input.tenantId]
  );
  const status = rows[0]?.status;
  // No reservation row visible for this tenant: nothing of ours is held, so there is nothing to
  // return. The job is still cancellable — refusing here would strand it for ever.
  if (!status) return false;
  if (status === "consumed") {
    throw new CardJobCancellationError(
      "CREDIT_ALREADY_SETTLED",
      `The Grading Credit for ${input.mvNumber ?? "this card"} has already been spent, so it cannot be cancelled.`
    );
  }
  if (status !== "active") return false; // already released or expired — availability already has it

  try {
    const result = await releaseReservedCreditInTransaction(
      client,
      { actorUserId: input.actorUserId, actorEmail: input.actorEmail },
      {
        tenantId: input.tenantId,
        reservationId: input.reservationId,
        idempotencyKey: `partner-card-job-cancel:${input.cardJobId}`,
        source: "portal",
        reason: "Card Job cancelled before capture. One Grading Credit returned to availability.",
        actorType: "partner_user",
        externalRef: null,
        metadata: {
          partner_card_job_id: input.cardJobId,
          station_id: input.stationId,
          mv_number: input.mvNumber,
          cancellation_reason: input.reason,
        },
      }
    );
    return !result.alreadyApplied;
  } catch (error) {
    if (error instanceof CreditReservationError) {
      // Lost a race with the expiry sweep or another release between the SELECT and the write. The
      // credit is back either way, so the cancellation continues rather than stranding the job.
      if (error.code === "RESERVATION_NOT_ACTIVE") return false;
      if (error.code === "RESERVATION_EXPIRED") {
        throw new CardJobCancellationError(
          "CREDIT_ALREADY_SETTLED",
          `The Grading Credit reservation for ${input.mvNumber ?? "this card"} has passed its expiry and must be settled by MintVault before this card can be cancelled.`
        );
      }
    }
    throw error;
  }
}

/**
 * CANCEL ONE CARD JOB THAT HAS NOT BEEN PHOTOGRAPHED — the canonical caller of `NEEDS_SCAN ->
 * CANCELLED`.
 *
 * ONE TRANSACTION covers the reservation release, the outstanding capture sessions and the status
 * transition, so there is no state in which the credit has been returned while the job still reads
 * NEEDS_SCAN, or the job reads CANCELLED while its credit is still held.
 *
 * IDEMPOTENT END TO END. A job already CANCELLED returns the same answer with `changed: false` and
 * releases nothing further; the reservation's own event key makes a replayed release a replay rather
 * than a second credit. Retrying is therefore always safe and never costs or refunds anything twice.
 */
export async function cancelCardJob(input: CancelCardJobInput): Promise<CancelCardJobResult> {
  const reason = String(input.reason ?? "").trim();
  if (!reason) {
    throw new CardJobCancellationError(
      "REASON_REQUIRED",
      "A reason is required to cancel a card and return its Grading Credit."
    );
  }

  return withPartnerAdminTenantTransaction(
    { tenantId: input.tenantId, locationId: input.locationId ?? null },
    async (client) => {
      const job = await lockCardJob(client, input.tenantId, input.cardJobId);

      const reservation = await client.query<{ reservation_id: string | null }>(
        `SELECT reservation_id FROM partner_card_jobs WHERE id = $1 AND tenant_id = $2`,
        [job.id, input.tenantId]
      );
      const reservationId = reservation.rows[0]?.reservation_id ?? null;

      // ---- A retry of a cancellation that already landed ------------------------------------
      if (job.status === CARD_JOB_STATUS.CANCELLED) {
        return {
          cardJobId: job.id,
          mvNumber: job.mvNumber,
          certificateId: job.certificateId,
          status: "CANCELLED" as const,
          reservationId,
          reservationReleased: false,
          changed: false,
          cancelledCaptureSessions: 0,
        };
      }

      if (!CANCELLABLE_STATUSES.includes(job.status)) {
        throw new CardJobCancellationError(
          "JOB_NOT_CANCELLABLE",
          `A card in ${job.status} cannot be cancelled at a station. Only a card that has not been photographed yet can be.`
        );
      }

      if (input.stationId) {
        await assertStationMayCancel(client, {
          tenantId: input.tenantId,
          stationId: input.stationId,
          jobLocationId: job.locationId,
        });
      }

      await assertNothingCaptured(client, { certificateId: job.certificateId, mvNumber: job.mvNumber });

      const cancelledCaptureSessions = await cancelOutstandingCaptureSessions(
        client,
        job.certificateId,
        "Card Job cancelled before capture"
      );

      const reservationReleased = reservationId
        ? await releaseReservationOnce(client, {
            tenantId: input.tenantId,
            cardJobId: job.id,
            reservationId,
            mvNumber: job.mvNumber,
            stationId: input.stationId ?? null,
            actorUserId: input.actorUserId,
            actorEmail: input.actorEmail ?? null,
            reason,
          })
        : false;

      // Last, so the audit row it writes can state what actually happened to the money and the
      // outstanding targets. All of it rolls back together if this refuses.
      const moved = await transitionCardJob(client, {
        tenantId: input.tenantId,
        cardJobId: job.id,
        from: CANCELLABLE_STATUSES,
        to: CARD_JOB_STATUS.CANCELLED,
        idempotent: true,
        actorUserId: input.actorUserId,
        deviceId: input.stationId ?? null,
        action: "partner_card_job_cancelled",
        reason,
        audit: {
          reservationId,
          reservationReleased,
          cancelledCaptureSessions,
          stationId: input.stationId ?? null,
          // Recorded explicitly so the trail says in as many words that the number was KEPT.
          mvNumberPreserved: job.mvNumber,
        },
      });

      return {
        cardJobId: job.id,
        mvNumber: moved.job.mvNumber,
        certificateId: moved.job.certificateId,
        status: "CANCELLED" as const,
        reservationId,
        reservationReleased,
        changed: moved.changed,
        cancelledCaptureSessions,
      };
    }
  );
}

/* ==========================================================================================
 * VOIDING A CARD WHOSE CAPTURE GEOMETRY CANNOT BE RECOVERED
 * ==========================================================================================
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT `cancelCardJob`.
 *
 * `cancelCardJob` above refuses any job holding evidence, and that refusal is right: throwing away
 * a photographed card is not a station decision. But on 2026-08-17 MV272 reached a state that has
 * NO exit through normal authority:
 *
 *   - Its FRONT is real, accepted evidence, so it cannot be cancelled.
 *   - Every one of its capture sessions carries `acquisition_region = NULL`, because they were
 *     armed BEFORE migration 0091 began snapshotting the authoritative capture window. We do not
 *     know which physical rectangle that FRONT was captured under.
 *   - 0091 therefore refuses to pair it with a BACK: a card whose two sides came from two different
 *     rectangles is not one piece of evidence, and "assume the standard one" is a guess, not a fact.
 *   - And the station cannot recalibrate while the card is open, because moving the window mid-card
 *     is the very thing that would produce mismatched sides.
 *
 * Four correct refusals with no way out between them. That is not a bug in any one of them; it is a
 * missing route, and it will recur for any card caught across a geometry-authority migration.
 *
 * WHAT THIS DOES, DELIBERATELY DIFFERENTLY.
 *
 *   - It ACCEPTS a job that holds evidence. That is the entire point, so the evidence assertion is
 *     skipped rather than weakened — `assertNothingCaptured` is untouched and still guards the
 *     station path.
 *   - It is SUPER-ADMIN ONLY. No station, no operator, no partner user. The route that calls it must
 *     sit behind admin step-up; this function refuses a station id outright so a Mac cannot reach it
 *     even if a route were wired wrongly later.
 *   - It PRESERVES THE MV NUMBER, like every other terminal path here. A voided card keeps its
 *     number for ever; numbers are never reused.
 *   - It RELEASES THE RESERVATION EXACTLY ONCE, through the same `releaseReservationOnce` helper, so
 *     the shop is not charged for a card that produced nothing usable. A consumed reservation is
 *     left alone by that helper — a credit already spent is not refunded here.
 *   - It DOES NOT DELETE EVIDENCE. The FRONT master stays exactly where it is. Voiding closes the
 *     job; it does not rewrite history, and an auditor can still see what was captured and when.
 *
 * WHY A SEPARATE ACTION NAME. `partner_card_job_voided_unrecoverable_geometry` is deliberately not
 * reused from cancellation: a void is a rarer, higher-authority event with a different cause, and an
 * audit trail that cannot distinguish "operator cancelled an unphotographed card" from "an admin
 * closed a card we could not finish" is not much of an audit trail.
 */
export interface VoidCardJobInput {
  tenantId: string;
  locationId: string | null;
  cardJobId: string;
  /** The super-admin performing this. Never a station, never a partner operator. */
  actorUserId: string;
  actorEmail?: string | null;
  /** Mandatory. A void with no stated cause is indistinguishable from data loss. */
  reason: string;
}

/** Anything not already terminal. A finished or cancelled card is not a candidate for voiding. */
const VOIDABLE_STATUSES: readonly CardJobStatus[] = [
  CARD_JOB_STATUS.CREDIT_RESERVED,
  CARD_JOB_STATUS.NEEDS_SCAN,
  CARD_JOB_STATUS.CAPTURING,
  CARD_JOB_STATUS.FIX_REQUIRED,
];

export async function voidCardJobUnrecoverableGeometry(
  input: VoidCardJobInput
): Promise<CancelCardJobResult> {
  const reason = String(input.reason ?? "").trim();
  if (!reason) {
    throw new CardJobCancellationError(
      "REASON_REQUIRED",
      "A reason is required to void a card and return its Grading Credit."
    );
  }
  if ((input as { stationId?: unknown }).stationId) {
    // Belt and braces against a future route wiring a station through by accident.
    throw new CardJobCancellationError(
      "STATION_MAY_NOT_VOID",
      "Voiding a card that holds evidence is a super-admin action and can never be performed at a station."
    );
  }

  return withPartnerAdminTenantTransaction(
    { tenantId: input.tenantId, locationId: input.locationId ?? null },
    async (client) => {
      const job = await lockCardJob(client, input.tenantId, input.cardJobId);

      const reservation = await client.query<{ reservation_id: string | null }>(
        `SELECT reservation_id FROM partner_card_jobs WHERE id = $1 AND tenant_id = $2`,
        [job.id, input.tenantId]
      );
      const reservationId = reservation.rows[0]?.reservation_id ?? null;

      // A void that already landed. Same idempotent shape as cancellation.
      if (job.status === CARD_JOB_STATUS.CANCELLED) {
        return {
          cardJobId: job.id,
          mvNumber: job.mvNumber,
          certificateId: job.certificateId,
          status: "CANCELLED" as const,
          reservationId,
          reservationReleased: false,
          changed: false,
          cancelledCaptureSessions: 0,
        };
      }

      if (!VOIDABLE_STATUSES.includes(job.status)) {
        throw new CardJobCancellationError(
          "JOB_NOT_VOIDABLE",
          `A card in ${job.status} cannot be voided. This route exists for a card that cannot finish capture, not for one that already has.`
        );
      }

      // NOTE: assertNothingCaptured is deliberately NOT called. Holding evidence is the precondition
      // for this route, not a bar to it. The evidence itself is left untouched on purpose.

      const cancelledCaptureSessions = await cancelOutstandingCaptureSessions(
        client,
        job.certificateId,
        "Card Job voided — capture geometry could not be recovered"
      );

      const reservationReleased = reservationId
        ? await releaseReservationOnce(client, {
            tenantId: input.tenantId,
            cardJobId: job.id,
            reservationId,
            mvNumber: job.mvNumber,
            stationId: null,
            actorUserId: input.actorUserId,
            actorEmail: input.actorEmail ?? null,
            reason,
          })
        : false;

      const moved = await transitionCardJob(client, {
        tenantId: input.tenantId,
        cardJobId: job.id,
        from: VOIDABLE_STATUSES,
        to: CARD_JOB_STATUS.CANCELLED,
        idempotent: true,
        actorUserId: input.actorUserId,
        deviceId: null,
        action: "partner_card_job_voided_unrecoverable_geometry",
        reason,
        audit: {
          reservationId,
          reservationReleased,
          cancelledCaptureSessions,
          stationId: null,
          mvNumberPreserved: job.mvNumber,
          // Stated explicitly: this closed a card that HELD evidence, and left that evidence alone.
          evidenceRetained: true,
          voidAuthority: "super_admin",
        },
      });

      return {
        cardJobId: job.id,
        mvNumber: moved.job.mvNumber,
        certificateId: moved.job.certificateId,
        status: "CANCELLED" as const,
        reservationId,
        reservationReleased,
        changed: moved.changed,
        cancelledCaptureSessions,
      };
    }
  );
}
