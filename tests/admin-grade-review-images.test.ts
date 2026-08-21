import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  dbExecute: vi.fn(),
  getCertificate: vi.fn(),
  getR2SignedUrl: vi.fn(async (key: string) => `https://signed.test/${encodeURIComponent(key)}`),
  checkR2ObjectReadable: vi.fn(async () => ({ ok: true as const })),
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
}));

import { buildAdminReviewImagesPayload, buildCertImagesPayload } from "../server/grader";

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
  runtime.dbExecute.mockResolvedValue({ rows: [] });
  runtime.getCertificate.mockResolvedValue({ ...cert });
  runtime.checkR2ObjectReadable.mockResolvedValue({ ok: true });
});

describe("Super Admin pending-review image payload", () => {
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

  it("keeps the generic grader/admin image payload strict and free of review-only fields", async () => {
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
});
