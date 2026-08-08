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
import {
  applyGradeAuthority,
  computePartnerGradeAuthority,
  computePartnerGradeAuthorityFromRow,
  gradeAuthorityAuditDetail,
  partnerGradeBody,
  persistedMatchesAuthority,
  persistPartnerGradeAuthorityScore,
  readPersistedAuthorityColumns,
  rejectedClientClaim,
  sameAuthority,
  type PartnerGradeAuthority,
} from "./grading-authority";
import { auditInOwnTxn } from "./audit";
import { partnerGradingMutationLimiter, partnerGradingReadLimiter } from "./rate-limit";
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

/**
 * What the partner operator is shown: the server's OUTCOME, never the machinery.
 *
 * Built from the POST-WRITE authority, so it can never describe a write that did not land
 * (F4). Deliberately omits `deductions` — the per-category breakdown is engine internals,
 * and echoing it to an external partner client hands them a free oracle for
 * reverse-engineering the deduction tables one request at a time.
 */
function publicAuthority(a: PartnerGradeAuthority) {
  return {
    source: "server" as const,
    version: a.version,
    basis: a.basis,
    overallGrade: a.overallGrade,
    subgrades: a.subgrades,
    tier: a.tier,
    notGraded: a.nonNumeric,
  };
}

interface AuthoritativeWrite {
  authority: PartnerGradeAuthority;
  evidenceKeys: string[];
  rejectedClaim: Record<string, unknown> | null;
}

/**
 * The ONE partner grade write. Every partner write path goes through it, so no route can
 * accidentally persist a client-authored grade.
 *
 * Three passes, because the invariant is about the ROW, not about the request:
 *
 *   1. whitelist the body, compute a first-pass authority, and hand the unmodified engine
 *      writer a complete draft (it requires an `overall_grade`).
 *   2. RE-DERIVE the authority from the row that actually landed. If it disagrees with
 *      pass 1, the row is the truth and pass 1 is corrected — a second call to the same
 *      unmodified writer, carrying authority only and no evidence. This is what closes F1
 *      (an input that is scored but never persisted) and F7 (a concurrent writer between
 *      the two reads), structurally rather than case by case.
 *   3. read the authority columns back and refuse to report success unless they carry the
 *      server's decision (F4).
 *
 * Cost: two extra reads, and one extra write only when the row disagreed.
 */
