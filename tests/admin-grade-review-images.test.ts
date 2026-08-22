import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  dbExecute: vi.fn(),
  getCertificate: vi.fn(),
  getR2SignedUrl: vi.fn(async (key: string) => `https://signed.test/${encodeURIComponent(key)}`),
  checkR2ObjectReadable: vi.fn(async () => ({ ok: true as const })),
  headR2: vi.fn(async () => ({ contentLength: 123, lastModified: new Date("2026-08-21T00:00:00Z") })),
}));

vi.mock("../server/db", () => ({
  db: { execute: runtime.dbExecute },
}));

vi.mock("../server/storage", () => ({
  storage: {
    getCertificate: runtime.getCertificate,
  },
}));

vi.mock("../server/r2", () => ({
  getR2SignedUrl: runtime.getR2SignedUrl,
  checkR2ObjectReadable: runtime.checkR2ObjectReadable,
  headR2: runtime.headR2,
}));

import { buildAdminReviewImagesPayload, buildCertImagesPayload, buildSuperAdminCertImagesPayload } from "../server/grader";

const cert = {
  id: 686,
  gradingFrontDisplay: "certificates/MV686/front_display.jpg",
  gradingBackDisplay: "certificates/MV686/back_display.jpg",
  gradingFrontOriginal: "certificates/MV686/front_original.jpg",
  gradingBackOriginal: "certificates/MV686/back_original.jpg",
  frontImagePath: "certificates/MV686/front_legacy.jpg",
  backImagePath: "certificates/MV686/back_legacy.jpg",
  imageQualityChecks: {},
};

beforeEach(() => {
  runtime.dbExecute.mockReset();
  runtime.getCertificate.mockReset();
  runtime.getR2SignedUrl.mockClear();
  runtime.checkR2ObjectReadable.mockReset();
  runtime.headR2.mockReset();
  runtime.dbExecute.mockResolvedValue({ rows: [] });
  runtime.getCertificate.mockResolvedValue({ ...cert });
  runtime.checkR2ObjectReadable.mockResolvedValue({ ok: true });
  runtime.headR2.mockResolvedValue({ contentLength: 123, lastModified: new Date("2026-08-21T00:00:00Z") });
});

function admittedWorkingRows(certId = 686) {
  return [
    {
      certificate_id: certId,
      side: "front",
      working_object_key: "evidence/MV686/front-working.jpg",
      format: "tiff",
      pixel_width: 4724,
      pixel_height: 6136,
      dpi: 1200,
      working_width: 4724,
      working_height: 6136,
      working_format: "jpeg",
      working_settings: { resize: null },
      scanner_profile_version: "mintvault-canon-lide-400-v3",
    },
    {
      certificate_id: certId,
      side: "back",
      working_object_key: "evidence/MV686/back-working.jpg",
      format: "tiff",
      pixel_width: 4724,
      pixel_height: 6136,
      dpi: 1200,
      working_width: 4724,
      working_height: 6136,
      working_format: "jpeg",
      working_settings: { resize: null },
      scanner_profile_version: "mintvault-canon-lide-400-v3",
    },
  ];
}

