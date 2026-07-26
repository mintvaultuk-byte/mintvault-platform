/**
 * grading-stale-grade-race.test.ts — PR A regression suite.
 *
 * Covers the three composed defects that let merely OPENING a certificate
 * corrupt its grade:
 *
 *   A→B  the grading workstation is mounted while Card Details is on screen;
 *   C→D  its debounced auto-save persisted UI defaults (all-zero defect state,
 *        which MVGS scores as a perfect card) for records with no grading data;
 *   E→G  the Card Details form then posted STALE full state including
 *        `gradeOverall`, and the metadata route accepted it.
 *
 * Live staging evidence this reproduces: MV900007 grade 9.0 → 10.0 (background
 * grading write) → 9.0 (metadata save reverting it), audit #1915
 * `gradeOverall: "10.0"->"9.0"`; MV900010 Authentic-Only (`NO`/null) converted
 * to numeric 10 with quad-10 subgrades.
 *
 * Pure source/contract assertions here; the route-level behaviour is proven
 * against real PostgreSQL in tests/certificate-update-route.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  METADATA_OWNED_FIELDS,
  GRADING_OWNED_FIELDS,
  isMetadataOwnedField,
  isGradingOwnedField,
  gradingFieldsIn,
  gradingFieldContractError,
} from "../shared/certificate-field-ownership";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const FORM = read("client/src/components/certificate-form.tsx");
const PANEL = read("client/src/components/grading/grading-panel.tsx");
const ROUTES = read("server/routes.ts");

// ─────────────────────────────────────────────────────────────────────────────
// 1. The ownership contract itself
// ─────────────────────────────────────────────────────────────────────────────

describe("field-ownership contract", () => {
  it("metadata and grading ownership sets are disjoint", () => {
    const overlap = METADATA_OWNED_FIELDS.filter((f) => (GRADING_OWNED_FIELDS as readonly string[]).includes(f));
    expect(overlap).toEqual([]);
  });

  it("every grading-owned field the race touched is covered", () => {
    for (const f of [
      "gradeOverall", "gradeType", "labelType",
      "gradeCentering", "gradeCorners", "gradeEdges", "gradeSurface",
      "centeringScore", "cornersScore", "edgesScore", "surfaceScore",
      "defects", "eyeAppealModifier", "gradeApprovedAt", "graderStatus",
    ]) {
      expect(isGradingOwnedField(f), `${f} must be grading-owned`).toBe(true);
      expect(isMetadataOwnedField(f), `${f} must NOT be metadata-owned`).toBe(false);
    }
  });

  it("Card Details identity + catalogue fields remain metadata-owned", () => {
    for (const f of [
      "cardGame", "setName", "cardName", "cardNumber", "year", "language",
      "variant", "rarityCode", "finishVariant", "promoType", "subsetName",
      "designations", "collectionCode", "notes",
    ]) {
      expect(isMetadataOwnedField(f), `${f} must stay metadata-owned`).toBe(true);
      expect(isGradingOwnedField(f)).toBe(false);
    }
  });

  it("gradingFieldsIn detects submitted grading state, and only that", () => {
    expect(gradingFieldsIn({ cardName: "X", gradeOverall: "9.0" })).toEqual(["gradeOverall"]);
    expect(gradingFieldsIn({ cardName: "X", setName: "Y" })).toEqual([]);
    // presence, not truthiness — an explicit null still counts as submitted
    expect(gradingFieldsIn({ gradeType: null })).toEqual(["gradeType"]);
  });

  it("the contract error names the offending fields and points at the grading route", () => {
    const msg = gradingFieldContractError(["gradeOverall", "labelType"]);
    expect(msg).toContain("gradeOverall");
    expect(msg).toContain("labelType");
    expect(msg).toMatch(/grade route|\/grade/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5-7. Client payload allowlist + server enforcement
// ─────────────────────────────────────────────────────────────────────────────

describe("5. Card Details payload contains no grading-owned fields", () => {
  it("buildCertFormData filters through the shared allowlist", () => {
    const fn = FORM.slice(FORM.indexOf("function buildCertFormData"), FORM.indexOf("function buildCertFormData") + 1400);
    expect(fn).toContain("isMetadataOwnedField(key)");
    // it must not simply serialise everything any more
    expect(fn).not.toMatch(/Object\.entries\(form\)\.forEach[\s\S]{0,200}formData\.append\(key[^)]*\);\s*\n\s*\}\s*\n\s*\}\);/);
  });

  it("the form imports the shared contract rather than a local copy", () => {
    expect(FORM).toContain('from "@shared/certificate-field-ownership"');
  });
});

describe("6-7. the metadata route cannot alter grading state", () => {
  it("rejects grading-owned fields that would change the stored value", () => {
    expect(ROUTES).toContain("gradingFieldsIn(req.body as Record<string, unknown>)");
    expect(ROUTES).toContain("changingGradingFields");
    expect(ROUTES).toContain("gradingFieldContractError(changingGradingFields)");
    expect(ROUTES).toContain("metadata_grading_field_rejected");
  });

  it("a harmless echo of an UNCHANGED grading value is tolerated (older clients)", () => {
    const block = ROUTES.slice(ROUTES.indexOf("const submittedGradingFields"), ROUTES.indexOf("const submittedGradingFields") + 1200);
    // only fields whose posted value differs from stored are rejected
    expect(block).toContain("norm(posted) !== norm(stored)");
  });

  it("the route never assigns grading-owned columns to the update object", () => {
    const routeStart = ROUTES.indexOf("export async function handleCertificateMetadataUpdate");
    const routeEnd = ROUTES.indexOf("export async function registerRoutes");
    const body = ROUTES.slice(routeStart, routeEnd > routeStart ? routeEnd : undefined);
    for (const f of ["gradeOverall", "gradeType", "labelType", "gradeCentering", "gradeCorners", "gradeEdges", "gradeSurface"]) {
      expect(body, `data.${f} must never be written by the metadata route`).not.toContain(`data.${f} =`);
    }
  });

  it("labelType is no longer re-derived on a metadata edit (historic certs unchanged)", () => {
    expect(ROUTES).not.toContain("data.labelType =");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2, 11, 12, 13. Grade-stage lifecycle
// ─────────────────────────────────────────────────────────────────────────────

describe("2/12/13. a hidden or inactive Grade stage never persists", () => {
  it("GradingPanel accepts an explicit `active` flag", () => {
    expect(PANEL).toContain("active?: boolean;");
    expect(PANEL).toContain("active = true,");
  });

  it("the auto-save effect returns early when inactive, before scheduling any debounce", () => {
    const eff = PANEL.slice(PANEL.indexOf("  useEffect(() => {\n    if (!certId) return;"), PANEL.indexOf("}, 500);"));
    expect(eff).toContain("if (!active) return;");
    // the inactive guard must precede the timer being armed
    expect(eff.indexOf("if (!active) return;")).toBeLessThan(eff.indexOf("autoSaveTimerRef.current = setTimeout"));
  });

  it("`active` is part of the effect dependencies so a stage switch re-evaluates", () => {
    const deps = PANEL.slice(PANEL.indexOf("gradingWorkflowLocked,\n    active,"), PANEL.indexOf("gradingWorkflowLocked,\n    active,") + 60);
    expect(deps).toContain("active");
  });

  it("the form tells the workstation whether Grade is the active stage", () => {
    expect(FORM).toContain("active: wfStage === GRADE_STAGE");
    expect(FORM).toContain("cloneElement");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3, 4, 11, 17. Safe hydration / sparse + Authentic-Only records
// ─────────────────────────────────────────────────────────────────────────────

describe("3/4/11/17. absence of grading evidence is never a perfect card", () => {
  it("nothing persists until the grading payload for this cert has actually landed", () => {
    expect(PANEL).toContain("const gradingHydratedRef = useRef(false)");
    expect(PANEL).toContain("if (!gradingHydratedRef.current) return;");
  });

  it("the hydration flag is reset per certificate, so a card switch cannot inherit it", () => {
    const reset = PANEL.slice(PANEL.indexOf("hydratedOnceRef.current = false;"), PANEL.indexOf("hydratedOnceRef.current = false;") + 200);
    expect(reset).toContain("gradingHydratedRef.current = false;");
  });

  it("the flag is only set once the query resolved without error", () => {
    const setter = PANEL.slice(PANEL.indexOf("gradingData !== undefined"), PANEL.indexOf("gradingData !== undefined") + 220);
    expect(setter).toContain("!gradingPending");
    expect(setter).toContain("!gradingError");
    expect(setter).toContain("gradingHydratedRef.current = true");
  });

  it("UI defaults represent NO defect evidence, not a graded perfect card", () => {
    // Documents why zero-defaults previously scored 10: they are absence, not evidence.
    expect(PANEL).toMatch(/DEFAULT_CORNERS[\s\S]{0,200}frontTL: 0/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 18/19. The exact staging regressions
// ─────────────────────────────────────────────────────────────────────────────

describe("18/19. MV900007 + MV900010 staging regressions are structurally impossible", () => {
  it("MV900007: a metadata save can no longer carry or write gradeOverall", () => {
    // client cannot send it…
    expect(isMetadataOwnedField("gradeOverall")).toBe(false);
    // …and the server would reject it if a stale client did.
    expect(gradingFieldsIn({ gradeOverall: "9.0" })).toEqual(["gradeOverall"]);
    expect(ROUTES).not.toContain("data.gradeOverall =");
  });

  it("MV900010: gradeType is grading-owned, so Authentic-Only cannot be converted by a metadata save", () => {
    expect(isGradingOwnedField("gradeType")).toBe(true);
    expect(isMetadataOwnedField("gradeType")).toBe(false);
    expect(ROUTES).not.toContain("data.gradeType =");
  });

  it("an inactive panel cannot manufacture the quad-10 that made Pristine reachable", () => {
    expect(PANEL).toContain("if (!active) return;");
    expect(PANEL).toContain("if (!gradingHydratedRef.current) return;");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scope guard — PR A must not touch grading rules, Pristine or rendering
// ─────────────────────────────────────────────────────────────────────────────

describe("PR A scope guard", () => {
  it("does not change the Pristine gate, the MVGS formula or label rendering", () => {
    const { execSync } = require("node:child_process");
    const changed = execSync("git diff --name-only d59311b9feb20342d9bd9938d743e7777eba6315...HEAD", {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    for (const forbidden of [
      "shared/pristine.ts",
      "shared/mvgs-scoring.ts",
      "shared/mvgs-input-builder.ts",
      "shared/centering.ts",
      "server/labels.ts",
      "server/certificate-document.ts",
      "server/mvgs-scoring.ts",
    ]) {
      expect(changed, `${forbidden} must not change in PR A`).not.toContain(forbidden);
    }
    // and no migration is introduced here
    expect(changed.filter((f) => f.startsWith("migrations/"))).toEqual([]);
  });

  it("records the tracked Pristine finding without hiding it", () => {
    const contract = read("shared/certificate-field-ownership.ts");
    expect(contract).toMatch(/not yet backed by a persisted authoritative 100-point MVGS result/i);
    expect(contract).toMatch(/separate prerequisite PR/i);
  });
});
