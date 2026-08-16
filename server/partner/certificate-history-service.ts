/** Read-only Partner certificate history, derived from immutable origin + the
 * completed connector mapping. It deliberately exposes no customer PII, admin
 * notes, or mutable internal grading data. */
import { withPartnerAdminTransaction } from "./db";
import { getR2SignedUrl } from "../r2";
import type { PartnerPrincipal } from "./session";

export type PartnerCertificateHistoryRow = {
  certificateId: number;
  certificateNumber: string;
  partnerSubmissionId: string;
  locationName: string | null;
  cardName: string | null;
  setName: string | null;
  cardNumber: string | null;
  year: string | null;
  grade: string | null;
  gradingStatus: string;
  qaClearedAt: string | null;
  printState: string | null;
  printedAt: string | null;
  stations: string[];
  evidenceComplete: boolean;
  issuedAt: string | null;
  /**
   * B3 — the walk-in Card Job lifecycle state, or null for a connector-lineage card that has no
   * Card Job. Additive: existing consumers that ignore it are unaffected.
   */
  cardJobStatus: string | null;
};

export type PartnerCertificateDetail = PartnerCertificateHistoryRow & {
  gradeCentering: string | null;
  gradeCorners: string | null;
  gradeEdges: string | null;
  gradeSurface: string | null;
  operatorName: string | null;
  rejectionReason: string | null;
  redoCount: number;
  frontImageUrl: string | null;
  backImageUrl: string | null;
};

