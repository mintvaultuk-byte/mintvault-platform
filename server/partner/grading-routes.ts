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
import { getR2SignedUrl, headR2 } from "../r2";
import { storage } from "../storage";
import { applyCertGradeDraft, buildCertGradingPayload, GradeDraftRejected, stripGraderPii } from "../grader";
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
  partnerSubmissionCardId: string | null;
  destinationSubmissionId: number;
  submissionItemId: number | null;
  submissionRef: string | null;
  serviceTier: string | null;
  cardOrdinal: number | null;
  frontImageKey: string | null;
  backImageKey: string | null;
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
};

const EDITABLE_STATUSES = new Set(["assigned", "returned_for_change"]);
const PARTNER_GRADING_PROXY_ACTIONS = new Set(["recrop", "manual-centering", "detect-card-bounds", "identify"]);
const FINAL_WORK_ITEM_STATUSES = sql`('assigned','returned_for_change')`;

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

function partnerGradeBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const clean = { ...(body as Record<string, unknown>) };
  delete clean.private_notes;
  delete clean.privateNotes;
  return clean;
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
              pgwi.partner_submission_card_id::text AS "partnerSubmissionCardId",
              pci.destination_submission_id::int AS "destinationSubmissionId",
              si.id::int AS "submissionItemId",
              s.tracking_number AS "submissionRef",
              s.service_tier AS "serviceTier",
              pgwi.card_ordinal::int AS "cardOrdinal",
              pgwi.front_image_key AS "frontImageKey",
              pgwi.back_image_key AS "backImageKey",
              cert.card_game AS "cardGame",
              cert.set_name AS "setName",
              cert.card_name AS "cardName",
              cert.card_number_display AS "cardNumber",
              cert.year_text AS "year",
              cert.language,
              cert.variant,
              cert.grade::text,
              cert.rejection_reason AS "rejectionReason",
              cert.redo_count::int AS "redoCount"
         FROM certificates cert
         LEFT JOIN cards c ON c.id = cert.card_id
         LEFT JOIN submission_items si ON si.id = cert.submission_item_id
         JOIN submissions s ON s.id = COALESCE(c.submission_id, si.submission_id)
         JOIN partner_connector_imports pci
           ON pci.destination_submission_id = s.id
         JOIN partner_grading_work_items pgwi
           ON pgwi.submission_item_id = si.id
          AND pgwi.destination_submission_id = si.submission_id
          AND pgwi.connector_import_id = pci.id
          AND pgwi.destination_submission_id = pci.destination_submission_id
          AND (pgwi.certificate_id IS NULL OR pgwi.certificate_id = cert.id)
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

