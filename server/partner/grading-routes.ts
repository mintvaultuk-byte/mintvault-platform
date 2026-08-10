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
import { APP_BASE_URL } from "../app-url";
import { checkPrintableGrade } from "@shared/printable-grade";
import { createBatchAtomic, markBatchPrinted, markCompleted, partnerSettlementBlockForCert } from "../print-workflow";
import { r2KeyForPrintBatch } from "../print-batch";
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
import { auditInOwnTxn, writePartnerAudit } from "./audit";
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

/** A deliberately small, operational certificate view for Partner printing/NFC. */
type PartnerCompletionCert = {
  id: number;
  certificateNumber: string;
  tenantId: string;
  locationId: string | null;
  gradeType: string | null;
  grade: string | null;
  gradeApprovedAt: string | null;
  certificateStatus: string | null;
  printState: string | null;
  nfcUid: string | null;
  nfcLocked: boolean;
  nfcLastVerifiedAt: string | null;
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

function partnerPrintActor(principal: PartnerPrincipal): string {
  // Do not impersonate an HQ admin in the print ledger. The user id is a stable
  // actor identity while the tenant prefix makes the event unambiguous in exports.
  return `partner:${principal.tenantId}:${principal.userId}`;
}

function nfcState(cert: Pick<PartnerCompletionCert, "nfcUid" | "nfcLocked" | "nfcLastVerifiedAt">) {
  if (cert.nfcLocked) return "LOCKED" as const;
  if (cert.nfcLastVerifiedAt) return "VERIFIED" as const;
  if (cert.nfcUid) return "WRITTEN" as const;
  return "NOT_WRITTEN" as const;
}

function parseNfcUid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const uid = value.trim();
  // UIDs from browser Web NFC and desktop encoders commonly contain colons;
  // reject whitespace/control characters and arbitrary opaque payloads.
  return /^[A-Za-z0-9:._-]{1,128}$/.test(uid) ? uid : null;
}

function parseNfcChipType(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return null;
  const chipType = value.trim();
  return /^[A-Za-z0-9 ._/-]{1,64}$/.test(chipType) ? chipType : null;
}

async function loadPartnerCompletionCert(
  principal: PartnerPrincipal,
  certificateNumber: string
): Promise<PartnerCompletionCert | null> {
  if (!principal.orgWide && !principal.locationId) return null;
  const params: unknown[] = [certificateNumber, principal.tenantId];
  const locationWhere = principal.orgWide
    ? ""
    : (() => {
        params.push(principal.locationId!);
        return `AND cert.origin_location_id = $${params.length}`;
      })();
  const { rows } = await withPartnerAdminTransaction((client) =>
    client.query<PartnerCompletionCert>(
      `SELECT cert.id::int AS id,
              cert.certificate_number AS "certificateNumber",
              cert.origin_partner_id::text AS "tenantId",
              cert.origin_location_id::text AS "locationId",
              cert.grade_type AS "gradeType",
              cert.grade::text AS grade,
              cert.grade_approved_at AS "gradeApprovedAt",
              cert.status AS "certificateStatus",
              to_jsonb(cert)->>'print_state' AS "printState",
              to_jsonb(cert)->>'nfc_uid' AS "nfcUid",
              COALESCE((to_jsonb(cert)->>'nfc_locked')::boolean, false) AS "nfcLocked",
              to_jsonb(cert)->>'nfc_last_verified_at' AS "nfcLastVerifiedAt"
         FROM certificates cert
        WHERE cert.certificate_number = $1
          AND cert.origin_type = 'PARTNER'
          AND cert.origin_partner_id = $2
          AND cert.deleted_at IS NULL
          ${locationWhere}
        LIMIT 1`,
      params
    )
  );
  return rows[0] ?? null;
}