export async function listPartnerCertificateHistory(
  principal: PartnerPrincipal
): Promise<PartnerCertificateHistoryRow[]> {
  if (!principal.orgWide && !principal.locationId) return [];
  const params: unknown[] = [principal.tenantId];
  let connectorLocationWhere = "";
  let cardJobLocationWhere = "";
  if (!principal.orgWide) {
    params.push(principal.locationId);
    connectorLocationWhere = `AND pci.partner_location_id = $${params.length}::uuid`;
    cardJobLocationWhere = `AND job.location_id = $${params.length}::uuid`;
  }

  return withPartnerAdminTransaction(async (client) => {
    const { rows } = await client.query<{
      certificate_id: number;
      certificate_number: string;
      partner_submission_id: string;
      location_name: string | null;
      card_name: string | null;
      set_name: string | null;
      card_number: string | null;
      year: string | null;
      grade: string | null;
      grading_status: string;
      qa_cleared_at: string | null;
      print_state: string | null;
      printed_at: string | null;
      stations: string[] | null;
      evidence_complete: boolean;
      issued_at: string | null;
      card_job_status: string | null;
    }>(
      /*
       * B3 — ONE PARTNER CARD HISTORY, TWO LINEAGES, NO DUPLICATES.
       *
       * THE DEFECT. This query used to be a single chain anchored on `partner_connector_imports`.
       * A walk-in card never travels that road — its certificate is minted directly inside the NEW
       * transaction and has no connector import row (and, deliberately, no `submission_item_id`) —
       * so the inner joins could not match it and every Scanner-started card was invisible here.
       * The dashboard's "Completed" tile reads Card Jobs and so could report finished work that
       * this page simultaneously reported as none: one authority visibly contradicting another.
       *
       * THE FIX IS A READ, NOT A MIGRATION. No row is copied anywhere. `scope` resolves the SAME
       * three facts — which partner, which location, which submission — from whichever lineage owns
       * the certificate, and everything below joins once against that.
       *
       * WHY DISTINCT ON RATHER THAN A PLAIN UNION. Migration 0081 stamps `certificate_id` onto the
       * CONNECTOR lineage's Card Jobs too, so a connector certificate can legitimately match BOTH
       * arms. A bare UNION would then list that card twice. `lineage_rank` makes the Card Job arm
       * win, which is also the ordering `loadPartnerCert` already uses — so this page and the
       * grading loader agree about which lineage owns a card rather than disagreeing quietly.
       *
       * TENANT AND LOCATION ARE PROVED INDEPENDENTLY IN EACH ARM, never inherited from the other,
       * and `cert.origin_*` is re-asserted in both — a certificate whose immutable origin snapshot
       * does not match the lineage that claims it is not returned at all.
       */
      `WITH scope AS (
         SELECT cert.id AS certificate_id,
                pci.partner_submission_id::text AS partner_submission_id,
                pci.partner_organisation_id AS tenant_id,
                pci.partner_location_id AS location_id,
                NULL::text AS card_job_status,
                1 AS lineage_rank
           FROM certificates cert
           JOIN submission_items item ON item.id = cert.submission_item_id
           JOIN submissions submission ON submission.id = item.submission_id
           JOIN partner_connector_imports pci
             ON pci.destination_submission_id = submission.id
            AND pci.state IN ('completed', 'imported')
           JOIN partner_connector_records connector
             ON connector.id = pci.connector_record_id
            AND connector.tenant_id = pci.partner_organisation_id
            AND connector.partner_submission_id = pci.partner_submission_id
            AND connector.handoff_id = pci.partner_handoff_id
            AND connector.state = 'imported'
          WHERE pci.partner_organisation_id = $1::uuid
            AND cert.origin_type = 'PARTNER'
            AND cert.origin_partner_id = pci.partner_organisation_id
            AND cert.origin_location_id = pci.partner_location_id
            AND cert.deleted_at IS NULL
            ${connectorLocationWhere}
          UNION ALL
         SELECT cert.id AS certificate_id,
                job.submission_id::text AS partner_submission_id,
                job.tenant_id,
                job.location_id,
                job.status AS card_job_status,
                0 AS lineage_rank
           FROM partner_card_jobs job
           JOIN certificates cert
             ON cert.id = job.certificate_id
            AND cert.deleted_at IS NULL
          WHERE job.tenant_id = $1::uuid
            AND job.cancelled_at IS NULL
            AND cert.origin_type = 'PARTNER'
            AND cert.origin_partner_id = job.tenant_id
            AND cert.origin_location_id = job.location_id
            ${cardJobLocationWhere}
       ),
       resolved AS (
         SELECT DISTINCT ON (certificate_id) *
           FROM scope
          ORDER BY certificate_id, lineage_rank
       )
       SELECT cert.id AS certificate_id,
              cert.certificate_number,
              resolved.partner_submission_id,
              location.name AS location_name,
              cert.card_name, cert.set_name, cert.card_number_display AS card_number, cert.year_text AS year,
              cert.grade::text, cert.grader_status, cert.grade_approved_at AS qa_cleared_at,
              cert.print_state, printed.printed_at, cert.issued_at,
              resolved.card_job_status,
              COALESCE(station_data.stations, ARRAY[]::text[]) AS stations,
              COALESCE(evidence_data.evidence_complete, false) AS evidence_complete
         FROM resolved
         JOIN certificates cert ON cert.id = resolved.certificate_id
         JOIN partner_locations location
           ON location.id = resolved.location_id
          AND location.tenant_id = resolved.tenant_id
         LEFT JOIN LATERAL (
           SELECT max(lp.printed_at) AS printed_at
             FROM label_prints lp
            WHERE lp.cert_id = cert.certificate_number
         ) printed ON true
         LEFT JOIN LATERAL (
           SELECT array_agg(DISTINCT station.station_code ORDER BY station.station_code) AS stations
             FROM certificate_image_evidence evidence
             JOIN scanner_capture_sessions session
               ON session.id = evidence.capture_metadata ->> 'captureSessionId'
              AND session.certificate_id = cert.id
              AND session.side = evidence.side
              AND session.state = 'captured'
             JOIN partner_stations station ON station.id = session.station_id
            WHERE evidence.certificate_id = cert.id
              AND evidence.is_current = true
              AND evidence.evidence_class = 'NEW_IMMUTABLE_MASTER'
              AND evidence.format = 'tiff'
         ) station_data ON true
         LEFT JOIN LATERAL (
           SELECT count(DISTINCT evidence.side) = 2 AS evidence_complete
             FROM certificate_image_evidence evidence
             JOIN scanner_capture_sessions session
               ON session.id = evidence.capture_metadata ->> 'captureSessionId'
              AND session.certificate_id = cert.id
              AND session.side = evidence.side
              AND session.state = 'captured'
             JOIN partner_stations station
               ON station.id = session.station_id
              AND station.tenant_id = resolved.tenant_id
              AND station.location_id = resolved.location_id
              AND station.approved_at IS NOT NULL
            WHERE evidence.certificate_id = cert.id
              AND evidence.is_current = true
              AND evidence.evidence_class = 'NEW_IMMUTABLE_MASTER'
              AND evidence.format = 'tiff'
         ) evidence_data ON true
        ORDER BY cert.issued_at DESC NULLS LAST, cert.id DESC
        LIMIT 500`,
      params
    );
    return rows.map((row) => ({
      certificateId: Number(row.certificate_id),
      certificateNumber: row.certificate_number,
      partnerSubmissionId: row.partner_submission_id,
      locationName: row.location_name,
      cardName: row.card_name,
      setName: row.set_name,
      cardNumber: row.card_number,
      year: row.year,
      grade: row.grade,
      gradingStatus: row.grading_status,
      qaClearedAt: row.qa_cleared_at,
      printState: row.print_state,
      printedAt: row.printed_at,
      stations: row.stations ?? [],
      evidenceComplete: row.evidence_complete === true,
      issuedAt: row.issued_at,
      /**
       * The walk-in lifecycle state (NEEDS_SCAN / CAPTURING / FIX_REQUIRED / READY_TO_GRADE /
       * GRADING / SUBMITTED / QA_REVIEW / APPROVED / PRINTABLE / COMPLETED), or null for a
       * connector-lineage card that has no Card Job. This is what lets a card list separate
       * "waiting to be photographed" from "finished" without inferring it from the grade.
       */
      cardJobStatus: row.card_job_status,
    }));
  });
}

