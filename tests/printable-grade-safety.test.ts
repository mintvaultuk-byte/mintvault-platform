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
import { isNonNumericGrade } from "../shared/schema";
import { generateLabelPDF, generateLabelPNG } from "../server/labels";
import { currentPrintOutputBlock } from "../server/lib/print-output-eligibility";

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

describe("the kind predicate matches the renderer EXACTLY (hostile-review Critical)", () => {
  // The first version of the rule TRIMMED grade_type while the renderer used exact string
  // membership. Consequence, proven by rendering the PNG: grade_type " NO " with a NULL
  // grade passed the gate as "authentication-only, no grade needed", the renderer saw " NO "
  // as numeric, and printed 0 / POOR — the incident artefact, reproduced. Every one of the
  // other 32 tests passed while that hole was open, which is why these exist.
  const padded = [" NO ", "NO ", " NO", "AA ", "\nNO", "\tAA", "not_original ", " authentic_altered"];

  it("a padded non-numeric grade_type with NO grade is NOT printable", () => {
    for (const gt of padded) {
      const v = checkPrintableGrade({ gradeType: gt, gradeOverall: null });
      expect(v.printable, `gradeType ${JSON.stringify(gt)} must fail closed`).toBe(false);
      expect(v.reason).toBe("missing_numeric_grade");
    }
  });

  it("the RENDERER refuses every padded form — no 0 / POOR panel can be produced", async () => {
    for (const gt of padded) {
      await expect(
        generateLabelPNG(numericCert({ gradeType: gt, gradeOverall: null }), "front"),
        `gradeType ${JSON.stringify(gt)}`
      ).rejects.toThrow(UnprintableGradeError);
    }
  });

  it("junk grade_type with no grade is NOT printable either", () => {
    for (const gt of ["banana", "NUMERIC", "no", "aa", "", "   ", "0"]) {
      expect(checkPrintableGrade({ gradeType: gt, gradeOverall: null }).printable, gt).toBe(false);
    }
  });

  it("the gate and the renderer agree on EVERY grade_type / grade combination", async () => {
    // The real invariant: the rule's verdict must predict the renderer's behaviour exactly.
    const types = ["numeric", "NO", "AA", "not_original", "authentic_altered", " NO ", "banana", "", null];
    const grades = [null, "", "8.5", "0", "7.55", "abc"];
    for (const gt of types) {
      for (const g of grades) {
        const predicted = checkPrintableGrade({ gradeType: gt, gradeOverall: g }).printable;
        let rendered = true;
        try {
          await generateLabelPNG(numericCert({ gradeType: gt, gradeOverall: g }), "front");
        } catch {
          rendered = false;
        }
        expect(rendered, `gradeType=${JSON.stringify(gt)} grade=${JSON.stringify(g)}`).toBe(predicted);
      }
    }
    /*
     * EXPLICIT TIMEOUT, because this case renders 54 real label PNGs through node-canvas — genuine
     * CPU work, not I/O. Vitest's 5s default happened to fit while the suite was the heaviest thing
     * running; once other suites started spinning up disposable PostgreSQL clusters alongside it,
     * the same passing assertions began timing out. Raising it does not weaken anything: every
     * assertion is unchanged, and a genuine hang still fails, just later.
     */
  }, 60_000);

  it("uses the shared isNonNumericGrade predicate rather than its own trimmed set", async () => {
    const { isNonNumericGrade } = await import("../shared/schema");
    const src = readFileSync(new URL("../shared/printable-grade.ts", import.meta.url), "utf8");
    expect(src).toContain("isNonNumericGrade(gradeType)");
    expect(src).not.toContain("NON_NUMERIC_TYPES");
    // And the predicate itself is exact, not trimming.
    expect(isNonNumericGrade(" NO ")).toBe(false);
    expect(isNonNumericGrade("NO")).toBe(true);
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

describe("real label PDFs retain their physical dimensions", () => {
  it.each(["front", "back", "both"] as const)("renders a complete %s PDF with embedded label images", async (side) => {
    for (const cert of [numericCert(), authOnlyCert()]) {
      const pdf = await generateLabelPDF(cert, side);
      const source = pdf.toString("latin1");
      expect(source.startsWith("%PDF-")).toBe(true);
      expect(source.trimEnd().endsWith("%%EOF")).toBe(true);
      const boxes = [...source.matchAll(/\/MediaBox\s*\[([^\]]+)\]/g)];
      expect(boxes).toHaveLength(1);
      const [x, y, width, height] = boxes[0][1].trim().split(/\s+/).map(Number);
      expect([x, y]).toEqual([0, 0]);
      // Preserve the renderer's established 2.83465 pt/mm conversion, not a
      // freshly rounded conversion that would change historical PDF geometry.
      expect(width).toBe(198.4255);
      expect(height).toBe(side === "both" ? 113.386 : 56.693);
      expect(source.match(/\/Type\s*\/Page\b/g)).toHaveLength(1);
      expect((source.match(/\/Subtype\s*\/Image\b/g) ?? []).length).toBeGreaterThanOrEqual(side === "both" ? 2 : 1);
      expect(pdf.length).toBeGreaterThan(1000);
    }
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

  it("reprint creation and cached-artifact download share the complete current-output gate", () => {
    const workflow = readFileSync(new URL("../server/print-workflow.ts", import.meta.url), "utf8");
    const routes = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
    const persistence = readFileSync(new URL("../server/lib/print-artifact-persistence.ts", import.meta.url), "utf8");
    expect(workflow).toContain("currentPrintOutputBlock(");
    expect(persistence).toContain("currentPrintOutputBlock(");
    expect(routes).toContain("assertBatchArtefactPrintable");
    expect(routes).toContain("currentPrintOutputBlock(");
  });

  it("the current-output gate rejects approval, review, validity, deletion, and grade drift", () => {
    const valid = {
      gradeType: "numeric",
      gradeOverall: "9",
      gradeApprovedAt: new Date("2026-09-04T10:00:00Z"),
      graderStatus: "approved",
      status: "active",
      deletedAt: null,
    };
    expect(currentPrintOutputBlock("MV-SAFE", valid)).toBeNull();
    expect(currentPrintOutputBlock("MV-NO-APPROVAL", { ...valid, gradeApprovedAt: null })?.code).toBe("not_approved");
    expect(currentPrintOutputBlock("MV-ASSIGNED", { ...valid, graderStatus: "assigned" })?.code).toBe(
      "grade_review_incomplete"
    );
    expect(currentPrintOutputBlock("MV-VOID", { ...valid, status: "voided" })?.code).toBe("cert_not_active");
    expect(currentPrintOutputBlock("MV-DELETED", { ...valid, deletedAt: new Date() })?.code).toBe("cert_deleted");
    expect(currentPrintOutputBlock("MV-GRADE", { ...valid, gradeOverall: null })?.code).toBe(
      "missing_numeric_grade"
    );
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

/* ------------------------------------------------------------------------------------------ */
/* Certificate CREATION — reachability closure, re-anchored on the named-handler architecture  */
/* ------------------------------------------------------------------------------------------ */

describe("certificate creation cannot mint an unprintable-but-plausible row", () => {
  // PR #254 closed this on the INLINE `POST /api/admin/certificates` handler. main has since
  // refactored that route body into the exported named handler `handleCertificateCreate`, so
  // the safeguard was re-applied there and these assertions target the named handler. PR #254
  // asserted this reachability closure only in prose — it had no test at all.
  const ROUTES = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");

  function namedHandler(name: string): string {
    const start = ROUTES.indexOf(`export async function ${name}(`);
    expect(start, `${name} must exist as an exported named handler`).toBeGreaterThan(-1);
    const next = ROUTES.indexOf("\nexport async function ", start + 1);
    return ROUTES.slice(start, next === -1 ? undefined : next);
  }

  it("the create path lives in handleCertificateCreate and normalises grade_type", () => {
    const body = namedHandler("handleCertificateCreate");
    expect(body).toContain("normaliseGradeType(req.body.gradeType)");
    // The verbatim write that made the incident row creatable must be gone from this handler.
    expect(body).not.toContain('req.body.gradeType || "numeric"');
  });

  it("the normalised value — not the raw body — is what gets persisted", () => {
    const body = namedHandler("handleCertificateCreate");
    const assignIdx = body.indexOf("normaliseGradeType(req.body.gradeType)");
    const persistIdx = body.indexOf("gradeType,", assignIdx);
    expect(assignIdx).toBeGreaterThan(-1);
    expect(persistIdx, "the persisted field must come from the normalised local").toBeGreaterThan(assignIdx);
    // No later re-read of the raw body for this column.
    expect(body.slice(assignIdx)).not.toMatch(/gradeType:\s*req\.body\.gradeType/);
  });

  it("the grade-update path normalises too, so create and update cannot disagree", () => {
    const body = namedHandler("handleCertificateGradeUpdate");
    expect(body).toContain("normaliseGradeType(");
  });

  it("no junk grade_type can survive creation as a printable-with-no-grade row", async () => {
    // The composition that the incident depended on: a kind that LOOKS non-numeric to a human,
    // is treated as numeric by the renderer, and carries no grade. After normalisation the
    // stored value is canonical, so the shared rule and the renderer agree for every input.
    const { normaliseGradeType } = await import("../server/lib/grade-kind");
    const junk = [
      " NO ",
      "NO ",
      " NO",
      "no",
      "  ",
      "",
      "banana",
      "AA ",
      " aa",
      "\nNO",
      "\tAA",
      "not_original ",
      " authentic_altered",
      "numeric ",
      "NUMERIC",
    ];
    for (const raw of junk) {
      const stored = normaliseGradeType(raw);
      const verdict = checkPrintableGrade({ gradeType: stored, gradeOverall: null });
      if (stored === "numeric") {
        expect(verdict.printable, `${JSON.stringify(raw)} -> numeric must need a grade`).toBe(false);
        expect(verdict.reason).toBe("missing_numeric_grade");
      } else {
        // Normalised to a genuine authentication-only token — one of the canonical set,
        // which includes the legacy long forms "not_original" / "authentic_altered" that
        // isNonNumericGrade still accepts. The invariant that matters is not WHICH token it
        // is, but that the RENDERER'S OWN predicate agrees it is non-numeric — that exact
        // agreement is what the hostile-review Critical broke.
        expect(isNonNumericGrade(stored), `${JSON.stringify(raw)} -> ${stored}`).toBe(true);
        expect(verdict.printable).toBe(true);
      }
    }
  });

  it("a created row that IS graded still prints — the gate is not a blanket refusal", () => {
    for (const g of ["1", "5.5", "9", "10"]) {
      expect(checkPrintableGrade({ gradeType: "numeric", gradeOverall: g }).printable).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------------------------------ */
/* THE PROTECTED LABEL DESIGN — standing golden-render protection                              */
/* ------------------------------------------------------------------------------------------ */

/**
 * server/labels.ts renders a PHYSICAL product. It used to be protected only by a filename check
 * in tests/grading-stale-grade-race.test.ts ("PR A scope guard"), which was pinned to a moving
 * HEAD. That could not tell an authorised change apart from a regression, so it blocked PR #254's
 * founder-approved print-safety work while catching no design drift at all — a filename says
 * nothing about pixels.
 *
 * This replaces it with the assertion that actually matters: the RENDERED BYTES. Any change to a
 * dimension, colour, font, position, tier name or the MVGS grade panel fails immediately.
 *
 * Truncated to 16 hex chars for readability; still 64 bits per label.
 *
 * ── WHY THESE HASHES ARE LINUX-ONLY (2026-07-29) ────────────────────────────────────────────
 * The table originally held hashes captured on a macOS dev machine. Those values never
 * described the product: macOS resolved `Arial` to Apple's licensed Monotype Arial, while the
 * Fly production image resolves it to Nimbus Sans. The slabs customers hold have NEVER been
 * rendered in Arial, so the old table pinned a rendering that only ever existed on one laptop
 * — it would have failed the moment CI ran, and "fixing" it by re-capturing on macOS would
 * have re-pinned the same fiction.
 *
 * Byte-identical PNGs across macOS and Linux are additionally IMPOSSIBLE, and not because of
 * fonts: a canvas containing only a filled rectangle and a circle — no text at all — already
 * hashes differently on the two platforms (0824d006b8d305d2 vs 7df18d6d92c86fe5 on the same
 * node-canvas 3.2.2). That is the cairo/libpng build, which no amount of font work can align.
 *
 * So the pixel goldens are captured where the artefact is actually produced — the Linux
 * production image — and this block runs on Linux only. Font determinism itself IS portable
 * and is asserted separately, on every platform, by the advance-width golden below.
 *
 * IF ONE OF THESE FAILS: do not update the hash to make it pass. A change here means the
 * physical product changed. Re-render, look at the PNG, and get founder approval before
 * touching this table.
 */
/**
 * THE GOLDENS DESCRIBE linux/x64 — THE PRODUCTION ARCHITECTURE. Do not change this to a
 * bare platform check.
 *
 * ROOT CAUSE, measured 2026-07-29 (do not re-diagnose from scratch):
 * The BACK-label goldens were originally captured in a Linux container on an arm64 developer
 * Mac. Fly production is linux/amd64 — proven by the deployed image's own manifest
 * (`registry.fly.io/mintvault:deployment-01KYN8J3JPPTKWZ281B99X2345` →
 * `{"architecture":"amd64","os":"linux"}`) — and GitHub's ubuntu runners are amd64 too. The
 * first time these goldens ever ran on hosted CI they therefore failed, against an arm64
 * reference that matched neither production nor CI.
 *
 * The difference is NOT a design change, a font change, a layout change or a scaling-mode
 * change. Bisected stage by stage across both architectures — blank canvas, QR buffer bytes,
 * PNG decode, each raster asset scaled, alpha compositing over white, full composite, PNG
 * encoding — EVERY stage hashes identically on arm64 and amd64. The whole back label differs
 * by 19 pixels out of 1,121,812 (0.0017 %) with a maximum channel delta of 1: a
 * last-significant-bit anti-aliasing difference in the stroked MVGS mark, which is the only
 * place the label strokes vector text rather than filling glyphs. Fronts, which only fill,
 * are byte-identical on both architectures — which is exactly why fronts passed CI and backs
 * did not.
 *
 * The values below were regenerated INSIDE the real Fly production image (amd64) with this
 * branch's source overlaid, and every FRONT hash came back identical to the original table —
 * confirming the fronts were always right and only the backs were captured on the wrong
 * architecture.
 *
 * IF ONE OF THESE FAILS on linux/x64: it is a real change to the physical product. Do not
 * update the hash to make it pass.
 */
const isProdArch = process.platform === "linux" && process.arch === "x64";
const GOLDEN_NUMERIC: [string, string, string][] = [
  ["1", "front", "106eeb89e7da3a46"],
  ["1", "back", "b8eb321264e8d4d1"],
  ["1.5", "front", "9060c533dbd9268d"],
  ["1.5", "back", "b8eb321264e8d4d1"],
  ["5", "front", "983c96b2f6b16d04"],
  ["5", "back", "b8eb321264e8d4d1"],
  ["7.5", "front", "4abbed8528c83a76"],
  ["7.5", "back", "b8eb321264e8d4d1"],
  ["8", "front", "75bed94b4c32e24d"],
  ["8", "back", "b8eb321264e8d4d1"],
  ["8.5", "front", "96ca7f0ade006884"],
  ["8.5", "back", "b8eb321264e8d4d1"],
  ["9", "front", "e48329a484263a82"],
  ["9", "back", "b8eb321264e8d4d1"],
  ["9.5", "front", "501f3857e4b978c6"],
  ["9.5", "back", "b8eb321264e8d4d1"],
  ["10", "front", "d10c95e8ce8a97ea"],
  ["10", "back", "b8eb321264e8d4d1"],
];

const GOLDEN_AUTH: [string, string, string][] = [
  ["NO", "front", "bf6feb5c6bd124bc"],
  ["NO", "back", "c4ba630206ffb5bf"],
  ["AA", "front", "24bcb38af5da6625"],
  ["AA", "back", "c4ba630206ffb5bf"],
  ["not_original", "front", "bf6feb5c6bd124bc"],
  ["not_original", "back", "c4ba630206ffb5bf"],
  ["authentic_altered", "front", "24bcb38af5da6625"],
  ["authentic_altered", "back", "c4ba630206ffb5bf"],
];

describe.skipIf(!isProdArch)("THE PROTECTED LABEL DESIGN — golden renders (do not update to make them pass)", () => {
  it("every numeric ladder grade renders to its committed golden hash, front and back", async () => {
    for (const [grade, side, expected] of GOLDEN_NUMERIC) {
      const png = await generateLabelPNG(numericCert({ gradeOverall: grade }), side as "front" | "back");
      expect(sha(png).slice(0, 16), `numeric ${grade} ${side} label design changed`).toBe(expected);
    }
  }, 300_000);

  it("every authentication-only kind renders to its committed golden hash, front and back", async () => {
    for (const [kind, side, expected] of GOLDEN_AUTH) {
      const png = await generateLabelPNG(
        authOnlyCert({ gradeType: kind, gradeOverall: null }),
        side as "front" | "back"
      );
      expect(sha(png).slice(0, 16), `auth-only ${kind} ${side} label design changed`).toBe(expected);
    }
  }, 300_000);
});

describe("the golden tables themselves (platform-independent)", () => {
  it("covers both sides of every grade and kind it claims to", () => {
    // A table that silently lost rows would pass vacuously.
    expect(GOLDEN_NUMERIC.length).toBe(18);
    expect(GOLDEN_AUTH.length).toBe(8);
    for (const side of ["front", "back"]) {
      expect(GOLDEN_NUMERIC.filter(([, s]) => s === side).length).toBe(9);
      expect(GOLDEN_AUTH.filter(([, s]) => s === side).length).toBe(4);
    }
  });

  /**
   * THE PORTABLE HALF OF THE LABEL PROTECTION.
   *
   * Pixel hashes cannot cross an OS boundary (cairo/libpng differ), but ADVANCE WIDTHS come
   * from the font file itself, so they can — and they are what actually determines typography,
   * spacing, line fitting and centring on the slab. Pinning them here means a font swap,
   * a missing bundled file falling back to a host font, or a metric-incompatible substitution
   * fails on EVERY platform, including a developer's Mac, without waiting for CI.
   *
   * Captured from the Linux production image. The 0.05px tolerance absorbs a sub-pixel CFF
   * scaling difference between platforms on the two OpenType (Nimbus) faces — measured at
   * 0.0225px — while still being ~1000x tighter than any real font substitution, which moves
   * these numbers by tens of pixels (e.g. Arial->DejaVu Sans moved SANS normal 603.14 -> 655.82).
   */
  it("every bundled face keeps its exact advance widths (portable font determinism)", async () => {
    const { createCanvas } = await import("canvas");
    const { ensureFontsRegistered, MV_SANS, MV_SERIF, MV_MONO, MV_BLACK } = await import("../server/labels");
    await ensureFontsRegistered();
    const SAMPLE = "CHARIZARD 8.5 MV-0000000900";
    const GOLDEN_WIDTHS: [string, string, number][] = [
      [MV_SANS, "normal", 603.1406],
      [MV_SANS, "bold", 610.2607],
      [MV_SERIF, "normal", 682.3828],
      [MV_SERIF, "bold", 745.5469],
      [MV_MONO, "normal", 647.9736],
      [MV_MONO, "bold", 647.9736],
      [MV_BLACK, "normal", 655.8203],
      [MV_BLACK, "bold", 724.9219],
    ];
    for (const [family, weight, expected] of GOLDEN_WIDTHS) {
      // A fresh context per measurement: node-canvas caches the resolved face on the context,
      // so reusing one silently reports the FIRST font for every later measurement.
      const ctx = createCanvas(10, 10).getContext("2d");
      ctx.font = `${weight} 40px ${family}`;
      const width = ctx.measureText(SAMPLE).width;
      expect(
        Math.abs(width - expected),
        `${family} ${weight} advance width is ${width}, expected ~${expected}`
      ).toBeLessThan(0.05);
    }
  });

  it("refuses to render rather than silently falling back to host fonts", async () => {
    // The whole mechanism is worthless if a bad asset degrades quietly. An existence check was
    // NOT enough — a corrupt, zero-byte, unreadable or substituted file passed it and rendered
    // with host fonts (hostile-review N2) — so integrity is now cryptographic. Every failure
    // mode is exercised for real in tests/label-font-integrity.test.ts.
    const src = readFileSync(new URL("../server/labels.ts", import.meta.url), "utf8");
    expect(src).toContain("Bundled label font missing");
    expect(src).toContain("BundledFontIntegrityError");
    expect(src).toMatch(/digest !== entry\.sha256/);
    expect(src).toMatch(/stat\.size !== entry\.bytes/);
  });

  it("is actually EXERCISED in CI, not skipped into vacuity", () => {
    // The pixel goldens are the strongest protection the label design has, and they are
    // Linux-gated. If CI ever moved to a non-Linux runner the gate would silently disable
    // them and nothing else would notice — so CI itself asserts the platform.
    // Keyed on GITHUB_ACTIONS, not the generic CI flag: this asserts a property of THIS
    // repository's pipeline (ubuntu-latest), and a developer exporting CI=true on a Mac
    // should not get a spurious failure.
    if (process.env.GITHUB_ACTIONS) {
      expect(process.platform, "CI must run on Linux or the pixel goldens skip").toBe("linux");
      // ARCHITECTURE matters as much as the OS. The goldens describe linux/x64 — the
      // architecture of Fly production AND of the ubuntu runners. Captured on arm64 they
      // matched neither, which is how they went red the first time they ever ran hosted.
      // Asserting it here means the gate below can never silently skip in CI.
      expect(process.arch, "CI must run on x64 — the goldens describe the production architecture").toBe("x64");
    }
  });
});
