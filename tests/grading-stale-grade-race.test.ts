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
  UNDECLARED_GRADING_COLUMNS,
  NUMERIC_GRADING_FIELDS,
  CREATE_ONLY_FIELDS,
  IMAGE_OWNED_FIELDS,
  STRUCTURED_METADATA_FIELDS,
  SERVER_METADATA_COMMIT_FIELDS,
  isMetadataOwnedField,
  isGradingOwnedField,
  isSendableCertificateFormKey,
  certificateFormEntriesToSend,
  canonicalGradingField,
  gradingFieldsIn,
  gradingFieldChanges,
  gradingFieldContractError,
  unapprovedCommitKeys,
  assertServerMetadataCommitKeys,
} from "../shared/certificate-field-ownership";
import { decideGradingPersistence } from "../shared/grading-persistence-lifecycle";

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

  // ── M-4 · gradeManualOverride is a REAL column, and is protected ──────────
  // A previous revision removed it as "invented". It is not: `certificates.
  // grade_manual_override` is a live `boolean` column (verified against the
  // staging database 2026-07-26 via information_schema). It is absent from
  // shared/schema.ts, exactly like `auth_status`, so it fails CLOSED.
  it("M-4: gradeManualOverride is grading-owned under both of its real names", () => {
    expect((GRADING_OWNED_FIELDS as readonly string[]).includes("gradeManualOverride")).toBe(true);
    expect(canonicalGradingField("gradeManualOverride")).toBe("gradeManualOverride");
    expect(canonicalGradingField("grade_manual_override")).toBe("gradeManualOverride");
    expect(isGradingOwnedField("gradeManualOverride")).toBe(true);
    expect(isMetadataOwnedField("gradeManualOverride")).toBe(false);
  });

  it("M-4: it fails CLOSED — a changed value is rejected, an echo is not", () => {
    // A Drizzle-selected row has no property for an undeclared column.
    const stored = { gradeOverall: "9.5" };
    expect(gradingFieldChanges({ gradeManualOverride: "true" }, stored).changing).toEqual([
      "gradeManualOverride",
    ]);
    expect(gradingFieldChanges({ grade_manual_override: "true" }, stored).changing).toEqual([
      "grade_manual_override",
    ]);
    // an empty submission carries no decision and stays harmless
    expect(gradingFieldChanges({ gradeManualOverride: "" }, stored).changing).toEqual([]);
    // and when the column IS visible, a true echo is tolerated…
    expect(gradingFieldChanges({ gradeManualOverride: false }, { gradeManualOverride: false }).changing).toEqual([]);
    expect(gradingFieldChanges({ grade_manual_override: "false" }, { gradeManualOverride: false }).changing).toEqual([]);
    // …while a real flip is rejected. It is a BOOLEAN: numeric normalisation
    // must never be applied to it.
    expect(gradingFieldChanges({ gradeManualOverride: true }, { gradeManualOverride: false }).changing).toEqual([
      "gradeManualOverride",
    ]);
  });

  it("M-4: every documented undeclared grading column is covered by the contract", () => {
    for (const col of UNDECLARED_GRADING_COLUMNS) {
      expect(canonicalGradingField(col), `${col} must resolve to a grading-owned field`).not.toBeNull();
      expect(isMetadataOwnedField(col), `${col} must never be metadata-owned`).toBe(false);
      // fail closed: absent from the selected row, so a non-empty value changes
      expect(gradingFieldChanges({ [col]: "x" }, { gradeOverall: "9.5" }).changing).toEqual([col]);
    }
  });

  // ── M-2 · prototype-like keys must not resolve as grading aliases ─────────
  describe("M-2: prototype keys are not grading aliases", () => {
    const PROTOTYPE_KEYS = [
      "constructor",
      "toString",
      "valueOf",
      "hasOwnProperty",
      "isPrototypeOf",
      "propertyIsEnumerable",
      "toLocaleString",
      "__proto__",
      "__defineGetter__",
      "__lookupGetter__",
    ];

    for (const key of PROTOTYPE_KEYS) {
      it(`"${key}" resolves to null and is not grading-owned`, () => {
        expect(canonicalGradingField(key)).toBeNull();
        expect(isGradingOwnedField(key)).toBe(false);
        // …so it raises NO false grading-rejection audit
        expect(gradingFieldsIn({ [key]: "anything" })).toEqual([]);
        expect(gradingFieldChanges({ [key]: "anything" }, { gradeOverall: "9.5" }).changing).toEqual([]);
      });
    }

    it("a submitted __proto__ cannot poison the alias map", () => {
      const before = canonicalGradingField("grade");
      // A body whose __proto__ tries to inject a grading alias.
      const hostile = JSON.parse('{"__proto__":{"cardName":"gradeOverall"}}');
      expect(gradingFieldsIn(hostile)).toEqual([]);
      // the map is unchanged, and an unrelated metadata key has NOT become an alias
      expect(canonicalGradingField("grade")).toBe(before);
      expect(canonicalGradingField("cardName")).toBeNull();
      expect(isMetadataOwnedField("cardName")).toBe(true);
    });

    it("the alias map itself has a null prototype and is frozen", () => {
      expect(Object.getPrototypeOf(GRADING_FIELD_ALIASES)).toBeNull();
      expect(Object.isFrozen(GRADING_FIELD_ALIASES)).toBe(true);
    });

    it("unknown keys return null; legitimate aliases still resolve", () => {
      expect(canonicalGradingField("totallyMadeUpKey")).toBeNull();
      expect(canonicalGradingField("")).toBeNull();
      expect(canonicalGradingField("grade_corners")).toBe("gradeCorners");
      expect(canonicalGradingField("corners_score")).toBe("gradeCorners");
      expect(canonicalGradingField("auth_status")).toBe("authStatus");
      expect(canonicalGradingField("grade_manual_override")).toBe("gradeManualOverride");
    });
  });

  // ── TASK 7 · numeric echo normalisation (Option A, narrowly scoped) ───────
  describe("Task 7: numeric grading echoes compare semantically", () => {
    it('"10" and "10.0" are the SAME grade', () => {
      expect(gradingFieldChanges({ gradeOverall: "10" }, { gradeOverall: "10.0" }).changing).toEqual([]);
      expect(gradingFieldChanges({ gradeOverall: "10.0" }, { gradeOverall: "10" }).changing).toEqual([]);
    });

    it('"9.5" and "9.50" are the SAME subgrade', () => {
      expect(gradingFieldChanges({ gradeCorners: "9.5" }, { gradeCorners: "9.50" }).changing).toEqual([]);
      expect(gradingFieldChanges({ corners_score: "9.50" }, { gradeCorners: "9.5" }).changing).toEqual([]);
    });

    it("a MATERIALLY different numeric value is still rejected", () => {
      expect(gradingFieldChanges({ gradeOverall: "9" }, { gradeOverall: "10.0" }).changing).toEqual(["gradeOverall"]);
      expect(gradingFieldChanges({ gradeOverall: "9.5" }, { gradeOverall: "9.0" }).changing).toEqual(["gradeOverall"]);
    });

    it("null and \"\" are equivalent (both mean absent)", () => {
      expect(gradingFieldChanges({ gradeOverall: "" }, { gradeOverall: null }).changing).toEqual([]);
      expect(gradingFieldChanges({ gradeOverall: null }, { gradeOverall: "" }).changing).toEqual([]);
    });

    it('a cleared grade is NOT equal to a stored 0 (Number("") would say otherwise)', () => {
      expect(gradingFieldChanges({ gradeOverall: "" }, { gradeOverall: "0" }).changing).toEqual(["gradeOverall"]);
      expect(gradingFieldChanges({ gradeOverall: "0" }, { gradeOverall: null }).changing).toEqual(["gradeOverall"]);
    });

    it("normalisation is NOT applied to grade type, approval fields or booleans", () => {
      // gradeType is an enum — "10" vs "10.0" cannot arise, but nothing about it
      // may be coerced. A different value is always a change.
      expect(gradingFieldChanges({ gradeType: "numeric" }, { gradeType: "NO" }).changing).toEqual(["gradeType"]);
      // approval provenance compares strictly
      expect(
        gradingFieldChanges({ gradeApprovedBy: "a@x" }, { gradeApprovedBy: "b@x" }).changing,
      ).toEqual(["gradeApprovedBy"]);
      // booleans compare as strings, so an echo is tolerated and a flip is not
      expect(gradingFieldChanges({ darkBorder: "false" }, { darkBorder: false }).changing).toEqual([]);
      expect(gradingFieldChanges({ darkBorder: "true" }, { darkBorder: false }).changing).toEqual(["darkBorder"]);
    });

    it("JSON defect structures compare structurally, never numerically", () => {
      const defects = [{ zone: "corner", severity: 2 }];
      // an equivalent object echo is tolerated
      expect(gradingFieldChanges({ defects }, { defects }).changing).toEqual([]);
      // a JSON STRING equal to the stored object's serialisation is also an echo
      expect(gradingFieldChanges({ defects: JSON.stringify(defects) }, { defects }).changing).toEqual([]);
      // a materially different structure is a change
      expect(
        gradingFieldChanges({ defects: [{ zone: "corner", severity: 3 }] }, { defects }).changing,
      ).toEqual(["defects"]);
    });

    it("only the declared numeric fields get semantic comparison", () => {
      for (const f of NUMERIC_GRADING_FIELDS) {
        expect(isGradingOwnedField(f), `${f} must be grading-owned`).toBe(true);
      }
      // …and the excluded ones are genuinely excluded
      for (const f of ["gradeType", "labelType", "authStatus", "gradeManualOverride", "gradeApprovedAt"]) {
        expect((NUMERIC_GRADING_FIELDS as readonly string[]).includes(f), `${f} must NOT be numeric`).toBe(false);
      }
    });
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
  // A representative slice of the real form state object, including every
  // create-only field and a spread of grading-owned keys that must never travel.
  const FORM_STATE = {
    cardGame: "pokemon",
    setName: "Base Set",
    cardName: "Charizard",
    cardNumber: "4/102",
    year: "1999",
    language: "English",
    variant: "1ST EDITION",
    rarity: "",
    notes: "n",
    status: "graded",
    designations: "[]",
    // create-only
    gradeType: "numeric",
    submissionItemId: "77",
    // grading-owned — must NEVER be sent from Card Details
    gradeOverall: "9.5",
    gradeCentering: "9",
    gradeCorners: "10",
    labelType: "black",
    gradeApprovedAt: "2026-07-20T00:00:00Z",
    // UI-only
    unifiedSelect: "x",
    otherText: "y",
  };

  const keysFor = (isEdit: boolean) =>
    certificateFormEntriesToSend(FORM_STATE, { isEdit }).map(([k]) => k);

  it("the form builds its payload from the shared contract, not a local copy", () => {
    expect(FORM).toContain('from "@shared/certificate-field-ownership"');
    expect(FORM).toContain("certificateFormEntriesToSend(");
  });

  it("MANDATORY 1: submissionItemId survives create payload construction", () => {
    expect(keysFor(false)).toContain("submissionItemId");
    const entries = certificateFormEntriesToSend(FORM_STATE, { isEdit: false });
    expect(entries.find(([k]) => k === "submissionItemId")?.[1]).toBe("77");
  });

  it("create FormData includes gradeType (the create route establishes the kind)", () => {
    expect(keysFor(false)).toContain("gradeType");
  });

  it("MANDATORY 4: create-only fields are EXCLUDED from an edit payload", () => {
    const edit = keysFor(true);
    for (const f of CREATE_ONLY_FIELDS) {
      expect(edit, `${f} must never be sent on an UPDATE`).not.toContain(f);
    }
    // …so an edit can neither change the kind nor silently re-link the submission
    expect(edit).not.toContain("submissionItemId");
    expect(edit).not.toContain("gradeType");
  });

  it("MANDATORY 19: no grading field leaks into EITHER payload", () => {
    for (const isEdit of [true, false]) {
      for (const key of keysFor(isEdit)) {
        // gradeType is the one create-only exception and is asserted above
        if (!isEdit && (CREATE_ONLY_FIELDS as readonly string[]).includes(key)) continue;
        expect(isGradingOwnedField(key), `${key} leaked into the ${isEdit ? "edit" : "create"} payload`).toBe(false);
        expect(isMetadataOwnedField(key), `${key} is not metadata-owned`).toBe(true);
      }
    }
    // explicitly: the fields that caused the staging regressions
    for (const f of ["gradeOverall", "gradeCentering", "gradeCorners", "labelType", "gradeApprovedAt"]) {
      expect(keysFor(true)).not.toContain(f);
      expect(keysFor(false)).not.toContain(f);
    }
  });

  it("UI-only keys are never serialised", () => {
    for (const isEdit of [true, false]) {
      expect(keysFor(isEdit)).not.toContain("unifiedSelect");
      expect(keysFor(isEdit)).not.toContain("otherText");
    }
  });

  it("null/undefined values are dropped, exactly as FormData drops them", () => {
    const entries = certificateFormEntriesToSend(
      { cardName: "X", setName: null, cardNumber: undefined, year: "" },
      { isEdit: true },
    );
    expect(entries.map(([k]) => k).sort()).toEqual(["cardName", "year"]);
  });

  it("submissionItemId is create-only, NOT an unrestricted grading bypass", () => {
    // It is not grading-owned, so it is not a way to smuggle grading state…
    expect(isGradingOwnedField("submissionItemId")).toBe(false);
    // …and it is not metadata-owned, so the metadata PUT can never commit it.
    expect(isMetadataOwnedField("submissionItemId")).toBe(false);
    expect(SERVER_METADATA_COMMIT_FIELDS).not.toContain("submissionItemId");
    expect(isSendableCertificateFormKey("submissionItemId", { isEdit: true })).toBe(false);
    expect(isSendableCertificateFormKey("submissionItemId", { isEdit: false })).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// M-5. The SERVER's committed keys are an explicit approved set
// ─────────────────────────────────────────────────────────────────────────────

describe("M-5: every key the metadata route commits is server-approved", () => {
  /** Everything the metadata route legitimately assembles into `data`. */
  const LEGITIMATE_COMMIT = {
    cardGame: "pokemon",
    setName: "Base Set",
    cardName: "Charizard",
    cardNumber: "4/102",
    year: "1999",
    language: "English",
    rarity: "OTHER",
    rarityOther: "custom",
    variant: "OTHER",
    variantOther: "custom",
    collectionCode: "OTHER",
    collectionOther: "custom",
    designations: ["PROMO"],
    notes: "n",
    status: "graded",
    frontImagePath: "images/MV1/front.jpg",
    backImagePath: "images/MV1/back.jpg",
    rarityCode: "rare",
    rarityLabelStructured: "Rare",
    printedSymbol: "star",
    printedSymbolCount: 1,
    printedSymbolColour: "black",
    finishVariant: "holo",
    promoType: "black_star",
    subsetName: "trainer_gallery",
    region: "eu",
    era: "wotc",
    structuredVariantVersion: 2,
  };

  it("MANDATORY 16: all legitimate current metadata fields pass", () => {
    expect(unapprovedCommitKeys(LEGITIMATE_COMMIT)).toEqual([]);
    expect(() => assertServerMetadataCommitKeys(LEGITIMATE_COMMIT)).not.toThrow();
  });

  it("image and structured-variant fields remain supported", () => {
    for (const f of [...IMAGE_OWNED_FIELDS, ...STRUCTURED_METADATA_FIELDS]) {
      expect(SERVER_METADATA_COMMIT_FIELDS, `${f} must stay committable`).toContain(f);
      expect(() => assertServerMetadataCommitKeys({ [f]: "x" })).not.toThrow();
    }
  });

  it("a future putGuarded(\"gradeOverall\") fails LOUDLY", () => {
    expect(() => assertServerMetadataCommitKeys({ ...LEGITIMATE_COMMIT, gradeOverall: "10" })).toThrow(
      /gradeOverall/,
    );
    // and the message says where it belongs
    expect(() => assertServerMetadataCommitKeys({ gradeOverall: "10" })).toThrow(/\/grade/);
  });

  it("gradeType, gradeManualOverride and approval fields all fail", () => {
    for (const f of [
      "gradeType",
      "gradeManualOverride",
      "labelType",
      "gradeCentering",
      "gradeCorners",
      "gradeEdges",
      "gradeSurface",
      "gradeApprovedAt",
      "gradeApprovedBy",
      "gradedAt",
      "gradedBy",
      "graderStatus",
      "authStatus",
    ]) {
      expect(unapprovedCommitKeys({ [f]: "x" }), `${f} must be rejected`).toEqual([f]);
      expect(() => assertServerMetadataCommitKeys({ [f]: "x" })).toThrow();
    }
  });

  it("MANDATORY 17: an accidentally introduced UNKNOWN key fails closed", () => {
    expect(unapprovedCommitKeys({ cardName: "X", someNewColumn: 1 })).toEqual(["someNewColumn"]);
    expect(() => assertServerMetadataCommitKeys({ someNewColumn: 1 })).toThrow(/someNewColumn/);
  });

  it("the approved set is a UNION of narrow sets, not one broad exception list", () => {
    const union = new Set([
      ...METADATA_OWNED_FIELDS,
      ...IMAGE_OWNED_FIELDS,
      ...STRUCTURED_METADATA_FIELDS,
      "rarityOther",
      "variantOther",
      "collectionOther",
    ]);
    expect([...SERVER_METADATA_COMMIT_FIELDS].sort()).toEqual([...union].sort());
    // and NO grading-owned field is in it, under any of its names
    for (const f of SERVER_METADATA_COMMIT_FIELDS) {
      expect(canonicalGradingField(f), `${f} is grading-owned and must not be committable`).toBeNull();
    }
  });

  it("the route calls the guard BEFORE it writes anything", () => {
    const body = ROUTES.slice(
      ROUTES.indexOf("export async function handleCertificateMetadataUpdate"),
      ROUTES.indexOf("export async function handleCertificateCreate"),
    );
    const guard = body.indexOf("assertServerMetadataCommitKeys(");
    const write = body.indexOf("storage.updateCertificateAudited(");
    expect(guard).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(write);
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
    // Stop at the NEXT top-level handler, not at registerRoutes — the extracted
    // create + grading handlers now sit between them and legitimately write grades.
    const routeEnd = ROUTES.indexOf("export async function handleCertificateCreate");
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
      ROUTES.indexOf("export async function handleCertificateCreate"),
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
    const block = FORM.slice(Math.max(0, i - 3000), j);
    expect(block).toContain("isEdit ?");
  });

  it("gradeType is sent on CREATE only, never on an UPDATE", () => {
    // Behavioural, via the shared contract — not a grep of the component.
    expect(isSendableCertificateFormKey("gradeType", { isEdit: false })).toBe(true);
    expect(isSendableCertificateFormKey("gradeType", { isEdit: true })).toBe(false);
    expect(CREATE_ONLY_FIELDS).toContain("gradeType");
  });

  it("the Overall Grade control remains read-only (owner directive 2026-07-01)", () => {
    expect(FORM).toContain('data-testid="display-grade-overall"');
    expect(FORM).not.toContain('data-testid="input-grade-overall"');
  });

  // ── TASK 8 · ACCESSIBILITY of the read-only Grade Type ────────────────────
  it("the read-only value is an accessible LABELLED control, not bare prose", () => {
    const i = FORM.indexOf('data-testid="display-grade-type"');
    expect(i).toBeGreaterThan(-1);
    const block = FORM.slice(i - 3000, i + 400);
    // a real form control, bound to the label, announced as read-only
    expect(block).toContain('htmlFor={isEdit ? "cert-grade-type-readonly" : "cert-grade-type"}');
    expect(block).toContain('id="cert-grade-type-readonly"');
    expect(block).toContain("readOnly");
    expect(block).toContain('aria-readonly="true"');
    // readOnly, NOT disabled — it stays reachable and is announced, rather than
    // being removed from the accessibility tree. (Checked as a JSX attribute so
    // the word appearing in the explanatory comment above does not match.)
    expect(block).not.toMatch(/^\s*disabled\b/m);
    expect(block).not.toMatch(/\bdisabled=\{/);
  });

  it("the read-only control introduces no second grading writer", () => {
    const i = FORM.indexOf('data-testid="display-grade-type"');
    const block = FORM.slice(i - 3000, i + 400);
    expect(block).not.toContain("onChange");
    expect(block).not.toContain("setForm");
    // and it carries no name, so it cannot be serialised into any payload
    expect(block).not.toMatch(/name=["']gradeType["']/);
  });

  it("creation stays editable, editing stays read-only", () => {
    expect(FORM).toContain('data-testid="select-grade-type"');
    expect(FORM).toContain('id="cert-grade-type"');
    const i = FORM.indexOf('data-testid="display-grade-type"');
    const j = FORM.indexOf('data-testid="select-grade-type"');
    expect(i).toBeLessThan(j); // read-only branch is the `isEdit ?` consequent
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2, 11, 12, 13. Grade-stage lifecycle
// ─────────────────────────────────────────────────────────────────────────────

describe("2/12/13. a hidden or inactive Grade stage never persists", () => {
  // NOTE: the LIFECYCLE DECISION itself is proven as behaviour, across every
  // scenario (inactive, hydration, stale response, cert switch, Strict Mode,
  // active edit, leaving Grade, failed GET), in
  // tests/grading-persistence-lifecycle.test.ts. What remains here is the
  // WIRING: that the component delegates to that function rather than
  // reimplementing the rule inline.
  it("GradingPanel requires an explicit `active` flag — no fail-open default", () => {
    expect(PANEL).toContain("active: boolean;");
    expect(PANEL).not.toContain("active = true");
  });

  it("the auto-save effect delegates to the shared pure decision", () => {
    expect(PANEL).toContain('from "@shared/grading-persistence-lifecycle"');
    const eff = PANEL.slice(PANEL.indexOf("const decision = decideGradingPersistence({"), PANEL.indexOf("}, 500);"));
    expect(eff).toContain("if (!decision.arm) return;");
    // the arming decision must precede the timer being set
    expect(eff.indexOf("if (!decision.arm) return;")).toBeLessThan(
      eff.indexOf("autoSaveTimerRef.current = setTimeout"),
    );
    // and every non-arming decision drops pending work
    expect(eff).toContain("if (decision.cancelPending && autoSaveTimerRef.current)");
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
    const memoStart = FORM.indexOf("const workstationSlot = useMemo(");
    // Bounded to the memo's REAL end (its dependency array) rather than a magic
    // character count: a fixed window silently loosens every time the memo grows,
    // and would let an injection moved OUT of the memo keep passing.
    const memoEnd = FORM.indexOf("[rawWorkstationSlot, wfStage, interactiveCardHost]", memoStart);
    expect(memoEnd, "memo dependency array must be findable").toBeGreaterThan(memoStart);
    const memo = FORM.slice(memoStart, memoEnd);
    expect(memo).toContain("isValidElement(rawWorkstationSlot)");
    expect(memo).toContain("active: wfStage === GRADE_STAGE");
    // H-1: the approval flag is injected the SAME way, in the same memo, so the
    // protected render site stays literally `{workstationSlot}`. On THIS surface
    // the approving stage is GRADE — /admin shows the whole panel, Approve
    // included, only on Grade (the role workstation is the one that approves on
    // Review). Both directions are pinned in tests/grading-shortcut-lifecycle.
    expect(memo).toContain("approvalStageActive: wfStage === GRADE_STAGE");
    expect(memo).toContain(": rawWorkstationSlot"); // untouched fallback
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3, 4, 11, 17. Safe hydration / sparse + Authentic-Only records
// ─────────────────────────────────────────────────────────────────────────────

describe("3/4/11/17. absence of grading evidence is never a perfect card", () => {
  it("nothing persists until the grading payload for this cert has actually landed", () => {
    // Wiring: the component tracks the hydrated certId and feeds it to the
    // shared decision. The RULE is proven behaviourally in
    // tests/grading-persistence-lifecycle.test.ts ("cannot arm before the
    // grading payload has landed" / "a card switch cannot inherit ...").
    expect(PANEL).toContain("const gradingHydratedForRef = useRef<number | null>(null)");
    expect(PANEL).toContain("hydratedForCertId: gradingHydratedForRef.current,");
    expect(
      decideGradingPersistence({
        active: true, certId: 7, hydratedForCertId: null,
        workflowLocked: false, gradeApprovedAt: null, settledAfterHydration: true,
      }).arm,
    ).toBe(false);
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
    const base = {
      certId: 7, hydratedForCertId: 7, workflowLocked: false,
      gradeApprovedAt: null, settledAfterHydration: true,
    };
    expect(decideGradingPersistence({ ...base, active: false }).arm).toBe(false);
    // …and an un-hydrated panel cannot either, active or not
    expect(decideGradingPersistence({ ...base, active: true, hydratedForCertId: null }).arm).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scope guard — PR A must not touch grading rules, Pristine or rendering
// ─────────────────────────────────────────────────────────────────────────────

describe("PR A scope guard", () => {
  it("does not change the Pristine gate, the MVGS formula or label rendering", () => {
    // BOTH assertions in this guard are pinned to PR A's OWN commit range. This describe block
    // is named "PR A scope guard" and its failure messages say "must not change in PR A": it is
    // a statement about what PR A did, and PR A is merged, so the range is closed and the
    // assertion is permanently true.
    //
    // It previously ran `d59311b9...HEAD`. An earlier pass pinned only the migration half and
    // argued the open-ended file half was a useful bonus standing protection. That was wrong,
    // and it broke immediately: `server/labels.ts` is on the forbidden list, and PR #254's
    // founder-authorised print-safety change (2026-07-25 approval — assertPrintableGrade at the
    // renderer entry, removing the two zero coercions that printed 0 / POOR) legitimately
    // touches it. A PR-scoped assertion left open-ended becomes a repo-wide prohibition that
    // every authorised change has to fight, which creates pressure to weaken it — exactly what
    // happened with the migration half.
    //
    // The standing protection for the renderer is NOT dropped; it is moved somewhere it can
    // distinguish an authorised change from a regression. See
    // tests/printable-grade-safety.test.ts, "THE PROTECTED LABEL DESIGN", which pins 26 golden
    // render hashes. That is behavioural: it permits a guard-only change (PR #254 is proven
    // byte-identical against origin/main across all 26) and fails on any design drift, which a
    // filename check could never tell apart.
    const PR_A_RANGE = "d59311b9feb20342d9bd9938d743e7777eba6315...0f71152d";
    const { execSync } = require("node:child_process");
    const changed = execSync(`git diff --name-only ${PR_A_RANGE}`, {
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
    // …and PR A introduced no migration. Same closed range, for the same reason: left open-ended
    // this read as "no migration may ever be added to this repository again" and fired on every
    // pending branch — 0020 and 0021 (partner auth/RBAC), 0025 (grading optimistic concurrency),
    // 0027 (g6d submission credits) and 0030 (Project Control) — none related to PR A.
    expect(changed.filter((f) => f.startsWith("migrations/"))).toEqual([]);
  });

  it("records the tracked Pristine finding without hiding it", () => {
    const contract = read("shared/certificate-field-ownership.ts");
    expect(contract).toMatch(/not yet backed by a persisted authoritative 100-point MVGS result/i);
    expect(contract).toMatch(/separate prerequisite PR/i);
  });
});
