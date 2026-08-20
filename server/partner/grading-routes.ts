/**
 * Partner grading adapter — ONE workstation, TWO intake lineages.
 *
 * This is deliberately a role/ownership adapter over the existing MVGS certificate workflow. It does
 * not score, publish, create certificates, print labels, or duplicate the grader engine.
 *
 * A partner may grade a certificate that is in their selected/org-wide location scope, not already
 * approved or deleted, and reachable by ONE of two lineages:
 *
 *   CARD JOB (canonical — Scanner NEW, P3–P6)
 *     - owned by a `partner_card_jobs` row in this tenant and location,
 *     - whose Card Job is in a legal grading state,
 *     - and, for any WRITE, held under a live grading edit lease at the current revision.
 *       Deliberately NOT `assigned_grader_id`: Scanner NEW assigns no grader, so requiring one made
 *       every Scanner Card Job permanently ungradeable. The lease is the assignment authority.
 *
 *   CONNECTOR (legacy/imported — preserved unchanged)
 *     - mapped back to their tenant through partner_connector_imports,
 *     - and assigned to their partner user id.
 *
 * Where a Card Job exists, Card Job lineage is authoritative for that work item. There is no second
 * queue, no second workstation and no second QA or output system — see card-job-grading-bridge.ts for
 * the full rationale and the defect this closes.
 */
import { Router } from "express";
import type { NextFunction, Response } from "express";
import rateLimit from "express-rate-limit";
import type { PoolClient } from "pg";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { getR2SignedUrl } from "../r2";
import { storage } from "../storage";
import type { CertificateRecord } from "@shared/schema";
import { checkPrintableGrade, UnprintableGradeError } from "@shared/printable-grade";
import { buildLabelPreviewCertificate, generateLabelPreviewPNG } from "../services/label-preview";
import { authorizePartnerLabelPreview } from "../services/label-preview-access";
import {
  applyCertGradeDraft,
  buildCertGradingPayload,
  buildCertImagesPayload,
  buildWorkingEvidencePayloads,
  GradeDraftRejected,
  stripGraderPii,
  type WorkingEvidenceStatus,
} from "../grader";
import { GradeDraftValidationError } from "@shared/grading-draft-validation";
import { auditInOwnTxn } from "./audit";
import { withPartnerAdminTransaction, withTenant } from "./db";
import { resolveFlag } from "./flags";
import { getPartnerPrintEligibilityBlocks } from "./print-eligibility";
import {
  requireNotSensitiveFrozen,
  requireNotViewOnly,
  requirePartnerAuth,
  requirePartnerCapability,
  type PartnerPrincipal,
} from "./session";
import {
  GradingLeaseError,
  acquireLease,
  assertMayWriteCertificate,
  getLease,
  heartbeatLease,
  releaseLease,
  takeoverLease,
} from "./grading-lease-service";
import {
  CardJobGradingError,
  cardJobErrorStatus,
  submitCardJobForReview,
  type PartnerCertLineage,
} from "./card-job-grading-bridge";
import { CardJobTransitionError } from "./card-job-lifecycle";

/**
 * Lease failures mapped to statuses a workstation can act on.
 *
 * A cross-tenant or cross-location Card Job resolves to 404 — the same answer an absent id gets,
 * because a distinct 403 would confirm the id is real and belongs to somebody.
 */
function leaseError(res: import("express").Response, error: unknown): void {
  if (error instanceof GradingLeaseError) {
    const status =
      error.code === "CARD_JOB_NOT_FOUND"
        ? 404
        : error.code === "FORBIDDEN"
          ? 403
          : error.code === "LEASE_HELD_BY_ANOTHER" || error.code === "STALE_REVISION" || error.code === "NOT_GRADABLE"
            ? 409
            : 410; // NOT_LEASE_HOLDER / LEASE_EXPIRED — your editing session is gone
    res.status(status).json({ error: { code: error.code, message: error.message, ...(error.detail ?? {}) } });
    return;
  }
  // eslint-disable-next-line no-console
  console.error("[partner grading lease] failed:", (error as Error).message);
  res.status(500).json({ error: { code: "lease_unavailable", message: "Could not open this card for editing." } });
}

/**
 * The normalised server authority for ONE Partner work item, whichever road it arrived by.
 *
 * ONE SHAPE, TWO LINEAGES — deliberately an extension of the existing type rather than a parallel
 * grading DTO. A second DTO would mean a second set of call sites, and the two would drift; the
 * fields that only one lineage can populate are simply nullable, and `lineage` says which is which.
 *
 * `card_job`  — Scanner NEW / canonical Partner intake. Identity comes from `partner_card_jobs`;
 *               there is no connector import and never will be, so `destinationSubmissionId`,
 *               `submissionRef`, `serviceTier` and `cardIndex` are null.
 * `connector` — legacy/imported Partner work. Every field is populated exactly as before, and every
 *               protection on that path is unchanged.
 */
export type PartnerCertAuth = {
  lineage: PartnerCertLineage;
  /** The Card Job this work item belongs to. Non-null iff lineage is `card_job`. */
  cardJobId: string | null;
  /** The Card Job's lifecycle state — the write authority for Card Job lineage. */
  cardJobStatus: string | null;
  mvNumber: string | null;
  certId: number;
  certificateNumber: string;
  gradingStatus: string;
  assignedGraderId: string | null;
  gradedBy: string | null;
  tenantId: string;
  locationId: string | null;
  /** The PARTNER-side submission id. Present on both lineages; the walk-in submission on card_job. */
  partnerSubmissionId: string;
  /** Connector lineage only — the MintVault destination submission the importer created. */
  destinationSubmissionId: number | null;
  submissionRef: string | null;
  serviceTier: string | null;
  cardIndex: number | null;
  cardGame: string | null;
  setName: string | null;
  cardName: string | null;
  cardNumber: string | null;
  year: string | null;
  language: string | null;
  variant: string | null;
  grade: string | null;
  rejectionReason: string | null;
  redoCount: number;
  provenanceValid: boolean;
};

/**
 * Put the P9 lease on the WRITE path.
 *
 * Until this existed the lease was a proven service that nothing consulted: `assertMayWrite` had no
 * caller anywhere in server/, so a grader who politely acquired could still be overwritten by one
 * who never did. The lease answered "who may write" to nobody.
 *
 * Returns the caller's next lease revision, or null when this certificate has no Card Job — a
 * connector-imported card, which has no lease and must keep grading exactly as before. Throws
 * GradingLeaseError otherwise, which `leaseError` turns into the 409/410 the workstation acts on.
 *
 * The revision travels as `leaseRevision`, deliberately NOT as `expectedRevision`. There are two
 * unrelated revisions on this surface — the lease's, and `certificates.grading_revision` which the
 * label-preview barrier already calls `expectedRevision` — and giving them one name is how a client
 * ends up sending a plausible number that means the wrong thing.
 */
async function requireLeaseForCertificateWrite(
  principal: PartnerPrincipal,
  certId: number,
  body: unknown
): Promise<number | null> {
  const authority = await assertMayWriteCertificate(
    principal,
    certId,
    (body as { leaseRevision?: unknown } | null | undefined)?.leaseRevision
  );
  return authority?.revision ?? null;
}

function expectedReviewRevision(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1) return null;
  return raw;
}

const EDITABLE_STATUSES = new Set(["assigned", "pending_review"]);

const partnerGradingEditRateLimit = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: false,
  keyGenerator: (req) => `partner-grading-edit:${req.partner?.userId ?? "unknown"}`,
  message: { error: "Too many grading edit requests. Please wait a minute and try again." },
});

// These routes run after the MFA/capability gate, so a per-operator budget
// limits abusive replay without penalising a partner location that shares an IP.
// Preview rendering and grade writes are deliberately separate: preview polling
// must never consume the write budget required to save a legitimate review.
const partnerGradingReadRateLimit = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: false,
  keyGenerator: (req) => `partner-grading-read:${req.partner?.userId ?? "unknown"}`,
  message: { error: "Too many grading read requests. Please wait a minute and try again." },
});

const partnerGradingPreviewRateLimit = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: false,
  keyGenerator: (req) => `partner-grading-preview:${req.partner?.userId ?? "unknown"}`,
  message: { error: "Too many label preview requests. Please wait a minute and try again." },
});

/**
 * May a grading DRAFT be written to this work item right now, by lineage?
 *
 * CARD JOB LINEAGE — the CARD JOB's own lifecycle state is the authority, and only GRADING permits a
 * write. That is deliberately stricter than the connector rule in one respect that matters: a
 * connector card in `pending_review` may still be edited by whoever submitted it, whereas a Card Job
 * that has been submitted is in QA_REVIEW and is refused here.
 *
 * Refusing is the correct answer for the pilot. QA is 100% Super Admin, and a grader silently
 * amending a card while a reviewer is looking at it would mean the reviewer approves something other
 * than what they read. The grader gets the card back through RETURN TO GRADER, which puts the job
 * back into GRADING with its history preserved — an audited hand-back rather than an invisible edit.
 *
 * `certificates.grader_status` is deliberately NOT consulted on this lineage. A Scanner Card Job's
 * certificate is `unassigned` until a grader takes the lease, so a status gate would refuse the very
 * first legitimate write. The lease (already proven by `assertMayWriteCertificate`) plus GRADING is
 * the complete authority.
 *
 * CONNECTOR LINEAGE — byte-for-byte the rule that shipped.
 */
