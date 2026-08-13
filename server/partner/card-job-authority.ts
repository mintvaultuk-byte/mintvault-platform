/**
 * P4 — GRADING CREDIT AUTHORITY for starting a NEW Card Job.
 *
 * THE ONE RULE THIS FILE OWNS: one usable Grading Credit authorises exactly one NEW Card Job.
 *
 * WHAT THIS IS NOT. It is not a second wallet, not a second balance model and not a new availability
 * formula. Availability is and remains `partner_credit_availability.available_balance`
 * (= SUM(ledger.amount) − SUM(active reservations)), computed by the existing engine; this module
 * never computes it, never caches it and never writes a balance. Every credit movement here goes
 * through `reserveCreditInTransaction`, the canonical 0016/0017 + 0041-0043 engine, unchanged.
 *
 * WHAT IT ADDS. The one thing genuinely missing: a client-supplied idempotency contract for an
 * operation the server cannot derive a key for.
 *
 * The portal's reservations are keyed `partner-submission-credit:<submissionId>:<cardId>:<ordinal>` —
 * deterministic, because the server already knows the submission. A Scanner station pressing NEW has
 * no submission yet, so there is nothing server-side to derive a key from, and the operation being
 * retried is "start a new card". A dropped response, a double-click, a lost ack and an app restart
 * mid-request are indistinguishable to the server; without a client operation id every one of them
 * would reserve ANOTHER credit and mint ANOTHER Card Job. `(station_id, client_op_id)` closes that,
 * and lives in PostgreSQL (migration 0082) because a retry can land on either Fly Machine and a
 * rolling deploy discards process memory (invariant I19).
 *
 * ORDER OF CHECKS IS DELIBERATE. Suspension and emergency stop are evaluated BEFORE the wallet is
 * touched, so a frozen partner is refused even with credits available (locked rule 11), and a replay
 * is answered BEFORE any credit is reserved, so a retry can never spend.
 */
import type { PoolClient } from "pg";
import crypto from "node:crypto";
import { withPartnerAdminTenantTransaction } from "./db";
import { reserveCreditInTransaction } from "./partner-credit-reservation-service";
import { readEmergencyState, isHardStopped } from "./emergency";

export class CardJobAuthorityError extends Error {
  constructor(
    public code:
      | "INSUFFICIENT_CREDITS"
      | "STATION_NOT_ACTIVE"
      | "ORGANISATION_NOT_ACTIVE"
      | "EMERGENCY_STOP"
      | "IDEMPOTENCY_CONFLICT"
      | "CARD_UNIT_INVALID",
    message: string
  ) {
    super(message);
  }
}

export interface StartNewCardJobInput {
  tenantId: string;
  locationId: string | null;
  /** Authenticated station. Never taken from a request body. */
  stationId: string;
  /** Opaque, station-generated, stable across that station's retries of ONE NEW press. */
  clientOpId: string;
  /** The paid unit: an existing submission card plus its ordinal (see migration 0080). */
  submissionId: string;
  cardId: string;
  ordinal: number;
  actorUserId: string;
  actorEmail: string;
}

export interface StartNewCardJobResult {
  cardJobId: string;
  reservationId: string;
  /** NULL until the connector allocates — a NEW job legitimately has no identity yet. */
  mvNumber: string | null;
  certificateId: number | null;
  status: string;
  /** True when this call replayed an earlier operation rather than performing a new one. */
  replayed: boolean;
}

/** Kept in step with the portal path so both entry points expire identically. */
const CARD_JOB_CREDIT_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Canonical request fingerprint. A replay carrying the same op id but different parameters is a
 * client bug or an attack, not a retry — returning the original job would hand the caller something
 * it did not ask for. Same discipline the credit engine already applies to its own keys.
 */
function fingerprintOf(input: StartNewCardJobInput): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        t: input.tenantId,
        s: input.stationId,
        o: input.clientOpId,
        sub: input.submissionId,
        c: input.cardId,
        n: input.ordinal,
      })
    )
    .digest("hex");
}

/** The reservation's card reference — byte-identical to the portal convention (migration 0080). */
function cardReferenceOf(cardId: string, ordinal: number): string {
  return `partner-submission-card:${cardId}:${ordinal}`;
}

async function loadExistingOperation(
  client: PoolClient,
  stationId: string,
  clientOpId: string
): Promise<{ card_job_id: string; reservation_id: string | null; request_fingerprint: string } | null> {
  const { rows } = await client.query<{
    card_job_id: string;
    reservation_id: string | null;
    request_fingerprint: string;
  }>(
    `SELECT card_job_id, reservation_id, request_fingerprint
       FROM partner_card_job_op_keys
      WHERE station_id=$1 AND client_op_id=$2`,
    [stationId, clientOpId]
  );
  return rows[0] ?? null;
}

