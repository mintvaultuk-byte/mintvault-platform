/**
 * Partner Pilot print authority.
 *
 * A Partner-origin certificate is deliberately held to a stricter contract
 * than legacy/HQ cards.  This module is the ONE decision point used before an
 * output is rendered, downloaded, or marked physically printed.  It derives
 * every fact from immutable origin, the completed connector mapping, terminal
 * scanner evidence, QA state, and the per-card credit ledger; no request can
 * provide a substitute identifier, station, image, or credit assertion.
 */
import { sql } from "drizzle-orm";
import { db } from "../db";

export type PartnerPrintBlock = {
  certId: string;
  code:
    | "partner_mapping_invalid"
    | "partner_card_job_state_invalid"
    | "partner_qa_incomplete"
    | "partner_credit_unsettled"
    | "partner_capture_evidence_missing"
    | "partner_print_state_invalid"
    | "partner_pilot_schema_unavailable";
  message: string;
};

function isUndefinedOriginColumn(error: unknown): boolean {
  // Drizzle preserves the PostgreSQL error as `cause`; inspect that bounded
  // chain rather than treating every wrapper failure as a legacy-schema case.
  let candidate: unknown = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof candidate !== "object" || candidate === null) return false;
    if ((candidate as { code?: unknown }).code === "42703") return true;
    candidate = (candidate as { cause?: unknown }).cause;
  }
  return false;
}

function pgTextArray(ids: readonly string[]): string {
  return `{${ids.map((id) => `"${String(id).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
}

/**
 * Return only Partner-origin blocks.  HQ/legacy cards retain the established
 * print lifecycle unchanged.  If the pilot's required schema is absent or
 * unavailable, only the affected Partner cards fail closed; an outage must not
 * silently turn a Partner card into a generic printable card.
 */