function authorizeAssigned(principal: PartnerPrincipal, auth: PartnerCertAuth | null) {
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
    AND grader_status = 'assigned'
    AND deleted_at IS NULL
    AND EXISTS (
      SELECT 1
        FROM certificates cert_check
        LEFT JOIN cards c ON c.id = cert_check.card_id
        LEFT JOIN submission_items si ON si.id = cert_check.submission_item_id
        JOIN submissions s ON s.id = COALESCE(c.submission_id, si.submission_id)
        JOIN partner_connector_imports pci ON pci.destination_submission_id = s.id
        JOIN partner_grading_work_items pgwi
          ON pgwi.submission_item_id = si.id
         AND pgwi.destination_submission_id = si.submission_id
         AND pgwi.connector_import_id = pci.id
         AND pgwi.destination_submission_id = pci.destination_submission_id
         AND (pgwi.certificate_id IS NULL OR pgwi.certificate_id = cert_check.id)
         AND (pgwi.assigned_partner_grader_id IS NULL OR pgwi.assigned_partner_grader_id = ${principal.userId})
         AND pgwi.status IN ('ready_for_assignment','assigned','returned_for_change')
       WHERE cert_check.id = certificates.id
         AND pci.partner_organisation_id = ${principal.tenantId}
         AND (${principal.orgWide} OR pci.partner_location_id = ${principal.locationId})
         AND pci.state IN ('completed','imported')
    )
  `;
}

function partnerImageKeyAllowed(auth: PartnerCertAuth, key: string, side: "front" | "back"): boolean {
  if (!auth.partnerSubmissionCardId) return false;
  return key.startsWith(
    `partner-submissions/${auth.tenantId}/${auth.partnerSubmissionId}/${auth.partnerSubmissionCardId}/${side}-`
  );
}

async function partnerImageFallback(auth: PartnerCertAuth): Promise<Record<string, string | null>> {
  const row = { front_image_key: auth.frontImageKey, back_image_key: auth.backImageKey };
  if (!row.front_image_key && !row.back_image_key) return {};
  const urls: Record<string, string | null> = {};
  if (row.front_image_key) {
    if (!partnerImageKeyAllowed(auth, row.front_image_key, "front")) return {};
    if (!(await headR2(row.front_image_key))) return {};
    const signed = await getR2SignedUrl(row.front_image_key, 3600);
    urls.front_original = signed;
    urls.front_display = signed;
  }
  if (row.back_image_key) {
    if (!partnerImageKeyAllowed(auth, row.back_image_key, "back")) return {};
    if (!(await headR2(row.back_image_key))) return {};
    const signed = await getR2SignedUrl(row.back_image_key, 3600);
    urls.back_original = signed;
    urls.back_display = signed;
  }
  return urls;
}

async function imagesForPartnerCert(auth: PartnerCertAuth) {
  const fallback = await partnerImageFallback(auth);
  return {
    urls: {
      ...Object.fromEntries(Object.entries(fallback).filter(([, value]) => value)),
    },
    quality: {},
  };
}

async function requireBothImages(auth: PartnerCertAuth): Promise<boolean> {
  if (!auth.frontImageKey || !auth.backImageKey) return false;
  if (!partnerImageKeyAllowed(auth, auth.frontImageKey, "front")) return false;
  if (!partnerImageKeyAllowed(auth, auth.backImageKey, "back")) return false;
  const [front, back] = await Promise.all([headR2(auth.frontImageKey), headR2(auth.backImageKey)]);
  return !!front && !!back;
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
             JOIN partner_grading_work_items pgwi
               ON pgwi.submission_item_id = si.id
              AND pgwi.destination_submission_id = si.submission_id
              AND pgwi.connector_import_id = pci.id
              AND pgwi.destination_submission_id = pci.destination_submission_id
              AND (pgwi.certificate_id IS NULL OR pgwi.certificate_id = cert.id)
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
      const auth = authorizeAssigned(req.partner!, await loadPartnerCert(req.partner!, certId));
      if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
      await withPartnerAdminTransaction((client) =>
        client.query(
          `UPDATE partner_grading_work_items
              SET certificate_id = $1,
                  certificate_linked_at = COALESCE(certificate_linked_at, now()),
                  status = CASE WHEN assigned_partner_grader_id IS NULL THEN status ELSE 'assigned' END,
                  updated_at = now()
            WHERE submission_item_id = $2
              AND tenant_id = $3
              AND (certificate_id IS NULL OR certificate_id = $1)`,
          [certId, auth.auth.submissionItemId, auth.auth.tenantId]
        )
      );
      res.json(await imagesForPartnerCert(auth.auth));
    } catch (err) {
      sendPartnerGradingError(res, err);
    }
  });

  r.get("/grading/certificates/:id/grading", requirePartnerCapability("partner.cards.assess"), async (req, res) => {
    try {
      const certId = numericId(req.params.id);
      if (!certId) return res.status(400).json({ error: "Invalid certificate id" });
      const auth = authorizeAssigned(req.partner!, await loadPartnerCert(req.partner!, certId));
      if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
      const payload = await buildCertGradingPayload(certId);
      if (!payload) return res.status(404).json({ error: "Not found" });
      res.json(stripGraderPii(payload));
    } catch (err) {
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
        const auth = authorizeAssigned(req.partner!, await loadPartnerCert(req.partner!, certId));
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
        const saved = await applyCertGradeDraft(
          certId,
          partnerGradeBody(req.body),
          partnerDraftWriteGuard(req.partner!)
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
        res.json({ ok: true, gradingStatus: auth.auth.gradingStatus });
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
        const auth = authorizeAssigned(req.partner!, await loadPartnerCert(req.partner!, certId));
        if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
        if (auth.auth.gradingStatus !== "assigned") {
          return res.status(409).json({ error: `Card is '${auth.auth.gradingStatus}', not submittable` });
        }
        if (!(await requireBothImages(auth.auth))) {
          return res.status(409).json({ error: "Upload front and back images before submitting grades." });
        }
        const body = partnerGradeBody(req.body);

        const saved = await applyCertGradeDraft(certId, body, partnerDraftWriteGuard(req.partner!), {
          submitForReviewBy: req.partner!.userId,
        });
        if (!saved) return res.status(409).json({ error: "Card status changed; refresh and try again" });

        const submitted = await db.execute(sql`
          UPDATE partner_grading_work_items pgwi
             SET certificate_id = ${certId},
                 certificate_linked_at = COALESCE(pgwi.certificate_linked_at, NOW()),
                 status = 'pending_review',
                 updated_at = NOW()
           WHERE pgwi.submission_item_id = ${auth.auth.submissionItemId}
             AND pgwi.tenant_id = ${req.partner!.tenantId}
             AND (pgwi.certificate_id IS NULL OR pgwi.certificate_id = ${certId})
             AND pgwi.assigned_partner_grader_id = ${req.partner!.userId}
             AND pgwi.status IN ${FINAL_WORK_ITEM_STATUSES}
          RETURNING pgwi.certificate_id
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
        const auth = authorizeAssigned(req.partner!, await loadPartnerCert(req.partner!, certId));
        if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
        if (auth.auth.gradingStatus !== "assigned") {
          return res.status(409).json({ error: `Card is '${auth.auth.gradingStatus}', not returned for change` });
        }
        if (auth.auth.gradedBy && auth.auth.gradedBy !== req.partner!.userId) {
          return res.status(403).json({ error: "Only the partner user who submitted this card can edit it" });
        }
        if (!(await requireBothImages(auth.auth))) {
          return res.status(409).json({ error: "Upload front and back images before submitting grades." });
        }
        const body = partnerGradeBody(req.body);
        const edited = await applyCertGradeDraft(certId, body, partnerDraftWriteGuard(req.partner!), {
          submitForReviewBy: req.partner!.userId,
        });
        if (!edited) return res.status(409).json({ error: "Card status changed; refresh and try again" });
        const linked = await db.execute(sql`
          UPDATE partner_grading_work_items pgwi
             SET certificate_id = ${certId},
                 certificate_linked_at = COALESCE(pgwi.certificate_linked_at, NOW()),
                 status = 'pending_review',
                 updated_at = NOW()
           WHERE pgwi.submission_item_id = ${auth.auth.submissionItemId}
             AND pgwi.tenant_id = ${req.partner!.tenantId}
             AND (pgwi.certificate_id IS NULL OR pgwi.certificate_id = ${certId})
             AND pgwi.assigned_partner_grader_id = ${req.partner!.userId}
             AND pgwi.status IN ${FINAL_WORK_ITEM_STATUSES}
          RETURNING pgwi.certificate_id
        `);
        if (linked.rows.length !== 1) {
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
        res.json({ ok: true, gradingStatus: "pending_review", changed: Object.keys(body) });
      } catch (err) {
        sendPartnerGradingError(res, err);
      }
    }
  );

  r.post(
    "/grading/certificates/:id/:action",
    requirePartnerCapability("partner.cards.assess"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    async (req, res) => {
      try {
        const action = String(req.params.action);
        if (!PARTNER_GRADING_PROXY_ACTIONS.has(action)) return res.status(404).json({ error: "Unknown action" });
        const certId = numericId(req.params.id);
        if (!certId) return res.status(400).json({ error: "Invalid certificate id" });
        const auth = authorizeAssigned(req.partner!, await loadPartnerCert(req.partner!, certId));
        if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
        if (!EDITABLE_STATUSES.has(auth.auth.gradingStatus)) {
          return res.status(409).json({ error: `Card is '${auth.auth.gradingStatus}', not editable` });
        }
        (req as any).__graderProxy = true;
        (req as any).__partnerGradingWriteGuard = {
          tenantId: req.partner!.tenantId,
          userId: req.partner!.userId,
          locationId: req.partner!.locationId,
          orgWide: req.partner!.orgWide,
        };
        const origJson = res.json.bind(res);
        (res as any).json = (body: any) => origJson(stripGraderPii(body));
        const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
        req.url = `/api/admin/certificates/${certId}/${action}${qs}`;
        return (req.app as any).handle(req, res);
      } catch (err) {
        sendPartnerGradingError(res, err);
      }
    }
  );

  return r;
}
