/**
 * P7 — SCANNER FIX: repairing a side of an EXISTING, ALREADY PAID Card Job.
 *
 * THE ONE RULE THIS FILE OWNS: a FIX costs ZERO Grading Credits and mints nothing. Same Card Job,
 * same MV, same certificate, same reservation. It replaces an image and nothing else.
 *
 * WHY THIS IS NOT `/api/admin/orphan-certs`. The Scanner's "Fix missing images" button has been dead
 * in production since station requests began to be signed: `station-request-scope.ts` refuses a
 * signed station on that route, and deliberately so. `/api/admin/orphan-certs` addresses
 * `certificates` by number with NO tenant predicate — its only principals were ever an admin cookie
 * or the HQ scanner token. Admitting a partner station would hand every approved shop cross-tenant
 * reads, evidence overwrites, presigned-URL disclosure and soft-deletes across the entire
 * certificate estate. The 403 is not the bug; the missing tenant-scoped route is. So this module is
 * that route, and the admin one is left exactly as strict as it is.
 *
 * THE ASYMMETRY THAT MAKES FIX SAFE. NEW must be expensive and rare — it creates identity and spends
 * money, so it is guarded by the wallet. FIX must be cheap and always available — a shop with a bad
 * scan and an empty wallet still has a paid card sitting on the counter, and refusing to let them
 * finish it would be punishing them for a defect in our own image capture. The wallet is therefore
 * never consulted here, and there is no code path in this file that can reach it.
 *
 * WHY IT CANNOT BECOME A FREE NEW CARD. Every operation is keyed on an EXISTING `partner_card_jobs`
 * row that already has an MV, already has a reservation, and belongs to the caller's tenant. There
 * is no create path, no allocator call and no wallet import. The only sides that can be authorised
 * are ones that a deliberate, audited invalidation has already emptied.
 */
import type { PoolClient } from "pg";
import { withPartnerAdminTenantTransaction } from "./db";
import { writePartnerAudit } from "./audit";

export class FixAuthorityError extends Error {
  constructor(
    public code:
      | "CARD_JOB_NOT_FOUND"
      | "SIDE_INVALID"
      | "SIDE_NOT_INVALIDATED"
      | "SIDE_ALREADY_MISSING"
      | "ORGANISATION_NOT_ACTIVE"
      | "STATION_NOT_ACTIVE"
      | "JOB_NOT_FIXABLE",
    message: string
  ) {
    super(message);
  }
}

export type FixSide = "front" | "back";

const SIDES: readonly FixSide[] = ["front", "back"];

function cleanSide(value: unknown): FixSide {
  if (value === "front" || value === "back") return value;
  throw new FixAuthorityError("SIDE_INVALID", "A capture side must be front or back.");
}

/**
 * Card Job states from which a side may be repaired.
 *
 * Deliberately excludes the terminal and post-approval states. Once a card is APPROVED, PRINTABLE or
 * COMPLETED its images are part of a published record, and changing one is a CORRECTION with its own
 * versioned history — not a quiet image swap. Migration 0080's transition trigger enforces the same
 * boundary; this list exists so the operator gets a reason rather than a constraint violation.
 */
const FIXABLE_STATUSES = new Set(["NEEDS_SCAN", "CAPTURING", "FIX_REQUIRED", "READY_TO_GRADE", "GRADING"]);

export interface FixQueueEntry {
  cardJobId: string;
  mvNumber: string;
  certificateId: number;
  status: string;
  cardName: string | null;
  /** Exactly the sides this card is missing. Server-derived; never a client filter. */
  missingSides: FixSide[];
  /** Rendered label, e.g. "FRONT + BACK MISSING". */
  missingLabel: string;
  locationId: string | null;
  updatedAt: string;
}

function missingLabelOf(sides: FixSide[]): string {
  if (sides.length === 2) return "FRONT + BACK MISSING";
  if (sides[0] === "front") return "FRONT MISSING";
  return "BACK MISSING";
}

