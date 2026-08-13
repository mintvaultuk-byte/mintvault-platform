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
import { CERTIFICATE_ORIGIN_SNAPSHOT_VERSION } from "../../shared/schema";
import { writePartnerAudit } from "./audit";

export class CardJobAuthorityError extends Error {
  constructor(
    public code:
      | "INSUFFICIENT_CREDITS"
      | "STATION_NOT_ACTIVE"
      | "ORGANISATION_NOT_ACTIVE"
      | "EMERGENCY_STOP"
      | "IDEMPOTENCY_CONFLICT"
      | "CARD_UNIT_INVALID"
      | "IDENTITY_UNAVAILABLE",
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
 * Suspension, emergency stop and station status — the checks that OVERRIDE remaining balance
 * (locked rule 11), evaluated BEFORE the wallet is touched by either entry point.
 *
 * Shared deliberately. Two copies of this block is how a station path quietly ends up enforcing
 * less than the portal path, and the difference would only ever show up as a suspended shop that
 * could still spend.
 */
async function assertStartAllowed(
  client: PoolClient,
  input: { tenantId: string; locationId: string | null; stationId: string }
): Promise<void> {
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
      await assertStartAllowed(client, {
        tenantId: input.tenantId,
        locationId: input.locationId ?? null,
        stationId: input.stationId,
      });

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

/* =================================================================================================
 * P6 — STATION-INITIATED NEW ("NEW CARD" at the counter)
 *
 * WHY A SECOND ENTRY POINT RATHER THAN A SECOND AUTHORITY. startNewCardJob above takes an EXISTING
 * submission card, because the portal path has one: a shop builds a submission, adds cards, submits.
 * An operator pressing NEW CARD at the counter has none of that. What differs is only how the paid
 * UNIT comes into existence — every rule about paying for it is identical, so the guards, the
 * reservation engine, the idempotency contract and the op-key table are all shared, and only the
 * unit-creation step is new.
 *
 * WHY THE MV IS MINTED HERE. Master plan §9 step 5 puts MV allocation inside the NEW-card
 * transaction; P4 deferred it (`mvNumber: null`, "NULL until the connector allocates"). For the
 * portal path deferring is right — the connector allocates on import. For a station it is not
 * merely a display gap, it is a hard block, in three places:
 *
 *   1. `scanner_capture_sessions.certificate_id` is NOT NULL with an FK to certificates. No
 *      certificate means no capture session can be armed at all.
 *   2. `partner_card_jobs` refuses the transition to READY_TO_GRADE while certificate_id IS NULL.
 *   3. The Scanner is specified to show "MV421 COMPLETE" once both sides are accepted.
 *
 * Minting here needs NO schema change to the capture table, and reuses the existing row-locked
 * `cert_counter` allocator — which is gapless on rollback precisely because it is a locked row and
 * not a sequence, so a failed NEW returns the number rather than burning it.
 *
 * WHY ONE SUBMISSION PER CARD. `partner_submission_cards.sequence_number` is unique per submission,
 * so a shared walk-in submission would put every station in the shop in a write race for the next
 * sequence number on one row — contention bought for nothing. One submission per NEW card also
 * keeps `card_count` trivially equal to the number of cards, which is the arithmetic the connector
 * validates, and means two stations pressing NEW simultaneously contend only where they genuinely
 * must: the wallet.
 *
 * OWNER DECISION RECORDED (OD-7): a walk-in card has no customer. The connector's validation gate
 * treats `customer_missing` as BLOCKING, so these Scanner-originated submissions are not eligible
 * for connector import and must not be swept into it — they are already complete (MV allocated,
 * credit reserved) and have nothing left for the importer to do.
 * ============================================================================================== */

export interface StartNewCardJobAtStationInput {
  tenantId: string;
  /** Required for a station start: a walk-in card is always taken at a specific shop location. */
  locationId: string;
  stationId: string;
  clientOpId: string;
  actorUserId: string;
  actorEmail: string;
  /** Optional operator label. Identity is confirmed later at grading; this is only a handle. */
  cardName?: string | null;
}

export interface StartNewCardJobAtStationResult extends StartNewCardJobResult {
  /** Always non-null on this path — the station cannot capture without it. */
  mvNumber: string;
  certificateId: number;
  submissionId: string;
  cardId: string;
  /** The sides the station is authorised to capture for this job. */
  sides: ReadonlyArray<"front" | "back">;
}

/** Placeholder used when the operator names nothing. Identity is confirmed at grading, not intake. */
const WALK_IN_CARD_NAME = "Unidentified card";

/**
 * Fingerprint for a station start. Deliberately does NOT include the submission or card ids: on this
 * path those are CREATED by the operation, so including them would make every retry a mismatch
 * against its own original and turn an ordinary double-click into IDEMPOTENCY_CONFLICT.
 */
function stationFingerprintOf(input: StartNewCardJobAtStationInput): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        mode: "station-walk-in",
        t: input.tenantId,
        l: input.locationId,
        s: input.stationId,
        o: input.clientOpId,
      })
    )
    .digest("hex");
}

