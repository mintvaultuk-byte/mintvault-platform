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
    console.warn("[partner-print-eligibility] origin schema unavailable:", error instanceof Error ? error.message : error);
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
    const result = await db.execute(sql`
      SELECT c.certificate_number,
             (
               pci.id IS NOT NULL
               AND pcr.id IS NOT NULL
               AND ps.id IS NOT NULL
               AND c.origin_partner_id = pci.partner_organisation_id
               AND c.origin_location_id = pci.partner_location_id
             ) AS mapping_valid,
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
             ), false) AS capture_complete
        FROM certificates c
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
      mapping_valid: boolean;
      qa_complete: boolean;
      print_state_allows_output: boolean;
      credit_settled: boolean;
      capture_complete: boolean;
    }>;
    const found = new Map(rows.map((row) => [row.certificate_number, row]));
    const blocks: PartnerPrintBlock[] = [];
    for (const certId of partnerIds) {
      const row = found.get(certId);
      if (!row || row.mapping_valid !== true) {
        blocks.push({ certId, code: "partner_mapping_invalid", message: `${certId}: Partner intake mapping is invalid.` });
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
