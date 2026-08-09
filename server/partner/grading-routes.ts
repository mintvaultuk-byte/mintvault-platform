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
import type { Response } from "express";
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
import { withPartnerAdminTransaction } from "./db";
import {
  requireNotSensitiveFrozen,
  requireNotViewOnly,
  requirePartnerAuth,
  requirePartnerCapability,
  type PartnerPrincipal,
} from "./session";

type PartnerCertAuth = {
  certId: number;
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

async function loadPartnerCert(principal: PartnerPrincipal, certId: number): Promise<PartnerCertAuth | null> {
  if (!principal.orgWide && !principal.locationId) return null;
  const { rows } = await withPartnerAdminTransaction((client) =>
    client.query<PartnerCertAuth>(
      `SELECT cert.id AS "certId",
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
              true AS "provenanceValid"
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
         AND pci.partner_organisation_id = ${principal.tenantId}
         AND (${principal.orgWide} OR pci.partner_location_id = ${principal.locationId})
         AND pci.state IN ('completed','imported')
    )
  `;
}

async function partnerImageFallback(auth: PartnerCertAuth): Promise<Record<string, string | null>> {
  if (!auth.cardIndex) return {};
  const { rows } = await withPartnerAdminTransaction((client) =>
    client.query<{ front_image_key: string | null; back_image_key: string | null }>(
      `SELECT front_image_key, back_image_key
         FROM partner_submission_cards
        WHERE tenant_id = $1
          AND submission_id = $2
          AND sequence_number = $3
          AND removed_at IS NULL`,
      [auth.tenantId, auth.partnerSubmissionId, auth.cardIndex]
    )
  );
  const row = rows[0];
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
  return {
    urls: {
      ...payload.urls,
      ...Object.fromEntries(Object.entries(fallback).filter(([, value]) => value)),
    },
    quality: payload.quality ?? {},
  };
}

async function requireBothImages(auth: PartnerCertAuth): Promise<boolean> {
  const images = await imagesForPartnerCert(auth);
  const urls = images.urls ?? {};
  return !!(urls.front_display || urls.front_original) && !!(urls.back_display || urls.back_original);
}

export function partnerGradingRouter(): Router {
  const r = Router();
  r.use(requirePartnerAuth);

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

  r.get("/grading/certificates/:id/images", requirePartnerCapability("partner.cards.assess"), async (req, res) => {
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

  r.get("/grading/certificates/:id/grading", requirePartnerCapability("partner.cards.assess"), async (req, res) => {
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

  r.post("/grading/certificates/label/preview", requirePartnerCapability("partner.cards.preview"), async (req, res) => {
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
          error: "This card changed while its certificate preview was preparing. Refresh the saved review before approving.",
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
        res.json({ ok: true, gradingStatus: auth.auth.gradingStatus, reviewRevision: saved });
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
          return res.status(409).json({ error: "Upload front and back images before submitting grades." });
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
          return res.status(409).json({ error: "Upload front and back images before submitting grades." });
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
        res.json({ ok: true, gradingStatus: "pending_review", changed: Object.keys(req.body || {}) });
      } catch (err) {
        sendPartnerGradingError(res, err);
      }
    }
  );

  return r;
}