export async function getPartnerPrintEligibilityBlocks(certIds: readonly string[]): Promise<PartnerPrintBlock[]> {
  const requested = [...new Set(certIds.filter(Boolean))];
  if (requested.length === 0) return [];

  let originRows: { rows: unknown[] };
  try {
    originRows = await db.execute(sql`
      SELECT certificate_number
        FROM certificates
       WHERE certificate_number = ANY(${pgTextArray(requested)}::text[])
         AND origin_type = 'PARTNER'
    `);
  } catch (error) {
    // A pre-origin legacy schema cannot contain a valid Partner-origin row, so
    // it is safe to leave established HQ/legacy output untouched while that
    // schema rolls forward. Every other error is ambiguous (including a
    // transient database/permission failure) and must block instead of turning
    // a Partner certificate into a generically printable one.
    console.warn(
      "[partner-print-eligibility] origin schema unavailable:",
      error instanceof Error ? error.message : error
    );
    if (isUndefinedOriginColumn(error)) return [];
    return requested.map((certId) => ({
      certId,
      code: "partner_pilot_schema_unavailable" as const,
      message: `${certId}: Partner print verification is unavailable.`,
    }));
  }
  const partnerIds = (originRows.rows as unknown as Array<{ certificate_number: string }>).map(
    (row) => row.certificate_number
  );
  if (partnerIds.length === 0) return [];

  try {
    /*
     * OUTPUT ELIGIBILITY IS DECIDED PER LINEAGE.
     *
     * THE DEFECT THIS CLOSES. Every fact below used to be derived through `partner_connector_imports`
     * — the intake mapping, the credit settlement and even which station's captures counted. A
     * Scanner-created Card Job has no connector import and never will (OD-7: a walk-in card has no
     * customer, so the connector's validation gate would block it for ever). So `mapping_valid` was
     * permanently false for it, and a fully graded, QA-approved, paid-for walk-in card was blocked as
     * `partner_mapping_invalid` for ever — an output that could never be produced, reported with a
     * cause that could never be fixed.
     *
     * The connector arm is UNCHANGED. `partner_mapping_invalid` still protects every imported card
     * exactly as it did; nothing here globally disables mapping validation.
     */
    const result = await db.execute(sql`
      SELECT c.certificate_number,
             (job.id IS NOT NULL) AS is_card_job,
             (
               pci.id IS NOT NULL
               AND pcr.id IS NOT NULL
               AND ps.id IS NOT NULL
               AND c.origin_partner_id = pci.partner_organisation_id
               AND c.origin_location_id = pci.partner_location_id
             ) AS mapping_valid,
             -- CARD JOB ARM. The Card Job replaces the connector mapping as the proof of Partner
             -- ownership: it carries the tenant, the location, the immutable MV/certificate pairing
             -- and its own lifecycle. Output is permitted only from a state past QA.
             (
               job.id IS NOT NULL
               AND job.cancelled_at IS NULL
               AND job.mv_number IS NOT NULL
               AND job.certificate_id = c.id
               AND c.origin_partner_id = job.tenant_id
               AND c.origin_location_id = job.location_id
               AND job.status IN ('APPROVED', 'PRINTABLE', 'COMPLETED')
             ) AS card_job_valid,
             (
               c.grader_status = 'approved'
               AND c.review_required = true
               AND c.grade_approved_at IS NOT NULL
               AND c.grade_approved_by IS NOT NULL
             ) AS qa_complete,
             c.print_state IN ('needs_printing', 'reprint_required', 'printing', 'printed', 'reprinted') AS print_state_allows_output,
             COALESCE((
               SELECT count(*) = ps.card_count
                  AND count(*) FILTER (WHERE reservation.status = 'consumed') = ps.card_count
                 FROM partner_credit_reservations reservation
                WHERE reservation.tenant_id = pci.partner_organisation_id
                  AND reservation.source = 'portal'
                  AND reservation.submission_reference = pci.partner_submission_id::text
             ), false) AS credit_settled,
             -- One Card Job is funded by exactly ONE reservation (uq_partner_card_jobs_reservation),
             -- so settlement is a single row rather than a count against a submission's card_count.
             COALESCE((
               SELECT reservation.status = 'consumed'
                 FROM partner_credit_reservations reservation
                WHERE reservation.id = job.reservation_id
                  AND reservation.tenant_id = job.tenant_id
             ), false) AS card_job_credit_settled,
             COALESCE((
               SELECT count(DISTINCT evidence.side) = 2
                 FROM certificate_image_evidence evidence
                 JOIN scanner_capture_sessions session
                   ON session.id = evidence.capture_metadata ->> 'captureSessionId'
                  AND session.certificate_id = evidence.certificate_id
                  AND session.side = evidence.side
                  AND session.state = 'captured'
                 JOIN partner_stations station
                   ON station.id = session.station_id
                  AND station.tenant_id = pci.partner_organisation_id
                  AND station.location_id = pci.partner_location_id
                  AND station.approved_at IS NOT NULL
                WHERE evidence.certificate_id = c.id
                  AND evidence.is_current = true
                  AND evidence.evidence_class = 'NEW_IMMUTABLE_MASTER'
                  AND evidence.format = 'tiff'
             ), false) AS capture_complete,
             -- Identical evidence contract, resolved through the Card Job's own tenant/location.
             COALESCE((
               SELECT count(DISTINCT evidence.side) = 2
                 FROM certificate_image_evidence evidence
                 JOIN scanner_capture_sessions session
                   ON session.id = evidence.capture_metadata ->> 'captureSessionId'
                  AND session.certificate_id = evidence.certificate_id
                  AND session.side = evidence.side
                  AND session.state = 'captured'
                 JOIN partner_stations station
                   ON station.id = session.station_id
                  AND station.tenant_id = job.tenant_id
                  AND station.location_id = job.location_id
                  AND station.approved_at IS NOT NULL
                WHERE evidence.certificate_id = c.id
                  AND evidence.is_current = true
                  AND evidence.evidence_class = 'NEW_IMMUTABLE_MASTER'
                  AND evidence.format = 'tiff'
             ), false) AS card_job_capture_complete
        FROM certificates c
        LEFT JOIN partner_card_jobs job
          ON job.certificate_id = c.id
         AND job.cancelled_at IS NULL
        LEFT JOIN submission_items si ON si.id = c.submission_item_id
        LEFT JOIN submissions s ON s.id = si.submission_id
        LEFT JOIN partner_connector_imports pci
          ON pci.destination_submission_id = s.id
         AND pci.state IN ('completed', 'imported')
         AND c.origin_partner_id = pci.partner_organisation_id
         AND c.origin_location_id = pci.partner_location_id
        LEFT JOIN partner_connector_records pcr
          ON pcr.id = pci.connector_record_id
         AND pcr.tenant_id = pci.partner_organisation_id
         AND pcr.partner_submission_id = pci.partner_submission_id
         AND pcr.handoff_id = pci.partner_handoff_id
         AND pcr.state = 'imported'
        LEFT JOIN partner_submissions ps
          ON ps.id = pci.partner_submission_id
         AND ps.tenant_id = pci.partner_organisation_id
         AND ps.location_id = pci.partner_location_id
       WHERE c.certificate_number = ANY(${pgTextArray(partnerIds)}::text[])
         AND c.origin_type = 'PARTNER'
    `);

    const rows = result.rows as unknown as Array<{
      certificate_number: string;
      is_card_job: boolean;
      mapping_valid: boolean;
      card_job_valid: boolean;
      qa_complete: boolean;
      print_state_allows_output: boolean;
      credit_settled: boolean;
      card_job_credit_settled: boolean;
      capture_complete: boolean;
      card_job_capture_complete: boolean;
    }>;
    const found = new Map(rows.map((row) => [row.certificate_number, row]));
    const blocks: PartnerPrintBlock[] = [];
    for (const certId of partnerIds) {
      const raw = found.get(certId);
      /*
       * A Partner certificate that resolves to NEITHER lineage is blocked, and deliberately reported
       * as a mapping failure: it has no Card Job and no valid import, so there is no Partner
       * provenance behind it at all. Failing closed is the safe direction.
       */
      const cardJobLineage = raw?.is_card_job === true;
      const row = raw
        ? {
            ...raw,
            credit_settled: cardJobLineage ? raw.card_job_credit_settled : raw.credit_settled,
            capture_complete: cardJobLineage ? raw.card_job_capture_complete : raw.capture_complete,
          }
        : undefined;
      if (!row) {
        blocks.push({
          certId,
          code: "partner_mapping_invalid",
          message: `${certId}: Partner intake mapping is invalid.`,
        });
        continue;
      }
      if (cardJobLineage) {
        if (row.card_job_valid !== true) {
          blocks.push({
            certId,
            code: "partner_card_job_state_invalid",
            message: `${certId}: this Partner card job is not in a state that permits output.`,
          });
          continue;
        }
      } else if (row.mapping_valid !== true) {
        blocks.push({
          certId,
          code: "partner_mapping_invalid",
          message: `${certId}: Partner intake mapping is invalid.`,
        });
        continue;
      }
      if (row.qa_complete !== true) {
        blocks.push({
          certId,
          code: "partner_qa_incomplete",
          message: `${certId}: Super Admin QA approval is required before output.`,
        });
        continue;
      }
      if (row.credit_settled !== true) {
        blocks.push({
          certId,
          code: "partner_credit_unsettled",
          message: `${certId}: Partner per-card credit settlement is incomplete.`,
        });
        continue;
      }
      if (row.print_state_allows_output !== true) {
        blocks.push({
          certId,
          code: "partner_print_state_invalid",
          message: `${certId}: certificate print state does not allow output.`,
        });
        continue;
      }
      if (row.capture_complete !== true) {
        blocks.push({
          certId,
          code: "partner_capture_evidence_missing",
          message: `${certId}: Current front and back scanner evidence is required.`,
        });
      }
    }
    return blocks;
  } catch (error) {
    // Do not leak schema/connection detail to a print operator. A source-only
    // pilot migration or a transient Partner-schema failure leaves these cards
    // blocked, which is the safe direction.
    console.error("[partner-print-eligibility] unavailable:", error instanceof Error ? error.message : error);
    return partnerIds.map((certId) => ({
      certId,
      code: "partner_pilot_schema_unavailable" as const,
      message: `${certId}: Partner print verification is unavailable.`,
    }));
  }
}
