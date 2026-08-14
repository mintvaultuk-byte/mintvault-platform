/**
 * Partner grading adapter.
 *
 * This is deliberately a role/ownership adapter over the existing MVGS certificate
 * workflow. It does not score, publish, create certificates, print labels, settle
 * credits, or duplicate the grader engine. A partner may only grade a certificate
 * that is:
 *   - mapped back to their tenant through partner_connector_imports,
 *   - in their selected/org-wide location scope,
 *   - assigned to their partner user id,
 *   - not already approved or deleted.
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
  GradeDraftRejected,
  stripGraderPii,
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

type PartnerCertAuth = {
  certId: number;
  certificateNumber: string;
  gradingStatus: string;
  assignedGraderId: string | null;
  gradedBy: string | null;
  tenantId: string;
  locationId: string | null;
  partnerSubmissionId: string;
  destinationSubmissionId: number;
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

async function loadPartnerCert(principal: PartnerPrincipal, certId: number): Promise<PartnerCertAuth | null> {
  if (!principal.orgWide && !principal.locationId) return null;
  const { rows } = await withPartnerAdminTransaction((client) =>
    client.query<PartnerCertAuth>(
      `SELECT cert.id AS "certId",
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

function authorizeAssignedPartnerCert(principal: PartnerPrincipal, auth: PartnerCertAuth | null) {
  if (!auth) return { ok: false as const, status: 404, error: "Not found" };
  if (auth.assignedGraderId !== principal.userId) {
    return { ok: false as const, status: 403, error: "This card is not assigned to you" };
  }
  if (auth.gradingStatus === "approved") {
    return { ok: false as const, status: 403, error: "This card is already approved" };
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

function partnerDraftWriteGuard(principal: PartnerPrincipal) {
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
  if (!auth.cardIndex) return {};
  const row = await withPartnerAdminTransaction((client) =>
    partnerCardImagesForCardIndex(client, {
      tenantId: auth.tenantId,
      partnerSubmissionId: auth.partnerSubmissionId,
      destinationSubmissionId: auth.destinationSubmissionId,
      cardIndex: auth.cardIndex as number,
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
  const payload = (await buildCertImagesPayload(auth.certId)) ?? { urls: {}, quality: {} };
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
  };
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
  r.use(requirePartnerAuth);
  // This router is mounted at the portal root so its auth middleware can protect
  // the grading routes. Scope the grading kill switch to its own prefix: a
  // router-wide gate would otherwise intercept submissions, customers and every
  // later portal router before their handlers can run.
  r.use("/grading", requirePartnerGradingEnabled);

  r.get("/grading/session", requirePartnerCapability("partner.cards.assess"), (req, res) => {
    res.json({ authenticated: true, userId: req.partner!.userId });
  });

  r.get("/grading/queue", requirePartnerCapability("partner.cards.assess"), async (req, res) => {
    try {
      const principal = req.partner!;
      if (!principal.orgWide && !principal.locationId) return res.json({ items: [] });
      const params: unknown[] = [principal.tenantId, principal.userId];
      let locationWhere = "";
      if (!principal.orgWide && principal.locationId) {
        params.push(principal.locationId);
        locationWhere = `AND pci.partner_location_id = $${params.length}`;
      }
      const { rows } = await withPartnerAdminTransaction((client) =>
        client.query(
          `SELECT cert.id AS cert_id, cert.certificate_number AS cert_id_str,
                  cert.grader_status, cert.rejection_reason, cert.redo_count,
                  cert.card_game, cert.set_name, cert.card_name,
                  cert.card_number_display AS card_number, cert.year_text AS year,
                  cert.language, cert.variant, cert.grade::text, cert.graded_by,
                  pci.destination_submission_id AS submission_id,
                  s.tracking_number AS submission_ref,
                  s.service_tier
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
              -- Ready to Grade is a physical-capture state, not merely a
              -- connector-import/assignment state.  Each side must be the
              -- current immutable TIFF accepted by a terminal session on an
              -- active station in this exact Partner location.  Keep this
              -- predicate here (rather than trusting a browser transition) so
              -- a guessed certificate ID can never make an uncaptured card
              -- appear in the operational queue.
              AND EXISTS (
                SELECT 1
                  FROM certificate_image_evidence evidence
                  JOIN scanner_capture_sessions session
                    ON session.id = evidence.capture_metadata ->> 'captureSessionId'
                   AND session.certificate_id = evidence.certificate_id
                   AND session.side = evidence.side
                   AND session.state = 'captured'
                  JOIN partner_stations station
                    ON station.id = session.station_id
                   AND station.status = 'ACTIVE'
                   AND station.tenant_id = pci.partner_organisation_id
                   AND station.location_id = pci.partner_location_id
                 WHERE evidence.certificate_id = cert.id
                   AND evidence.side = 'front'
                   AND evidence.is_current = true
                   AND evidence.evidence_class = 'NEW_IMMUTABLE_MASTER'
                   AND evidence.format = 'tiff'
              )
              AND EXISTS (
                SELECT 1
                  FROM certificate_image_evidence evidence
                  JOIN scanner_capture_sessions session
                    ON session.id = evidence.capture_metadata ->> 'captureSessionId'
                   AND session.certificate_id = evidence.certificate_id
                   AND session.side = evidence.side
                   AND session.state = 'captured'
                  JOIN partner_stations station
                    ON station.id = session.station_id
                   AND station.status = 'ACTIVE'
                   AND station.tenant_id = pci.partner_organisation_id
                   AND station.location_id = pci.partner_location_id
                 WHERE evidence.certificate_id = cert.id
                   AND evidence.side = 'back'
                   AND evidence.is_current = true
                   AND evidence.evidence_class = 'NEW_IMMUTABLE_MASTER'
                   AND evidence.format = 'tiff'
              )
              ${locationWhere}
            ORDER BY cert.assigned_at DESC NULLS LAST, cert.id DESC`,
          params
        )
      );
      const bySub = new Map<string, any>();
      for (const row of rows as any[]) {
        const key = String(row.submission_id);
        if (!bySub.has(key)) {
          bySub.set(key, {
            submissionId: Number(row.submission_id),
            submissionRef: row.submission_ref,
            serviceTier: row.service_tier ?? null,
            cards: [],
          });
        }
        bySub.get(key).cards.push({
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
          assignedToMe: true,
          gradedByMe: String(row.graded_by ?? "") === principal.userId,
        });
      }
      res.json({ items: Array.from(bySub.values()) });
    } catch (err) {
      sendPartnerGradingError(res, err);
    }
  });

  r.get("/grading/certificates/:id/images", requirePartnerCapability("partner.cards.assess"), partnerGradingReadRateLimit, async (req, res) => {
    try {
      const certId = numericId(req.params.id);
      if (!certId) return res.status(400).json({ error: "Invalid certificate id" });
      const auth = authorizeAssignedPartnerCert(req.partner!, await loadPartnerCert(req.partner!, certId));
      if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
      res.json(await imagesForPartnerCert(auth.auth));
    } catch (err) {
      sendPartnerGradingError(res, err);
    }
  });

  r.get("/grading/certificates/:id/grading", requirePartnerCapability("partner.cards.assess"), partnerGradingReadRateLimit, async (req, res) => {
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
  });

  r.post("/grading/certificates/label/preview", requirePartnerCapability("partner.cards.preview"), partnerGradingPreviewRateLimit, async (req, res) => {
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
  });

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
        if (!EDITABLE_STATUSES.has(auth.auth.gradingStatus)) {
          return res.status(409).json({ error: `Card is '${auth.auth.gradingStatus}', not editable` });
        }
        if (
          auth.auth.gradingStatus === "pending_review" &&
          auth.auth.gradedBy &&
          auth.auth.gradedBy !== req.partner!.userId
        ) {
          return res.status(403).json({ error: "Only the partner user who submitted this card can edit it" });
        }
        const saved = await applyCertGradeDraft(certId, req.body || {}, partnerDraftWriteGuard(req.partner!));
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
          authoritativeGrade: payload?.authoritativeGrade ?? null,
        });
      } catch (err) {
        sendPartnerGradingError(res, err);
      }
    }
  );

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
        if (auth.auth.gradingStatus !== "assigned") {
          return res.status(409).json({ error: `Card is '${auth.auth.gradingStatus}', not submittable` });
        }
        if (!(await requireBothImages(auth.auth))) {
          return res
            .status(409)
            .json({ error: "Capture front and back on the approved station before submitting grades." });
        }
        if (req.body && Object.keys(req.body).length) {
          const saved = await applyCertGradeDraft(certId, req.body, partnerDraftWriteGuard(req.partner!));
          if (!saved) return res.status(409).json({ error: "Card status changed; refresh and try again" });
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
        res.json({ ok: true, gradingStatus: "pending_review", reviewRequired: true });
      } catch (err) {
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
        const saved = await applyCertGradeDraft(certId, req.body || {}, partnerDraftWriteGuard(req.partner!));
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