describe("Super Admin certificate-bound image payload", () => {
  it("adds authorised certificate-bound FRONT/BACK review URLs without pretending they are working evidence", async () => {
    const payload = await buildAdminReviewImagesPayload(686);

    expect(payload?.urls.front_working).toBeNull();
    expect(payload?.urls.back_working).toBeNull();
    expect(payload?.workingEvidence.front.available).toBe(false);
    expect(payload?.urls.front_review).toBe("https://signed.test/certificates%2FMV686%2Ffront_display.jpg");
    expect(payload?.urls.back_review).toBe("https://signed.test/certificates%2FMV686%2Fback_display.jpg");
    expect(payload?.reviewEvidence.front).toEqual({
      available: true,
      reason: null,
      recovery: null,
      source: "certificate-bound-image",
    });
    expect(payload?.reviewEvidence.back.available).toBe(true);
    expect(runtime.checkR2ObjectReadable).toHaveBeenCalledWith("certificates/MV686/front_display.jpg");
    expect(runtime.checkR2ObjectReadable).toHaveBeenCalledWith("certificates/MV686/back_display.jpg");
  });

  it("uses admitted working evidence before authoritative Super Admin review images when both exist", async () => {
    runtime.dbExecute.mockResolvedValueOnce({ rows: admittedWorkingRows() });

    const payload = await buildSuperAdminCertImagesPayload(686);

    expect(payload?.urls.front_working).toBe("https://signed.test/evidence%2FMV686%2Ffront-working.jpg");
    expect(payload?.urls.back_working).toBe("https://signed.test/evidence%2FMV686%2Fback-working.jpg");
    expect(payload?.workingEvidence.front.available).toBe(true);
    expect(payload?.workingEvidence.back.available).toBe(true);
    expect(payload?.reviewEvidence.front.available).toBe(true);
    expect(runtime.headR2).toHaveBeenCalledWith("evidence/MV686/front-working.jpg");
    expect(runtime.checkR2ObjectReadable).toHaveBeenCalledWith("certificates/MV686/front_display.jpg");
  });

  it("allows main Super Admin certificate preview to receive certificate-bound FRONT/BACK when working evidence is unavailable", async () => {
    const payload = await buildSuperAdminCertImagesPayload(686);

    expect(payload?.urls.front_working).toBeNull();
    expect(payload?.urls.back_working).toBeNull();
    expect(payload?.urls.front_review).toBe("https://signed.test/certificates%2FMV686%2Ffront_display.jpg");
    expect(payload?.urls.back_review).toBe("https://signed.test/certificates%2FMV686%2Fback_display.jpg");
    expect(payload?.reviewEvidence.front.source).toBe("certificate-bound-image");
    expect(payload?.reviewEvidence.back.available).toBe(true);
  });

  it("keeps the generic grader image payload strict and free of Super Admin review-only fields", async () => {
    const payload = (await buildCertImagesPayload(686)) as any;

    expect(payload.urls.front_review).toBeUndefined();
    expect(payload.reviewEvidence).toBeUndefined();
  });

  it("distinguishes missing bindings from missing storage objects per side", async () => {
    runtime.getCertificate.mockResolvedValueOnce({
      ...cert,
      gradingFrontDisplay: null,
      gradingFrontOriginal: null,
      frontImagePath: null,
    });
    runtime.getCertificate.mockResolvedValueOnce({
      ...cert,
      gradingFrontDisplay: null,
      gradingFrontOriginal: null,
      frontImagePath: null,
    });
    runtime.checkR2ObjectReadable.mockResolvedValueOnce({
      ok: false,
      reason: "missing",
      message: "Storage object missing.",
    });

    const payload = await buildAdminReviewImagesPayload(712);

    expect(payload?.urls.front_review).toBeNull();
    expect(payload?.reviewEvidence.front.reason).toContain("binding is missing");
    expect(payload?.urls.back_review).toBeNull();
    expect(payload?.reviewEvidence.back.reason).toContain("storage object is missing");
  });

  it("keeps FRONT and BACK review bindings side-specific", async () => {
    const payload = await buildSuperAdminCertImagesPayload(686);

    expect(payload?.urls.front_review).toContain("front_display");
    expect(payload?.urls.front_review).not.toContain("back_display");
    expect(payload?.urls.back_review).toContain("back_display");
    expect(payload?.urls.back_review).not.toContain("front_display");
  });

  it("does not substitute another certificate image when a side binding is missing", async () => {
    runtime.getCertificate.mockResolvedValueOnce({
      ...cert,
      gradingBackDisplay: null,
      gradingBackCropped: null,
      gradingBackOriginal: null,
      backImagePath: null,
    });
    runtime.getCertificate.mockResolvedValueOnce({
      ...cert,
      gradingBackDisplay: null,
      gradingBackCropped: null,
      gradingBackOriginal: null,
      backImagePath: null,
    });

    const payload = await buildSuperAdminCertImagesPayload(686);

    expect(payload?.urls.front_review).toContain("front_display");
    expect(payload?.urls.back_review).toBeNull();
    expect(payload?.reviewEvidence.back.reason).toContain("binding is missing");
    expect(runtime.getR2SignedUrl).not.toHaveBeenCalledWith(expect.stringContaining("MV999"), expect.anything());
  });
});