function completionEligibilityError(cert: PartnerCompletionCert): string | null {
  if (!cert.gradeApprovedAt) return "Certificate approval is required before this operation.";
  if (String(cert.certificateStatus ?? "").toLowerCase() !== "active") {
    return "Only an active certificate can be prepared or programmed.";
  }
  const grade = checkPrintableGrade({ gradeType: cert.gradeType, gradeOverall: cert.grade });
  return grade.printable ? null : (grade.message ?? "This certificate has no printable grade.");
}

async function settlementEligibilityError(cert: PartnerCompletionCert): Promise<string | null> {
  const settlement = await partnerSettlementBlockForCert(cert.certificateNumber);
  return settlement?.message ?? null;
}

async function findPartnerPrintingBatch(
  principal: PartnerPrincipal,
  certificateNumber: string
): Promise<string | null> {
  if (!principal.orgWide && !principal.locationId) return null;
  const params: unknown[] = [certificateNumber, principal.tenantId];
  const locationScopeMismatch = principal.orgWide
    ? ""
    : (() => {
        params.push(principal.locationId!);
        return `OR cert.origin_location_id IS DISTINCT FROM $${params.length}`;
      })();
  const { rows } = await withPartnerAdminTransaction((client) =>
    client.query<{ batch_id: string }>(
      `SELECT batch.batch_id
         FROM print_batches batch
        WHERE batch.status = 'printing'
          AND batch.created_by_role = 'partner_print'
          AND batch.cert_ids @> jsonb_build_array($1::text)
          AND NOT EXISTS (
            SELECT 1
              FROM jsonb_array_elements_text(batch.cert_ids) AS grouped(certificate_number)
              LEFT JOIN certificates cert ON cert.certificate_number = grouped.certificate_number
             WHERE cert.id IS NULL
                OR cert.origin_type <> 'PARTNER'
                OR cert.origin_partner_id <> $2
                ${locationScopeMismatch}
          )
        ORDER BY batch.created_at DESC
        LIMIT 1`,
      params
    )
  );
  return rows[0]?.batch_id ?? null;
}

/**
 * A physical Partner submission is one label unit in the established workflow.
 * Starting from the visible certificate, derive its complete immutable-origin
 * sibling set on the server rather than asking the browser to construct a batch.
 */
async function partnerSubmissionCertificateNumbers(
  principal: PartnerPrincipal,
  certificateNumber: string
): Promise<string[]> {
  if (!principal.orgWide && !principal.locationId) return [];
  const params: unknown[] = [certificateNumber, principal.tenantId];
  const locationWhere = principal.orgWide
    ? ""
    : (() => {
        params.push(principal.locationId!);
        return `AND cert.origin_location_id = $${params.length}`;
      })();
  const { rows } = await withPartnerAdminTransaction((client) =>
    client.query<{ certificate_number: string }>(
      `WITH target AS (
         SELECT pgwi.tenant_id, pgwi.partner_submission_id, pgwi.destination_submission_id
           FROM certificates target_cert
           JOIN submission_items target_item ON target_item.id = target_cert.submission_item_id
           JOIN partner_grading_work_items pgwi
             ON pgwi.certificate_id = target_cert.id
            AND pgwi.submission_item_id = target_cert.submission_item_id
            AND pgwi.destination_submission_id = target_item.submission_id
          WHERE target_cert.certificate_number = $1
            AND target_cert.origin_type = 'PARTNER'
            AND target_cert.origin_partner_id = $2
            AND target_cert.deleted_at IS NULL
            ${principal.orgWide ? "" : `AND target_cert.origin_location_id = $${params.length}`}
          LIMIT 1
       )
       SELECT cert.certificate_number
         FROM target
         JOIN partner_grading_work_items pgwi
           ON pgwi.tenant_id = target.tenant_id
          AND pgwi.partner_submission_id = target.partner_submission_id
          AND pgwi.destination_submission_id = target.destination_submission_id
         JOIN certificates cert
           ON cert.id = pgwi.certificate_id
          AND cert.submission_item_id = pgwi.submission_item_id
        WHERE cert.origin_type = 'PARTNER'
          AND cert.origin_partner_id = $2
          AND cert.deleted_at IS NULL
          ${locationWhere}
          AND pgwi.status <> 'void'
        ORDER BY cert.id`,
      params
    )
  );
  return rows.map((row) => row.certificate_number);
}