async function loadJob(client: PoolClient, tenantId: string, cardJobId: string) {
  const { rows } = await client.query<{
    id: string;
    reservation_id: string | null;
    mv_number: string | null;
    certificate_id: number | null;
    status: string;
  }>(
    `SELECT id, reservation_id, mv_number, certificate_id, status
       FROM partner_card_jobs WHERE id=$1 AND tenant_id=$2`,
    [cardJobId, tenantId]
  );
  return rows[0] ?? null;
}

/**
 * Start (or replay) a NEW Card Job.
 *
 * ATOMICITY: the reservation, the Card Job and the operation record are written in ONE transaction,
 * so no combination of them can survive a failure — no orphan credit, no unfunded job, no operation
 * record pointing at a job that was rolled back.
 *
 * LAST-CREDIT RACE: `reserveCreditInTransaction` takes `SELECT ... FROM partner_wallets ... FOR
 * UPDATE` before reading availability, so two concurrent starts on a wallet with one credit are
 * serialised by PostgreSQL: the first commits, the second's availability read then sees 0 and raises
 * INSUFFICIENT_CREDITS. That protection is the existing engine's, not new here, and this function is
 * careful not to step outside it — availability is never read or cached in application code.
 */
export async function startNewCardJob(input: StartNewCardJobInput): Promise<StartNewCardJobResult> {
  if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 1) {
    throw new CardJobAuthorityError("CARD_UNIT_INVALID", "A card unit ordinal must be a positive integer.");
  }
  if (typeof input.clientOpId !== "string" || input.clientOpId.length < 8 || input.clientOpId.length > 200) {
    throw new CardJobAuthorityError("CARD_UNIT_INVALID", "A client operation id of 8-200 characters is required.");
  }

  const fingerprint = fingerprintOf(input);

  return withPartnerAdminTenantTransaction(
    { tenantId: input.tenantId, locationId: input.locationId ?? null },
    async (client) => {
      // ---- 1. REPLAY, answered before anything is spent ------------------------------------
      const existing = await loadExistingOperation(client, input.stationId, input.clientOpId);
      if (existing) {
        if (existing.request_fingerprint !== fingerprint) {
          throw new CardJobAuthorityError(
            "IDEMPOTENCY_CONFLICT",
            "This client operation id was already used for a different NEW request."
          );
        }
        const job = await loadJob(client, input.tenantId, existing.card_job_id);
        if (!job) {
          // The composite FK makes this unreachable; if it ever happens the invariant is broken and
          // must be surfaced, never papered over by starting a fresh job (which would double-spend).
          throw new CardJobAuthorityError(
            "CARD_UNIT_INVALID",
            "Recorded operation references a Card Job that is not visible in this tenant."
          );
        }
        return {
          cardJobId: job.id,
          reservationId: existing.reservation_id ?? job.reservation_id ?? "",
          mvNumber: job.mv_number,
          certificateId: job.certificate_id,
          status: job.status,
          replayed: true,
        };
      }

      // ---- 2. Suspension / emergency stop OVERRIDE remaining credits (locked rule 11) -------
      const org = await client.query<{ status: string }>(`SELECT status FROM partner_organisations WHERE id=$1`, [
        input.tenantId,
      ]);
      if (org.rows[0]?.status !== "ACTIVE") {
        throw new CardJobAuthorityError(
          "ORGANISATION_NOT_ACTIVE",
          "This organisation cannot start new cards while it is not active."
        );
      }

      const emergency = await readEmergencyState(client, {
        tenantId: input.tenantId,
        locationId: input.locationId ?? null,
      });
      if (isHardStopped(emergency)) {
        throw new CardJobAuthorityError(
          "EMERGENCY_STOP",
          "New cards are stopped for this partner. Grading, FIX and QA of existing cards are unaffected."
        );
      }

      /*
       * The station must be ACTIVE. Guarded by to_regclass because partner_stations arrives in
       * migration 0045 and is absent from some partner-only databases; where the table does not
       * exist there is no station lifecycle to enforce and the authenticated-station check upstream
       * is the control. Where it DOES exist the check is mandatory.
       */
      const stationsPresent = await client.query<{ present: boolean }>(
        `SELECT to_regclass('public.partner_stations') IS NOT NULL AS present`
      );
      if (stationsPresent.rows[0]?.present) {
        const station = await client.query<{ status: string }>(
          `SELECT status FROM partner_stations WHERE id=$1 AND tenant_id=$2`,
          [input.stationId, input.tenantId]
        );
        if (station.rows[0]?.status !== "ACTIVE") {
          throw new CardJobAuthorityError("STATION_NOT_ACTIVE", "This station is not approved to start new cards.");
        }
      }

      // ---- 3. Reserve exactly one Grading Credit through the CANONICAL engine ---------------
      // Not reimplemented here: the wallet row lock, the availability formula, the ledger discipline
      // and the exactly-once semantics all remain the engine's.
      const cardReference = cardReferenceOf(input.cardId, input.ordinal);
      let reservation;
      try {
        reservation = await reserveCreditInTransaction(
          client,
          { actorUserId: input.actorUserId, actorEmail: input.actorEmail },
          {
            tenantId: input.tenantId,
            locationId: input.locationId ?? null,
            cardReference,
            submissionReference: input.submissionId,
            expiresAt: new Date(Date.now() + CARD_JOB_CREDIT_TTL_MS),
            // Server-derived and deterministic, so the engine's own idempotency still holds even if
            // this function were somehow entered twice for the same unit.
            idempotencyKey: `partner-card-job-new:${input.cardId}:${input.ordinal}`,
            source: "portal",
            reason: "Reserved one Grading Credit for a NEW Card Job started at a station.",
            actorType: "partner_user",
            externalRef: null,
            metadata: {
              partner_submission_id: input.submissionId,
              partner_submission_card_id: input.cardId,
              card_ordinal: input.ordinal,
              station_id: input.stationId,
              client_op_id: input.clientOpId,
            },
          }
        );
      } catch (err) {
        // Surface the engine's own refusal verbatim in code terms — a wallet at zero must reject NEW
        // server-side regardless of what any UI believes.
        if ((err as { code?: string })?.code === "INSUFFICIENT_CREDITS") {
          throw new CardJobAuthorityError(
            "INSUFFICIENT_CREDITS",
            "No Grading Credits are available. Buy more credits to start a new card."
          );
        }
        throw err;
      }

      // ---- 4. The Card Job, in the same transaction as the credit that pays for it ----------
      const job = await client.query<{ id: string; status: string }>(
        `INSERT INTO partner_card_jobs
           (tenant_id, submission_id, card_id, ordinal, card_reference, reservation_id,
            location_id, created_by, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'CREDIT_RESERVED')
         ON CONFLICT (card_id, ordinal) DO NOTHING
         RETURNING id, status`,
        [
          input.tenantId,
          input.submissionId,
          input.cardId,
          input.ordinal,
          cardReference,
          reservation.reservation.id,
          input.locationId ?? null,
          input.actorUserId,
        ]
      );

      let cardJobId: string;
      let status: string;
      if (job.rowCount === 0) {
        // The unit already had a job — e.g. the portal created it. Adopt it rather than failing, but
        // only after proving it is funded by the SAME reservation; anything else would mean one card
        // unit associated with two paid credits.
        const adopted = await client.query<{ id: string; reservation_id: string | null; status: string }>(
          `SELECT id, reservation_id, status FROM partner_card_jobs
            WHERE card_id=$1 AND ordinal=$2 AND tenant_id=$3`,
          [input.cardId, input.ordinal, input.tenantId]
        );
        const row = adopted.rows[0];
        if (!row || row.reservation_id !== reservation.reservation.id) {
          throw new CardJobAuthorityError(
            "IDEMPOTENCY_CONFLICT",
            "This card unit is already funded by a different Grading Credit reservation."
          );
        }
        cardJobId = row.id;
        status = row.status;
      } else {
        cardJobId = job.rows[0].id;
        status = job.rows[0].status;
      }

      // ---- 5. Record the operation, making every future retry a replay ----------------------
      // A UNIQUE violation here means a concurrent request for the SAME (station, client_op_id) won
      // the race. That is a correct outcome, not an error: this transaction rolls back — releasing
      // its reservation and job with it — and the caller retries into the replay branch above.
      await client.query(
        `INSERT INTO partner_card_job_op_keys
           (tenant_id, station_id, client_op_id, card_job_id, reservation_id, request_fingerprint)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [input.tenantId, input.stationId, input.clientOpId, cardJobId, reservation.reservation.id, fingerprint]
      );

      return {
        cardJobId,
        reservationId: reservation.reservation.id,
        mvNumber: null,
        certificateId: null,
        status,
        replayed: false,
      };
    }
  );
}
