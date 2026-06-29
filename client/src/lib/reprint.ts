/**
 * Pure decision for the admin certificate reprint flow (Phase 1).
 *
 * The removed route /api/admin/printing/reprint/:certId is NOT restored.
 * Reprints route through the supported print-batch endpoints:
 *   - unclaimed cert -> POST /api/admin/print-batch         { certIds: [certId] }
 *   - claimed cert   -> POST /api/admin/print-batch/reprint { certIds: [certId], reason }
 * A claimed reprint requires a genuine 10–500 character audit reason.
 */

export interface ReprintCert {
  certId: string;
  ownershipStatus?: string | null;
}

export const REPRINT_REASON_MIN = 10;
export const REPRINT_REASON_MAX = 500;

export function isClaimed(cert: ReprintCert): boolean {
  return (cert.ownershipStatus ?? "unclaimed") !== "unclaimed";
}

export function isValidReprintReason(reason: string | null | undefined): boolean {
  const r = (reason ?? "").trim();
  return r.length >= REPRINT_REASON_MIN && r.length <= REPRINT_REASON_MAX;
}

export type ReprintRequest =
  | { url: "/api/admin/print-batch"; body: { certIds: string[] } }
  | { url: "/api/admin/print-batch/reprint"; body: { certIds: string[]; reason: string } };

/**
 * Build the request for reprinting a single certificate. Throws when a claimed
 * cert is reprinted without a valid reason (the caller must collect one first).
 */
export function buildReprintRequest(cert: ReprintCert, reason?: string): ReprintRequest {
  if (isClaimed(cert)) {
    const r = (reason ?? "").trim();
    if (!isValidReprintReason(r)) {
      throw new Error(
        `A reprint reason of ${REPRINT_REASON_MIN}–${REPRINT_REASON_MAX} characters is required for a claimed certificate.`
      );
    }
    return { url: "/api/admin/print-batch/reprint", body: { certIds: [cert.certId], reason: r } };
  }
  return { url: "/api/admin/print-batch", body: { certIds: [cert.certId] } };
}