/**
 * The FIX queue, derived entirely on the server from THIS tenant's own Card Jobs.
 *
 * TENANT SCOPING IS THE WHOLE POINT. The predicate is `job.tenant_id = $1`, applied in SQL, inside a
 * tenant transaction. There is no parameter by which a caller can widen it, and knowing another
 * partner's MV number grants nothing — it simply will not appear in their own queue. This is why the
 * normal FIX flow never asks anybody to type an MV number: typing one is what creates the
 * opportunity to type someone else's.
 *
 * A card appears here when it has an allocated identity and at least one side with no CURRENT
 * evidence row — which is exactly the state a deliberate invalidation leaves behind.
 */
export async function listFixQueue(input: { tenantId: string; locationId?: string | null }): Promise<FixQueueEntry[]> {
  return withPartnerAdminTenantTransaction(
    { tenantId: input.tenantId, locationId: input.locationId ?? null },
    async (client) => {
      const { rows } = await client.query<{
        card_job_id: string;
        mv_number: string;
        certificate_id: number;
        status: string;
        card_name: string | null;
        location_id: string | null;
        updated_at: string;
        has_front: boolean;
        has_back: boolean;
      }>(
        `SELECT job.id            AS card_job_id,
                job.mv_number     AS mv_number,
                job.certificate_id,
                job.status,
                card.card_name,
                job.location_id,
                job.updated_at,
                EXISTS (SELECT 1 FROM certificate_image_evidence e
                         WHERE e.certificate_id = job.certificate_id
                           AND e.side = 'front' AND e.is_current) AS has_front,
                EXISTS (SELECT 1 FROM certificate_image_evidence e
                         WHERE e.certificate_id = job.certificate_id
                           AND e.side = 'back'  AND e.is_current) AS has_back
           FROM partner_card_jobs job
           LEFT JOIN partner_submission_cards card
             ON card.id = job.card_id AND card.tenant_id = job.tenant_id
          WHERE job.tenant_id = $1
            AND job.certificate_id IS NOT NULL
            AND job.mv_number IS NOT NULL
            AND job.status = ANY($2::text[])
            AND job.cancelled_at IS NULL
          ORDER BY job.updated_at DESC
          LIMIT 500`,
        [input.tenantId, [...FIXABLE_STATUSES]]
      );

      return rows
        .map((row) => {
          const missingSides: FixSide[] = [];
          if (!row.has_front) missingSides.push("front");
          if (!row.has_back) missingSides.push("back");
          return { row, missingSides };
        })
        .filter(({ missingSides }) => missingSides.length > 0)
        .map(({ row, missingSides }) => ({
          cardJobId: row.card_job_id,
          mvNumber: row.mv_number,
          certificateId: row.certificate_id,
          status: row.status,
          cardName: row.card_name,
          missingSides,
          missingLabel: missingLabelOf(missingSides),
          locationId: row.location_id,
          updatedAt: new Date(row.updated_at).toISOString(),
        }));
    }
  );
}

/**
 * Load a Card Job with a HARD tenant predicate.
 *
 * The tenant id comes from the authenticated session, never the request, and is applied in the WHERE
 * clause rather than checked afterwards — so a forged or guessed Card Job id from another partner
 * returns "not found", which is also the honest answer: it does not exist as far as this caller is
 * concerned. Never `CARD_JOB_NOT_FOUND` for one tenant and `FORBIDDEN` for another; the difference
 * would confirm the id is real.
 */
async function loadFixableJob(
  client: PoolClient,
  tenantId: string,
  cardJobId: string
): Promise<{ id: string; certificate_id: number; mv_number: string; status: string; location_id: string | null }> {
  const { rows } = await client.query<{
    id: string;
    certificate_id: number | null;
    mv_number: string | null;
    status: string;
    location_id: string | null;
  }>(
    `SELECT id, certificate_id, mv_number, status, location_id
       FROM partner_card_jobs
      WHERE id = $1 AND tenant_id = $2 AND cancelled_at IS NULL`,
    [cardJobId, tenantId]
  );
  const row = rows[0];
  if (!row || row.certificate_id === null || row.mv_number === null) {
    throw new FixAuthorityError("CARD_JOB_NOT_FOUND", "That card was not found for this partner.");
  }
  if (!FIXABLE_STATUSES.has(row.status)) {
    throw new FixAuthorityError(
      "JOB_NOT_FIXABLE",
      `A card in ${row.status} cannot have an image replaced. Approved work is corrected, not re-scanned.`
    );
  }
  return {
    id: row.id,
    certificate_id: row.certificate_id,
    mv_number: row.mv_number,
    status: row.status,
    location_id: row.location_id,
  };
}

