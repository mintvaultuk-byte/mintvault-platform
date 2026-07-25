/**
 * Regression proof for the 0 / POOR label incident (production, found 2026-07-25).
 *
 * `POST /api/admin/print-batch` had no grade or approval gate, and the renderer coerced a
 * missing numeric grade to zero: `parseFloat(cert.gradeOverall || "0")`. Because
 * `mvgsTierName(0)` returns "Poor", 22 ungraded production certificates were rendered onto a
 * real 4-page label sheet whose gold grade panel read **0** and **POOR** — a grade no grader
 * ever awarded, on a physical product.
 *
 * These tests exercise the REAL renderer (`generateLabelPNG` from server/labels.ts) and the
 * REAL shared rule, so they fail if either regresses. The byte-identity tests are the
 * safety net for the protected label design: a valid label must render exactly as before.
 */
import { describe, expect, it, vi } from "vitest";

// The renderer imports the MVGS calibration loader, which imports server/db. This test
// needs no database — it renders from in-memory certificates — so the connection is
// stubbed. Queries return no rows, which is exactly the "no calibration override" case the
// loader already handles, so the rendered output is the default/production calibration.
vi.mock("../server/db", () => ({
  db: { execute: async () => ({ rows: [] }) },
  pool: { query: async () => ({ rows: [] }) },
}));
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { UnprintableGradeError, checkPrintableGrade, parseStoredGrade } from "../shared/printable-grade";
import { generateLabelPNG } from "../server/labels";

/** A complete, production-shaped numeric certificate. */
const numericCert = (over: Record<string, unknown> = {}) =>
  ({
    certId: "MV-0000000900",
    cardName: "CHARIZARD",
    setName: "Base Set",
    year: "1999",
    cardNumber: "4",
    gradeType: "numeric",
    gradeOverall: "8.5",
    centering: null,
    gradeCentering: 8.5,
    gradeCorners: 9,
    gradeEdges: 8,
    gradeSurface: 9,
    ...over,
  }) as never;

/** An authentication-only certificate: NO grade is its CORRECT state. */
const authOnlyCert = (over: Record<string, unknown> = {}) =>
  ({
    certId: "MV-0000000901",
    cardName: "CHARIZARD",
    setName: "Base Set",
    year: "1999",
    cardNumber: "4",
    gradeType: "NO",
    gradeOverall: null,
    ...over,
  }) as never;

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("the rule: parseStoredGrade never invents a number", () => {
  it("rejects everything parseFloat would have coerced", () => {
    for (const v of ["", "   ", null, undefined, "abc", "7.5abc", "0x0A", "1e2", "Infinity", "NaN", [8], {}, true]) {
      expect(parseStoredGrade(v as unknown)).toBeNull();
    }
  });

  it("accepts genuine stored values (Drizzle returns numeric as a string)", () => {
    expect(parseStoredGrade("8.5")).toBe(8.5);
    expect(parseStoredGrade("10")).toBe(10);
    expect(parseStoredGrade("8.0")).toBe(8);
    expect(parseStoredGrade(9.5)).toBe(9.5);
  });
});

