import { describe, expect, it } from "vitest";
import {
  buildVoidedVerificationResponse,
  classifyPublicCertificate,
  filterPublicCertificates,
} from "../server/public-certificate-validity";

describe("public certificate validity contract", () => {
  it("classifies only approved active records as publicly valid", () => {
    expect(classifyPublicCertificate({ certId: "MV1", status: "active", gradeApprovedAt: new Date() })).toBe("active");
    expect(classifyPublicCertificate({ certId: "MV1", status: "voided", gradeApprovedAt: new Date() })).toBe("voided");
    expect(classifyPublicCertificate({ certId: "MV1", status: "active", gradeApprovedAt: null })).toBe("hidden");
    expect(classifyPublicCertificate({ certId: "MV1", status: "unexpected", gradeApprovedAt: new Date() })).toBe(
      "hidden"
    );
  });

  it("returns a minimal discriminated revocation response with no stale public authority", () => {
    const response = buildVoidedVerificationResponse({
      certId: "MV-0000000123",
      status: "voided",
      gradeApprovedAt: new Date(),
      grade: "GEM MINT",
      ownerDisplayName: "Private Owner",
      verifyUrl: "/cert/MV123",
    } as never);

    expect(response).toEqual({ verified: false, reason: "voided", certId: "MV123", status: "voided" });
    expect(response).not.toHaveProperty("grade");
    expect(response).not.toHaveProperty("ownerDisplayName");
    expect(response).not.toHaveProperty("verifyUrl");
  });

  it("filters search/list projections to approved active certificates only", () => {
    const active = { certId: "MV1", status: "active", gradeApprovedAt: new Date(), cardName: "public" };
    const voided = { certId: "MV2", status: "voided", gradeApprovedAt: new Date(), cardName: "revoked" };
    const unapproved = { certId: "MV3", status: "active", gradeApprovedAt: null, cardName: "draft" };

    expect(filterPublicCertificates([active, voided, unapproved])).toEqual([active]);
  });
});