export function draftEditability(
  auth: PartnerCertAuth,
  principal: PartnerPrincipal
): { ok: true } | { ok: false; status: number; error: string } {
  if (auth.lineage === "card_job") {
    if (auth.cardJobStatus !== "GRADING") {
      return {
        ok: false,
        status: 409,
        error:
          auth.cardJobStatus === "QA_REVIEW" || auth.cardJobStatus === "SUBMITTED"
            ? "This card is with Super Admin review and cannot be edited. It must be returned to you first."
            : `This card is ${auth.cardJobStatus}, so it is not open for editing. Open it for grading first.`,
      };
    }
    return { ok: true };
  }
  if (!EDITABLE_STATUSES.has(auth.gradingStatus)) {
    return { ok: false, status: 409, error: `Card is '${auth.gradingStatus}', not editable` };
  }
  if (auth.gradingStatus === "pending_review" && auth.gradedBy && auth.gradedBy !== principal.userId) {
    return { ok: false, status: 403, error: "Only the partner user who submitted this card can edit it" };
  }
  return { ok: true };
}

/** Map a Card Job bridge/lifecycle failure onto its HTTP answer, or fall through to the generic one. */
function sendCardJobError(res: Response, err: unknown): boolean {
  const status = cardJobErrorStatus(err);
  if (status === null) return false;
  const error = err as CardJobGradingError | CardJobTransitionError;
  res.status(status).json({ error: error.message, code: error.code });
  return true;
}