describe("the rule: checkPrintableGrade", () => {
  it("blocks a numeric certificate with NO grade — the exact incident condition", () => {
    const v = checkPrintableGrade({ gradeType: "numeric", gradeOverall: null });
    expect(v.printable).toBe(false);
    expect(v.reason).toBe("missing_numeric_grade");
    expect(v.message).toMatch(/has no grade yet/i);
  });

  it("blocks an empty-string grade", () => {
    expect(checkPrintableGrade({ gradeType: "numeric", gradeOverall: "" }).printable).toBe(false);
  });

  it("blocks a malformed grade", () => {
    const v = checkPrintableGrade({ gradeType: "numeric", gradeOverall: "7.5abc" });
    expect(v.printable).toBe(false);
    expect(v.reason).toBe("malformed_numeric_grade");
  });

  it("blocks off-ladder grades", () => {
    for (const g of ["0", "-5", "7.55", "100", "10.5", "0.5"]) {
      const v = checkPrintableGrade({ gradeType: "numeric", gradeOverall: g });
      expect(v.printable, `grade ${g} must be blocked`).toBe(false);
      expect(v.reason).toBe("off_ladder_numeric_grade");
    }
  });

  it("ALLOWS every legitimate MVGS ladder grade", () => {
    for (const g of ["1", "1.5", "2", "3.5", "5", "7.5", "8", "8.5", "9", "9.5", "10"]) {
      expect(checkPrintableGrade({ gradeType: "numeric", gradeOverall: g }).printable, `grade ${g}`).toBe(true);
    }
  });

  it("ALLOWS an authentication-only certificate with no grade — its correct state", () => {
    for (const t of ["NO", "AA", "not_original", "authentic_altered"]) {
      expect(checkPrintableGrade({ gradeType: t, gradeOverall: null }).printable, t).toBe(true);
      expect(checkPrintableGrade({ gradeType: t, gradeOverall: "" }).printable, t).toBe(true);
    }
  });

  it("blocks a kind/grade CONTRADICTION rather than guessing which is right", () => {
    const v = checkPrintableGrade({ gradeType: "NO", gradeOverall: "8.5" });
    expect(v.printable).toBe(false);
    expect(v.reason).toBe("kind_grade_contradiction");
  });

  it("treats an absent grade_type as numeric (the column default)", () => {
    expect(checkPrintableGrade({ gradeType: null, gradeOverall: null }).printable).toBe(false);
    expect(checkPrintableGrade({ gradeType: undefined, gradeOverall: "9" }).printable).toBe(true);
  });

  it("never leaks customer data in the operator message", () => {
    const v = checkPrintableGrade({ gradeType: "numeric", gradeOverall: null });
    expect(v.message).not.toMatch(/@|customer|email|address|phone/i);
  });
});

describe("THE RENDERER cannot turn a missing grade into 0 / POOR", () => {
  it("REFUSES to render a numeric certificate with a NULL grade", async () => {
    await expect(generateLabelPNG(numericCert({ gradeOverall: null }), "front")).rejects.toThrow(UnprintableGradeError);
  });

  it("refuses an empty-string grade", async () => {
    await expect(generateLabelPNG(numericCert({ gradeOverall: "" }), "front")).rejects.toThrow(UnprintableGradeError);
  });

  it("refuses a malformed grade rather than prefix-parsing it", async () => {
    await expect(generateLabelPNG(numericCert({ gradeOverall: "7.5abc" }), "front")).rejects.toThrow(
      UnprintableGradeError
    );
  });

  it("refuses an off-ladder grade", async () => {
    await expect(generateLabelPNG(numericCert({ gradeOverall: "0" }), "front")).rejects.toThrow(UnprintableGradeError);
  });

  it("refuses the BACK side too — a slab is a pair, not a half", async () => {
    await expect(generateLabelPNG(numericCert({ gradeOverall: null }), "back")).rejects.toThrow(UnprintableGradeError);
  });

  it("carries the certificate number so an operator knows which card blocked the sheet", async () => {
    try {
      await generateLabelPNG(numericCert({ gradeOverall: null }), "front");
      throw new Error("should have refused");
    } catch (err) {
      expect(err).toBeInstanceOf(UnprintableGradeError);
      expect((err as UnprintableGradeError).certId).toBe("MV-0000000900");
      expect((err as UnprintableGradeError).reason).toBe("missing_numeric_grade");
    }
  });

  it("the zero coercion is gone from the source", () => {
    const src = readFileSync(new URL("../server/labels.ts", import.meta.url), "utf8");
    expect(src).not.toContain('parseFloat(cert.gradeOverall || "0")');
    expect(src).toContain("assertPrintableGrade(");
  });
});

describe("legitimate labels are UNCHANGED (protected label design)", () => {
  it("a valid numeric label still renders, and identical input is byte-identical", async () => {
    const a = await generateLabelPNG(numericCert(), "front");
    const b = await generateLabelPNG(numericCert(), "front");
    expect(a.length).toBeGreaterThan(1000);
    expect(sha(a)).toBe(sha(b));
  });

  it("every ladder grade renders, and each grade is visually distinct", async () => {
    const hashes = new Map<string, string>();
    for (const g of ["1", "1.5", "7.5", "8", "8.5", "9", "9.5", "10"]) {
      const png = await generateLabelPNG(numericCert({ gradeOverall: g }), "front");
      hashes.set(g, sha(png));
    }
    expect(new Set(hashes.values()).size).toBe(hashes.size);
  });

  it("an authentication-only label still renders through its legitimate path", async () => {
    const png = await generateLabelPNG(authOnlyCert(), "front");
    expect(png.length).toBeGreaterThan(1000);
  });

  it("an authentication-only label is NOT forced to carry a numeric grade", async () => {
    // Its render must differ from any numeric render — no grade digit is drawn.
    const auth = sha(await generateLabelPNG(authOnlyCert(), "front"));
    for (const g of ["1", "8.5", "10"]) {
      expect(auth).not.toBe(
        sha(await generateLabelPNG(numericCert({ certId: "MV-0000000901", gradeOverall: g }), "front"))
      );
    }
  });

  it("both AA and NO render, and differ from each other", async () => {
    const no = sha(await generateLabelPNG(authOnlyCert({ gradeType: "NO" }), "front"));
    const aa = sha(await generateLabelPNG(authOnlyCert({ gradeType: "AA" }), "front"));
    expect(no).not.toBe(aa);
  });

  it("the back label still renders for a valid certificate", async () => {
    const png = await generateLabelPNG(numericCert(), "back");
    expect(png.length).toBeGreaterThan(1000);
  });
});

