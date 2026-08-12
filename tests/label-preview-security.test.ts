import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CertificateRecord } from "@shared/schema";

vi.mock("../server/lib/catalogue-provider", () => ({ getCatalogueSnapshot: vi.fn(async () => []) }));
vi.mock("../server/labels", () => ({ generateLabelPNG: vi.fn(async () => Buffer.from("png")) }));

import { buildLabelPreviewCertificate, generateLabelPreviewPNG } from "../server/services/label-preview";
import {
  authorizePartnerLabelPreview,
  authorizeStaffLabelPreview,
  previewCertificateId,
  type PartnerPreviewCandidateLike,
  type PartnerPreviewPrincipalLike,
} from "../server/services/label-preview-access";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const PARTNER = read("server/partner/grading-routes.ts");
const SESSION = read("server/partner/session.ts");
const ADMIN = read("server/routes/admin/label-preview.ts");
const SERVICE = read("server/services/label-preview.ts");
const ACCESS = read("server/services/label-preview-access.ts");

function saved(overrides: Record<string, unknown> = {}): CertificateRecord {
  return {
    id: 41,
    certId: "MV-0000000041",
    cardName: "Saved card",
    setName: "Saved set",
    rarity: "Saved rarity",
    labelType: "standard",
    gradeType: "numeric",
    gradeOverall: "7",
    ...overrides,
  } as unknown as CertificateRecord;
}

const partnerPrincipal = (overrides: Partial<PartnerPreviewPrincipalLike> = {}): PartnerPreviewPrincipalLike => ({
  tenantId: "tenant-a",
  userId: "partner-user-a",
  locationId: "location-a",
  orgWide: false,
  mfaPassed: true,
  permissions: new Set(["partner.cards.preview"]),
  ...overrides,
});

const partnerCandidate = (overrides: Partial<PartnerPreviewCandidateLike> = {}): PartnerPreviewCandidateLike => ({
  tenantId: "tenant-a",
  locationId: "location-a",
  assignedGraderId: "partner-user-a",
  gradingStatus: "assigned",
  provenanceValid: true,
  ...overrides,
});