function numericId(raw: unknown): number | null {
  const value = String(raw);
  if (!/^[1-9][0-9]*$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function sendPartnerGradingError(res: Response, err: unknown): void {
  if (err instanceof GradeDraftRejected) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof GradeDraftValidationError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  // eslint-disable-next-line no-console
  console.error("[partner grading] error:", err instanceof Error ? err.message : err);
  res.status(500).json({ error: "Partner grading is unavailable." });
}

/**
 * Grading is deliberately a tenant/location-scoped pilot capability, not a
 * global UI affordance. Resolve it on the restricted Partner runtime
 * connection and fail closed: an unavailable flag store must never open the
 * grading and label-preview surface by accident.
 */
async function requirePartnerGradingEnabled(
  req: Parameters<typeof requirePartnerAuth>[0],
  res: Response,
  next: NextFunction
): Promise<void> {
  const principal = req.partner;
  if (!principal) {
    res.status(401).json({ error: "authentication required" });
    return;
  }
  try {
    const enabled = await withTenant({ tenantId: principal.tenantId, locationId: principal.locationId }, (client) =>
      resolveFlag(client, "partner_grading_enabled", principal)
    );
    if (!enabled) {
      res.status(503).json({ error: "Partner grading is unavailable." });
      return;
    }
    next();
  } catch (err) {
    // Do not reveal runtime/database detail to a Partner caller. The server log
    // is sufficient for operations, while the route stays closed.
    // eslint-disable-next-line no-console
    console.error("[partner grading] flag resolution failed:", err instanceof Error ? err.message : err);
    res.status(503).json({ error: "Partner grading is unavailable." });
  }
}

/**
 * CARD JOB LINEAGE — the canonical Partner intake road.
 *
 * The tenant AND location predicates are IN THE SQL, not applied afterwards in TypeScript. A job on
 * another partner's books, or on another shop floor than a location-scoped grader is entitled to,
 * must never be read at all — so it resolves to "no row", which the caller turns into the same 404 an
 * absent certificate gets. A distinct refusal would confirm the id is real and belongs to somebody.
 *
 * `partner_card_jobs.certificate_id` is uniquely indexed where non-null and immutable once stamped
 * (0080), so at most one job answers and it cannot drift to another job later.
 *
 * The origin columns are re-asserted against the JOB's own tenant/location, which is the Card Job
 * equivalent of the connector path's provenance check: a certificate whose immutable 0035 origin
 * snapshot disagrees with the job that owns it is not a card this partner may grade.
 */
async function loadPartnerCertByCardJob(principal: PartnerPrincipal, certId: number): Promise<PartnerCertAuth | null> {
  const scopedLocationId = principal.orgWide ? null : principal.locationId;
  const { rows } = await withPartnerAdminTransaction((client) =>
    client.query<PartnerCertAuth>(
      `SELECT 'card_job'::text AS "lineage",
              job.id::text AS "cardJobId",
              job.status AS "cardJobStatus",
              job.mv_number AS "mvNumber",
              cert.id AS "certId",
              cert.certificate_number AS "certificateNumber",
              cert.grader_status AS "gradingStatus",
              cert.assigned_grader_id AS "assignedGraderId",
              cert.graded_by AS "gradedBy",
              job.tenant_id::text AS "tenantId",
              job.location_id::text AS "locationId",
              job.submission_id::text AS "partnerSubmissionId",
              NULL::int AS "destinationSubmissionId",
              NULL::text AS "submissionRef",
              NULL::text AS "serviceTier",
              NULL::int AS "cardIndex",
              cert.card_game AS "cardGame",
              cert.set_name AS "setName",
              cert.card_name AS "cardName",
              cert.card_number_display AS "cardNumber",
              cert.year_text AS "year",
              cert.language,
              cert.variant,
              cert.grade::text,
              cert.rejection_reason AS "rejectionReason",
              cert.redo_count::int AS "redoCount",
              (
                cert.origin_type = 'PARTNER'
                AND cert.origin_partner_id = job.tenant_id
                AND cert.origin_location_id = job.location_id
              ) AS "provenanceValid"
         FROM partner_card_jobs job
         JOIN certificates cert ON cert.id = job.certificate_id
        WHERE job.certificate_id = $1
          AND job.tenant_id = $2
          AND job.cancelled_at IS NULL
          AND ($3::uuid IS NULL OR job.location_id = $3::uuid)
          AND cert.deleted_at IS NULL
          AND cert.origin_type = 'PARTNER'
          AND cert.origin_partner_id = job.tenant_id
          AND cert.origin_location_id = job.location_id`,
      [certId, principal.tenantId, scopedLocationId]
    )
  );
  return rows[0] ?? null;
}

/**
 * Resolve ONE Partner work item, trying Card Job lineage FIRST.
 *
 * ORDER MATTERS AND IS THE ARCHITECTURE: where a Card Job exists, Card Job lineage is authoritative
 * for that work item. The connector query is reached only when no Card Job answers, and it is
 * unchanged — same five-table JOIN chain, same provenance predicates, same protections. Nothing on
 * the legacy path is weakened to make the new path work.
 */
/*
 * EXPORTED FOR PROOF, not for reuse. `loadPartnerCert`, `authorizeAssignedPartnerCert`,
 * `partnerDraftWriteGuard` and `draftEditability` are the four decisions the bridge turns on, and
 * three of them are SQL that only a real PostgreSQL can evaluate. The hostile bridge suite composes
 * the guard into the SAME `UPDATE ... WHERE id = ? AND grade_approved_at IS NULL ${guard}` shape
 * `applyCertGradeDraft` builds, so what is proven is the statement that actually runs — not a
 * paraphrase of it. Nothing in server/ imports them from here.
 */
export async function loadPartnerCert(principal: PartnerPrincipal, certId: number): Promise<PartnerCertAuth | null> {
  if (!principal.orgWide && !principal.locationId) return null;
  const cardJob = await loadPartnerCertByCardJob(principal, certId);
  if (cardJob) return cardJob;
  return loadPartnerCertByConnector(principal, certId);
}

async function loadPartnerCertByConnector(
  principal: PartnerPrincipal,
  certId: number
): Promise<PartnerCertAuth | null> {
  if (!principal.orgWide && !principal.locationId) return null;
  const { rows } = await withPartnerAdminTransaction((client) =>
    client.query<PartnerCertAuth>(
      `SELECT 'connector'::text AS "lineage",
              NULL::text AS "cardJobId",
              NULL::text AS "cardJobStatus",
              NULL::text AS "mvNumber",
              cert.id AS "certId",
              cert.certificate_number AS "certificateNumber",
              cert.grader_status AS "gradingStatus",
              cert.assigned_grader_id AS "assignedGraderId",
              cert.graded_by AS "gradedBy",
              pci.partner_organisation_id::text AS "tenantId",
              pci.partner_location_id::text AS "locationId",
              pci.partner_submission_id::text AS "partnerSubmissionId",
              pci.destination_submission_id::int AS "destinationSubmissionId",
              s.tracking_number AS "submissionRef",
              s.service_tier AS "serviceTier",
              si.card_index::int AS "cardIndex",
              cert.card_game AS "cardGame",
              cert.set_name AS "setName",
              cert.card_name AS "cardName",
              cert.card_number_display AS "cardNumber",
              cert.year_text AS "year",
              cert.language,
              cert.variant,
              cert.grade::text,
              cert.rejection_reason AS "rejectionReason",
              cert.redo_count::int AS "redoCount",
              (
                cert.origin_type = 'PARTNER'
                AND cert.origin_partner_id = pci.partner_organisation_id
                AND cert.origin_location_id = pci.partner_location_id
                AND cert.submission_item_id = si.id
              ) AS "provenanceValid"
         FROM certificates cert
         LEFT JOIN cards c ON c.id = cert.card_id
         LEFT JOIN submission_items si ON si.id = cert.submission_item_id
         JOIN submissions s ON s.id = COALESCE(c.submission_id, si.submission_id)
         JOIN partner_connector_imports pci
           ON pci.destination_submission_id = s.id
         JOIN partner_connector_records pcr
           ON pcr.id = pci.connector_record_id
          AND pcr.tenant_id = pci.partner_organisation_id
          AND pcr.partner_submission_id = pci.partner_submission_id
          AND pcr.handoff_id = pci.partner_handoff_id
          AND pcr.state = 'imported'
         JOIN partner_submissions ps
           ON ps.id = pci.partner_submission_id
          AND ps.tenant_id = pci.partner_organisation_id
          AND ps.location_id = pci.partner_location_id
         JOIN partner_submission_handoffs psh
           ON psh.id = pci.partner_handoff_id
          AND psh.tenant_id = pci.partner_organisation_id
          AND psh.submission_id = pci.partner_submission_id
        WHERE cert.id = $1
          AND cert.deleted_at IS NULL
          AND cert.origin_type = 'PARTNER'
          AND cert.origin_partner_id = pci.partner_organisation_id
          AND cert.origin_location_id = pci.partner_location_id
          AND pci.partner_organisation_id = $2
          AND pci.state IN ('completed','imported')`,
      [certId, principal.tenantId]
    )
  );
  const row = rows[0];
  if (!row) return null;
  if (!principal.orgWide && row.locationId !== principal.locationId) return null;
  return row;
}

/**
 * READ/LOAD authority for one Partner work item, by lineage.
 *
 * CONNECTOR LINEAGE — unchanged. `assigned_grader_id` must equal the caller. That binding is the
 * legacy path's assignment model and there is no proven defect in it, so it is preserved exactly.
 *
 * CARD JOB LINEAGE — the assigned-grader requirement is deliberately NOT applied, and this is the
 * central change of the bridge. Scanner NEW assigns no grader: a walk-in card is graded by whoever
 * picks it up next, and there is no step in that flow at which anybody could pre-assign one. Keeping
 * the check would have made every Scanner Card Job permanently ungradeable — which is exactly the
 * defect that was found.
 *
 * WHAT AUTHORISES A READ INSTEAD. Three facts, all already proven by the time this runs:
 *   - TENANT and LOCATION — enforced in `loadPartnerCertByCardJob`'s SQL, so a job outside the
 *     caller's scope produced no row and `auth` is null here;
 *   - PERMISSION — `requirePartnerCapability("partner.cards.assess")` on every route below, which
 *     SCANNER_OPERATOR (cards.scan + cards.view, never cards.assess) does not hold;
 *   - SESSION — `requirePartnerAuth`, plus the view-only/frozen guards on the write routes.
 *
 * WRITES need strictly more than this — a live edit lease, the current lease revision and a Card Job
 * in GRADING. That is `assertMayWriteCertificate` plus `partnerDraftWriteGuard`, not this function.
 * This gate answers "may you LOOK at this card", and being able to look is not being able to write.
 */
export function authorizeAssignedPartnerCert(principal: PartnerPrincipal, auth: PartnerCertAuth | null) {
  if (!auth) return { ok: false as const, status: 404, error: "Not found" };
  if (auth.gradingStatus === "approved") {
    return { ok: false as const, status: 403, error: "This card is already approved" };
  }
  if (auth.lineage === "connector" && auth.assignedGraderId !== principal.userId) {
    return { ok: false as const, status: 403, error: "This card is not assigned to you" };
  }
  return { ok: true as const, auth };
}

/** Shared target authorisation for the station capture adapter. It deliberately
 * reuses the same Partner certificate/assignment binding as grading, rather
 * than accepting an arbitrary certificate ID from a Mac.
 *
 * MERGE NOTE (2026-08-11, sibling reconciliation): this arrived on the v1069
 * scanner lineage bound to that lineage's `authorizeAssigned` + the pre-repair
 * `loadPartnerCert`. It is re-pointed here at the canonical
 * `authorizeAssignedPartnerCert` and the canonical `loadPartnerCert`, so a
 * station capture now inherits the full provenance JOIN chain
 * (partner_connector_records / partner_submissions / partner_submission_handoffs)
 * rather than the weaker tenant-only binding it shipped with. */
export async function authorizePartnerScannerCertificate(
  principal: PartnerPrincipal,
  certId: number
): Promise<PartnerCertAuth | null> {
  const authorised = authorizeAssignedPartnerCert(principal, await loadPartnerCert(principal, certId));
  return authorised.ok ? authorised.auth : null;
}

/**
 * The SQL that must match for a Partner grading draft write to land, by lineage.
 *
 * WHY THIS FUNCTION IS THE DEFECT'S EPICENTRE. `applyCertGradeDraft` appends this to its own
 * `WHERE id = ... AND grade_approved_at IS NULL`, and a zero-row UPDATE is reported to the operator as
 * "Card status changed; refresh and try again". For a Scanner Card Job the connector EXISTS chain
 * below matches NOTHING — not because the status changed, but because the card has no connector
 * lineage and never will. So the honest answer ("this card cannot be graded through the connector
 * path") arrived as a misleading one that invited the grader to refresh for ever.
 *
 * SWITCHED ON THE RESOLVED LINEAGE, not OR-ed across both. Both arms would also work, but OR-ing them
 * means a connector card gets a second chance to match through the Card Job arm and vice versa — a
 * strictly wider guard than either lineage needs. The lineage is already known for certain by the
 * time a write is attempted (the loader resolved it), so each write is held to exactly its own
 * lineage's rules. The connector arm below is byte-for-byte the guard that shipped.
 */
export function partnerDraftWriteGuard(principal: PartnerPrincipal, auth: PartnerCertAuth) {
  if (auth.lineage === "card_job") {
    /*
     * CARD JOB ARM.
     *
     * NO `assigned_grader_id` PREDICATE, deliberately — see authorizeAssignedPartnerCert. What
     * replaces it is stronger, because it is a live, expiring, uniquely-indexed lease rather than a
     * column comparison:
     *
     *   - `assertMayWriteCertificate` has ALREADY run before this SQL is built. It proved the caller
     *     holds the lease on this exact Card Job, that the lease has not expired, and that the
     *     revision they presented is current — then bumped it, so this write cannot be replayed.
     *   - `job.status = 'GRADING'` is asserted HERE, in the UPDATE itself. A card that has been
     *     submitted, sent to FIX, cancelled or returned to the shop floor between the authorisation
     *     and the write matches no row and the write is refused.
     *   - tenant and location are re-asserted in the UPDATE rather than trusted from the load, so a
     *     scoped grader cannot write to another floor's job even if the loader were ever relaxed.
     */
    return sql`
      AND deleted_at IS NULL
      AND EXISTS (
        SELECT 1
          FROM partner_card_jobs job
         WHERE job.certificate_id = certificates.id
           AND job.id = ${auth.cardJobId}::uuid
           AND job.tenant_id = ${principal.tenantId}::uuid
           AND job.cancelled_at IS NULL
           AND job.status = 'GRADING'
           AND (${principal.orgWide} OR job.location_id = ${principal.locationId}::uuid)
           AND certificates.origin_type = 'PARTNER'
           AND certificates.origin_partner_id = job.tenant_id
           AND certificates.origin_location_id = job.location_id
      )
    `;
  }
  return sql`
    AND assigned_grader_id = ${principal.userId}
    AND deleted_at IS NULL
    AND EXISTS (
      SELECT 1
        FROM certificates cert_check
        LEFT JOIN cards c ON c.id = cert_check.card_id
        LEFT JOIN submission_items si ON si.id = cert_check.submission_item_id
        JOIN submissions s ON s.id = COALESCE(c.submission_id, si.submission_id)
        JOIN partner_connector_imports pci ON pci.destination_submission_id = s.id
        JOIN partner_connector_records pcr
          ON pcr.id = pci.connector_record_id
         AND pcr.tenant_id = pci.partner_organisation_id
         AND pcr.partner_submission_id = pci.partner_submission_id
         AND pcr.handoff_id = pci.partner_handoff_id
         AND pcr.state = 'imported'
        JOIN partner_submissions ps
          ON ps.id = pci.partner_submission_id
         AND ps.tenant_id = pci.partner_organisation_id
         AND ps.location_id = pci.partner_location_id
        JOIN partner_submission_handoffs psh
          ON psh.id = pci.partner_handoff_id
         AND psh.tenant_id = pci.partner_organisation_id
         AND psh.submission_id = pci.partner_submission_id
       WHERE cert_check.id = certificates.id
         AND cert_check.origin_type = 'PARTNER'
         AND cert_check.origin_partner_id = pci.partner_organisation_id
         AND cert_check.origin_location_id = pci.partner_location_id
         AND pci.partner_organisation_id = ${principal.tenantId}
         AND (${principal.orgWide} OR pci.partner_location_id = ${principal.locationId})
         AND pci.state IN ('completed','imported')
    )
  `;
}

/**
 * Resolve the ONE partner intake card whose images belong to a destination
 * `submission_items.card_index`.
 *
 * OWNER-AUTHORISED REPAIR (2026-08-11). WHY THIS IS NOT `sequence_number = card_index`:
 * connector-import-service.ts expands each intake card by its `quantity` BEFORE
 * numbering the destination items —
 *
 *     const expandedItems = rows.cards.flatMap((card) =>
 *       Array.from({ length: Math.max(1, card.quantity) }, () => card));
 *     let cardIndex = 1; for (const card of expandedItems) { INSERT ... card_index = cardIndex++ }
 *
 * so `card_index` is an ordinal over the EXPANDED unit list while `sequence_number`
 * is an ordinal over the intake ROWS. They coincide only when every card has
 * quantity 1 and the sequence numbers are gapless. With card A (seq 1, qty 2) and
 * card B (seq 2, qty 1) the destination items are [A, A, B] at card_index 1,2,3, so
 * the old predicate handed item 2 card B's photographs and item 3 none at all — and
 * because imagesForPartnerCert() spreads this AFTER buildCertImagesPayload(), the
 * wrong photograph OVERRODE the certificate's own. A grader could assess the wrong
 * card. `addCard` allocates MAX(sequence_number)+1 over LIVE rows only, so a removed
 * middle card leaves a gap and breaks the equality for the same reason.
 *
 * The expansion is reproduced in SQL rather than joined on a stored id because no
 * per-item link exists: submission_items has no partner column, the credit tables
 * bind per SUBMISSION, and 0035's origin columns are per ORGANISATION. It is
 * faithful — same ordering as the importer's card load (ORDER BY sequence_number
 * ASC) and the same GREATEST(1, quantity) floor as Math.max(1, card.quantity).
 * `c.id` is a total-order tiebreak that is unreachable in practice (0007 makes
 * (submission_id, sequence_number) unique among live rows) but removes any
 * dependence on Postgres's choice between equal keys.
 *
 * CARDINALITY GUARD: the intake rows cannot legitimately change after import
 * (addCard/editCard/removeCard are all draft-only), so the reconstruction is exact.
 * If they ever DID drift, the expanded count would no longer equal the destination
 * item count and this returns NO row rather than a plausible-looking wrong one.
 * Showing nothing makes requireBothImages() block the submit; showing the wrong card
 * does not, and is the harm this function exists to prevent.
 *
 * Exported so the binding can be proven against a REAL imported submission without
 * standing up the certificates table.
 */
export async function partnerCardImagesForCardIndex(
  client: { query: PoolClient["query"] },
  params: { tenantId: string; partnerSubmissionId: string; destinationSubmissionId: number; cardIndex: number }
): Promise<{ front_image_key: string | null; back_image_key: string | null } | null> {
  const { rows } = await client.query<{ front_image_key: string | null; back_image_key: string | null }>(
    `WITH expanded AS (
       SELECT c.front_image_key,
              c.back_image_key,
              row_number() OVER (ORDER BY c.sequence_number ASC, c.id ASC, ord.n ASC) AS card_index
         FROM partner_submission_cards c
         CROSS JOIN LATERAL generate_series(1, GREATEST(1, c.quantity)) AS ord(n)
        WHERE c.tenant_id = $1
          AND c.submission_id = $2
          AND c.removed_at IS NULL
     )
     SELECT e.front_image_key, e.back_image_key
       FROM expanded e
      WHERE e.card_index = $3
        AND (SELECT count(*) FROM expanded)
            = (SELECT count(*) FROM submission_items si WHERE si.submission_id = $4)`,
    [params.tenantId, params.partnerSubmissionId, params.cardIndex, params.destinationSubmissionId]
  );
  return rows[0] ?? null;
}

async function partnerImageFallback(auth: PartnerCertAuth): Promise<Record<string, string | null>> {
  /*
   * CARD JOB LINEAGE HAS NO INTAKE-PHOTO FALLBACK, and must not fabricate one.
   *
   * This fallback exists so a connector-imported card can show the photographs the shop uploaded at
   * intake while an operator prepares the target. A walk-in card has no intake stage at all — its
   * `partner_submission_cards` row is created by Scanner NEW with no image keys — so there is nothing
   * to fall back TO. `cardIndex` and `destinationSubmissionId` are both null on this lineage, which
   * would make the reconstruction below meaningless rather than merely empty.
   *
   * The only images a Card Job ever shows are its own accepted scanner masters, which is the
   * stricter of the two behaviours.
   */
  if (auth.lineage === "card_job") return {};
  const destinationSubmissionId = auth.destinationSubmissionId;
  const cardIndex = auth.cardIndex;
  if (!cardIndex || destinationSubmissionId === null) return {};
  const row = await withPartnerAdminTransaction((client) =>
    partnerCardImagesForCardIndex(client, {
      tenantId: auth.tenantId,
      partnerSubmissionId: auth.partnerSubmissionId,
      destinationSubmissionId,
      cardIndex,
    })
  );
  if (!row) return {};
  const urls: Record<string, string | null> = {};
  if (row.front_image_key) {
    const signed = await getR2SignedUrl(row.front_image_key, 3600);
    urls.front_original = signed;
    urls.front_display = signed;
  }
  if (row.back_image_key) {
    const signed = await getR2SignedUrl(row.back_image_key, 3600);
    urls.back_original = signed;
    urls.back_display = signed;
  }
  return urls;
}

async function imagesForPartnerCert(auth: PartnerCertAuth) {
  const payload = (await buildCertImagesPayload(auth.certId)) ?? { urls: {}, quality: {}, workingEvidence: undefined };
  const fallback = await partnerImageFallback(auth);
  // Intake photos can help an operator prepare a target, but may never replace
  // accepted scanner derivatives. Those are bound to a certificate/session/
  // station in the immutable evidence ledger.
  const urls = { ...payload.urls } as Record<string, string | null>;
  for (const side of ["front", "back"] as const) {
    const hasCapturedImage = Boolean(urls[`${side}_display`] || urls[`${side}_original`] || urls[`${side}_working`]);
    if (!hasCapturedImage && fallback[`${side}_original`]) {
      urls[`${side}_original`] = fallback[`${side}_original`];
      urls[`${side}_display`] = fallback[`${side}_display`];
    }
  }
  return {
    urls,
    quality: payload.quality ?? {},
    // The Partner adapter must preserve the same server admission verdict consumed by the canonical
    // workstation. Dropping it makes valid Canon evidence look unavailable, while recreating it in
    // the browser would create a second evidence authority.
    workingEvidence: payload.workingEvidence,
  };
}

type PartnerQueueEvidenceSide = {
  state: WorkingEvidenceStatus["state"];
  label: string;
  thumbnailUrl: string | null;
  reason: string | null;
  recovery: string | null;
};

export type PartnerQueueEvidence = {
  front: PartnerQueueEvidenceSide;
  back: PartnerQueueEvidenceSide;
  workflow: "READY_TO_GRADE" | "IN_GRADING" | "INCOMPLETE_EVIDENCE" | "EVIDENCE_ERROR" | "AWAITING_CAPTURE_ACCEPTANCE";
};

/**
 * The queue and the workstation share the exact ledger admission verdict. `thumbnailUrl` is a
 * deliberately small presentation use of the same admitted working evidence; it is never a
 * substitute grading source and is null unless that side is admitted.
 */
export function projectPartnerQueueEvidence(input: {
  workingEvidence: Record<"front" | "back", WorkingEvidenceStatus>;
  urls: Record<string, string | null>;
  cardJobStatus: string | null;
  gradingStatus: string;
}): PartnerQueueEvidence {
  const side = (
    name: "FRONT" | "BACK",
    status: WorkingEvidenceStatus,
    url: string | null
  ): PartnerQueueEvidenceSide => {
    const label =
      status.state === "admitted"
        ? `${name} ✓`
        : status.state === "missing"
          ? `${name} MISSING`
          : status.state === "invalid"
            ? `${name} INVALID`
            : `${name} UNAVAILABLE`;
    return {
      state: status.state,
      label,
      // A stale URL is never enough. The explicit canonical admission verdict is
      // the only authority that can permit even a queue thumbnail.
      thumbnailUrl: status.state === "admitted" && status.available ? url : null,
      reason: status.reason,
      recovery: status.recovery,
    };
  };

  const front = side("FRONT", input.workingEvidence.front, input.urls.front_working ?? null);
  const back = side("BACK", input.workingEvidence.back, input.urls.back_working ?? null);
  const statuses = [front.state, back.state];
  const workflow = statuses.includes("missing")
    ? "INCOMPLETE_EVIDENCE"
    : statuses.some((state) => state !== "admitted")
      ? "EVIDENCE_ERROR"
      : input.cardJobStatus === "GRADING" || input.gradingStatus === "pending_review"
        ? "IN_GRADING"
        : input.cardJobStatus !== null && input.cardJobStatus !== "READY_TO_GRADE"
          ? "AWAITING_CAPTURE_ACCEPTANCE"
          : "READY_TO_GRADE";
  return { front, back, workflow };
}

async function requireBothImages(auth: PartnerCertAuth): Promise<boolean> {
  // A mutable certificate path or original Partner upload is not proof of a
  // physical capture. Require both CURRENT TIFF masters, each linked to a
  // terminal capture session on an ACTIVE station in this exact location.
  const { rows } = await withPartnerAdminTransaction((client) =>
    client.query<{ side: "front" | "back" }>(
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
      [auth.certId, auth.tenantId, auth.locationId]
    )
  );
  const captured = new Set(rows.map((row) => row.side));
  return captured.has("front") && captured.has("back");
}

export function partnerGradingRouter(): Router {
  const r = Router();
  // BOTH gates are /grading-scoped (AT-23 mount-order defect, 2026-08-14). This router is mounted
  // BEFORE the station router, and a pathless requirePartnerAuth ran for every request that fell
  // through the earlier routers — so a signed-station request (Ed25519 headers, deliberately no
  // session cookie) was 401-rejected here and could never reach the station router at all. Every
  // route this router owns is under /grading, so the scoped guard protects exactly the same
  // surface; everything else falls through to the next router, each of which carries its own
  // guards. Same reasoning as the grading kill switch below, and as the catalogue router's guard.
  r.use("/grading", requirePartnerAuth);
  r.use("/grading", requirePartnerGradingEnabled);

  r.get("/grading/session", requirePartnerCapability("partner.cards.assess"), (req, res) => {
    res.json({ authenticated: true, userId: req.partner!.userId });
  });

  /* ------------------------------------------------------------------------------------------
   * P9 — GRADING EDIT LEASE.
   *
   * Keyed on the CARD JOB — the unit a grader edits and the unit that becomes a permanent MV. All
   * five require partner.cards.assess, so SCANNER_OPERATOR (cards.scan + cards.view, never
   * cards.assess) cannot reach any of them.
   *
   * These do not grade. They decide who MAY grade; the MVGS engine is untouched.
   * ---------------------------------------------------------------------------------------- */
  r.get("/grading/card-jobs/:cardJobId/lease", requirePartnerCapability("partner.cards.assess"), async (req, res) => {
    try {
      res.json({ lease: await getLease(req.partner!, String(req.params.cardJobId)) });
    } catch (error) {
      leaseError(res, error);
    }
  });

  r.post(
    "/grading/card-jobs/:cardJobId/lease",
    requirePartnerCapability("partner.cards.assess"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    async (req, res) => {
      try {
        const result = await acquireLease(req.partner!, String(req.params.cardJobId), req.body?.displayName);
        res.status(result.reacquired ? 200 : 201).json(result);
      } catch (error) {
        leaseError(res, error);
      }
    }
  );

  r.post(
    "/grading/card-jobs/:cardJobId/lease/heartbeat",
    requirePartnerCapability("partner.cards.assess"),
    requireNotViewOnly,
    async (req, res) => {
      try {
        res.json({ lease: await heartbeatLease(req.partner!, String(req.params.cardJobId)) });
      } catch (error) {
        leaseError(res, error);
      }
    }
  );

  r.post(
    "/grading/card-jobs/:cardJobId/lease/release",
    requirePartnerCapability("partner.cards.assess"),
    async (req, res) => {
      try {
        await releaseLease(req.partner!, String(req.params.cardJobId));
        res.json({ ok: true });
      } catch (error) {
        leaseError(res, error);
      }
    }
  );

  /*
   * Taking a card off another grader. Deliberately a SEPARATE route from acquire: it is a different
   * act, it needs org-wide authority and a reason, and it is audited. A flag on acquire would let a
   * UI perform it by accident.
   */
  r.post(
    "/grading/card-jobs/:cardJobId/lease/takeover",
    requirePartnerCapability("partner.cards.assess"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    async (req, res) => {
      try {
        const lease = await takeoverLease(
          req.partner!,
          String(req.params.cardJobId),
          typeof req.body?.reason === "string" ? req.body.reason : "",
          req.body?.displayName
        );
        res.json({ lease });
      } catch (error) {
        leaseError(res, error);
      }
    }
  );

  /* ------------------------------------------------------------------------------------------
   * THE ONE PARTNER GRADING QUEUE.
   *
   * Two lineages, ONE normalised result. There is no second queue and no Dashboard V2: a Scanner
   * Card Job and a legacy connector-imported card arrive in the same list, in the same shape, and
   * open the same workstation.
   *
   * WHY THE OPENABILITY DECISION IS MADE HERE. The browser used to derive it —
   * `gradingStatus === "assigned" && assignedToMe`. A Card Job's certificate is `unassigned` until a
   * grader takes the lease, so that rule renders every Scanner card permanently un-openable, and
   * "teach the browser the second rule too" would put grading authority in browser state. The server
   * decides; the client renders what it is told.
   *
   * DEDUPLICATION. A certificate could in principle be reachable by BOTH lineages (a historical
   * import that also acquired a Card Job). Card Job lineage wins, per the locked architecture, and
   * the card appears exactly once.
   * ---------------------------------------------------------------------------------------- */
  r.get("/grading/queue", requirePartnerCapability("partner.cards.assess"), async (req, res) => {
    try {
      const principal = req.partner!;
      if (!principal.orgWide && !principal.locationId) return res.json({ items: [] });
      const scopedLocationId = principal.orgWide ? null : principal.locationId;

      type QueueRow = {
        lineage: PartnerCertLineage;
        card_job_id: string | null;
        card_job_status: string | null;
        mv_number: string | null;
        cert_id: number;
        cert_id_str: string;
        grader_status: string;
        rejection_reason: string | null;
        redo_count: number;
        card_game: string | null;
        set_name: string | null;
        card_name: string | null;
        card_number: string | null;
        year: string | null;
        language: string | null;
        variant: string | null;
        grade: string | null;
        graded_by: string | null;
        assigned_grader_id: string | null;
        lease_holder: string | null;
        lease_holder_display: string | null;
        submission_id: number | null;
        submission_ref: string | null;
        service_tier: string | null;
        group_key: string;
      };

      const { cardJobRows, connectorRows } = await withPartnerAdminTransaction(async (client) => {
        /* ---- CARD JOB LINEAGE (canonical) ------------------------------------------------------
         * Scoped by tenant AND location in the SQL itself. The live lease is joined so the response
         * can say who is holding a card WITHOUT the client comparing user ids, and without leaking
         * an email or a user id for somebody else's card — only a display name the shop already
         * shows its own staff.
         */
        const cardJob = await client.query<QueueRow>(
          `SELECT 'card_job'::text AS lineage,
                  job.id::text AS card_job_id,
                  job.status AS card_job_status,
                  job.mv_number,
                  cert.id AS cert_id, cert.certificate_number AS cert_id_str,
                  cert.grader_status, cert.rejection_reason, cert.redo_count,
                  cert.card_game, cert.set_name, cert.card_name,
                  cert.card_number_display AS card_number, cert.year_text AS year,
                  cert.language, cert.variant, cert.grade::text, cert.graded_by,
                  cert.assigned_grader_id,
                  lease.holder_user_id::text AS lease_holder,
                  lease.holder_display AS lease_holder_display,
                  NULL::int AS submission_id,
                  job.mv_number AS submission_ref,
                  NULL::text AS service_tier,
                  'card-job:' || job.id::text AS group_key
             FROM partner_card_jobs job
             JOIN certificates cert ON cert.id = job.certificate_id
             LEFT JOIN partner_grading_leases lease
               ON lease.tenant_id = job.tenant_id
              AND lease.card_job_id = job.id
              AND lease.released_at IS NULL
              AND lease.expires_at > now()
            WHERE job.tenant_id = $1
              AND job.cancelled_at IS NULL
              AND job.status IN ('NEEDS_SCAN', 'CAPTURING', 'FIX_REQUIRED', 'READY_TO_GRADE', 'GRADING')
              AND ($2::uuid IS NULL OR job.location_id = $2::uuid)
              AND cert.deleted_at IS NULL
              AND cert.origin_type = 'PARTNER'
              AND cert.origin_partner_id = job.tenant_id
              AND cert.origin_location_id = job.location_id
            ORDER BY job.updated_at DESC, job.id DESC`,
          [principal.tenantId, scopedLocationId]
        );

        /* ---- CONNECTOR LINEAGE (legacy) — the query that shipped, unchanged ------------------- */
        const params: unknown[] = [principal.tenantId, principal.userId];
        let locationWhere = "";
        if (!principal.orgWide && principal.locationId) {
          params.push(principal.locationId);
          locationWhere = `AND pci.partner_location_id = $${params.length}`;
        }
        const connector = await client.query<QueueRow>(
          `SELECT 'connector'::text AS lineage,
                  NULL::text AS card_job_id,
                  NULL::text AS card_job_status,
                  NULL::text AS mv_number,
                  cert.id AS cert_id, cert.certificate_number AS cert_id_str,
                  cert.grader_status, cert.rejection_reason, cert.redo_count,
                  cert.card_game, cert.set_name, cert.card_name,
                  cert.card_number_display AS card_number, cert.year_text AS year,
                  cert.language, cert.variant, cert.grade::text, cert.graded_by,
                  cert.assigned_grader_id,
                  NULL::text AS lease_holder,
                  NULL::text AS lease_holder_display,
                  pci.destination_submission_id AS submission_id,
                  s.tracking_number AS submission_ref,
                  s.service_tier,
                  'submission:' || pci.destination_submission_id::text AS group_key
             FROM certificates cert
             LEFT JOIN cards c ON c.id = cert.card_id
             LEFT JOIN submission_items si ON si.id = cert.submission_item_id
             JOIN submissions s ON s.id = COALESCE(c.submission_id, si.submission_id)
             JOIN partner_connector_imports pci
               ON pci.destination_submission_id = s.id
             JOIN partner_connector_records pcr
               ON pcr.id = pci.connector_record_id
              AND pcr.tenant_id = pci.partner_organisation_id
              AND pcr.partner_submission_id = pci.partner_submission_id
              AND pcr.handoff_id = pci.partner_handoff_id
              AND pcr.state = 'imported'
             JOIN partner_submissions ps
               ON ps.id = pci.partner_submission_id
              AND ps.tenant_id = pci.partner_organisation_id
              AND ps.location_id = pci.partner_location_id
             JOIN partner_submission_handoffs psh
               ON psh.id = pci.partner_handoff_id
              AND psh.tenant_id = pci.partner_organisation_id
              AND psh.submission_id = pci.partner_submission_id
            WHERE pci.partner_organisation_id = $1
              AND pci.state IN ('completed','imported')
              AND cert.assigned_grader_id = $2
              AND cert.grader_status IN ('assigned','pending_review')
              AND cert.deleted_at IS NULL
              AND cert.origin_type = 'PARTNER'
              AND cert.origin_partner_id = pci.partner_organisation_id
              AND cert.origin_location_id = pci.partner_location_id
              ${locationWhere}
            ORDER BY cert.assigned_at DESC NULLS LAST, cert.id DESC`,
          params
        );
        return { cardJobRows: cardJob.rows, connectorRows: connector.rows };
      });

      /*
       * CARD JOB LINEAGE WINS on any certificate both queries can resolve, so the same physical card
       * is never offered twice under two different sets of rules.
       */
      const seen = new Set(cardJobRows.map((row) => Number(row.cert_id)));
      const rows = [...cardJobRows, ...connectorRows.filter((row) => !seen.has(Number(row.cert_id)))];
      const evidenceByCertificate = await buildWorkingEvidencePayloads(rows.map((row) => Number(row.cert_id)));

      const byGroup = new Map<string, Record<string, unknown>>();
      for (const row of rows) {
        const heldByMe = row.lease_holder !== null && row.lease_holder === principal.userId;
        const heldByAnother = row.lease_holder !== null && row.lease_holder !== principal.userId;
        const gradedByMe = String(row.graded_by ?? "") === principal.userId;
        const assignedToMe = String(row.assigned_grader_id ?? "") === principal.userId;
        const evidencePayload = evidenceByCertificate.get(Number(row.cert_id));
        if (!evidencePayload) throw new Error("Queue evidence projection is missing its certificate binding.");
        const evidence = projectPartnerQueueEvidence({
          workingEvidence: evidencePayload.workingEvidence,
          urls: evidencePayload.urls,
          cardJobStatus: row.card_job_status,
          gradingStatus: row.grader_status,
        });

        /*
         * SERVER-DERIVED OPENABILITY.
         *
         * card_job  — READY_TO_GRADE is open to any grader with the permission (the lease decides who
         *             actually gets it, atomically, when they try). GRADING is open only to the
         *             holder, or to anyone if the lease has lapsed — reopening then is legitimate and
         *             the acquire will either succeed or tell them who holds it.
         * connector — exactly the rule the client used to apply, unchanged, now computed here.
         */
        const openable =
          row.lineage === "card_job"
            ? row.card_job_status === "READY_TO_GRADE" || (row.card_job_status === "GRADING" && !heldByAnother)
            : (row.grader_status === "assigned" && assignedToMe) ||
              (row.grader_status === "pending_review" && gradedByMe);

        if (!byGroup.has(row.group_key)) {
          byGroup.set(row.group_key, {
            groupKey: row.group_key,
            lineage: row.lineage,
            submissionId: row.submission_id === null ? null : Number(row.submission_id),
            submissionRef: row.submission_ref,
            serviceTier: row.service_tier ?? null,
            cards: [] as unknown[],
          });
        }
        (byGroup.get(row.group_key)!.cards as unknown[]).push({
          lineage: row.lineage,
          cardJobId: row.card_job_id,
          cardJobStatus: row.card_job_status,
          mvNumber: row.mv_number,
          certId: Number(row.cert_id),
          certIdStr: row.cert_id_str,
          cardGame: row.card_game ?? null,
          setName: row.set_name ?? null,
          cardName: row.card_name ?? null,
          cardNumber: row.card_number ?? null,
          year: row.year ?? null,
          language: row.language ?? null,
          variant: row.variant ?? null,
          grade: row.grade ?? null,
          gradingStatus: row.grader_status,
          rejectionReason: row.rejection_reason ?? null,
          redoCount: Number(row.redo_count ?? 0),
          assignedToMe: row.lineage === "card_job" ? heldByMe : assignedToMe,
          gradedByMe,
          openable,
          evidence,
          // A display name the shop already shows its own staff — never an email or a user id.
          heldBy: heldByAnother ? (row.lease_holder_display ?? "Another grader") : null,
        });
      }
      res.json({ items: Array.from(byGroup.values()) });
    } catch (err) {
      sendPartnerGradingError(res, err);
    }
  });

  r.get(
    "/grading/certificates/:id/images",
    requirePartnerCapability("partner.cards.assess"),
    partnerGradingReadRateLimit,
    async (req, res) => {
      try {
        const certId = numericId(req.params.id);
        if (!certId) return res.status(400).json({ error: "Invalid certificate id" });
        const auth = authorizeAssignedPartnerCert(req.partner!, await loadPartnerCert(req.partner!, certId));
        if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
        res.json(await imagesForPartnerCert(auth.auth));
      } catch (err) {
        sendPartnerGradingError(res, err);
      }
    }
  );

  r.get(
    "/grading/certificates/:id/grading",
    requirePartnerCapability("partner.cards.assess"),
    partnerGradingReadRateLimit,
    async (req, res) => {
      try {
        const certId = numericId(req.params.id);
        if (!certId) return res.status(400).json({ error: "Invalid certificate id" });
        const auth = authorizeAssignedPartnerCert(req.partner!, await loadPartnerCert(req.partner!, certId));
        if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
        const payload = await buildCertGradingPayload(certId);
        if (!payload) return res.status(404).json({ error: "Not found" });
        res.json(stripGraderPii(payload));
      } catch (err) {
        sendPartnerGradingError(res, err);
      }
    }
  );

  r.post(
    "/grading/certificates/label/preview",
    requirePartnerCapability("partner.cards.preview"),
    partnerGradingPreviewRateLimit,
    async (req, res) => {
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const certId = numericId(body.certificateId ?? body.id);
        if (!certId) return res.status(400).json({ error: "Valid certificateId required" });

        // This is the same tenant/location/provenance lookup and per-user
        // assignment check used by every other Partner grading read/write.
        const candidate = await loadPartnerCert(req.partner!, certId);
        const access = authorizePartnerLabelPreview(req.partner!, candidate);
        if (!access.ok) return res.status(access.status).json({ error: access.error });
        const auth = authorizeAssignedPartnerCert(req.partner!, candidate);
        if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
        const partnerBlocks = await getPartnerPrintEligibilityBlocks([auth.auth.certificateNumber]);
        if (partnerBlocks.length > 0) {
          return res.status(409).json({ error: partnerBlocks[0].message, code: partnerBlocks[0].code });
        }

        const saved = await storage.getCertificate(certId);
        if (!saved) return res.status(404).json({ error: "Not found" });
        const expected = expectedReviewRevision(body.expectedRevision);
        if (expected == null) {
          return res.status(400).json({ error: "A valid expectedRevision is required for certificate preview" });
        }
        const actual = Number((saved as CertificateRecord).gradingRevision);
        if (!Number.isSafeInteger(actual) || actual < 1) {
          return res.status(500).json({ error: "Certificate has an invalid grading revision" });
        }
        if (actual !== expected) {
          return res.status(409).json({
            code: "STALE_REVIEW",
            error: "This card changed after the saved review. Refresh the saved review before approving.",
          });
        }
        const cert = await buildLabelPreviewCertificate(saved as CertificateRecord, body);
        const verdict = checkPrintableGrade({ gradeType: cert.gradeType, gradeOverall: cert.gradeOverall });
        if (!verdict.printable) {
          return res.status(422).json({
            error:
              verdict.reason === "missing_numeric_grade"
                ? "Not graded yet — the preview appears once a grade is set."
                : (verdict.message ?? "This certificate's grade cannot be previewed yet."),
            code: "UNPRINTABLE_GRADE",
            reason: verdict.reason,
          });
        }

        const png = await generateLabelPreviewPNG(cert);
        // Detect a mutation that raced the render itself. A pre-render revision
        // comparison alone would otherwise acknowledge stale pixels as ready.
        const current = await storage.getCertificate(certId);
        const currentRevision = Number((current as CertificateRecord | undefined)?.gradingRevision);
        if (currentRevision !== expected) {
          return res.status(409).json({
            code: "STALE_REVIEW",
            error:
              "This card changed while its certificate preview was preparing. Refresh the saved review before approving.",
          });
        }
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-MintVault-Review-Revision", String(actual));
        res.setHeader("Access-Control-Expose-Headers", "X-MintVault-Review-Revision");
        return res.send(png);
      } catch (err) {
        if (err instanceof UnprintableGradeError) {
          return res.status(422).json({ error: err.message, code: "UNPRINTABLE_GRADE", reason: err.reason });
        }
        sendPartnerGradingError(res, err);
      }
    }
  );

  r.put(
    "/grading/certificates/:id/grade",
    requirePartnerCapability("partner.cards.assess"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    partnerGradingEditRateLimit,
    async (req, res) => {
      try {
        const certId = numericId(req.params.id);
        if (!certId) return res.status(400).json({ error: "Invalid certificate id" });
        const auth = authorizeAssignedPartnerCert(req.partner!, await loadPartnerCert(req.partner!, certId));
        if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
        const editable = draftEditability(auth.auth, req.partner!);
        if (!editable.ok) return res.status(editable.status).json({ error: editable.error });
        let leaseRevision: number | null;
        try {
          leaseRevision = await requireLeaseForCertificateWrite(req.partner!, certId, req.body);
        } catch (leaseFailure) {
          return leaseError(res, leaseFailure);
        }
        const saved = await applyCertGradeDraft(
          certId,
          req.body || {},
          partnerDraftWriteGuard(req.partner!, auth.auth)
        );
        if (!saved) return res.status(409).json({ error: "Card status changed; refresh and try again" });
        await auditInOwnTxn({
          tenantId: req.partner!.tenantId,
          locationId: auth.auth.locationId,
          actorUserId: req.partner!.userId,
          action: "grading.draft_saved",
          recordType: "certificate",
          recordId: String(certId),
          sessionId: req.partner!.sessionId,
          correlationId: auth.auth.partnerSubmissionId,
        });
        const payload = await buildCertGradingPayload(certId);
        res.json({
          ok: true,
          gradingStatus: auth.auth.gradingStatus,
          reviewRevision: saved,
          // The lease revision the client's NEXT write must present. Null for a connector card,
          // which has no lease — the client sends nothing back and the guard stays inert.
          leaseRevision,
          authoritativeGrade: payload?.authoritativeGrade ?? null,
        });
      } catch (err) {
        sendPartnerGradingError(res, err);
      }
    }
  );

  /* ------------------------------------------------------------------------------------------
   * SUBMIT — the edge past which a grade is a submitted assessment.
   *
   * CARD JOB LINEAGE goes through `submitCardJobForReview`, which commits the lifecycle transition,
   * the certificate hand-off to QA and the Grading Credit settlement in ONE transaction. Migration
   * 0080 names SUBMITTED "credit consumed exactly once at this edge"; nothing implemented that until
   * now, because the only settlement path in the repository is keyed on a connector destination
   * submission a walk-in card does not have.
   *
   * CONNECTOR LINEAGE keeps the statement that shipped, unchanged — including its assigned-grader and
   * connector-mapping predicates.
   * ---------------------------------------------------------------------------------------- */
  r.post(
    "/grading/certificates/:id/submit",
    requirePartnerCapability("partner.cards.assess"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    partnerGradingEditRateLimit,
    async (req, res) => {
      try {
        const certId = numericId(req.params.id);
        if (!certId) return res.status(400).json({ error: "Invalid certificate id" });
        const auth = authorizeAssignedPartnerCert(req.partner!, await loadPartnerCert(req.partner!, certId));
        if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

        /*
         * SUBMITTABILITY, by lineage.
         *
         * card_job  — the CARD JOB must be in GRADING, i.e. somebody opened it and holds the lease.
         *             A job already SUBMITTED/QA_REVIEW is not refused here: it falls through to the
         *             bridge, which answers it as an idempotent REPLAY rather than a second submit.
         * connector — `grader_status = 'assigned'`, exactly as before.
         */
        if (auth.auth.lineage === "card_job") {
          const submittable =
            auth.auth.cardJobStatus === "GRADING" ||
            auth.auth.cardJobStatus === "SUBMITTED" ||
            auth.auth.cardJobStatus === "QA_REVIEW";
          if (!submittable) {
            return res
              .status(409)
              .json({ error: `This card is ${auth.auth.cardJobStatus}, so it cannot be submitted for review.` });
          }
        } else if (auth.auth.gradingStatus !== "assigned") {
          return res.status(409).json({ error: `Card is '${auth.auth.gradingStatus}', not submittable` });
        }

        if (!(await requireBothImages(auth.auth))) {
          return res
            .status(409)
            .json({ error: "Capture front and back on the approved station before submitting grades." });
        }

        /*
         * A REPLAY MUST NOT BE REFUSED BY THE LEASE.
         *
         * On a genuine retry the first attempt already bumped the lease revision, so presenting the
         * revision the client still holds would fail STALE_REVISION — turning a safe, idempotent
         * retry into a dead end for a card that HAS been submitted. So the replay is detected first,
         * on the locked Card Job row, and answered before the lease is consulted.
         */
        if (auth.auth.lineage === "card_job" && auth.auth.cardJobStatus !== "GRADING") {
          const replay = await submitCardJobForReview(req.partner!, certId);
          return res.json({
            ok: true,
            gradingStatus: "pending_review",
            reviewRequired: true,
            lineage: "card_job",
            cardJobId: replay.cardJobId,
            cardJobStatus: replay.status,
            submitted: replay.submitted,
            creditSettled: replay.creditSettled,
          });
        }

        // SUBMIT is a write like any other, and the most consequential one. A stale editor must be
        // refused HERE, not merely on the incremental saves that preceded it.
        try {
          await requireLeaseForCertificateWrite(req.partner!, certId, req.body);
        } catch (leaseFailure) {
          return leaseError(res, leaseFailure);
        }
        if (req.body && Object.keys(req.body).length) {
          const saved = await applyCertGradeDraft(certId, req.body, partnerDraftWriteGuard(req.partner!, auth.auth));
          if (!saved) return res.status(409).json({ error: "Card status changed; refresh and try again" });
        }

        if (auth.auth.lineage === "card_job") {
          let result;
          try {
            result = await submitCardJobForReview(req.partner!, certId);
          } catch (bridgeFailure) {
            if (sendCardJobError(res, bridgeFailure)) return;
            throw bridgeFailure;
          }
          await storage.writeAuditLog("certificate", String(certId), "partner_grade_submit", req.partner!.userId, {
            tenant_id: req.partner!.tenantId,
            partner_card_job_id: result.cardJobId,
            partner_submission_id: auth.auth.partnerSubmissionId,
            review_required: true,
            credit_settled: result.creditSettled,
          });
          return res.json({
            ok: true,
            gradingStatus: "pending_review",
            reviewRequired: true,
            lineage: "card_job",
            cardJobId: result.cardJobId,
            cardJobStatus: result.status,
            submitted: result.submitted,
            creditSettled: result.creditSettled,
          });
        }

        const submitted = await db.execute(sql`
          UPDATE certificates SET
            grader_status = 'pending_review',
            review_required = true,
            graded_at = NOW(),
            graded_by = ${req.partner!.userId},
            operator_grade = grade,
            operator_subgrades = jsonb_build_object(
              'centering', centering_score,
              'corners', corners_score,
              'edges', edges_score,
              'surface', surface_score
            ),
            updated_at = NOW()
          WHERE id = ${certId}
            AND assigned_grader_id = ${req.partner!.userId}
            AND grader_status = 'assigned'
            AND deleted_at IS NULL
            AND EXISTS (
              SELECT 1
                FROM certificates cert_check
                LEFT JOIN cards c ON c.id = cert_check.card_id
                LEFT JOIN submission_items si ON si.id = cert_check.submission_item_id
                JOIN submissions s ON s.id = COALESCE(c.submission_id, si.submission_id)
                JOIN partner_connector_imports pci ON pci.destination_submission_id = s.id
                JOIN partner_connector_records pcr
                  ON pcr.id = pci.connector_record_id
                 AND pcr.tenant_id = pci.partner_organisation_id
                 AND pcr.partner_submission_id = pci.partner_submission_id
                 AND pcr.handoff_id = pci.partner_handoff_id
                 AND pcr.state = 'imported'
                JOIN partner_submissions ps
                  ON ps.id = pci.partner_submission_id
                 AND ps.tenant_id = pci.partner_organisation_id
                 AND ps.location_id = pci.partner_location_id
                JOIN partner_submission_handoffs psh
                  ON psh.id = pci.partner_handoff_id
                 AND psh.tenant_id = pci.partner_organisation_id
                 AND psh.submission_id = pci.partner_submission_id
               WHERE cert_check.id = certificates.id
                 AND cert_check.origin_type = 'PARTNER'
                 AND cert_check.origin_partner_id = pci.partner_organisation_id
                 AND cert_check.origin_location_id = pci.partner_location_id
                 AND pci.partner_organisation_id = ${req.partner!.tenantId}
                 AND (${req.partner!.orgWide} OR pci.partner_location_id = ${req.partner!.locationId})
                 AND pci.state IN ('completed','imported')
            )
          RETURNING id
        `);
        if (submitted.rows.length !== 1) {
          return res.status(409).json({ error: "Card status changed; refresh and try again" });
        }
        await storage.writeAuditLog("certificate", String(certId), "partner_grade_submit", req.partner!.userId, {
          tenant_id: req.partner!.tenantId,
          partner_submission_id: auth.auth.partnerSubmissionId,
          review_required: true,
        });
        await auditInOwnTxn({
          tenantId: req.partner!.tenantId,
          locationId: auth.auth.locationId,
          actorUserId: req.partner!.userId,
          action: "grading.submitted_for_review",
          recordType: "certificate",
          recordId: String(certId),
          sessionId: req.partner!.sessionId,
          correlationId: auth.auth.partnerSubmissionId,
          after: { gradingStatus: "pending_review", reviewRequired: true },
        });
        res.json({ ok: true, gradingStatus: "pending_review", reviewRequired: true, lineage: "connector" });
      } catch (err) {
        if (sendCardJobError(res, err)) return;
        sendPartnerGradingError(res, err);
      }
    }
  );

  r.post(
    "/grading/certificates/:id/edit-submission",
    requirePartnerCapability("partner.cards.assess"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    partnerGradingEditRateLimit,
    async (req, res) => {
      try {
        const certId = numericId(req.params.id);
        if (!certId) return res.status(400).json({ error: "Invalid certificate id" });
        const auth = authorizeAssignedPartnerCert(req.partner!, await loadPartnerCert(req.partner!, certId));
        if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
        /*
         * CONNECTOR LINEAGE ONLY, deliberately.
         *
         * This route lets the grader who submitted a card amend it while it still sits in
         * `pending_review` — the legacy path's self-service correction, preserved unchanged.
         *
         * A Card Job cannot travel it. Once submitted, a Card Job is in QA_REVIEW, and the pilot is
         * 100% Super Admin QA: a grader amending the card under review would mean the reviewer
         * approves something other than what they read. The Card Job correction path is RETURN TO
         * GRADER, which returns the job to GRADING with its history and revisions preserved and an
         * audit row saying who returned it and why. Refusing here rather than quietly allowing it is
         * what keeps that single QA authority real.
         */
        if (auth.auth.lineage === "card_job") {
          return res.status(409).json({
            code: "CARD_JOB_QA_OWNED",
            error: "This card is with Super Admin review. It must be returned to you before it can be edited again.",
          });
        }
        if (auth.auth.gradingStatus !== "pending_review") {
          return res.status(409).json({ error: `Card is '${auth.auth.gradingStatus}', not editable as submitted` });
        }
        if (auth.auth.gradedBy && auth.auth.gradedBy !== req.partner!.userId) {
          return res.status(403).json({ error: "Only the partner user who submitted this card can edit it" });
        }
        if (!(await requireBothImages(auth.auth))) {
          return res
            .status(409)
            .json({ error: "Capture front and back on the approved station before submitting grades." });
        }
        try {
          await requireLeaseForCertificateWrite(req.partner!, certId, req.body);
        } catch (leaseFailure) {
          return leaseError(res, leaseFailure);
        }
        const saved = await applyCertGradeDraft(
          certId,
          req.body || {},
          partnerDraftWriteGuard(req.partner!, auth.auth)
        );
        if (!saved) return res.status(409).json({ error: "Card status changed; refresh and try again" });
        const edited = await db.execute(sql`
          UPDATE certificates SET
            grader_status = 'pending_review',
            review_required = true,
            graded_at = NOW(),
            graded_by = ${req.partner!.userId},
            operator_grade = grade,
            operator_subgrades = jsonb_build_object(
              'centering', centering_score,
              'corners', corners_score,
              'edges', edges_score,
              'surface', surface_score
            ),
            updated_at = NOW()
          WHERE id = ${certId}
            AND assigned_grader_id = ${req.partner!.userId}
            AND grader_status = 'pending_review'
            AND deleted_at IS NULL
            AND EXISTS (
              SELECT 1
                FROM certificates cert_check
                LEFT JOIN cards c ON c.id = cert_check.card_id
                LEFT JOIN submission_items si ON si.id = cert_check.submission_item_id
                JOIN submissions s ON s.id = COALESCE(c.submission_id, si.submission_id)
                JOIN partner_connector_imports pci ON pci.destination_submission_id = s.id
                JOIN partner_connector_records pcr
                  ON pcr.id = pci.connector_record_id
                 AND pcr.tenant_id = pci.partner_organisation_id
                 AND pcr.partner_submission_id = pci.partner_submission_id
                 AND pcr.handoff_id = pci.partner_handoff_id
                 AND pcr.state = 'imported'
                JOIN partner_submissions ps
                  ON ps.id = pci.partner_submission_id
                 AND ps.tenant_id = pci.partner_organisation_id
                 AND ps.location_id = pci.partner_location_id
                JOIN partner_submission_handoffs psh
                  ON psh.id = pci.partner_handoff_id
                 AND psh.tenant_id = pci.partner_organisation_id
                 AND psh.submission_id = pci.partner_submission_id
               WHERE cert_check.id = certificates.id
                 AND cert_check.origin_type = 'PARTNER'
                 AND cert_check.origin_partner_id = pci.partner_organisation_id
                 AND cert_check.origin_location_id = pci.partner_location_id
                 AND pci.partner_organisation_id = ${req.partner!.tenantId}
                 AND (${req.partner!.orgWide} OR pci.partner_location_id = ${req.partner!.locationId})
                 AND pci.state IN ('completed','imported')
            )
          RETURNING id
        `);
        if (edited.rows.length !== 1) {
          return res.status(409).json({ error: "Card status changed; refresh and try again" });
        }
        await storage.writeAuditLog(
          "certificate",
          String(certId),
          "partner_grade_edit_submission",
          req.partner!.userId,
          {
            tenant_id: req.partner!.tenantId,
            partner_submission_id: auth.auth.partnerSubmissionId,
            review_required: true,
          }
        );
        await auditInOwnTxn({
          tenantId: req.partner!.tenantId,
          locationId: auth.auth.locationId,
          actorUserId: req.partner!.userId,
          action: "grading.submission_edited_for_review",
          recordType: "certificate",
          recordId: String(certId),
          sessionId: req.partner!.sessionId,
          correlationId: auth.auth.partnerSubmissionId,
          after: { gradingStatus: "pending_review", reviewRequired: true },
        });
        const payload = await buildCertGradingPayload(certId);
        res.json({
          ok: true,
          gradingStatus: "pending_review",
          changed: Object.keys(req.body || {}),
          authoritativeGrade: payload?.authoritativeGrade ?? null,
        });
      } catch (err) {
        sendPartnerGradingError(res, err);
      }
    }
  );

  return r;
}
