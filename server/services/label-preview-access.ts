/** Pure, executable access decisions for live certificate previews. */

export type PreviewAccessDecision = { ok: true } | { ok: false; status: 400 | 401 | 403 | 404; error: string };

export function previewCertificateId(body: Record<string, unknown>): number | null {
  const raw = body.certificateId ?? body.id;
  if (!/^[1-9][0-9]*$/.test(String(raw ?? ""))) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

export function authorizeStaffLabelPreview(
  session: { isStaff?: boolean; capGrade?: boolean; staffId?: string; graderId?: string } | null | undefined,
  assignment: { assignedGraderId: string | null } | null
): PreviewAccessDecision {
  if (!session?.isStaff || !session.staffId) return { ok: false, status: 401, error: "Unauthorized" };
  if (!session.capGrade) return { ok: false, status: 403, error: "Forbidden: missing 'grade' capability" };
  if (!assignment) return { ok: false, status: 404, error: "Certificate not found" };
  const actorId = String(session.graderId ?? session.staffId);
  if (String(assignment.assignedGraderId ?? "") !== actorId) {
    return { ok: false, status: 403, error: "This card is not assigned to you" };
  }
  return { ok: true };
}

export interface PartnerPreviewPrincipalLike {
  tenantId: string;
  userId: string;
  locationId: string | null;
  orgWide: boolean;
  mfaPassed: boolean;
  permissions: Set<string>;
}

export interface PartnerPreviewCandidateLike {
  tenantId: string;
  locationId: string | null;
  assignedGraderId: string | null;
  gradingStatus: string;
  provenanceValid: boolean;
}

export function authorizePartnerLabelPreview(
  principal: PartnerPreviewPrincipalLike | null | undefined,
  candidate: PartnerPreviewCandidateLike | null
): PreviewAccessDecision {
  if (!principal?.mfaPassed) return { ok: false, status: 401, error: "authentication required" };
  if (!principal.permissions.has("partner.cards.preview")) {
    return { ok: false, status: 403, error: "forbidden" };
  }
  if (!candidate || !candidate.provenanceValid || candidate.tenantId !== principal.tenantId) {
    return { ok: false, status: 404, error: "Not found" };
  }
  if (!principal.orgWide && (!principal.locationId || candidate.locationId !== principal.locationId)) {
    return { ok: false, status: 404, error: "Not found" };
  }
  if (candidate.assignedGraderId !== principal.userId) {
    return { ok: false, status: 403, error: "This card is not assigned to you" };
  }
  if (candidate.gradingStatus === "approved") {
    return { ok: false, status: 403, error: "This card is already approved" };
  }
  return { ok: true };
}
