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
  GRADING_FIELD_ALIASES,
  isMetadataOwnedField,
  isGradingOwnedField,
  canonicalGradingField,
  gradingFieldsIn,
  gradingFieldChanges,
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

  // ── ALIAS COVERAGE ─────────────────────────────────────────────────────────
  // The same column travels under three naming families in this repository:
  // Drizzle keys (`gradeCorners`), grading-API payload keys (`grade_corners`,
  // `corners`) and database/audit column names (`corners_score`). A multipart
  // client using an UNCOVERED alias would have received a 200 for a grading
  // write that silently did nothing. Every alias below is a real name that
  // appears in shared/schema.ts, in a `b.<key>` read in the grade route, or in
  // the grade route's audit fieldMap.
  const ALIAS_CASES: Array<[string, string]> = [
    // overall grade — the column is literally `grade`
    ["grade", "gradeOverall"],
    ["grade_overall", "gradeOverall"],
    ["overallGrade", "gradeOverall"],
    ["overall_grade", "gradeOverall"],
    // kind + derived label
    ["grade_type", "gradeType"],
    ["label_type", "labelType"],
    // centering
    ["grade_centering", "gradeCentering"],
    ["centeringScore", "gradeCentering"],
    ["centering_score", "gradeCentering"],
    // corners
    ["grade_corners", "gradeCorners"],
    ["cornersScore", "gradeCorners"],
    ["corners_score", "gradeCorners"],
    // edges
    ["grade_edges", "gradeEdges"],
    ["edgesScore", "gradeEdges"],
    ["edges_score", "gradeEdges"],
    // surface
    ["grade_surface", "gradeSurface"],
    ["surfaceScore", "gradeSurface"],
    ["surface_score", "gradeSurface"],
    // authenticity
    ["auth_status", "authStatus"],
    // measurements
    ["centering_front_lr", "centeringFrontLr"],
    ["centering_back_tb", "centeringBackTb"],
    ["centering_inner_front", "centeringInnerFront"],
    ["centering_method", "centeringMethod"],
    // per-zone evidence — the grade route reads bare `corners`/`edges`/`surface`
    ["corners", "cornerValues"],
    ["corner_values", "cornerValues"],
    ["edges", "edgeValues"],
    ["surface", "surfaceValues"],
    // defects
    ["ai_defects", "aiDefects"],
    ["verified_defects", "verifiedDefects"],
    ["ai_defect_candidates", "aiDefectCandidates"],
    // MVGS modifiers / deduction inputs
    ["dark_border", "darkBorder"],
    ["dark_border_front", "darkBorderFront"],
    ["eye_appeal_modifier", "eyeAppealModifier"],
    ["whitening_lines", "whiteningLines"],
    ["crease_lines", "creaseLines"],
    ["crease_span_pct", "creaseSpanPct"],
    ["wrinkle_severity", "wrinkleSeverity"],
    ["tear_severity", "tearSeverity"],
    ["grade_strength_score", "gradeStrengthScore"],
    ["grade_explanation", "gradeExplanation"],
    ["ai_draft_grade", "aiDraftGrade"],
    // operator snapshot
    ["operator_grade", "operatorGrade"],
    ["operator_subgrades", "operatorSubgrades"],
    ["grading_report", "gradingReport"],
    // approval state
    ["grade_approved_at", "gradeApprovedAt"],
    ["grade_approved_by", "gradeApprovedBy"],
    ["graded_at", "gradedAt"],
    ["graded_by", "gradedBy"],
    ["grader_status", "graderStatus"],
  ];

  for (const [alias, canonical] of ALIAS_CASES) {
    it(`alias "${alias}" resolves to ${canonical} and is grading-owned`, () => {
      expect(canonicalGradingField(alias), `${alias} must resolve`).toBe(canonical);
      expect(isGradingOwnedField(alias)).toBe(true);
      expect(isMetadataOwnedField(alias), `${alias} must never be metadata-owned`).toBe(false);
      expect(gradingFieldsIn({ [alias]: "x" })).toEqual([alias]);
    });
  }

  it("no alias collides with a metadata-owned field", () => {
    for (const alias of Object.keys(GRADING_FIELD_ALIASES)) {
      expect(isMetadataOwnedField(alias), `${alias} collides with the metadata allowlist`).toBe(false);
    }
  });

  it("every alias resolves to a declared grading-owned field", () => {
    for (const [alias, canonical] of Object.entries(GRADING_FIELD_ALIASES)) {
      expect(
        (GRADING_OWNED_FIELDS as readonly string[]).includes(canonical),
        `${alias} -> ${canonical} is not a declared grading-owned field`,
      ).toBe(true);
    }
  });

  it("does NOT invent aliases: gradeManualOverride is gone (no repository evidence)", () => {
    expect((GRADING_OWNED_FIELDS as readonly string[]).includes("gradeManualOverride")).toBe(false);
    expect(canonicalGradingField("gradeManualOverride")).toBeNull();
  });

  it("an alias change is detected against the CANONICAL stored column", () => {
    const stored = { gradeCorners: "10.0", gradeOverall: "9.5" };
    // snake_case DB-column alias carrying a DIFFERENT value → changing
    expect(gradingFieldChanges({ corners_score: "3.0" }, stored).changing).toEqual(["corners_score"]);
    // grading-API alias carrying the SAME value → harmless echo, not changing
    expect(gradingFieldChanges({ grade_corners: "10.0" }, stored).changing).toEqual([]);
    // and the comparison is NOT against an undefined property (the old bug):
    // `cornersScore` used to be treated as its own field and always mismatched
    expect(gradingFieldChanges({ cornersScore: "10.0" }, stored).changing).toEqual([]);
  });

  it("fails CLOSED for a real column shared/schema.ts does not declare", () => {
    // `auth_status` exists in the database but not in the Drizzle schema, so a
    // selected row has no such property. A submitted value must NOT be assumed
    // to be an echo.
    const stored = { gradeOverall: "9.5" }; // no authStatus property at all
    expect(gradingFieldChanges({ auth_status: "authentic_altered" }, stored).changing).toEqual(["auth_status"]);
    // an empty submission is still harmless
    expect(gradingFieldChanges({ auth_status: "" }, stored).changing).toEqual([]);
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
    // Detection + echo tolerance now live in the SHARED contract, so the client
    // and the server cannot drift; the route consumes it.
    expect(ROUTES).toContain("gradingFieldChanges(");
    expect(ROUTES).toContain("changingGradingFields");
    expect(ROUTES).toContain("gradingFieldContractError(changingGradingFields)");
    expect(ROUTES).toContain("metadata_grading_field_rejected");
  });

  it("a harmless echo of an UNCHANGED grading value is tolerated (older clients)", () => {
    // Behavioural, not textual — asserted directly against the shared contract.
    const stored = { gradeOverall: "9.5", gradeType: "numeric" };
    expect(gradingFieldChanges({ gradeOverall: "9.5" }, stored).changing).toEqual([]);
    expect(gradingFieldChanges({ gradeOverall: "8.0" }, stored).changing).toEqual(["gradeOverall"]);
  });

  it("the route never assigns grading-owned columns to the update object", () => {
    const routeStart = ROUTES.indexOf("export async function handleCertificateMetadataUpdate");
    // Stop at the NEXT top-level handler, not at registerRoutes — the dedicated
    // grading handler now sits between them and legitimately writes grades.
    const routeEnd = ROUTES.indexOf("export async function handleCertificateGradeUpdate");
    expect(routeEnd).toBeGreaterThan(routeStart);
    const body = ROUTES.slice(routeStart, routeEnd);
    for (const f of ["gradeOverall", "gradeType", "labelType", "gradeCentering", "gradeCorners", "gradeEdges", "gradeSurface"]) {
      expect(body, `data.${f} must never be written by the metadata route`).not.toContain(`data.${f} =`);
    }
  });

  it("labelType is no longer re-derived on a metadata edit (historic certs unchanged)", () => {
    expect(ROUTES).not.toContain("data.labelType =");
  });

  it("a genuine no-op neither writes nor audits", () => {
    const body = ROUTES.slice(
      ROUTES.indexOf("export async function handleCertificateMetadataUpdate"),
      ROUTES.indexOf("export async function handleCertificateGradeUpdate"),
    );
    // the early return must come BEFORE the audited update, not after it
    const guard = body.indexOf("if (auditChanges.length === 0)");
    const write = body.indexOf("storage.updateCertificateAudited(");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(write);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Grade-kind ownership on the client
// ─────────────────────────────────────────────────────────────────────────────

describe("Grade Type is not a second writer on an existing certificate", () => {
  it("Card Details shows the kind read-only when editing", () => {
    expect(FORM).toContain('data-testid="display-grade-type"');
  });

  it("the editable dropdown is reachable only on CREATE", () => {
    const i = FORM.indexOf('data-testid="display-grade-type"');
    const j = FORM.indexOf('data-testid="select-grade-type"');
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(-1);
    // read-only branch first, editable branch in the `: (` alternative
    const block = FORM.slice(i - 400, j);
    expect(block).toContain("isEdit ?");
  });

  it("gradeType is sent on CREATE only, never on an UPDATE", () => {
    const fn = FORM.slice(FORM.indexOf("function buildCertFormData"), FORM.indexOf("function buildCertFormData") + 1600);
    expect(fn).toContain("const CREATE_ONLY_GRADING_KEYS = isEdit ? [] : [\"gradeType\"]");
  });

  it("the Overall Grade control remains read-only (owner directive 2026-07-01)", () => {
    expect(FORM).toContain('data-testid="display-grade-overall"');
    expect(FORM).not.toContain('data-testid="input-grade-overall"');
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

  it("the flag is injected OUTSIDE the JSX so the protected render site is untouched", () => {
    // The Stage-3 render site must stay literally `{workstationSlot}` — several
    // protected-surface suites assert the workstation is passed through with no
    // wrapper, transform or scale. The `active` flag is therefore attached in a
    // memo above the return, not at the render site.
    expect(FORM).toContain("workstationSlot: rawWorkstationSlot");
    expect(FORM).toContain("{workstationSlot}");
    const memo = FORM.slice(FORM.indexOf("const workstationSlot = useMemo("), FORM.indexOf("const workstationSlot = useMemo(") + 500);
    expect(memo).toContain("isValidElement(rawWorkstationSlot)");
    expect(memo).toContain("active: wfStage === GRADE_STAGE");
    expect(memo).toContain(": rawWorkstationSlot"); // untouched fallback
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3, 4, 11, 17. Safe hydration / sparse + Authentic-Only records
// ─────────────────────────────────────────────────────────────────────────────

describe("3/4/11/17. absence of grading evidence is never a perfect card", () => {
  it("nothing persists until the grading payload for this cert has actually landed", () => {
    expect(PANEL).toContain("const gradingHydratedForRef = useRef<number | null>(null)");
    expect(PANEL).toContain("if (gradingHydratedForRef.current !== certId) return;");
  });

  it("hydration is tracked PER CERTIFICATE, so a card switch cannot inherit it", () => {
    // The marker stores the certId it hydrated for, so it invalidates itself on a
    // switch. A boolean cleared by the reset effect was ordering-dependent: for a
    // certificate already in the react-query cache the hydration effect (declared
    // earlier) set it true and the reset effect immediately cleared it, leaving
    // grading auto-save permanently dead for that mount.
    const reset = PANEL.slice(
      PANEL.indexOf("hydratedOnceRef.current = false;"),
      PANEL.indexOf("hydratedOnceRef.current = false;") + 400,
    );
    expect(reset, "the reset effect must NOT clear the hydration marker").not.toContain(
      "gradingHydratedForRef.current = null",
    );
    expect(reset).not.toContain("gradingHydratedForRef.current = false");
  });

  it("the marker is only set once the query resolved without error, for this certId", () => {
    const setter = PANEL.slice(PANEL.indexOf("gradingData !== undefined"), PANEL.indexOf("gradingData !== undefined") + 220);
    expect(setter).toContain("!gradingPending");
    expect(setter).toContain("!gradingError");
    expect(setter).toContain("gradingHydratedForRef.current = certId");
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
    expect(PANEL).toContain("if (gradingHydratedForRef.current !== certId) return;");
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
