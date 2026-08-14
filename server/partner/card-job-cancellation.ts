import type { StationPrincipal } from "./station-service";
import { withPartnerAdminTenantTransaction } from "./db";
import { releaseReservedCreditInTransaction } from "./partner-credit-reservation-service";
import { writePartnerAudit } from "./audit";

export class CardJobCancellationError extends Error {
  constructor(
    readonly code: "CARD_JOB_NOT_FOUND" | "CARD_JOB_HAS_ACCEPTED_EVIDENCE" | "CANCELLATION_TARGET_MISMATCH",
    message: string,
    readonly cardJobId?: string
  ) {
    super(message);
  }
}

export async function cancelCardJobBeforeEvidence(input: {
  station: StationPrincipal;
  actorUserId: string;
  cardJobId: string;
  clientOpId: string;
  captureSessionId: string;
  captureAuthorisationId: string;
}): Promise<Record<string, unknown>> {
  return withPartnerAdminTenantTransaction(
    { tenantId: input.station.tenantId, locationId: input.station.locationId },
    async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`scanner-card-cancel:${input.cardJobId}`]);
      const found = await client.query<{
        id: string;
        status: string;
        reservation_id: string | null;
        certificate_id: number | null;
        location_id: string | null;
        scanner_cancel_operation_id: string | null;
        reservation_status: string | null;
        capture_session_id: string | null;
        capture_authorisation_id: string | null;
      }>(
        `SELECT job.id,job.status,job.reservation_id,job.certificate_id,job.location_id,
                job.scanner_cancel_operation_id,r.status AS reservation_status,
                capture.id AS capture_session_id,capture.capture_authorisation_id::text
           FROM partner_card_jobs job
           LEFT JOIN partner_credit_reservations r ON r.id=job.reservation_id AND r.tenant_id=job.tenant_id
           LEFT JOIN scanner_capture_sessions capture
             ON capture.id=$4 AND capture.card_job_id=job.id AND capture.station_id=$5
          WHERE job.id=$1 AND job.tenant_id=$2 AND job.location_id=$3
          FOR UPDATE OF job`,
        [input.cardJobId, input.station.tenantId, input.station.locationId, input.captureSessionId, input.station.id]
      );
      const job = found.rows[0];
      if (!job) throw new CardJobCancellationError("CARD_JOB_NOT_FOUND", "Card Job is not available", input.cardJobId);
      if (
        job.capture_session_id !== input.captureSessionId ||
        job.capture_authorisation_id !== input.captureAuthorisationId
      ) {
        throw new CardJobCancellationError(
          "CANCELLATION_TARGET_MISMATCH",
          "Card Job cancellation target does not match its capture authorisation",
          input.cardJobId
        );
      }
      if (job.status === "CANCELLED") {
        if (job.scanner_cancel_operation_id !== input.clientOpId || job.reservation_status !== "released") {
          throw new CardJobCancellationError(
            "CANCELLATION_TARGET_MISMATCH",
            "Card Job was cancelled by a different authority",
            input.cardJobId
          );
        }
        return {
          clientOpId: input.clientOpId,
          cardJobId: input.cardJobId,
          captureSessionId: input.captureSessionId,
          status: "CANCELLED",
          acceptedEvidenceCount: 0,
          creditSpent: false,
          reservationReleased: true,
        };
      }
      const evidence = job.certificate_id == null
        ? { rows: [{ count: "0" }] }
        : await client.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM certificate_image_evidence WHERE certificate_id=$1`,
            [job.certificate_id]
          );
      const acceptedEvidenceCount = Number(evidence.rows[0]?.count || 0);
      if (acceptedEvidenceCount > 0) {
        throw new CardJobCancellationError(
          "CARD_JOB_HAS_ACCEPTED_EVIDENCE",
          "Card Job cannot be cancelled after evidence acceptance",
          input.cardJobId
        );
      }
      if (!job.reservation_id || job.reservation_status !== "active") {
        throw new CardJobCancellationError(
          "CANCELLATION_TARGET_MISMATCH",
          "Card Job does not have one releasable Grading Credit reservation",
          input.cardJobId
        );
      }
      await releaseReservedCreditInTransaction(
        client,
        { actorUserId: input.actorUserId, actorEmail: null },
        {
          tenantId: input.station.tenantId,
          reservationId: job.reservation_id,
          idempotencyKey: `scanner-cancel:${input.clientOpId}`,
          source: "portal",
          reason: "Scanner operator cancelled the Card Job before first accepted evidence.",
          actorType: "partner_user",
          externalRef: input.cardJobId,
          metadata: {
            station_id: input.station.id,
            capture_session_id: input.captureSessionId,
            capture_authorisation_id: input.captureAuthorisationId,
            semantic_operation_id: input.clientOpId,
          },
        }
      );
      const moved = await client.query(
        `UPDATE partner_card_jobs
            SET status='CANCELLED',cancelled_at=now(),
                cancelled_reason='Scanner operator cancelled before first accepted evidence',
                scanner_cancel_operation_id=$3,updated_at=now()
          WHERE id=$1 AND tenant_id=$2 AND status IN ('CREDIT_RESERVED','NEEDS_SCAN','CAPTURING')`,
        [input.cardJobId, input.station.tenantId, input.clientOpId]
      );
      if (moved.rowCount !== 1) {
        throw new CardJobCancellationError(
          "CANCELLATION_TARGET_MISMATCH",
          "Card Job lifecycle no longer permits cancellation",
          input.cardJobId
        );
      }
      await client.query(
        `UPDATE scanner_capture_sessions SET state='cancelled',failure_reason='Card Job cancelled before evidence'
          WHERE id=$1 AND card_job_id=$2 AND state IN ('armed','claimed')`,
        [input.captureSessionId, input.cardJobId]
      );
      await writePartnerAudit(client, {
        tenantId: input.station.tenantId,
        locationId: input.station.locationId,
        actorUserId: input.actorUserId,
        deviceId: input.station.id,
        action: "partner_card_job_cancelled_before_evidence",
        recordType: "partner_card_job",
        recordId: input.cardJobId,
        before: { status: job.status, reservationStatus: job.reservation_status },
        after: { status: "CANCELLED", reservationStatus: "released", acceptedEvidenceCount: 0 },
        reason: "Scanner operator cancelled before first accepted evidence.",
      });
      return {
        clientOpId: input.clientOpId,
        cardJobId: input.cardJobId,
        captureSessionId: input.captureSessionId,
        status: "CANCELLED",
        acceptedEvidenceCount: 0,
        creditSpent: false,
        reservationReleased: true,
      };
    }
  );
}
