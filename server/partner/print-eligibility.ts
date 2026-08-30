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
import { readPartnerPrintAuthority } from "./operational-authority";

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
    const authority = await readPartnerPrintAuthority(partnerIds);
    const blocks: PartnerPrintBlock[] = [];
    for (const certId of partnerIds) {
      const row = authority.get(certId);
      /*
       * A Partner certificate that resolves to NEITHER lineage is blocked, and deliberately reported
       * as a mapping failure: it has no Card Job and no valid import, so there is no Partner
       * provenance behind it at all. Failing closed is the safe direction.
       */
      const cardJobLineage = row?.isCardJob === true;
      if (!row) {
        blocks.push({
          certId,
          code: "partner_mapping_invalid",
          message: `${certId}: Partner intake mapping is invalid.`,
        });
        continue;
      }
      if (cardJobLineage) {
        if (row.cardJobValid !== true) {
          blocks.push({
            certId,
            code: "partner_card_job_state_invalid",
            message: `${certId}: this Partner card job is not in a state that permits output.`,
          });
          continue;
        }
      } else if (row.mappingValid !== true) {
        blocks.push({
          certId,
          code: "partner_mapping_invalid",
          message: `${certId}: Partner intake mapping is invalid.`,
        });
        continue;
      }
      if (row.qaComplete !== true) {
        blocks.push({
          certId,
          code: "partner_qa_incomplete",
          message: `${certId}: Super Admin QA approval is required before output.`,
        });
        continue;
      }
      if (row.creditSettled !== true) {
        blocks.push({
          certId,
          code: "partner_credit_unsettled",
          message: `${certId}: Partner per-card credit settlement is incomplete.`,
        });
        continue;
      }
      if (row.printStateAllowsOutput !== true) {
        blocks.push({
          certId,
          code: "partner_print_state_invalid",
          message: `${certId}: certificate print state does not allow output.`,
        });
        continue;
      }
      if (row.captureComplete !== true) {
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