/**
 * Allocate the next MV number and its certificate, inside the caller's transaction.
 *
 * The counter is a LOCKED ROW, not a sequence: `UPDATE ... RETURNING` holds the row for the rest of
 * the transaction, so concurrent starts serialise here and a rollback returns the number instead of
 * burning it. That is what makes MV numbers gapless (locked rule 10), and it is why this must not be
 * "optimised" into a sequence or a read-then-write.
 */
async function mintPartnerCertificate(
  client: PoolClient,
  input: { tenantId: string; locationId: string; actorEmail: string }
): Promise<{ certificateId: number; mvNumber: string }> {
  const present = await client.query<{ certs: boolean; counter: boolean }>(
    `SELECT to_regclass('public.certificates') IS NOT NULL AS certs,
            to_regclass('public.cert_counter')  IS NOT NULL AS counter`
  );
  if (!present.rows[0]?.certs || !present.rows[0]?.counter) {
    // Fail loudly rather than handing back a job with no identity. A station that received a Card
    // Job it can never capture against is worse than a refusal it can act on (invariant I18).
    throw new CardJobAuthorityError(
      "IDENTITY_UNAVAILABLE",
      "Certificate identity is unavailable on this deployment. New cards cannot be started."
    );
  }

  // The origin snapshot is frozen at issue and never rewritten by a later rename or move
  // (locked rule 8), so it is read here, in this transaction, from the live records.
  /*
   * The trading name lives on partner_profiles (migration 0015), NOT on partner_organisations, and
   * it is nullable — which is exactly why 0035 documents legal_name as the fallback. Read both and
   * let the caller decide, so a partner with no profile row still gets a certificate that can say
   * who graded the card.
   *
   * LEFT JOIN via to_regclass because partner_profiles arrives later than the foundation migration
   * and is absent from some partner-only databases; a missing profile must degrade to "no trading
   * name", never to a failed NEW.
   */
  const profilesPresent = await client.query<{ present: boolean }>(
    `SELECT to_regclass('public.partner_profiles') IS NOT NULL AS present`
  );
  const org = profilesPresent.rows[0]?.present
    ? await client.query<{ public_ref: string | null; legal_name: string | null; trading_name: string | null }>(
        `SELECT o.public_ref, o.legal_name, p.trading_name
           FROM partner_organisations o
           LEFT JOIN partner_profiles p ON p.tenant_id = o.id
          WHERE o.id=$1`,
        [input.tenantId]
      )
    : await client.query<{ public_ref: string | null; legal_name: string | null; trading_name: string | null }>(
        `SELECT public_ref, legal_name, NULL::text AS trading_name FROM partner_organisations WHERE id=$1`,
        [input.tenantId]
      );
  const loc = await client.query<{ public_ref: string | null; name: string | null; address: string | null }>(
    `SELECT public_ref, name, address FROM partner_locations WHERE id=$1 AND tenant_id=$2`,
    [input.locationId, input.tenantId]
  );
  const organisation = org.rows[0];
  const location = loc.rows[0];
  const tradingName = organisation?.trading_name?.trim() || null;
  const legalName = organisation?.legal_name?.trim() || null;
  if (!tradingName && !legalName) {
    // chk_certificates_origin_partner_complete would reject this anyway; refusing here gives the
    // operator a cause they can act on instead of a constraint violation.
    throw new CardJobAuthorityError(
      "IDENTITY_UNAVAILABLE",
      "This partner has no trading or legal name recorded, so a certificate origin cannot be stamped."
    );
  }

  const counter = await client.query<{ last_issued: string }>(
    `UPDATE cert_counter SET last_issued = last_issued + 1, updated_at = NOW()
      WHERE id = 1 RETURNING last_issued`
  );
  if (counter.rowCount !== 1) {
    throw new CardJobAuthorityError(
      "IDENTITY_UNAVAILABLE",
      "The certificate number allocator is not initialised on this deployment."
    );
  }
  const mvNumber = `MV${counter.rows[0].last_issued}`;

  const cert = await client.query<{ id: number }>(
    `INSERT INTO certificates
       (certificate_number, status, label_type, grade_type, source, scan_status, raw_uploaded,
        created_by, issued_at, updated_at,
        origin_type, origin_partner_id, origin_partner_public_ref, origin_partner_legal_name,
        origin_partner_trading_name, origin_location_id, origin_location_public_ref,
        origin_location_name, origin_location_address, origin_captured_at, origin_snapshot_version)
     VALUES ($1,'active','Standard','numeric','partner_station','pending',false,
             $2, NOW(), NOW(),
             'PARTNER', $3, $4, $5, $6, $7, $8, $9, $10, NOW(), $11)
     RETURNING id`,
    [
      mvNumber,
      input.actorEmail,
      input.tenantId,
      organisation?.public_ref ?? null,
      legalName,
      tradingName,
      input.locationId,
      location?.public_ref ?? null,
      location?.name ?? null,
      location?.address ?? null,
      CERTIFICATE_ORIGIN_SNAPSHOT_VERSION,
    ]
  );

  return { certificateId: cert.rows[0].id, mvNumber };
}