/**
 * Completion is a submission-level physical hand-off. Every derived sibling
 * must still be owned by this Partner scope, have a confirmed print, and have
 * an NFC tag locked before any certificate can become terminal. The workflow
 * repeats the immutable-origin fence on its actual writes to close races.
 */
async function partnerCompletionReadiness(
  principal: PartnerPrincipal,
  certificateNumbers: string[]
): Promise<"not_found" | "print_confirmation_required" | "nfc_lock_required" | null> {
  if (certificateNumbers.length === 0 || (!principal.orgWide && !principal.locationId)) return "not_found";
  const params: unknown[] = [certificateNumbers, principal.tenantId];
  const locationWhere = principal.orgWide
    ? ""
    : (() => {
        params.push(principal.locationId!);
        return `AND cert.origin_location_id = $${params.length}`;
      })();
  const { rows } = await withPartnerAdminTransaction((client) =>
    client.query<{ requested: number; in_scope: number; printed: number; locked: number }>(
      `WITH selected AS (
         SELECT DISTINCT unnest($1::text[]) AS certificate_number
       )
       SELECT count(*)::int AS requested,
              count(cert.id)::int AS in_scope,
              count(*) FILTER (
                WHERE cert.id IS NOT NULL
                  AND (to_jsonb(cert)->>'print_state') IN ('printed','reprinted')
              )::int AS printed,
              count(*) FILTER (
                WHERE cert.id IS NOT NULL
                  AND COALESCE((to_jsonb(cert)->>'nfc_locked')::boolean, false)
              )::int AS locked
         FROM selected
         LEFT JOIN certificates cert
           ON cert.certificate_number = selected.certificate_number
          AND cert.origin_type = 'PARTNER'
          AND cert.origin_partner_id = $2
          AND cert.deleted_at IS NULL
          ${locationWhere}`,
      params
    )
  );
  const row = rows[0];
  if (!row || row.in_scope !== row.requested) return "not_found";
  if (row.printed !== row.requested) return "print_confirmation_required";
  if (row.locked !== row.requested) return "nfc_lock_required";
  return null;
}

type PartnerNfcMutation =
  | { ok: true; state: "NOT_WRITTEN" | "WRITTEN" | "VERIFIED" | "LOCKED"; changed: boolean }
  | { ok: false; status: 404 | 409; error: string; code?: string };

/**
 * NFC writes are deliberately not delegated to the broad admin storage methods:
 * this transaction carries the immutable Partner-origin predicate, eligibility
 * recheck and Partner audit record together. A Partner can never replace or
 * clear a tag; those exceptional repairs remain a Super Admin responsibility.
 */
