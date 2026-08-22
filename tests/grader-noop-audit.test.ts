import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  dbExecute: vi.fn(),
  getCertificate: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock("../server/db", () => ({
  db: { execute: runtime.dbExecute },
}));

vi.mock("../server/storage", () => ({
  storage: {
    getCertificate: runtime.getCertificate,
    writeAuditLog: runtime.writeAuditLog,
  },
}));

vi.mock("../server/r2", () => ({
  getR2SignedUrl: vi.fn(async () => "https://example.invalid/signed"),
}));

import { adminReviewSaveDraft } from "../server/grader";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const certSnapshot = {
  id: 700,
  language: "Spanish",
  rarityCode: "holo_rare_v",
  finishVariant: "holo",
  promoType: null,
  gradeOverall: "9.0",
  gradeCentering: "9.0",
  gradeCorners: "9.0",
  gradeEdges: "9.0",
  gradeSurface: "9.0",
  gradeType: "numeric",
};

beforeEach(() => {
  runtime.dbExecute.mockReset();
  runtime.getCertificate.mockReset();
  runtime.writeAuditLog.mockReset();
});

describe("role write paths suppress no-op audit rows", () => {
  it("admin review draft save writes no admin_grade_edit audit when the snapshot is unchanged", async () => {
    runtime.dbExecute
      .mockResolvedValueOnce({
        rows: [{ id: 700, assigned_grader_id: "grader-1", grader_status: "pending_review" }],
      })
      // The two calibration SELECTs that used to sit here are GONE. The MVGS
      // v1.4 freeze pinned calibration to constants in shared/mvgs/v1_4, so the
      // grade authority no longer reads `pipeline_settings` — neither for the
      // draft write nor for buildCertGradingPayload's returned result. The
      // remaining execute is the draft UPDATE itself.
      .mockResolvedValueOnce({ rows: [{ grading_revision: 1 }] });
    runtime.getCertificate.mockResolvedValue({ ...certSnapshot });

    const result = await adminReviewSaveDraft(
      700,
      {
        language: "Spanish",
        rarity_code: "holo_rare_v",
        finish_variant: "holo",
        overall_grade: "9.0",
        grade_centering: "9.0",
        grade_corners: "9.0",
        grade_edges: "9.0",
        grade_surface: "9.0",
      },
      "admin@example.test"
    );

    expect(result).toMatchObject({ ok: true, revision: 1, authoritativeGrade: expect.any(Object) });
    expect(runtime.writeAuditLog).not.toHaveBeenCalled();
  });

  it("grader edit-submission audits only when changed is non-empty", () => {
    const routes = read("server/routes/grader.ts");
    const start = routes.indexOf('"/api/grader/certificates/:id/edit-submission"');
    const block = routes.slice(start, routes.indexOf("return res.json({ ok: true, gradingStatus", start));
    expect(block).toContain("const changed: Record<string, { from: unknown; to: unknown }> = {};");
    expect(block).toMatch(/if \(Object\.keys\(changed\)\.length > 0\) \{\s*await storage\.writeAuditLog/);
  });
});