describe("preview and print share ONE rule, so they cannot disagree", () => {
  it("the preview endpoint calls the same checkPrintableGrade", () => {
    const src = readFileSync(new URL("../server/routes/admin/label-preview.ts", import.meta.url), "utf8");
    expect(src).toContain("checkPrintableGrade(");
    expect(src).toContain("UNPRINTABLE_GRADE");
    expect(src).toContain("422");
  });

  it("batch creation calls the same rule BEFORE reserving (no partial batch)", () => {
    const src = readFileSync(new URL("../server/print-workflow.ts", import.meta.url), "utf8");
    const gateAt = src.indexOf("checkPrintableGrade(");
    const reserveAt = src.indexOf("// ── 1. RESERVE");
    expect(gateAt).toBeGreaterThan(0);
    expect(reserveAt).toBeGreaterThan(0);
    expect(gateAt).toBeLessThan(reserveAt); // gate strictly before any write
  });

  it("the legacy print-batch route gates BEFORE minting claim codes (no side effects)", () => {
    const src = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
    const gateAt = src.indexOf("Grade printability PRE-PASS");
    const mintAt = src.indexOf("getOrGenerateClaimCode", gateAt);
    expect(gateAt).toBeGreaterThan(0);
    expect(mintAt).toBeGreaterThan(gateAt);
  });

  it("reprint enforces the same rule — no invented historical-artefact exemption", () => {
    const src = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
    expect(src).toContain("unprintableRe");
    expect(src).toMatch(/Cannot reprint/);
  });

  it("all print paths report the blocked certificate number and no customer data", () => {
    const src = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
    expect(src).toContain("blockedCertIds");
    const idx = src.indexOf("blockedCertIds");
    const around = src.slice(idx - 600, idx + 300);
    expect(around).not.toMatch(/customerEmail|customerName|address/);
  });
});

describe("the grader publication path cannot publish a blank numeric grade (MV205 class)", () => {
  it("approveGraderCert validates the stored grade before any approval write", () => {
    const src = readFileSync(new URL("../server/grader.ts", import.meta.url), "utf8");
    const gateAt = src.indexOf("checkPrintableGrade(");
    const approveAt = src.indexOf("await approveCertGrade(certId", gateAt);
    expect(gateAt).toBeGreaterThan(0);
    expect(approveAt).toBeGreaterThan(gateAt); // validation strictly before the publish CAS
    expect(src).toMatch(/Cannot publish a numeric certificate with no grade/);
  });

  it("applyCertGradeDraft routes the kind decision through the shared rule and rejects junk", () => {
    const src = readFileSync(new URL("../server/grader.ts", import.meta.url), "utf8");
    expect(src).toContain("rejectKindChange({");
    expect(src).toContain("normaliseGradeType(cert.gradeType)");
    expect(src).toContain("Unrecognised grade type.");
    // The old verbatim write must be gone.
    expect(src).not.toContain('const gradeType = pick(body.grade_type, cert.gradeType) || "numeric";');
  });

  it("a draft refusal throws a typed rejection, not a truthy object (callers check `if (!saved)`)", () => {
    const src = readFileSync(new URL("../server/grader.ts", import.meta.url), "utf8");
    expect(src).toContain("class GradeDraftRejected");
    expect(src).not.toContain("as never;");
    const routes = readFileSync(new URL("../server/routes/grader.ts", import.meta.url), "utf8");
    expect((routes.match(/GradeDraftRejected/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});
