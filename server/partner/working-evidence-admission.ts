/**
 * Partner full-resolution evidence admission.
 *
 * This is the one physical-capture predicate used by the queue, workstation,
 * lease service and every direct Partner grading write. Keeping it here stops
 * a metadata-shaped ledger row from bypassing the Scanner session/station
 * authority through a second route.
 */
import type { PoolClient } from "pg";
import {
  assessWorkingEvidenceAvailability,
  buildWorkingEvidencePayloadsFromRows,
  unavailableWorkingEvidencePayloads,
  type WorkingEvidencePayload,
  type WorkingEvidenceRow,
} from "../grader";
import { withPartnerAdminTransaction } from "./db";

export type PartnerWorkingEvidenceRow = WorkingEvidenceRow & {
  certificate_id: number;
};

type Queryable = Pick<PoolClient, "query">;

/**
 * Reads only CURRENT immutable masters and binds each side to the certificate's
 * own Partner origin location. A session from another card, tenant, location,
 * inactive station or non-terminal capture cannot satisfy this proof.
 */
export async function loadPartnerWorkingEvidenceRows(
  client: Queryable,
  certificateIds: readonly number[],
  tenantId: string,
  options: { forShare?: boolean } = {}
): Promise<PartnerWorkingEvidenceRow[]> {
  const ids = [...new Set(certificateIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (ids.length === 0) return [];
  const lock = options.forShare ? " FOR SHARE" : "";
  const result = await client.query<PartnerWorkingEvidenceRow>(
    `SELECT evidence.certificate_id, evidence.side, evidence.working_object_key, evidence.format,
            evidence.pixel_width, evidence.pixel_height, evidence.dpi,
            evidence.working_width, evidence.working_height, evidence.working_format,
            evidence.working_settings,
            COALESCE(evidence.capture_metadata->>'scannerProfileVersion', evidence.capture_metadata->>'profileVersion')
              AS scanner_profile_version,
            EXISTS (
              SELECT 1
                FROM scanner_capture_sessions session
                JOIN partner_stations station ON station.id = session.station_id
               WHERE session.id = evidence.capture_metadata ->> 'captureSessionId'
                 AND session.certificate_id = evidence.certificate_id
                 AND session.side = evidence.side
                 AND session.state = 'captured'
                 AND station.status = 'ACTIVE'
                 AND station.tenant_id = $2::uuid
                 AND station.location_id = certificate.origin_location_id
            ) AS capture_provenance_valid
       FROM certificate_image_evidence evidence
       JOIN certificates certificate ON certificate.id = evidence.certificate_id
      WHERE evidence.certificate_id = ANY($1::int[])
        AND evidence.evidence_class = 'NEW_IMMUTABLE_MASTER'
        AND evidence.format = 'tiff'
        AND evidence.is_current = true${lock}`,
    [ids, tenantId]
  );
  return result.rows;
}

/**
 * Includes object-store reachability, not just ledger metadata. Both sides
 * must be admitted before a Partner queue row may open or a write may persist.
 */
export async function hasAdmittedPartnerWorkingEvidence(
  rows: readonly PartnerWorkingEvidenceRow[],
  certificateId: number
): Promise<boolean> {
  const admitted = new Set<string>();
  for (const row of rows) {
    if (Number(row.certificate_id) !== certificateId) continue;
    if (row.side !== "front" && row.side !== "back") continue;
    if ((await assessWorkingEvidenceAvailability(row)).state === "admitted") admitted.add(row.side);
  }
  return admitted.has("front") && admitted.has("back");
}

/** Read the scoped physical evidence once, then render its URLs/statuses from
 * that same proof. The queue and workstation therefore cannot disagree about
 * whether a side is admissible. */
export async function buildPartnerWorkingEvidencePayloads(
  certificateIds: readonly number[],
  tenantId: string
): Promise<Map<number, WorkingEvidencePayload>> {
  const ids = [...new Set(certificateIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  try {
    const rows = await withPartnerAdminTransaction((client) => loadPartnerWorkingEvidenceRows(client, ids, tenantId));
    return buildWorkingEvidencePayloadsFromRows(ids, rows);
  } catch {
    return unavailableWorkingEvidencePayloads(ids);
  }
}