describe("server-authorised certificate label preview", () => {
  it("rejects arbitrary/malformed certificate IDs and looks up every supplied ID server-side", () => {
    expect(previewCertificateId({ certificateId: "41 OR 1=1" })).toBeNull();
    expect(previewCertificateId({ certificateId: -1 })).toBeNull();
    expect(previewCertificateId({ certificateId: 41 })).toBe(41);
    expect(ACCESS).toContain('if (!/^[1-9][0-9]*$/.test(String(raw ?? ""))) return null');
    expect(ADMIN).toContain("await storage.getCertificate(authorisedId)");
    expect(ADMIN).toContain("if (authorisedId != null && !saved)");
  });

  it("rejects cross-staff assignment access after requiring the live grade capability", () => {
    expect(
      authorizeStaffLabelPreview(
        { isStaff: true, capGrade: true, staffId: "staff-a", graderId: "staff-a" },
        { assignedGraderId: "staff-b" }
      )
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      authorizeStaffLabelPreview(
        { isStaff: true, capGrade: false, staffId: "staff-a", graderId: "staff-a" },
        { assignedGraderId: "staff-a" }
      )
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      authorizeStaffLabelPreview(
        { isStaff: true, capGrade: true, staffId: "staff-a", graderId: "staff-a" },
        { assignedGraderId: "staff-a" }
      )
    ).toEqual({ ok: true });
    expect(ADMIN).toContain('requireCapability("grade")');
    expect(ACCESS).toContain("assignment.assignedGraderId");
    expect(ACCESS).toContain("!== actorId");
  });

  it("rejects cross-Partner tenant access", () => {
    expect(authorizePartnerLabelPreview(partnerPrincipal(), partnerCandidate({ tenantId: "tenant-b" }))).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(PARTNER).toContain("pci.partner_organisation_id = $2");
    expect(PARTNER).toContain("pcr.tenant_id = pci.partner_organisation_id");
    expect(PARTNER).toContain("ps.tenant_id = pci.partner_organisation_id");
  });

  it("rejects cross-location Partner access", () => {
    expect(
      authorizePartnerLabelPreview(partnerPrincipal(), partnerCandidate({ locationId: "location-b" }))
    ).toMatchObject({ ok: false, status: 404 });
    expect(PARTNER).toContain("row.locationId !== principal.locationId");
    expect(PARTNER).toContain("ps.location_id = pci.partner_location_id");
  });

  it("rejects provenance mismatch/corruption across record, handoff and source submission", () => {
    expect(
      authorizePartnerLabelPreview(partnerPrincipal(), partnerCandidate({ provenanceValid: false }))
    ).toMatchObject({ ok: false, status: 404 });
    expect(PARTNER).toContain("pcr.id = pci.connector_record_id");
    expect(PARTNER).toContain("pcr.partner_submission_id = pci.partner_submission_id");
    expect(PARTNER).toContain("pcr.handoff_id = pci.partner_handoff_id");
    expect(PARTNER).toContain("psh.submission_id = pci.partner_submission_id");
    expect(PARTNER).toContain("pcr.state = 'imported'");
    expect(PARTNER).toContain("pci.state IN ('completed','imported')");
  });

  it("rejects unassigned Partner cards", () => {
    expect(
      authorizePartnerLabelPreview(partnerPrincipal(), partnerCandidate({ assignedGraderId: "partner-user-b" }))
    ).toMatchObject({ ok: false, status: 403 });
    expect(PARTNER).toContain("auth.assignedGraderId !== principal.userId");
    expect(PARTNER).toContain("This card is not assigned to you");
  });

  it("rejects suspended/unauthorised Partner sessions and missing preview permission", () => {
    expect(authorizePartnerLabelPreview(null, partnerCandidate())).toMatchObject({ ok: false, status: 401 });
    expect(authorizePartnerLabelPreview(partnerPrincipal({ mfaPassed: false }), partnerCandidate())).toMatchObject({
      ok: false,
      status: 401,
    });
    expect(
      authorizePartnerLabelPreview(partnerPrincipal({ permissions: new Set() }), partnerCandidate())
    ).toMatchObject({ ok: false, status: 403 });
    expect(SESSION).toContain('s.user_status !== "ACTIVE" || s.org_status !== "ACTIVE"');
    expect(SESSION).toContain('s.location_status !== "ACTIVE"');
    expect(PARTNER).toContain('requirePartnerCapability("partner.cards.preview")');
  });

  it("permits the valid assigned-card path only after all Partner scope gates", () => {
    expect(authorizePartnerLabelPreview(partnerPrincipal(), partnerCandidate())).toEqual({ ok: true });
    const previewRoute = PARTNER.slice(PARTNER.indexOf('"/grading/certificates/label/preview"'));
    expect(previewRoute).toContain("loadPartnerCert(req.partner!, certId)");
    expect(previewRoute).toContain("authorizeAssignedPartnerCert");
    expect(previewRoute).toContain("await storage.getCertificate(certId)");
    expect(previewRoute).toContain("generateLabelPreviewPNG(cert)");
  });

  it("blocks a Partner label preview while Super Admin QA is pending", () => {
    expect(
      authorizePartnerLabelPreview(partnerPrincipal(), partnerCandidate({ gradingStatus: "pending_review" }))
    ).toMatchObject({ ok: false, status: 403, error: "This card is awaiting Super Admin QA" });
    expect(ACCESS).toContain('candidate.gradingStatus === "pending_review"');
  });

  it("preserves the authorised saved certificate number and omitted metadata", async () => {
    const base = saved();
    const cert = await buildLabelPreviewCertificate(base, {
      certificateId: 41,
      certId: "MV-HOSTILE",
      cardName: "Live draft",
      gradeOverall: 8,
    });
    expect(cert.certId).toBe("MV-0000000041");
    expect(cert.cardName).toBe("Live draft");
    expect(cert.gradeOverall).toBe("7");
    expect(cert.setName).toBe("Saved set");
    expect(cert.rarity).toBe("Saved rarity");
    expect(base.cardName).toBe("Saved card");
    const mutableFields = SERVICE.slice(SERVICE.indexOf("MUTABLE_PREVIEW_FIELDS"), SERVICE.indexOf("] as const"));
    expect(mutableFields).not.toContain('"gradeOverall"');
    expect(mutableFields).not.toContain('"gradeCentering"');
  });

  it("refreshes saved authoritative grades only after a successful grade write", () => {
    const panel = read("client/src/components/grading/grading-panel.tsx");
    const workstation = read("client/src/components/grading-workflow/GradingWorkstation.tsx");
    const preview = read("client/src/components/grading-workflow/CertificatePreviewPanel.tsx");
    expect(panel).toContain("onPreviewSaved?.(readReviewRevision(data))");
    expect(workstation).toContain("revision={previewRevision}");
    expect(preview).toContain('body: JSON.stringify(body)');
    expect(preview).toContain('res.headers.get("X-MintVault-Review-Revision")');
    expect(preview).toContain("authoritativeRevision !== expectedRevision");
    expect(preview).toContain("[endpoint, expectedRevision, key, requireExpectedRevision, revision, onRevisionComplete, requestTimeoutMs]");
  });

  it("provides Pending Review language and service tier from the authorised queue", () => {
    const adminStaff = read("client/src/pages/admin-staff.tsx");
    const routes = read("server/routes.ts");
    expect(routes).toContain("cert.year_text AS year, cert.language, cert.variant");
    expect(routes).toContain("s.tracking_number AS submission_ref, s.service_tier");
    expect(adminStaff).toContain("serviceTier={reviewCert.serviceTier}");
  });

  it("uses the canonical renderer and has zero issuance/numbering/print/NFC/claim/credit side effects", async () => {
    await expect(generateLabelPreviewPNG(saved())).resolves.toEqual(Buffer.from("png"));
    expect(SERVICE).toContain('generateLabelPNG(cert, "front")');
    const executable = SERVICE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const forbidden of [
      /storage\./,
      /\bINSERT\b/i,
      /\bUPDATE\b/i,
      /createCertificate/,
      /certificateNumber|certificate_number/,
      /approveCert|approval/i,
      /print_state|printable/i,
      /\bnfc\b/i,
      /claim.?code/i,
      /settle|consume|reservation|credit/i,
    ]) {
      expect(executable, `preview service contains side-effect surface ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it("keeps Pending Review on the admin adapter but requires pending_review state", () => {
    expect(ADMIN).toContain('"/api/admin/grade-review/certificates/label/preview"');
    expect(ADMIN).toContain('assignment.gradingStatus !== "pending_review"');
  });
});