/**
 * Start (or replay) a NEW Card Job from an approved station — the "NEW CARD" press.
 *
 * ONE TRANSACTION covers: the walk-in submission, its card, the MV and certificate, the credit
 * reservation, the Card Job and the operation record. Any failure rolls back all of it, so there is
 * no state in which a shop has been charged for a card that does not exist, or holds an MV number
 * attached to nothing.
 *
 * The replay check runs FIRST, before any of it — so a double-click, a dropped response or an app
 * restart mid-request returns the SAME job, the SAME MV and the same lineage, having spent nothing
 * further and created no orphan submission.
 */
export async function startNewCardJobAtStation(
  input: StartNewCardJobAtStationInput
): Promise<StartNewCardJobAtStationResult> {
  if (typeof input.clientOpId !== "string" || input.clientOpId.length < 8 || input.clientOpId.length > 200) {
    throw new CardJobAuthorityError("CARD_UNIT_INVALID", "A client operation id of 8-200 characters is required.");
  }
  if (!input.locationId) {
    throw new CardJobAuthorityError("CARD_UNIT_INVALID", "A station start requires the station's location.");
  }

  const fingerprint = stationFingerprintOf(input);
  const cardName = (input.cardName ?? "").trim() || WALK_IN_CARD_NAME;

  return withPartnerAdminTenantTransaction(
    { tenantId: input.tenantId, locationId: input.locationId },
    async (client) => {
      // ---- 1. REPLAY, answered before anything is created or spent -------------------------------
      const existing = await loadExistingOperation(client, input.stationId, input.clientOpId);
      if (existing) {
        if (existing.request_fingerprint !== fingerprint) {
          throw new CardJobAuthorityError(
            "IDEMPOTENCY_CONFLICT",
            "This client operation id was already used for a different NEW request."
          );
        }
        const job = await client.query<{
          id: string;
          reservation_id: string | null;
          mv_number: string | null;
          certificate_id: number | null;
          status: string;
          submission_id: string;
          card_id: string;
        }>(
          `SELECT id, reservation_id, mv_number, certificate_id, status, submission_id, card_id
           FROM partner_card_jobs WHERE id=$1 AND tenant_id=$2`,
          [existing.card_job_id, input.tenantId]
        );
        const row = job.rows[0];
        if (!row || row.mv_number === null || row.certificate_id === null) {
          throw new CardJobAuthorityError(
            "CARD_UNIT_INVALID",
            "Recorded operation references a Card Job that is not visible or has no identity."
          );
        }
        return {
          cardJobId: row.id,
          reservationId: existing.reservation_id ?? row.reservation_id ?? "",
          mvNumber: row.mv_number,
          certificateId: row.certificate_id,
          status: row.status,
          submissionId: row.submission_id,
          cardId: row.card_id,
          sides: ["front", "back"] as const,
          replayed: true,
        };
      }

      // ---- 2. The same overrides the portal path enforces (locked rule 11) -----------------------
      await assertStartAllowed(client, {
        tenantId: input.tenantId,
        locationId: input.locationId,
        stationId: input.stationId,
      });

      // ---- 3. The walk-in card unit -------------------------------------------------------------
      // No customer and no service tier: this is a card handed over the counter (OD-7). Both columns
      // are nullable by design; what makes them mandatory is the connector's validation gate, which
      // this path deliberately does not enter.
      const submission = await client.query<{ id: string }>(
        `INSERT INTO partner_submissions (tenant_id, location_id, created_by, card_count, status, intake_notes)
       VALUES ($1,$2,$3,1,'draft',$4)
       RETURNING id`,
        [input.tenantId, input.locationId, input.actorUserId, "Walk-in card started at a grading station."]
      );
      const submissionId = submission.rows[0].id;

      const card = await client.query<{ id: string }>(
        `INSERT INTO partner_submission_cards (tenant_id, submission_id, sequence_number, card_name, quantity)
       VALUES ($1,$2,1,$3,1)
       RETURNING id`,
        [input.tenantId, submissionId, cardName]
      );
      const cardId = card.rows[0].id;
      const ordinal = 1;

      // ---- 4. Permanent identity, in the same transaction that pays for it -----------------------
      const identity = await mintPartnerCertificate(client, {
        tenantId: input.tenantId,
        locationId: input.locationId,
        actorEmail: input.actorEmail,
      });

      // ---- 5. Exactly one Grading Credit, through the CANONICAL engine ---------------------------
      const cardReference = cardReferenceOf(cardId, ordinal);
      let reservation;
      try {
        reservation = await reserveCreditInTransaction(
          client,
          { actorUserId: input.actorUserId, actorEmail: input.actorEmail },
          {
            tenantId: input.tenantId,
            locationId: input.locationId,
            cardReference,
            submissionReference: submissionId,
            expiresAt: new Date(Date.now() + CARD_JOB_CREDIT_TTL_MS),
            idempotencyKey: `partner-card-job-new:${cardId}:${ordinal}`,
            source: "portal",
            reason: "Reserved one Grading Credit for a NEW Card Job started at a station.",
            actorType: "partner_user",
            externalRef: null,
            metadata: {
              partner_submission_id: submissionId,
              partner_submission_card_id: cardId,
              card_ordinal: ordinal,
              station_id: input.stationId,
              client_op_id: input.clientOpId,
              mv_number: identity.mvNumber,
              walk_in: true,
            },
          }
        );
      } catch (err) {
        if ((err as { code?: string })?.code === "INSUFFICIENT_CREDITS") {
          throw new CardJobAuthorityError(
            "INSUFFICIENT_CREDITS",
            "No Grading Credits are available. Buy more credits to start a new card."
          );
        }
        throw err;
      }

      // ---- 6. The Card Job, stamped with its identity at INSERT ----------------------------------
      // Stamped on INSERT rather than a later UPDATE: the immutability trigger is BEFORE UPDATE, and
      // the only role granted UPDATE on (certificate_id, mv_number) is the connector's definer. A job
      // is therefore born complete, and chk_partner_card_jobs_mv_pairing is satisfied from the start.
      const job = await client.query<{ id: string; status: string }>(
        `INSERT INTO partner_card_jobs
         (tenant_id, submission_id, card_id, ordinal, card_reference, reservation_id,
          certificate_id, mv_number, location_id, created_by, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'NEEDS_SCAN')
       RETURNING id, status`,
        [
          input.tenantId,
          submissionId,
          cardId,
          ordinal,
          cardReference,
          reservation.reservation.id,
          identity.certificateId,
          identity.mvNumber,
          input.locationId,
          input.actorUserId,
        ]
      );

      // ---- 7. Record the operation, making every future retry a replay ---------------------------
      // A UNIQUE violation here means a concurrent request for the SAME (station, client_op_id) won.
      // That is correct: this transaction rolls back — submission, card, MV, credit and job with it —
      // and the caller retries into the replay branch above.
      await client.query(
        `INSERT INTO partner_card_job_op_keys
         (tenant_id, station_id, client_op_id, card_job_id, reservation_id, request_fingerprint)
       VALUES ($1,$2,$3,$4,$5,$6)`,
        [input.tenantId, input.stationId, input.clientOpId, job.rows[0].id, reservation.reservation.id, fingerprint]
      );

      /*
       * AUDIT — the locked requirement is that a NEW must answer, later and without guesswork:
       * WHO did it, AT WHICH SHOP, AT WHICH LOCATION, ON WHICH MAC, TO WHICH CARD/MV, WHEN.
       *
       * `partner_card_jobs` carries the operator (`created_by`) and the location but NOT the
       * station, so without this row the Mac was recoverable only by joining
       * partner_card_job_op_keys or reading ledger metadata JSON — a forensic reconstruction, not
       * an audit trail. The FIX path already writes one; NEW spends money and mints permanent
       * identity, so it has a stronger claim to one, not a weaker one.
       *
       * `device_id` carries the station id, matching the convention the FIX path established.
       */
      await writePartnerAudit(client, {
        tenantId: input.tenantId,
        locationId: input.locationId,
        actorUserId: input.actorUserId,
        deviceId: input.stationId,
        action: "partner_card_job_started",
        recordType: "partner_card_job",
        recordId: job.rows[0].id,
        after: {
          mvNumber: identity.mvNumber,
          certificateId: identity.certificateId,
          cardId,
          submissionId,
          reservationId: reservation.reservation.id,
          status: job.rows[0].status,
          walkIn: true,
        },
        reason: "NEW card started at a station. One Grading Credit reserved.",
      });

      return {
        cardJobId: job.rows[0].id,
        reservationId: reservation.reservation.id,
        mvNumber: identity.mvNumber,
        certificateId: identity.certificateId,
        status: job.rows[0].status,
        submissionId,
        cardId,
        sides: ["front", "back"] as const,
        replayed: false,
      };
    }
  );
}