export interface InvalidateSideResult {
  cardJobId: string;
  mvNumber: string;
  side: FixSide;
  /** The evidence row that was retired. Its object is NOT deleted. */
  supersededEvidenceId: number;
  status: string;
}

/**
 * Invalidate one side of an existing paid Card Job — the dashboard's "Delete Front/Back image".
 *
 * "DELETE" IS A LIE WE DO NOT TELL THE DATABASE. Nothing is removed. The current evidence row is
 * marked `is_current = false` with a `superseded_at` stamp, which is the same append-only supersede
 * chain the recapture path already uses (`ON DELETE RESTRICT` on `superseded_by_id` means the
 * original can never be cascaded away). The immutable master in R2 stays exactly where it is.
 *
 * WHAT SURVIVES, ALL OF IT DELIBERATE: the Card Job, its MV, its certificate, its reservation and
 * its credit lineage. A bad photograph is not a reason to unpick a payment, and re-minting identity
 * would break "one Card Job = one permanent MV" (locked rule 1). The card simply moves to
 * FIX_REQUIRED and waits for a replacement image.
 */
export async function invalidateSide(input: {
  tenantId: string;
  locationId: string | null;
  cardJobId: string;
  side: unknown;
  actorUserId: string;
  reason: string;
  stationId?: string | null;
}): Promise<InvalidateSideResult> {
  const side = cleanSide(input.side);
  const reason = (input.reason ?? "").trim();
  if (!reason) {
    // An unexplained invalidation is indistinguishable from an accident or an abuse. The audit row
    // is the only thing that can tell them apart later, so the reason is mandatory.
    throw new FixAuthorityError("SIDE_INVALID", "A reason is required to remove an image from grading.");
  }

  return withPartnerAdminTenantTransaction(
    { tenantId: input.tenantId, locationId: input.locationId ?? null },
    async (client) => {
      const job = await loadFixableJob(client, input.tenantId, input.cardJobId);

      // Retire the CURRENT row only. A partial unique index allows exactly one current row per
      // (certificate, side), so this is at most one row, and rowcount 0 means the side was already
      // empty — a no-op that must not be reported as a successful invalidation.
      const superseded = await client.query<{ id: number }>(
        `UPDATE certificate_image_evidence
            SET is_current = false, superseded_at = NOW()
          WHERE certificate_id = $1 AND side = $2 AND is_current = true
          RETURNING id`,
        [job.certificate_id, side]
      );
      if (superseded.rowCount === 0) {
        throw new FixAuthorityError(
          "SIDE_ALREADY_MISSING",
          `The ${side} image is already missing for ${job.mv_number}; it is ready to re-scan.`
        );
      }

      // The card leaves any "ready" state immediately: an invalidated side must never be gradeable.
      const moved = await client.query<{ status: string }>(
        `UPDATE partner_card_jobs SET status = 'FIX_REQUIRED', updated_at = NOW()
          WHERE id = $1 AND tenant_id = $2 AND status <> 'FIX_REQUIRED'
          RETURNING status`,
        [job.id, input.tenantId]
      );

      await writePartnerAudit(client, {
        tenantId: input.tenantId,
        locationId: input.locationId ?? job.location_id ?? null,
        actorUserId: input.actorUserId,
        deviceId: input.stationId ?? null,
        action: side === "front" ? "partner_card_front_invalidated" : "partner_card_back_invalidated",
        recordType: "partner_card_job",
        recordId: job.id,
        before: { side, evidenceId: superseded.rows[0].id, status: job.status, isCurrent: true },
        after: { side, status: "FIX_REQUIRED", isCurrent: false, mvNumber: job.mv_number },
        reason,
      });

      return {
        cardJobId: job.id,
        mvNumber: job.mv_number,
        side,
        supersededEvidenceId: superseded.rows[0].id,
        status: moved.rows[0]?.status ?? "FIX_REQUIRED",
      };
    }
  );
}