async function mutatePartnerNfc(params: {
  principal: PartnerPrincipal;
  certificateNumber: string;
  action: "write" | "verify" | "lock";
  uid?: string;
  chipType?: string | null;
}): Promise<PartnerNfcMutation> {
  const { principal } = params;
  if (!principal.orgWide && !principal.locationId) return { ok: false, status: 404, error: "Not found" };
  const actor = partnerPrintActor(principal);
  const paramsForCert: unknown[] = [params.certificateNumber, principal.tenantId];
  const locationWhere = principal.orgWide
    ? ""
    : (() => {
        paramsForCert.push(principal.locationId!);
        return `AND cert.origin_location_id = $${paramsForCert.length}`;
      })();

  return withPartnerAdminTransaction(async (client) => {
    const current = await client.query<PartnerCompletionCert>(
      `SELECT cert.id::int AS id,
              cert.certificate_number AS "certificateNumber",
              cert.origin_partner_id::text AS "tenantId",
              cert.origin_location_id::text AS "locationId",
              cert.grade_type AS "gradeType",
              cert.grade::text AS grade,
              cert.grade_approved_at AS "gradeApprovedAt",
              cert.status AS "certificateStatus",
              to_jsonb(cert)->>'print_state' AS "printState",
              to_jsonb(cert)->>'nfc_uid' AS "nfcUid",
              COALESCE((to_jsonb(cert)->>'nfc_locked')::boolean, false) AS "nfcLocked",
              to_jsonb(cert)->>'nfc_last_verified_at' AS "nfcLastVerifiedAt"
         FROM certificates cert
        WHERE cert.certificate_number = $1
          AND cert.origin_type = 'PARTNER'
          AND cert.origin_partner_id = $2
          AND cert.deleted_at IS NULL
          ${locationWhere}
        FOR UPDATE`,
      paramsForCert
    );
    const cert = current.rows[0];
    if (!cert) return { ok: false, status: 404, error: "Not found" } as const;

    const eligibility = completionEligibilityError(cert);
    if (eligibility) return { ok: false, status: 409, error: eligibility, code: "CERTIFICATE_INELIGIBLE" } as const;
    // A printed label is the physical hand-off point for NFC. Do not create a
    // live tag while a label is merely being rendered or before it is confirmed.
    if (!["printed", "reprinted", "completed"].includes(String(cert.printState))) {
      return {
        ok: false,
        status: 409,
        error: "Confirm the printed label before programming this certificate's NFC tag.",
        code: "PRINT_CONFIRMATION_REQUIRED",
      } as const;
    }

    const baseAudit = {
      tenantId: principal.tenantId,
      locationId: cert.locationId,
      actorUserId: principal.userId,
      sessionId: principal.sessionId,
      recordType: "certificate",
      recordId: String(cert.id),
    };

    if (params.action === "write") {
      const uid = params.uid!;
      if (cert.nfcLocked) {
        return {
          ok: false,
          status: 409,
          error: "This NFC tag is locked and cannot be changed.",
          code: "NFC_LOCKED",
        } as const;
      }
      if (cert.nfcUid) {
        if (cert.nfcUid.toLowerCase() === uid.toLowerCase()) {
          return { ok: true, state: nfcState(cert), changed: false } as const;
        }
        return {
          ok: false,
          status: 409,
          error: "This certificate already has an NFC tag. Ask MintVault support to review a replacement.",
          code: "ALREADY_ASSIGNED",
        } as const;
      }

      // Serialise competing Partner writers for the same physical UID before
      // the duplicate check and write; the broad HQ repair route remains
      // separately restricted to Super Admin.
      await client.query("SELECT pg_advisory_xact_lock(hashtext(lower($1)))", [uid]);
      const existing = await client.query<{ certificate_number: string }>(
        `SELECT certificate_number FROM certificates
          WHERE LOWER(nfc_uid) = LOWER($1) AND deleted_at IS NULL AND id <> $2
          LIMIT 1`,
        [uid, cert.id]
      );
      if (existing.rows[0]) {
        return {
          ok: false,
          status: 409,
          error: "This NFC UID is already assigned to another certificate.",
          code: "UID_IN_USE",
        } as const;
      }

      await client.query(
        `UPDATE certificates
            SET nfc_uid=$2,
                nfc_enabled=true,
                nfc_chip_type=$3,
                nfc_url=$4,
                nfc_locked=false,
                nfc_written_at=NOW(),
                nfc_written_by=$5,
                nfc_last_verified_at=NULL,
                nfc_locked_at=NULL,
                updated_at=NOW()
          WHERE id=$1`,
        [
          cert.id,
          uid,
          params.chipType ?? null,
          `${APP_BASE_URL}/nfc/${encodeURIComponent(cert.certificateNumber)}`,
          actor,
        ]
      );
      await writePartnerAudit(client, {
        ...baseAudit,
        action: "certificate.nfc_written",
        after: { state: "WRITTEN", chipType: params.chipType ?? null },
      });
      return { ok: true, state: "WRITTEN", changed: true } as const;
    }

    if (!cert.nfcUid) {
      return {
        ok: false,
        status: 409,
        error: "Write a verified NFC UID before continuing.",
        code: "NFC_NOT_WRITTEN",
      } as const;
    }

    if (params.action === "verify") {
      if (cert.nfcUid.toLowerCase() !== params.uid!.toLowerCase()) {
        return {
          ok: false,
          status: 409,
          error: "The scanned NFC UID does not match this certificate.",
          code: "UID_MISMATCH",
        } as const;
      }
      if (cert.nfcLastVerifiedAt) return { ok: true, state: nfcState(cert), changed: false } as const;
      await client.query("UPDATE certificates SET nfc_last_verified_at=NOW(), updated_at=NOW() WHERE id=$1", [cert.id]);
      await writePartnerAudit(client, {
        ...baseAudit,
        action: "certificate.nfc_verified",
        after: { state: "VERIFIED" },
      });
      return { ok: true, state: "VERIFIED", changed: true } as const;
    }

    if (cert.nfcLocked) return { ok: true, state: "LOCKED", changed: false } as const;
    if (!cert.nfcLastVerifiedAt) {
      return {
        ok: false,
        status: 409,
        error: "Verify the NFC tag before locking it.",
        code: "NFC_VERIFICATION_REQUIRED",
      } as const;
    }
    await client.query("UPDATE certificates SET nfc_locked=true, nfc_locked_at=NOW(), updated_at=NOW() WHERE id=$1", [
      cert.id,
    ]);
    await writePartnerAudit(client, { ...baseAudit, action: "certificate.nfc_locked", after: { state: "LOCKED" } });
    return { ok: true, state: "LOCKED", changed: true } as const;
  });
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

  /**
   * Partner-owned certificate/completion register.
   *
   * This is deliberately a read-only operational projection, not a second certificate engine:
   * certificate provenance remains the immutable `origin_partner_id` / `origin_location_id`
   * snapshot captured at intake.  Never use the current customer, shop profile, public listing,
   * or grading assignment as the ownership authority here.  The projection omits private notes,
   * evidence paths, NFC UID, wallet data and all customer/submission fields.
   */
  r.get(
    "/certificates",
    partnerGradingReadLimiter,
    requirePartnerCapability("partner.cards.view"),
    async (req, res) => {
      try {
        const principal = req.partner!;
        if (!principal.orgWide && !principal.locationId) return res.json({ certificates: [] });
        const params: unknown[] = [principal.tenantId];
        const locationWhere = principal.orgWide
          ? ""
          : (() => {
              params.push(principal.locationId!);
              return `AND cert.origin_location_id = $${params.length}`;
            })();
        const { rows } = await withPartnerAdminTransaction((client) =>
          client.query<{
            certificate_number: string;
            card_game: string | null;
            set_name: string | null;
            card_name: string | null;
            card_number: string | null;
            grade: string | null;
            certificate_status: string | null;
            approval_state: "APPROVED" | "PENDING_REVIEW";
            print_state: string | null;
            nfc_state: "NOT_WRITTEN" | "WRITTEN" | "VERIFIED" | "LOCKED";
            origin_location_name: string | null;
            approved_at: string | null;
          }>(
            `SELECT cert.certificate_number,
                  cert.card_game,
                  cert.set_name,
                  cert.card_name,
                  cert.card_number_display AS card_number,
                  cert.grade::text AS grade,
                  cert.status AS certificate_status,
                  CASE WHEN cert.grade_approved_at IS NULL THEN 'PENDING_REVIEW' ELSE 'APPROVED' END AS approval_state,
                  CASE
                    WHEN to_jsonb(cert)->>'print_state' IN ('printing','printed','reprint_required','reprinted','completed')
                      THEN to_jsonb(cert)->>'print_state'
                    WHEN cert.grade_approved_at IS NOT NULL THEN 'needs_printing'
                    ELSE 'awaiting_approval'
                  END AS print_state,
                  CASE
                    WHEN COALESCE((to_jsonb(cert)->>'nfc_locked')::boolean, false) THEN 'LOCKED'
                    WHEN (to_jsonb(cert)->>'nfc_last_verified_at') IS NOT NULL THEN 'VERIFIED'
                    WHEN (to_jsonb(cert)->>'nfc_uid') IS NOT NULL THEN 'WRITTEN'
                    ELSE 'NOT_WRITTEN'
                  END AS nfc_state,
                  cert.origin_location_name,
                  cert.grade_approved_at AS approved_at
             FROM certificates cert
            WHERE cert.origin_type = 'PARTNER'
              AND cert.origin_partner_id = $1
              AND cert.deleted_at IS NULL
              ${locationWhere}
            ORDER BY cert.grade_approved_at DESC NULLS LAST, cert.updated_at DESC, cert.id DESC
            LIMIT 100`,
            params
          )
        );
        res.json({
          certificates: rows.map((row) => ({
            certificateNumber: row.certificate_number,
            cardGame: row.card_game,
            setName: row.set_name,
            cardName: row.card_name,
            cardNumber: row.card_number,
            grade: row.grade,
            status: row.certificate_status,
            approvalState: row.approval_state,
            printState: row.print_state,
            nfcState: row.nfc_state,
            originLocationName: row.origin_location_name,
            approvedAt: row.approved_at,
          })),
        });
      } catch (err) {
        sendPartnerGradingError(res, err);
      }
    }
  );

  /**
   * Create a one-certificate Partner print batch and return only a short-lived
   * object-store URL. The Partner route never delegates to the broad admin
   * download endpoint, so a guessed batch id cannot become a cross-tenant PDF
   * oracle. Existing workflow events remain the durable print audit trail.
   */
  r.post(
    "/certificates/:certificateNumber/print",
    partnerGradingMutationLimiter,
    requirePartnerCapability("partner.cards.assess"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    async (req, res) => {
      try {
        const cert = await loadPartnerCompletionCert(req.partner!, String(req.params.certificateNumber));
        if (!cert) return res.status(404).json({ error: "Not found" });
        const eligibility = completionEligibilityError(cert);
        if (eligibility) return res.status(409).json({ error: eligibility, code: "CERTIFICATE_INELIGIBLE" });
        const settlement = await settlementEligibilityError(cert);
        if (settlement) return res.status(409).json({ error: settlement, code: "PARTNER_SETTLEMENT_REQUIRED" });

        const certIds = await partnerSubmissionCertificateNumbers(req.partner!, cert.certificateNumber);
        if (certIds.length === 0) return res.status(404).json({ error: "Not found" });
        const result = await createBatchAtomic({
          certIds,
          identity: { actor: partnerPrintActor(req.partner!), role: "partner_print" },
          partnerScope: {
            tenantId: req.partner!.tenantId,
            locationId: req.partner!.orgWide ? null : req.partner!.locationId,
          },
        });
        if (!result.batchId || !result.applied.includes(cert.certificateNumber)) {
          const rejected = result.rejected[0];
          return res.status(409).json({
            error: rejected?.message ?? "This certificate is not ready for a label.",
            code: rejected?.code ?? "PRINT_NOT_READY",
          });
        }
        const pdfUrl = await getR2SignedUrl(r2KeyForPrintBatch(result.batchId, "pdf"), 300);
        res.json({
          ok: true,
          certificateNumber: cert.certificateNumber,
          certificateNumbers: result.applied,
          printState: "printing",
          labelPreviewUrl: pdfUrl,
          expiresInSeconds: 300,
        });
      } catch (err) {
        sendPartnerGradingError(res, err);
      }
    }
  );

  /** Positive physical confirmation only: a PDF preview never itself marks a label printed. */
  r.post(
    "/certificates/:certificateNumber/print/confirm",
    partnerGradingMutationLimiter,
    requirePartnerCapability("partner.cards.assess"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    async (req, res) => {
      try {
        const cert = await loadPartnerCompletionCert(req.partner!, String(req.params.certificateNumber));
        if (!cert) return res.status(404).json({ error: "Not found" });
        const batchId = await findPartnerPrintingBatch(req.partner!, cert.certificateNumber);
        if (!batchId)
          return res
            .status(409)
            .json({ error: "No prepared Partner label is awaiting confirmation.", code: "PRINT_NOT_READY" });
        const result = await markBatchPrinted(batchId, {
          actor: partnerPrintActor(req.partner!),
          role: "partner_print",
        });
        if (!result.applied.includes(cert.certificateNumber)) {
          const rejected = result.rejected[0];
          return res
            .status(409)
            .json({
              error: rejected?.message ?? "The label could not be confirmed.",
              code: rejected?.code ?? "PRINT_NOT_READY",
            });
        }
        res.json({ ok: true, certificateNumber: cert.certificateNumber, printState: "printed" });
      } catch (err) {
        sendPartnerGradingError(res, err);
      }
    }
  );

  r.post(
    "/certificates/:certificateNumber/nfc",
    partnerGradingMutationLimiter,
    requirePartnerCapability("partner.cards.assess"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    async (req, res) => {
      try {
        const uid = parseNfcUid(req.body?.uid);
        const chipType = parseNfcChipType(req.body?.chipType);
        if (!uid || (req.body?.chipType !== undefined && req.body?.chipType !== null && !chipType)) {
          return res.status(400).json({ error: "Provide a valid NFC UID and optional chip type." });
        }
        const cert = await loadPartnerCompletionCert(req.partner!, String(req.params.certificateNumber));
        if (!cert) return res.status(404).json({ error: "Not found" });
        const settlement = await settlementEligibilityError(cert);
        if (settlement) return res.status(409).json({ error: settlement, code: "PARTNER_SETTLEMENT_REQUIRED" });
        const result = await mutatePartnerNfc({
          principal: req.partner!,
          certificateNumber: cert.certificateNumber,
          action: "write",
          uid,
          chipType,
        });
        if (!result.ok) return res.status(result.status).json({ error: result.error, code: result.code });
        res.json({
          ok: true,
          certificateNumber: cert.certificateNumber,
          nfcState: result.state,
          changed: result.changed,
        });
      } catch (err) {
        sendPartnerGradingError(res, err);
      }
    }
  );

  r.post(
    "/certificates/:certificateNumber/nfc/verify",
    partnerGradingMutationLimiter,
    requirePartnerCapability("partner.cards.assess"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    async (req, res) => {
      try {
        const uid = parseNfcUid(req.body?.uid);
        if (!uid) return res.status(400).json({ error: "Provide the NFC UID read from the tag." });
        const cert = await loadPartnerCompletionCert(req.partner!, String(req.params.certificateNumber));
        if (!cert) return res.status(404).json({ error: "Not found" });
        const settlement = await settlementEligibilityError(cert);
        if (settlement) return res.status(409).json({ error: settlement, code: "PARTNER_SETTLEMENT_REQUIRED" });
        const result = await mutatePartnerNfc({
          principal: req.partner!,
          certificateNumber: cert.certificateNumber,
          action: "verify",
          uid,
        });
        if (!result.ok) return res.status(result.status).json({ error: result.error, code: result.code });
        res.json({
          ok: true,
          certificateNumber: cert.certificateNumber,
          nfcState: result.state,
          changed: result.changed,
        });
      } catch (err) {
        sendPartnerGradingError(res, err);
      }
    }
  );

  r.post(
    "/certificates/:certificateNumber/nfc/lock",
    partnerGradingMutationLimiter,
    requirePartnerCapability("partner.cards.assess"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    async (req, res) => {
      try {
        const cert = await loadPartnerCompletionCert(req.partner!, String(req.params.certificateNumber));
        if (!cert) return res.status(404).json({ error: "Not found" });
        const settlement = await settlementEligibilityError(cert);
        if (settlement) return res.status(409).json({ error: settlement, code: "PARTNER_SETTLEMENT_REQUIRED" });
        const result = await mutatePartnerNfc({
          principal: req.partner!,
          certificateNumber: cert.certificateNumber,
          action: "lock",
        });
        if (!result.ok) return res.status(result.status).json({ error: result.error, code: result.code });
        res.json({
          ok: true,
          certificateNumber: cert.certificateNumber,
          nfcState: result.state,
          changed: result.changed,
        });
      } catch (err) {
        sendPartnerGradingError(res, err);
      }
    }
  );

  /**
   * The ordinary shop end-state: after physical print, NFC verification and
   * NFC lock, complete the complete server-derived Partner submission. HQ is
   * not in this normal fulfilment loop; exceptions remain in HQ workflows.
   */
  r.post(
    "/certificates/:certificateNumber/complete",
    partnerGradingMutationLimiter,
    requirePartnerCapability("partner.cards.assess"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    async (req, res) => {
      try {
        const cert = await loadPartnerCompletionCert(req.partner!, String(req.params.certificateNumber));
        if (!cert) return res.status(404).json({ error: "Not found" });
        const eligibility = completionEligibilityError(cert);
        if (eligibility) return res.status(409).json({ error: eligibility, code: "CERTIFICATE_INELIGIBLE" });
        const settlement = await settlementEligibilityError(cert);
        if (settlement) return res.status(409).json({ error: settlement, code: "PARTNER_SETTLEMENT_REQUIRED" });

        const certIds = await partnerSubmissionCertificateNumbers(req.partner!, cert.certificateNumber);
        const readiness = await partnerCompletionReadiness(req.partner!, certIds);
        if (readiness === "not_found") return res.status(404).json({ error: "Not found" });
        if (readiness === "print_confirmation_required") {
          return res.status(409).json({
            error: "Every certificate in this Partner submission needs a confirmed physical print before completion.",
            code: "PRINT_CONFIRMATION_REQUIRED",
          });
        }
        if (readiness === "nfc_lock_required") {
          return res.status(409).json({
            error: "Verify and lock NFC on every certificate in this Partner submission before completion.",
            code: "NFC_LOCK_REQUIRED",
          });
        }

        const result = await markCompleted({
          certIds,
          identity: { actor: partnerPrintActor(req.partner!), role: "partner_print" },
          partnerScope: {
            tenantId: req.partner!.tenantId,
            locationId: req.partner!.orgWide ? null : req.partner!.locationId,
          },
          allOrNothing: true,
        });
        if (result.applied.length !== certIds.length) {
          const rejected = result.rejected[0];
          return res.status(409).json({
            error: rejected?.message ?? "This Partner submission could not be completed.",
            code: rejected?.code ?? "COMPLETION_NOT_READY",
          });
        }
        res.json({
          ok: true,
          certificateNumber: cert.certificateNumber,
          certificateNumbers: result.applied,
          printState: "completed",
        });
      } catch (err) {
        sendPartnerGradingError(res, err);
      }
    }
  );

  r.get(
    "/grading/queue",
    partnerGradingReadLimiter,
    requirePartnerCapability("partner.cards.assess"),
    async (req, res) => {
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
    }
  );

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
  r.get(
    "/grading/certificates/:id/images",
    partnerGradingReadLimiter,
    requirePartnerCapability("partner.cards.assess"),
    async (req, res) => {
      try {
        const certId = numericId(req.params.id);
        if (!certId) return res.status(400).json({ error: "Invalid certificate id" });
        const auth = authorizeAssigned(req.partner!, await loadPartnerCert(req.partner!, certId));
        if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
        res.json(await imagesForPartnerCert(auth.auth));
      } catch (err) {
        sendPartnerGradingError(res, err);
      }
    }
  );

  r.get(
    "/grading/certificates/:id/grading",
    partnerGradingReadLimiter,
    requirePartnerCapability("partner.cards.assess"),
    async (req, res) => {
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
    }
  );

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