/**
 * Detail is intentionally a second exact-origin read rather than a generic
 * certificate lookup. A guessed MV number therefore has the same not-found
 * result whether it belongs to another Partner, another selected location, or
 * does not exist at all. Evidence links are signed only after that scope is
 * proved by the same connector and immutable-origin predicates as history.
 */
export async function getPartnerCertificateDetail(
  principal: PartnerPrincipal,
  certificateNumber: string
): Promise<PartnerCertificateDetail | null> {
  if (!principal.orgWide && !principal.locationId) return null;
  const params: unknown[] = [principal.tenantId, certificateNumber];
  let connectorLocationWhere = "";
  let cardJobLocationWhere = "";
  if (!principal.orgWide) {
    params.push(principal.locationId);
    connectorLocationWhere = `AND pci.partner_location_id = $${params.length}::uuid`;
    cardJobLocationWhere = `AND job.location_id = $${params.length}::uuid`;
  }

  return withPartnerAdminTransaction(async (client) => {
    const { rows } = await client.query<{
      certificate_id: number;
      certificate_number: string;
      partner_submission_id: string;
      location_name: string | null;
      card_name: string | null;
      set_name: string | null;
      card_number: string | null;
      year: string | null;
      grade: string | null;
      grading_status: string;
      qa_cleared_at: string | null;
      print_state: string | null;
      printed_at: string | null;
      stations: string[] | null;
      evidence_complete: boolean;
      issued_at: string | null;
      centering_score: string | null;
      corners_score: string | null;
      edges_score: string | null;
      surface_score: string | null;
      operator_name: string | null;
      rejection_reason: string | null;
      redo_count: number | null;
      front_object_key: string | null;
      back_object_key: string | null;
      card_job_status: string | null;
    }>(
      /*
       * B3 — the SAME two-lineage scope as the list above, for the same reason: a walk-in card has
       * no connector import, so an exact-origin read anchored on one could never return it and the
       * "Open details" button on a Scanner-started card had nothing behind it.
       *
       * The non-confirmation property is preserved exactly. A guessed MV number still produces one
       * identical not-found whether it belongs to another partner, another location, the wrong
       * lineage, or nothing at all — both arms prove tenant, location and `cert.origin_*`
       * independently, and neither leaks which of those failed.
       */
      `WITH scope AS (
         SELECT cert.id AS certificate_id,
                pci.partner_submission_id::text AS partner_submission_id,
                pci.partner_organisation_id AS tenant_id,
                pci.partner_location_id AS location_id,
                NULL::text AS card_job_status,
                1 AS lineage_rank
           FROM certificates cert
           JOIN submission_items item ON item.id = cert.submission_item_id
           JOIN submissions submission ON submission.id = item.submission_id
           JOIN partner_connector_imports pci
             ON pci.destination_submission_id = submission.id
            AND pci.state IN ('completed', 'imported')
           JOIN partner_connector_records connector
             ON connector.id = pci.connector_record_id
            AND connector.tenant_id = pci.partner_organisation_id
            AND connector.partner_submission_id = pci.partner_submission_id
            AND connector.handoff_id = pci.partner_handoff_id
            AND connector.state = 'imported'
          WHERE pci.partner_organisation_id = $1::uuid
            AND cert.certificate_number = $2::text
            AND cert.origin_type = 'PARTNER'
            AND cert.origin_partner_id = pci.partner_organisation_id
            AND cert.origin_location_id = pci.partner_location_id
            AND cert.deleted_at IS NULL
            ${connectorLocationWhere}
          UNION ALL
         SELECT cert.id AS certificate_id,
                job.submission_id::text AS partner_submission_id,
                job.tenant_id,
                job.location_id,
                job.status AS card_job_status,
                0 AS lineage_rank
           FROM partner_card_jobs job
           JOIN certificates cert
             ON cert.id = job.certificate_id
            AND cert.deleted_at IS NULL
          WHERE job.tenant_id = $1::uuid
            AND cert.certificate_number = $2::text
            AND job.cancelled_at IS NULL
            AND cert.origin_type = 'PARTNER'
            AND cert.origin_partner_id = job.tenant_id
            AND cert.origin_location_id = job.location_id
            ${cardJobLocationWhere}
       ),
       resolved AS (
         SELECT DISTINCT ON (certificate_id) *
           FROM scope
          ORDER BY certificate_id, lineage_rank
       )
       SELECT cert.id AS certificate_id,
              cert.certificate_number,
              resolved.partner_submission_id,
              resolved.card_job_status,
              location.name AS location_name,
              cert.card_name, cert.set_name, cert.card_number_display AS card_number, cert.year_text AS year,
              cert.grade::text, cert.grader_status, cert.grade_approved_at AS qa_cleared_at,
              cert.print_state, printed.printed_at, cert.issued_at,
              cert.centering_score::text, cert.corners_score::text, cert.edges_score::text, cert.surface_score::text,
              NULLIF(concat_ws(' ', operator.first_name, operator.last_name), '') AS operator_name,
              cert.rejection_reason, cert.redo_count,
              COALESCE(station_data.stations, ARRAY[]::text[]) AS stations,
              COALESCE(evidence_data.evidence_complete, false) AS evidence_complete,
              evidence_data.front_object_key, evidence_data.back_object_key
         FROM resolved
         JOIN certificates cert ON cert.id = resolved.certificate_id
         JOIN partner_locations location
           ON location.id = resolved.location_id
          AND location.tenant_id = resolved.tenant_id
         LEFT JOIN partner_users operator
           ON operator.id::text = cert.graded_by
          AND operator.tenant_id = resolved.tenant_id
         LEFT JOIN LATERAL (
           SELECT max(lp.printed_at) AS printed_at
             FROM label_prints lp
            WHERE lp.cert_id = cert.certificate_number
         ) printed ON true
         LEFT JOIN LATERAL (
           SELECT array_agg(DISTINCT station.station_code ORDER BY station.station_code) AS stations
             FROM certificate_image_evidence evidence
             JOIN scanner_capture_sessions session
               ON session.id = evidence.capture_metadata ->> 'captureSessionId'
              AND session.certificate_id = cert.id
              AND session.side = evidence.side
              AND session.state = 'captured'
             JOIN partner_stations station ON station.id = session.station_id
            WHERE evidence.certificate_id = cert.id
              AND evidence.is_current = true
              AND evidence.evidence_class = 'NEW_IMMUTABLE_MASTER'
              AND evidence.format = 'tiff'
         ) station_data ON true
         LEFT JOIN LATERAL (
           SELECT count(DISTINCT evidence.side) = 2 AS evidence_complete,
                  max(evidence.object_key) FILTER (WHERE evidence.side = 'front') AS front_object_key,
                  max(evidence.object_key) FILTER (WHERE evidence.side = 'back') AS back_object_key
             FROM certificate_image_evidence evidence
             JOIN scanner_capture_sessions session
               ON session.id = evidence.capture_metadata ->> 'captureSessionId'
              AND session.certificate_id = cert.id
              AND session.side = evidence.side
              AND session.state = 'captured'
             JOIN partner_stations station
               ON station.id = session.station_id
              AND station.tenant_id = resolved.tenant_id
              AND station.location_id = resolved.location_id
              AND station.approved_at IS NOT NULL
            WHERE evidence.certificate_id = cert.id
              AND evidence.is_current = true
              AND evidence.evidence_class = 'NEW_IMMUTABLE_MASTER'
              AND evidence.format = 'tiff'
         ) evidence_data ON true
        LIMIT 1`,
      params
    );
    const row = rows[0];
    if (!row) return null;
    const [frontImageUrl, backImageUrl] = await Promise.all([
      row.front_object_key ? getR2SignedUrl(row.front_object_key, 3600) : null,
      row.back_object_key ? getR2SignedUrl(row.back_object_key, 3600) : null,
    ]);
    return {
      certificateId: Number(row.certificate_id),
      certificateNumber: row.certificate_number,
      partnerSubmissionId: row.partner_submission_id,
      locationName: row.location_name,
      cardName: row.card_name,
      setName: row.set_name,
      cardNumber: row.card_number,
      year: row.year,
      grade: row.grade,
      gradingStatus: row.grading_status,
      qaClearedAt: row.qa_cleared_at,
      printState: row.print_state,
      printedAt: row.printed_at,
      stations: row.stations ?? [],
      evidenceComplete: row.evidence_complete === true,
      issuedAt: row.issued_at,
      cardJobStatus: row.card_job_status,
      gradeCentering: row.centering_score,
      gradeCorners: row.corners_score,
      gradeEdges: row.edges_score,
      gradeSurface: row.surface_score,
      operatorName: row.operator_name,
      rejectionReason: row.rejection_reason,
      redoCount: Number(row.redo_count ?? 0),
      frontImageUrl,
      backImageUrl,
    };
  });
}