export interface FixAuthorisation {
  cardJobId: string;
  mvNumber: string;
  certificateId: number;
  /** ONLY the sides that are genuinely missing. Never both when only one is. */
  authorisedSides: FixSide[];
  locationId: string | null;
}

/**
 * Authorise the capture of the missing side(s) of an existing paid card.
 *
 * SPENDS NOTHING AND MINTS NOTHING — this function contains no wallet call, no allocator call and no
 * insert into `partner_card_jobs`. It answers one question: which sides of this already-paid card is
 * this caller allowed to re-capture? The answer is computed from the evidence table, so a side that
 * still has an accepted image can never be authorised. An operator cannot "fix" a good image to
 * replace it; they must invalidate it first, deliberately and with a recorded reason.
 *
 * It works identically at a zero balance, because it never asks what the balance is.
 */
export async function authoriseFix(input: {
  tenantId: string;
  locationId: string | null;
  cardJobId: string;
  /** Optional narrowing. Omitted means "whatever is missing". */
  requestedSides?: unknown;
  stationId?: string | null;
  actorUserId: string;
}): Promise<FixAuthorisation> {
  return withPartnerAdminTenantTransaction(
    { tenantId: input.tenantId, locationId: input.locationId ?? null },
    async (client) => {
      const job = await loadFixableJob(client, input.tenantId, input.cardJobId);

      if (input.stationId) {
        // A revoked or suspended station must not be able to capture, even for a free repair.
        const station = await client.query<{ status: string; location_id: string }>(
          `SELECT status, location_id FROM partner_stations WHERE id = $1 AND tenant_id = $2`,
          [input.stationId, input.tenantId]
        );
        const row = station.rows[0];
        if (!row || row.status !== "ACTIVE") {
          throw new FixAuthorityError("STATION_NOT_ACTIVE", "This station is not approved to capture cards.");
        }
        // A station belongs to one location and may only repair cards taken at that location.
        if (job.location_id && row.location_id !== job.location_id) {
          throw new FixAuthorityError("CARD_JOB_NOT_FOUND", "That card was not found for this partner.");
        }
      }

      const current = await client.query<{ side: string }>(
        `SELECT side FROM certificate_image_evidence
          WHERE certificate_id = $1 AND is_current = true`,
        [job.certificate_id]
      );
      const present = new Set(current.rows.map((r) => r.side));
      const missing = SIDES.filter((s) => !present.has(s));

      if (missing.length === 0) {
        throw new FixAuthorityError(
          "SIDE_NOT_INVALIDATED",
          `${job.mv_number} has both images. Remove the bad one from grading first, then re-scan it.`
        );
      }

      let authorisedSides = missing;
      if (Array.isArray(input.requestedSides) && input.requestedSides.length > 0) {
        const requested = input.requestedSides.map(cleanSide);
        // Narrowing only. A request for a side that is NOT missing is refused outright rather than
        // quietly ignored — silently returning a different set than was asked for is how a caller
        // ends up overwriting an accepted image.
        for (const side of requested) {
          if (!missing.includes(side)) {
            throw new FixAuthorityError(
              "SIDE_NOT_INVALIDATED",
              `The ${side} image of ${job.mv_number} is present and cannot be replaced without removing it first.`
            );
          }
        }
        authorisedSides = SIDES.filter((s) => requested.includes(s));
      }

      await writePartnerAudit(client, {
        tenantId: input.tenantId,
        locationId: input.locationId ?? job.location_id ?? null,
        actorUserId: input.actorUserId,
        deviceId: input.stationId ?? null,
        action: "partner_card_fix_authorised",
        recordType: "partner_card_job",
        recordId: job.id,
        after: { mvNumber: job.mv_number, sides: authorisedSides, status: job.status },
        reason: "Authorised replacement capture for missing side(s). No Grading Credit is consumed.",
      });

      return {
        cardJobId: job.id,
        mvNumber: job.mv_number,
        certificateId: job.certificate_id,
        authorisedSides,
        locationId: job.location_id,
      };
    }
  );
}