async function partnerAuthoritativeWrite(
  certId: number,
  rawBody: unknown
): Promise<{ ok: true; result: AuthoritativeWrite } | { ok: false; status: number; error: string }> {
  const CONFLICT = { ok: false as const, status: 409, error: "Card status changed; refresh and try again" };
  const evidence = partnerGradeBody(rawBody);
  const rejectedClaim = rejectedClientClaim(rawBody);

  const pre = await computePartnerGradeAuthority(certId, evidence);
  if (!(await applyCertGradeDraft(certId, applyGradeAuthority(evidence, pre)))) return CONFLICT;

  let authority = await computePartnerGradeAuthorityFromRow(certId);
  if (!sameAuthority(pre, authority)) {
    // The row disagrees with the simulation. The ROW wins. Re-write authority only.
    if (!(await applyCertGradeDraft(certId, applyGradeAuthority({}, authority)))) return CONFLICT;
    authority = await computePartnerGradeAuthorityFromRow(certId);
  }

  const persisted = await readPersistedAuthorityColumns(certId);
  if (!persistedMatchesAuthority(persisted, authority)) {
    // Something wrote this row underneath us. Fail closed rather than report a grade the
    // certificate does not carry.
    return {
      ok: false,
      status: 409,
      error: "This card's evidence changed while it was being graded; refresh and try again",
    };
  }

  await persistPartnerGradeAuthorityScore(certId, authority);
  return { ok: true, result: { authority, evidenceKeys: Object.keys(evidence), rejectedClaim } };
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

/**
 * Re-assert, at write time, that this partner principal may still write this card.
 *
 * `partnerDraftWriteGuard` was previously threaded INTO server/grader.ts's draft writer as an
 * extra WHERE predicate. That required modifying a protected MVGS engine file, so the predicate
 * now runs here, in partner-owned code, immediately before the unmodified writer is called.
 *
 * Honest limitation, stated rather than glossed: as a separate statement this is a check-then-act
 * pair, not one atomic predicate. The window is small and the blast radius is nil — the worst case
 * is that draft field values land on a card this same principal was authorised to draft on
 * microseconds earlier, which is precisely what the draft-save endpoint does anyway. It grants no
 * access and changes no lifecycle state; every state TRANSITION below still carries the full guard
 * inside its own single UPDATE, where atomicity actually matters.
 */
async function assertPartnerDraftWritable(certId: number, principal: PartnerPrincipal): Promise<boolean> {
  const r = await db.execute(sql`
    SELECT 1
      FROM certificates
     WHERE certificates.id = ${certId}
       AND certificates.grade_approved_at IS NULL
       ${partnerDraftWriteGuard(principal)}
     LIMIT 1
  `);
  return r.rows.length === 1;
}

/** Internal sentinel: rolls the submit transaction back without surfacing as a 500. */
class PartnerSubmitConflict extends Error {}

/**
 * Move a partner-graded card to pending_review: snapshot the operator's submission AND transition
 * the work item, as ONE atomic unit.
 *
 * Both guarded UPDATEs run inside a single transaction. Each statement still carries its own full
 * ownership + state predicate, so neither can be separated from its authorisation check by a
 * concurrent writer; the transaction additionally guarantees the two transitions cannot be
 * separated from EACH OTHER. Previously these were two auto-commit statements, so a failure — or
 * merely a lost race on the work item, which returns 409 on a NORMAL concurrency path — left the
 * certificate at pending_review with the work item still 'assigned'. That split state is
 * unrecoverable in-app: both retry doors require 'assigned', and the approval mirror keys on the
 * work item being 'pending_review'. Covered by G3-ATOMIC.
 *
 * The operator_* snapshot is taken from the row's OWN freshly-written columns rather than from
 * request values, so it can never disagree with what was persisted.
 *
 * Deliberately OUTSIDE this boundary: the MVGS authoritative grade writes (they live in the
 * protected grading engine, and their partial-failure state is benign — the card stays 'assigned'
 * and a retry is clean), the two audit writes (different pools/roles, cannot enrol), and
 * settlement (runs from the admin approval mirror, on its own connection and lock order).
 *
 * This lives in partner code, not in the grading engine: nothing here scores, derives or adjusts a
 * grade. It copies already-computed values and sets partner workflow state.
 */
async function partnerSubmitForReview(
  certId: number,
  principal: PartnerPrincipal,
  // Nullable by design: a null flows into the predicate, matches zero rows, and surfaces as the
  // same 409 the pre-transaction code produced. Preserved exactly.
  submissionItemId: number | null
): Promise<boolean> {
  try {
    await db.transaction(async (tx) => {
      const graded = await tx.execute(sql`
        UPDATE certificates
           SET grader_status = 'pending_review',
               review_required = true,
               graded_at = NOW(),
               graded_by = ${principal.userId},
               operator_grade = certificates.grade,
               operator_subgrades = jsonb_build_object(
                 'centering', certificates.centering_score,
                 'corners', certificates.corners_score,
                 'edges', certificates.edges_score,
                 'surface', certificates.surface_score
               ),
               updated_at = NOW()
         WHERE certificates.id = ${certId}
           AND certificates.grade_approved_at IS NULL
           ${partnerDraftWriteGuard(principal)}
         RETURNING certificates.id
      `);
      if (graded.rows.length !== 1) throw new PartnerSubmitConflict();

      const linked = await tx.execute(sql`
        UPDATE partner_grading_work_items pgwi
           SET certificate_id = ${certId},
               certificate_linked_at = COALESCE(pgwi.certificate_linked_at, NOW()),
               status = 'pending_review',
               updated_at = NOW()
         WHERE pgwi.submission_item_id = ${submissionItemId}
           AND pgwi.tenant_id = ${principal.tenantId}
           AND (pgwi.certificate_id IS NULL OR pgwi.certificate_id = ${certId})
           AND pgwi.assigned_partner_grader_id = ${principal.userId}
           AND pgwi.status IN ${FINAL_WORK_ITEM_STATUSES}
        RETURNING pgwi.certificate_id
      `);
      if (linked.rows.length !== 1) throw new PartnerSubmitConflict();
    });
    return true;
  } catch (err) {
    if (err instanceof PartnerSubmitConflict) return false;
    throw err;
  }
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

  r.get("/grading/session", partnerGradingReadLimiter, requirePartnerCapability("partner.cards.assess"), (req, res) => {
    res.json({ authenticated: true, userId: req.partner!.userId });
  });

  r.get("/grading/queue", partnerGradingReadLimiter, requirePartnerCapability("partner.cards.assess"), async (req, res) => {
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

  /**
   * READ-ONLY, deliberately. This handler must never write.
   *
   * It used to run an unpredicated `UPDATE partner_grading_work_items ... status = CASE WHEN
   * assigned_partner_grader_id IS NULL THEN status ELSE 'assigned' END`. `authorizeAssigned` only
   * rejects an APPROVED certificate, so a card at `pending_review` passed the gate and merely
   * LOOKING at its images knocked the work item back to `assigned` — permanently. From there
   * `mirrorPartnerApproval` (which keys on `pgwi.status = 'pending_review'`) returns `not_partner`,
   * server/routes/grader.ts treats that as success, and the operator sees 200 {ok:true} while the
   * certificate publishes, the work item freezes, the destination never reaches `ready_to_return`,
   * settlement never runs and the reserved credits are held for 365 days. No in-app recovery.
   *
   * Nothing needed the write. `certificate_id`/`certificate_linked_at` are already set when the
   * work item is INSERTed (server/partner/connector-import-service.ts) and re-asserted by
   * `assignPartnerCerts` (grading-assignment.ts) and by the submit / edit-submission routes below,
   * so the link was pure duplication; and the only callers of this route are the workstation's
   * image queries (client/src/components/grading/grading-panel.tsx and
   * client/src/components/grading-workflow/CardPreviewPanel.tsx, which share one cache key), which
   * read signed URLs and depend on no transition. Note that `assignPartnerCerts` performs its own
   * status = 'assigned' transition, but PREDICATED on status IN ('ready_for_assignment','assigned',
   * 'returned_for_change') — which is exactly the guard this GET's copy was missing.
   *
   * Regression pinned behaviourally by tests/partner-grading-get-readonly.test.ts.
   */
  r.get("/grading/certificates/:id/images", partnerGradingReadLimiter, requirePartnerCapability("partner.cards.assess"), async (req, res) => {
    try {
      const certId = numericId(req.params.id);
      if (!certId) return res.status(400).json({ error: "Invalid certificate id" });
      const auth = authorizeAssigned(req.partner!, await loadPartnerCert(req.partner!, certId));
      if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
      res.json(await imagesForPartnerCert(auth.auth));
    } catch (err) {
      sendPartnerGradingError(res, err);
    }
  });

  r.get("/grading/certificates/:id/grading", partnerGradingReadLimiter, requirePartnerCapability("partner.cards.assess"), async (req, res) => {
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
    partnerGradingMutationLimiter,
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
        if (!(await assertPartnerDraftWritable(certId, req.partner!))) {
          return res.status(409).json({ error: "Card status changed; refresh and try again" });
        }
        const written = await partnerAuthoritativeWrite(certId, req.body);
        if (!written.ok) return res.status(written.status).json({ error: written.error });
        const { authority, rejectedClaim } = written.result;
        await auditInOwnTxn({
          tenantId: req.partner!.tenantId,
          locationId: auth.auth.locationId,
          actorUserId: req.partner!.userId,
          action: "grading.draft_saved",
          recordType: "certificate",
          recordId: String(certId),
          sessionId: req.partner!.sessionId,
          correlationId: auth.auth.partnerSubmissionId,
          after: gradeAuthorityAuditDetail(authority, rejectedClaim),
        });
        // The partner sees the SERVER's result, not their own claim.
        res.json({ ok: true, gradingStatus: auth.auth.gradingStatus, authority: publicAuthority(authority) });
      } catch (err) {
        sendPartnerGradingError(res, err);
      }
    }
  );

  r.post(
    "/grading/certificates/:id/submit",
    partnerGradingMutationLimiter,
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
        if (!(await assertPartnerDraftWritable(certId, req.partner!))) {
          return res.status(409).json({ error: "Card status changed; refresh and try again" });
        }
        const written = await partnerAuthoritativeWrite(certId, req.body);
        if (!written.ok) return res.status(written.status).json({ error: written.error });
        const { authority, rejectedClaim } = written.result;
        // One transaction: the certificate transition and the work-item transition commit together
        // or not at all. Each still carries its own ownership + state predicate.
        if (!(await partnerSubmitForReview(certId, req.partner!, auth.auth.submissionItemId))) {
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
          after: {
            gradingStatus: "pending_review",
            reviewRequired: true,
            ...gradeAuthorityAuditDetail(authority, rejectedClaim),
          },
        });
        res.json({
          ok: true,
          gradingStatus: "pending_review",
          reviewRequired: true,
          authority: publicAuthority(authority),
        });
      } catch (err) {
        sendPartnerGradingError(res, err);
      }
    }
  );

  r.post(
    "/grading/certificates/:id/edit-submission",
    partnerGradingMutationLimiter,
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
        if (!(await assertPartnerDraftWritable(certId, req.partner!))) {
          return res.status(409).json({ error: "Card status changed; refresh and try again" });
        }
        const written = await partnerAuthoritativeWrite(certId, req.body);
        if (!written.ok) return res.status(written.status).json({ error: written.error });
        const { authority, rejectedClaim, evidenceKeys } = written.result;
        // Same atomic transition as /submit — see partnerSubmitForReview.
        if (!(await partnerSubmitForReview(certId, req.partner!, auth.auth.submissionItemId))) {
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
          after: {
            gradingStatus: "pending_review",
            reviewRequired: true,
            ...gradeAuthorityAuditDetail(authority, rejectedClaim),
          },
        });
        res.json({
          ok: true,
          gradingStatus: "pending_review",
          changed: evidenceKeys,
          authority: publicAuthority(authority),
        });
      } catch (err) {
        sendPartnerGradingError(res, err);
      }
    }
  );

  r.post(
    "/grading/certificates/:id/:action",
    partnerGradingMutationLimiter,
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
