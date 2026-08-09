import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../server/db", () => ({
  db: { transaction: vi.fn(), execute: vi.fn() },
}));

vi.mock("../server/storage", () => ({
  storage: {
    getUserByEmail: vi.fn(async () => ({
      id: "admin-user-1",
      email: "mintvaultuk@gmail.com",
      credentialVersion: 1,
      deletedAt: null,
    })),
  },
}));

vi.mock("../server/account-auth", () => ({
  verifyPassword: vi.fn(async () => true),
}));

vi.mock("../server/r2", () => ({
  uploadToR2: vi.fn(async () => undefined),
}));

import { isSuperAdminEmail, requireSuperAdmin } from "../server/auth";
import { correctionModeInternals } from "../server/correction-mode";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

function makeRes() {
  const res: any = {
    statusCode: null,
    body: null,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
}

describe("Super Admin correction permission boundary", () => {
  beforeEach(() => {
    process.env.SUPER_ADMIN_EMAILS = "owner@example.com,mintvaultuk@gmail.com";
  });

  it("uses a central Super Admin allowlist and rejects normal admin sessions", async () => {
    expect(isSuperAdminEmail("OWNER@example.com")).toBe(true);
    expect(isSuperAdminEmail("admin@example.com")).toBe(false);

    const res = makeRes();
    const next = vi.fn();
    await requireSuperAdmin(
      {
        path: "/api/admin/certificates/1/correction",
        session: {
          isAdmin: true,
          adminEmail: "admin@example.com",
          credentialVersion: 1,
          authenticatedAt: Date.now(),
        },
      } as never,
      res as never,
      next as never
    );

    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("allows a configured Super Admin after the normal admin gate passes", async () => {
    const res = makeRes();
    const next = vi.fn();
    await requireSuperAdmin(
      {
        path: "/api/admin/certificates/1/correction",
        session: {
          isAdmin: true,
          adminEmail: "owner@example.com",
          credentialVersion: 1,
          authenticatedAt: Date.now(),
        },
      } as never,
      res as never,
      next as never
    );

    expect(res.statusCode).toBeNull();
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe("correction payload and audit helpers", () => {
  it("does not create phantom collection changes when the existing form omitted collection fields", () => {
    const metadata = correctionModeInternals.buildMetadata(
      {
        cardGame: "Pokemon",
        setName: "Base Set",
        cardName: "Charizard",
        cardNumber: "4/102",
        year: "1999",
      },
      {
        variant: null,
        rarity: null,
        collection: "Vintage",
        collection_code: "WOTC",
        collection_other: null,
        grade_type: "numeric",
        designations: [],
      }
    );

    expect(metadata).not.toHaveProperty("collection");
    expect(metadata).not.toHaveProperty("collectionCode");
    expect(metadata).not.toHaveProperty("collectionOther");
  });

  it("fails closed on blank required identity values rather than persisting empty corrections", () => {
    expect(() =>
      correctionModeInternals.buildMetadata(
        { cardGame: "Pokemon", setName: "", cardName: "Charizard", cardNumber: "4/102", year: "1999" },
        { variant: null, rarity: null, grade_type: "numeric", designations: [] }
      )
    ).toThrow(/Set is required/);
  });

  it("keeps private/internal fields out of grading corrections and staff-visible audit changes", () => {
    const grading = correctionModeInternals.buildGrading({
      overall_grade: "8.5",
      grade_centering: "9",
      defects: [{ type: "corner", severity: "minor" }],
      private_notes: "do not expose",
      ai_defect_candidates: [{ type: "scratch" }],
    });

    expect(grading).toMatchObject({ grade: "8.5", centering: "9.0" });
    expect(grading).not.toHaveProperty("privateNotes");

    const details = correctionModeInternals.safeAuditDetails({
      certificateNumber: "MV123",
      gradedBy: "grader-1",
      idempotencyKey: null,
      changes: [
        { field: "grade", before: "8.0", after: "8.5" },
        { field: "aiDefectCandidates", before: [], after: [{ type: "scratch" }] },
        { field: "labelType", before: "standard", after: "standard" },
      ],
    });

    // The audit must be TRUTHFUL: every field the live record actually changed is listed.
    // A previous revision omitted the internal fields here, so an audit row could report
    // changed_fields: [] while the certificates row had in fact been mutated.
    expect(details.changed_fields).toEqual(["grade", "aiDefectCandidates", "labelType"]);
    // Large AI blobs are recorded as a bounded shape summary, never verbatim.
    expect(details.changes.grade).toEqual({ before: "8.0", after: "8.5" });
    expect(details.changes.aiDefectCandidates).toMatchObject({ summarized: true, after: "array(1)" });
    expect(details.summarized_fields).toEqual(["aiDefectCandidates", "labelType"]);

    // Keeping them from staff is a DISPLAY concern, enforced by one shared exclusion list.
    const staffVisible = details.changed_fields.filter(
      (f: string) => !correctionModeInternals.CORRECTION_DISPLAY_EXCLUDED_FIELDS.has(f)
    );
    expect(staffVisible).toEqual(["grade"]);
    // `notes` is admin free-text that may reference the customer — never shown to a grader.
    expect(correctionModeInternals.CORRECTION_DISPLAY_EXCLUDED_FIELDS.has("notes")).toBe(true);
  });

  it("derives R2 object keys from the server-side cert number, not client input", () => {
    const seg = correctionModeInternals.correctionKeySegment;
    // normalizeCertId is pass-through for non-MV input, so it is not a sanitiser on its own.
    expect(seg("MV-0000004242")).toBe("MV4242");
    expect(seg("../../images/MV1")).toBe("unknown");
    expect(seg("../../../etc/passwd")).toBe("unknown");
    expect(seg("")).toBe("unknown");

    // Defence-in-depth guard rejects anything that escapes the corrections/ prefix.
    const assertKey = correctionModeInternals.assertSafeCorrectionKey;
    expect(() => assertKey("corrections/MV1/front/abc.jpg")).not.toThrow();
    expect(() => assertKey("corrections/../images/MV1/front/a.jpg")).toThrow();
    expect(() => assertKey("images/MV1/front/a.jpg")).toThrow();
  });
});

describe("correction route, audit, image, stats, and UI wiring", () => {
  const correctionService = read("server/correction-mode.ts");
  const graderRoutes = read("server/routes/grader.ts");
  const graderService = read("server/grader.ts");
  const adminDashboard = read("client/src/pages/admin-dashboard.tsx");
  const staffPage = read("client/src/pages/staff.tsx");
  const operatorStats = read("client/src/pages/admin-operator-stats.tsx");
  const gradingPanel = read("client/src/components/grading/grading-panel.tsx");
  const certificateForm = read("client/src/components/certificate-form.tsx");
  const authRoutes = read("server/routes/auth.ts");

  it("registers a single Super Admin correction endpoint with optimistic locking and mandatory audit", () => {
    expect(correctionService).toContain('"/api/admin/certificates/:id/correction"');
    expect(correctionService).toMatch(/requireSuperAdmin,\s*upload\.fields/s);
    expect(correctionService).toContain("FOR UPDATE");
    expect(correctionService).toContain("EXTRACT(EPOCH FROM updated_at)::text AS correction_version");
    expect(correctionService).toContain("String(input.expectedVersion) !== currentVersion");
    expect(correctionService).toContain('code: "version_conflict"');
    expect(correctionService).toContain("db.transaction(async (tx)");
    expect(correctionService).toContain("INSERT INTO audit_log");
    expect(correctionService).toContain("Correction audit insert failed");
    expect(correctionService).not.toMatch(/writeAuditLog|catch\s*\([^)]*\)\s*\{\s*console\.warn/s);
  });

  it("validates grading JSON before image upload and never deletes old evidence during correction", () => {
    const handler = correctionService.slice(
      correctionService.indexOf('"/api/admin/certificates/:id/correction"'),
      correctionService.indexOf("const result =")
    );
    expect(handler.indexOf("parseBodyJson")).toBeLessThan(handler.indexOf("uploadCorrectionImages"));
    // The R2 key seed must come from the DB row, never from the request body.
    expect(correctionService).toContain("loadCorrectionTarget");
    expect(correctionService).not.toContain("body.certId || body.certificateNumber");
    // Target/version are resolved BEFORE any bytes are written, so a rejected correction
    // does not strand orphaned objects in the bucket.
    expect(handler.indexOf("loadCorrectionTarget")).toBeLessThan(handler.indexOf("uploadCorrectionImages"));
    expect(correctionService).toContain("crypto.randomUUID()");
    expect(correctionService).not.toMatch(/deleteObject|deleteFromR2|remove.*R2/i);
  });

  it("approved grader reads are pure and staff writes remain fail-closed", () => {
    const readHandler = graderRoutes.slice(
      graderRoutes.indexOf('"/api/grader/certificates/:id/grading"'),
      graderRoutes.indexOf('app.put("/api/grader/certificates/:id/edit-submission"')
    );
    expect(readHandler).toContain("authorizeGraderCertRead");
    expect(readHandler.indexOf('auth.gradingStatus === "approved"')).toBeLessThan(readHandler.indexOf("ensureAiDraft"));
    expect(readHandler).toContain("return res.json(payload)");
    expect(graderRoutes).toContain("if (!graderId) return { ok: false, status: 401");
    expect(graderRoutes).toMatch(/app\.get\(\s*"\/api\/grader\/certificates\/:id\/corrections"/);
    expect(graderRoutes).toContain("action = 'cert_live_record_edit'");
  });

  it("uses the canonical workstation plus a bounded CertificateForm metadata surface for correction mode", () => {
    expect(adminDashboard).toContain('data-testid="button-correction-mode"');
    expect(adminDashboard).toContain('data-testid="button-save-correction"');
    expect(adminDashboard).toContain("correctionVersionFor");
    expect(adminDashboard).toContain("correctionMode={correctionMode}");
    expect(adminDashboard).toContain("<GradingWorkstation");
    expect(adminDashboard).toContain('mode="super-admin"');
    expect(adminDashboard).toContain('data-testid="certificate-metadata-surface"');
    expect(certificateForm).toContain("onCorrectionMetadataReady");
    expect(certificateForm).not.toMatch(/CanonicalGradingWorkstationShell|<GradingPanel|data-workflow-stage/);
    expect(gradingPanel).toContain("onCorrectionGradingReady");
    expect(gradingPanel).toContain("delete (payload as any).private_notes");
  });

  it("shows corrected fields to the original grader without adding inbox-style workflows", () => {
    expect(staffPage).toContain("fetch(`/api/grader/certificates/${certId}/corrections`");
    expect(staffPage).toContain("btn-view-approved");
    expect(staffPage).toContain("correctionFeedback={correctionFeedback}");
    expect(gradingPanel).toContain("This grading has been corrected by Admin.");
    expect(gradingPanel).toContain('data-testid="staff-correction-feedback"');
    expect(gradingPanel).not.toMatch(/acknowledge|read receipt|training note|inbox/i);
  });

  it("adds bounded correction stats to the existing operator stats page", () => {
    expect(graderService).toContain("LIMIT 10000");
    expect(graderService).toContain("NOW() - INTERVAL '180 days'");
    expect(graderService).toContain("action = 'cert_live_record_edit'");
    expect(operatorStats).toContain("corrected: number");
    expect(operatorStats).toContain("correctionPercentage: number");
    expect(operatorStats).toContain("mostCorrectedField: string | null");
    expect(operatorStats).toContain('label="Corrected"');
    expect(operatorStats).toContain('label="Correction %"');
    expect(operatorStats).toContain('label="Common fix"');
  });

  it("advertises Super Admin identity in the existing admin session response", () => {
    expect(authRoutes).toContain("isSuperAdmin: isSuperAdminEmail(status.email)");
  });
});
