/**
 * Consolidated Variant line — regression coverage for the single canonical
 * formatter (shared/variant-line.ts) and its use by the printed-label renderer,
 * the live preview, the Review summary and the structured picker.
 *
 * Pure logic only — zero DB, zero provider calls. The DB round-trip persistence
 * (save → load) is covered by the disposable-Postgres suite; here we prove the
 * deterministic wording, the single-select semantics, preview↔print parity, the
 * backward-compatibility version gate, and that MVGS is untouched.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { protectedChangedFiles, protectedDiffFor } from "./helpers/protected-diff";
import { execFileSync } from "child_process";
import { join } from "path";
import { addedCodeOf, addedJsOf, hasMalformedEscape, stripNonCode } from "./helpers/strip-non-code";
import { diffProtectedEngineReach } from "./helpers/protected-module-refs";
import { visibilityOnlyExportChange } from "./helpers/visibility-only-change";
import { formatVariantLine, hasStructuredVariant, CONSOLIDATED_VARIANT_SCHEME } from "@shared/variant-line";
import {
  STRUCTURED_VARIANT_VERSION,
  validateStructuredVariant,
  structuredColumnsToCertFields,
} from "@shared/structured-variant-validate";
import { consolidatedVariantForLabel } from "../server/labels";
import { nextCatalogueRarity } from "../client/src/components/rarity-picker/RarityVariantPicker";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("formatVariantLine — deterministic consolidated wording (item 7)", () => {
  const cases: Array<[Parameters<typeof formatVariantLine>[0], string]> = [
    [{ rarityCode: "rare_holo" }, "Holo Rare"],
    [{ rarityCode: "illustration_rare" }, "Illustration Rare"],
    [{ rarityCode: "special_illustration_rare" }, "Special Illustration Rare"],
    [{ finishVariant: "reverse_holo" }, "Reverse Holo"],
    [{ rarityCode: "rare_holo", finishVariant: "cosmos_holo" }, "Holo Rare · Cosmos Holo"],
    [{ promoType: "black_star_promo", finishVariant: "cosmos_holo" }, "Black Star Promo · Cosmos Holo"],
    [{ promoType: "mcdonalds_promo", finishVariant: "holo" }, "McDonald’s Promo · Holo"],
    [{ rarityCode: "ace_spec" }, "ACE SPEC"],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → "${expected}"`, () => {
      expect(formatVariantLine(input)).toBe(expected);
    });
  }
  it("is a pure deterministic function (same input → same output)", () => {
    const input = { rarityCode: "rare_holo", finishVariant: "cosmos_holo" };
    expect(formatVariantLine(input)).toBe(formatVariantLine(input));
  });
});

describe("empty structured fields never create separators or placeholders (item 12)", () => {
  it("no fields → empty string, not a separator", () => {
    expect(formatVariantLine({})).toBe("");
    expect(formatVariantLine({ rarityCode: "", finishVariant: "", promoType: "", subsetName: "" })).toBe("");
  });
  it("single field → no leading/trailing separator", () => {
    expect(formatVariantLine({ finishVariant: "cosmos_holo" })).toBe("Cosmos Holo");
    expect(formatVariantLine({ finishVariant: "cosmos_holo" })).not.toMatch(/^ ?· | ?· ?$/);
  });
  it("never emits a double separator", () => {
    expect(formatVariantLine({ rarityCode: "rare_holo", promoType: "", finishVariant: "cosmos_holo" })).not.toContain(
      "·  ·"
    );
  });
});

describe("legacy variant/rarity is folded in, never silently erased (item 11)", () => {
  it("a card with only a legacy finish variant still prints it", () => {
    expect(formatVariantLine({ variant: "COSMOS_HOLO" })).toBe("Cosmos Holo");
  });
  it("adding a structured rarity keeps the legacy finish", () => {
    expect(formatVariantLine({ rarityCode: "rare_holo", variant: "COSMOS_HOLO" })).toBe("Holo Rare · Cosmos Holo");
  });
  it("a structured finish takes precedence over a legacy one, without duplication", () => {
    expect(formatVariantLine({ rarityCode: "rare_holo", finishVariant: "cosmos_holo", variant: "HOLO" })).toBe(
      "Holo Rare · Cosmos Holo"
    );
  });
  it("an ordinary legacy rarity is preserved, not dropped, on a mixed cert (backend hostile F1)", () => {
    // legacy rarity RARE_HOLO has no clean structured code — must still print.
    expect(formatVariantLine({ finishVariant: "cosmos_holo", rarity: "RARE_HOLO" })).toBe("Holo Rare · Cosmos Holo");
    expect(formatVariantLine({ rarity: "COMMON" })).toBe("Common");
    expect(formatVariantLine({ rarity: "UNCOMMON" })).toBe("Uncommon");
  });
  it("an ambiguous legacy code keeps its own wording instead of a silent remap (F2)", () => {
    // SECRET_RARE must not become 'Super Rare' via the ambiguous jp_super_rare map.
    expect(formatVariantLine({ variant: "SECRET_RARE" })).toBe("Secret Rare");
  });
  it("legacy OTHER free-text is preserved verbatim (frontend hostile F2)", () => {
    expect(formatVariantLine({ variant: "OTHER", variantOther: "Prism Foil" })).toBe("Prism Foil");
    expect(formatVariantLine({ rarity: "OTHER", rarityOther: "Staff Stamp" })).toBe("Staff Stamp");
  });
  it("a structured rarity always wins over a legacy rarity (no duplication)", () => {
    expect(formatVariantLine({ rarityCode: "rare_holo", rarity: "ULTRA_RARE" })).toBe("Holo Rare");
  });
});

describe("single rarity semantics (items 4, 5, 6)", () => {
  it("selecting a rarity when none is active sets it", () => {
    expect(nextCatalogueRarity(null, "rare_holo", false)).toBe("rare_holo");
  });
  it("selecting a different rarity replaces the previous one (never two)", () => {
    expect(nextCatalogueRarity("rare_holo", "illustration_rare", false)).toBe("illustration_rare");
  });
  it("clicking the already-selected rarity clears it", () => {
    expect(nextCatalogueRarity("rare_holo", "rare_holo", false)).toBeNull();
  });
  it("a custom rarity is selected being active switches to the catalogue one (not a same-value toggle)", () => {
    expect(nextCatalogueRarity("rare_holo", "rare_holo", true)).toBe("rare_holo");
  });
});

describe("structured finish / promo single-select is a replace-or-clear toggle (items 4-6 for finish/promo)", () => {
  const PICKER = read("client/src/components/rarity-picker/RarityVariantPicker.tsx");
  it("finish is a single value cleared by re-click", () => {
    expect(PICKER).toContain("const pickFinish = (value: string | null) => {");
    expect(PICKER).toContain("pickFinish(finish === x.value ? null : x.value)");
  });
  it("promo/subset is a single value cleared by re-click", () => {
    expect(PICKER).toContain("const pickPromoOrSubset = (value: string | null) => {");
    expect(PICKER).toContain("pickPromoOrSubset(promoOrSubset === x.value ? null : x.value)");
  });
});

describe("structured columns persist through the canonical mapper (items 1, 2, 3)", () => {
  it("rarity/finish/promo/subset survive validation → cert-field mapping and stamp the consolidated scheme", () => {
    const result = validateStructuredVariant({
      rarityCode: "special_illustration_rare",
      finishVariant: "cosmos_holo",
      promoType: "black_star_promo",
      subsetName: null,
      language: "en",
      era: "sv",
      legacyVariant: null,
    });
    expect(result.ok).toBe(true);
    const fields = structuredColumnsToCertFields(result.columns);
    expect(fields.rarityCode).toBe("special_illustration_rare");
    expect(fields.finishVariant).toBe("cosmos_holo");
    expect(fields.promoType).toBe("black_star_promo");
    expect(fields.structuredVariantVersion).toBe(STRUCTURED_VARIANT_VERSION);
  });
});

describe("preview ↔ printed-label parity (items 8, 9, 10)", () => {
  const v2 = (extra: Record<string, unknown>) =>
    ({ structuredVariantVersion: CONSOLIDATED_VARIANT_SCHEME, ...extra }) as any;

  it("the printed label wording equals the shared formatter output, upper-cased (summary shows the same words)", () => {
    const cert = v2({ rarityCode: "rare_holo", finishVariant: "cosmos_holo" });
    expect(consolidatedVariantForLabel(cert)).toBe(formatVariantLine(cert).toUpperCase());
    expect(consolidatedVariantForLabel(cert)).toBe("HOLO RARE · COSMOS HOLO");
  });

  it("saving then rendering produces the same wording the unsaved live preview shows", () => {
    // Preview and print both run the SAME renderer path (consolidatedVariantForLabel)
    // on a scheme-v2 cert, so the unsaved preview and the saved print are identical.
    const draft = v2({
      rarityCode: "special_illustration_rare",
      finishVariant: "cosmos_holo",
      promoType: "black_star_promo",
    });
    const rendered = consolidatedVariantForLabel(draft);
    expect(rendered).toBe(formatVariantLine(draft).toUpperCase());
    expect(rendered).toBe("SPECIAL ILLUSTRATION RARE · BLACK STAR PROMO · COSMOS HOLO");
  });

  it("the live preview endpoint renders through the SAME generateLabelPNG as printing (no second renderer)", () => {
    // After the four-build integration there is exactly ONE canonical preview
    // endpoint — the modular server/routes/admin/label-preview.ts — which calls
    // the exact same renderer the print/label routes use (generateLabelPNG). The
    // former duplicate inline app.post("/api/admin/label-preview") in routes.ts
    // was consolidated away.
    const preview = read("server/routes/admin/label-preview.ts");
    expect(preview).toContain('app.post("/api/admin/certificates/label/preview"');
    expect(preview).toContain('generateLabelPNG(cert, "front")');
    // The duplicate inline route must be gone (one canonical endpoint only).
    const routes = read("server/routes.ts");
    expect(routes).not.toContain('app.post("/api/admin/label-preview"');
    // And the renderer composes the variant line through the single shared helper.
    const labels = read("server/labels.ts");
    expect(labels).toContain("consolidatedVariantForLabel(cert)");
  });
});

describe("backward compatibility — existing certs unchanged unless edited & saved", () => {
  it("a pre-consolidation cert with only structured cols keeps its previous (blank) label line", () => {
    // version < scheme → legacy path; no legacy variant/rarity set → the exact
    // string the old renderer produced ("") — byte-identical, no retroactive change.
    expect(consolidatedVariantForLabel({ structuredVariantVersion: 1, rarityCode: "rare_holo" } as any)).toBe("");
    expect(consolidatedVariantForLabel({ rarityCode: "rare_holo" } as any)).toBe("");
  });
  it("a legacy variant cert prints exactly as before (uppercased legacy map)", () => {
    expect(consolidatedVariantForLabel({ variant: "COSMOS_HOLO" } as any)).toBe("COSMOS HOLO");
  });
  it("a legacy rarity cert prints exactly as before", () => {
    expect(consolidatedVariantForLabel({ rarity: "RARE_HOLO" } as any)).toBe("HOLO RARE");
  });
  it("hasStructuredVariant only trips on structured columns", () => {
    expect(hasStructuredVariant({ rarityCode: "rare_holo" })).toBe(true);
    expect(hasStructuredVariant({ variant: "COSMOS_HOLO" })).toBe(false);
    expect(hasStructuredVariant({})).toBe(false);
  });
});

describe("scheme constants stay in sync + one formatter across surfaces (item 13)", () => {
  it("the write-stamp equals the renderer gate (they can never drift)", () => {
    expect(STRUCTURED_VARIANT_VERSION).toBe(CONSOLIDATED_VARIANT_SCHEME);
  });
  it("every variant surface imports the ONE shared formatter (admin / staff / grader all render these)", () => {
    for (const f of [
      "client/src/components/grading-workflow/VariantSummary.tsx",
      "client/src/components/grading-workflow/ReviewSummary.tsx",
    ]) {
      expect(read(f)).toContain('from "@shared/variant-line"');
    }
    expect(read("server/labels.ts")).toContain('from "@shared/variant-line"');
  });
});

describe("MVGS / grading calculations are not touched (item 14)", () => {
  it("the variant-line formatter's imports reference nothing in the grading engine", () => {
    const importLines = read("shared/variant-line.ts")
      .split("\n")
      .filter((l) => l.trim().startsWith("import"))
      .join("\n");
    expect(importLines).not.toMatch(/mvgs|scoring|centering|pristine|grade|grader/i);
  });
  it("no MVGS/grading-CALCULATION engine file was modified on this branch", () => {
    // labels.ts (the label renderer) and server/grader.ts (the grader WORKFLOW) are
    // founder-authorised for narrowly scoped safety fixes — see the 2026-07-25 approval
    // covering the print-batch grade gate, approveGraderCert and applyCertGradeDraft.
    // The genuine CALCULATION engine is still hard-blocked: scoring tables, the centering
    // maths, the Pristine gate, the MVGS input builder and the grading prompt.
    // Base resolution is FAIL-CLOSED (tests/helpers/protected-diff.ts): under a shallow
    // checkout an unresolvable base throws rather than yielding an empty changed-file list
    // that would make this loop a no-op and report green while enforcing nothing.
    const changed = protectedChangedFiles();
    // `server/grader.ts` stays INSIDE calcEngine — it is NOT exempted. A change to it is
    // permitted only if the added lines match one of the explicitly founder-authorised
    // signatures below AND contain no calculation logic. Anything else fails.
    //
    // Two authorised signatures, kept as a UNION rather than replacing one with the other:
    //   A) the identity/variant draft validation already on main;
    //   B) PR #254's print-safety work (2026-07-25 approval) — approveGraderCert validating
    //      against the shared printability rule, and applyCertGradeDraft normalising
    //      grade_type and refusing malformed kinds via a typed GradeDraftRejected.
    // A single-signature whitelist rejects the other authorised change, which is why this is
    // a union and not an overwrite.
    const calcEngine =
      /mvgs-scoring|shared\/pristine|shared\/centering|mvgs-input-builder|server\/grader|grading-prompt|shared\/mvgs-scoring/;
    for (const f of changed) {
      if (f === "server/grader.ts") {
        const diff = protectedDiffFor(f);
        // Two representations — see tests/helpers/strip-non-code.ts. `addedCode` keeps tagged
        // SQL (for identifier/write detection, F2/N4); `addedJs` drops ALL template text so
        // SQL can never satisfy a JavaScript signature (N5). Tokenised by the TypeScript
        // parser, so a regex literal cannot swallow the diff (N1).
        const addedCode = addedCodeOf(diff, "+");
        const addedJs = addedJsOf(diff, "+");
        expect(hasMalformedEscape(diff), "server/grader.ts contains a malformed escape sequence").toBe(false);
        // A module SPECIFIER is a StringLiteral, so `stripNonCode`/`stripToJs` blank it in BOTH
        // modes — correctly, since that is what stops prose and SQL faking a signature (N5). The
        // side effect, proven by hostile review on 2026-08-07, is that a dynamic reach into a
        // protected CALCULATION engine leaves no token for the identifier scans below:
        //     const seg = ["@shared", "cent" + "ering"].join("/");
        //     const eng = await import(seg);
        // Resolving specifiers is therefore done in a SEPARATE pass whose output never reaches
        // the signature regexes — see tests/helpers/protected-module-refs.ts for why that is
        // strictly safer than un-blanking literals (and why un-blanking would not even catch the
        // concatenated form). Nothing in strip-non-code.ts changed.
        const engineReach = diffProtectedEngineReach(diff, "+");
        expect(engineReach, `server/grader.ts reaches the protected calculation engine: ${engineReach}`).toBe("");
        const signatureA =
          /\bvalidateGradeDraftIdentityAndVariant\s*\(/.test(addedJs) &&
          /rarity_code\s*=\s*\$\{/.test(addedCode) &&
          /finish_variant\s*=\s*\$\{/.test(addedCode) &&
          /promo_type\s*=\s*\$\{/.test(addedCode);
        const signatureB = /class\s+GradeDraftRejected\b/.test(addedJs) && /\bcheckPrintableGrade\s*\(/.test(addedJs);
        // C) Wave 1 Partner-origin integration — founder-approved 2026-07-31, narrowly, for
        //    the reviewed integration ONLY. It recognises the immutable Partner provenance
        //    added by migration 0035, distinguishes PARTNER / HQ / legacy safely, fails closed
        //    on unknown provenance, and forces mandatory Super Admin review for Partner-
        //    originated grading (no review-rate sampling bypass), reusing the EXISTING B3 and
        //    printability rules rather than restating them.
        //
        //    ALL FOUR tokens are required, so this cannot be satisfied by an incidental edit:
        //    the provenance column constant, the origin resolver, the fail-closed predicate,
        //    and the extracted publish-gate helper. No calculation identifier appears in any
        //    of them, and the calculation-token assertion below still applies unchanged — so
        //    a weighting, threshold, defect-scoring, centering or B1/B2/B3 change still fails
        //    even if it were bundled alongside this signature.
        const signatureC =
          /\bexport const PARTNER_ORIGIN_COLUMN\b/.test(addedJs) &&
          /\bgetCertOrigin\s*\(/.test(addedJs) &&
          /\bisPartnerOriginatedCert\s*\(/.test(addedJs) &&
          /\bcheckGradePublishGates\s*\(/.test(addedJs);
        // D) D-1 undeclared-column preservation — founder-approved 2026-08-07, narrowly, for
        //    THAT REPAIR ONLY.
        //
        //    What it admits: `auth_status`, `auth_notes` and `private_notes` are real
        //    `certificates` columns that applyCertGradeDraft writes in raw SQL, but
        //    shared/schema.ts declares none of them, so `cert.*` was structurally `undefined`
        //    and pick() collapsed all three to NULL on EVERY grading save — destroying HQ
        //    private notes and resetting an authenticity verdict. The repair preserves them at
        //    the SQL layer (the identical COALESCE form server/routes.ts already ships for
        //    these exact three columns) and reads the two operator-visible ones explicitly
        //    instead of fabricating "genuine".
        //
        //    FIVE independent tokens are required, so an incidental or bundled edit cannot
        //    satisfy it: two JavaScript implementations proven in JS mode (tagged-template text
        //    can never fake them — N5), plus all three COALESCE column assignments proven in
        //    guarded mode. Both halves are mandatory; neither can stand in for the other.
        //
        //    What it does NOT authorise, and cannot: no scoring, no MVGS mathematics, no
        //    centering, no Pristine / Black Label, no B1/B2/B3 rule change, no grading
        //    threshold, deduction, weighting or calibration change, and no unrelated
        //    server/grader.ts change of any kind. None of the five tokens names any of those,
        //    the calculation-token assertion below still applies unchanged, and the sibling
        //    per-line formula guard in this file still scans every added AND removed line — so
        //    an unrelated protected-engine change bundled alongside this signature still FAILS.
        const signatureD =
          /\bkeepStoredText\s*\(/.test(addedJs) &&
          /\breadUndeclaredAuthColumns\s*\(/.test(addedJs) &&
          /auth_status\s*=\s*COALESCE\(/.test(addedCode) &&
          /auth_notes\s*=\s*COALESCE\(/.test(addedCode) &&
          /private_notes\s*=\s*COALESCE\(/.test(addedCode);
        // E) Durable review-lifecycle clock — founder-approved 2026-08-09, narrowly, for THAT
        //    REPAIR ONLY (owner DECISION 1 of the partner-network final blocker repair).
        //
        //    What it admits: PARTNER_QUALITY_V2's rolling 180-day window positioned each unit with
        //    COALESCE(grade_approved_at, graded_at, status_updated_at, issued_at). For the exact
        //    unit V2 exists to keep — reviewed, returned, ABANDONED — all three of the first
        //    options are NULL, and one of them is nulled by THIS FUNCTION (`graded_at = NULL` in
        //    the rejection CAS). The clock therefore fell through to `issued_at`, the connector
        //    IMPORT date, so a shop could import a batch, sit on it, grade it badly six months
        //    later and abandon the bounces — evidence already outside the window on the day it was
        //    created. The repair stamps `review_entered_at` in the SAME CAS that increments
        //    `redo_count`, so the population predicate and the clock can never disagree.
        //
        //    TWO independent tokens are required and they are in DIFFERENT representations, so
        //    neither can fake the other: the exported column constant is proven in JS mode (tagged
        //    template text can never satisfy it — N5), and the SQL assignment is proven in guarded
        //    mode. Both are mandatory.
        //
        //    What it does NOT authorise, and cannot: no scoring, no MVGS mathematics, no
        //    centering, no Pristine / Black Label, no B1/B2/B3 rule change, no grading threshold,
        //    deduction, weighting or calibration change, and no unrelated server/grader.ts change
        //    of any kind. Neither token names any of those; the calculation-token assertion below
        //    still applies unchanged; and the sibling per-line formula guard in this file still
        //    scans every added AND removed line — so an unrelated protected-engine change bundled
        //    alongside this signature still FAILS. `review_entered_at` is a timestamp column: it
        //    contains no digit, no arithmetic and no grade-ish identifier.
        const signatureE =
          /\bexport const REVIEW_LIFECYCLE_COLUMN\b/.test(addedJs) &&
          /review_entered_at\s*=\s*NOW\(\)/.test(addedCode);
        expect(
          signatureA || signatureB || signatureC || signatureD || signatureE,
          "server/grader.ts changed but matches no founder-authorised signature"
        ).toBe(true);
        // The B3 sub-grade COMPLETENESS check that signature C extracts verbatim from
        // approveGraderCert references the four sub-grade COLUMNS by name, one of which is
        // `centering_score`. Those are column identifiers in a NULL-completeness predicate,
        // not centering MATHS — the centering calculation lives in shared/centering.ts, which
        // remains byte-identical and is still hard-blocked by `calcEngine` above.
        //
        // So the four column names are removed before the calculation-token test, and ONLY
        // those exact identifiers. Bare `centering`, `mvgs`, `pristine`, `gradeNum`,
        // `calculateOverallGrade` and `scoreMvgs` all still fail, in this file and every other.
        const b3Columns = /\b(centering_score|corners_score|edges_score|surface_score)\b/g;
        expect(addedCode.replace(b3Columns, "")).not.toMatch(
          /mvgs|pristine|centering|gradeNum|calculateOverallGrade|scoreMvgs/i
        );
        continue;
      }
      if (f === "shared/mvgs-scoring.ts") {
        // ── The ONE narrowly-authorised exemption (owner, 2026-08-07) ────────────────────
        // The server-authoritative partner MVGS adapter needs the engine's bucket function
        // `remainingToGrade` to derive sub-grades. Forking the bracket table into partner code
        // violates the owner's "ONE MVGS engine, do not fork" rule; skipping the sub-grades
        // makes B3 block every partner publish. The owner therefore approved the export
        // keyword, and ONLY a pure visibility widening:
        //
        //     -function remainingToGrade(remaining: number): number {
        //     +export function remainingToGrade(remaining: number): number {
        //
        // shared/mvgs-scoring.ts REMAINS in `calcEngine` above — this is a conditional
        // exemption, not a removal, and it is CONJUNCTIVE with the malformed-escape and
        // module-reach checks below. Thresholds, deductions, calibration, the centering maths,
        // Pristine and Black Label are all still frozen: any added or removed line containing a
        // digit, or any change to a line body beyond the `export` keyword, fails.
        //
        // Scope is exactly one file. shared/centering.ts, shared/pristine.ts,
        // shared/mvgs-input-builder.ts, grading-prompt and server/grader.ts are NOT exempted.
        const diff = protectedDiffFor(f);
        const verdict = visibilityOnlyExportChange(diff);
        expect(
          verdict.ok,
          `shared/mvgs-scoring.ts changed and is NOT a pure visibility-only export: ${verdict.reason}`
        ).toBe(true);
        // Conjunctive with the pre-existing protections — the exemption replaces nothing.
        expect(hasMalformedEscape(diff), "shared/mvgs-scoring.ts contains a malformed escape sequence").toBe(false);
        const mvgsReach = diffProtectedEngineReach(diff, "both");
        expect(mvgsReach, `shared/mvgs-scoring.ts gained a protected-engine module reach: ${mvgsReach}`).toBe("");
        continue;
      }
      expect(f, `unexpected change to grading engine: ${f}`).not.toMatch(calcEngine);
    }
    // 60s, not the 5s default. This guard SHELLS OUT to `git diff` once per protected file via
    // execFileSync — process spawn plus git object I/O. Alone that is well under a second; run
    // alongside nine other suites it exceeded the default budget and failed at 5000ms, which reads
    // as "the protected-engine guard is broken" when nothing about the guard changed.
    //
    // Raising the budget is the correct fix HERE because this test asserts a PROPERTY (no
    // calculation engine file changed), not a duration — there is no guarantee being weakened. A
    // test that asserted elapsed time would need the opposite treatment.
  }, 60_000);

  it("if the grader workflow changed, it added NO scoring, weighting or formula logic", () => {
    // The narrow-scope half of the founder authorisation: server/grader.ts may gain GUARDS,
    // but must never gain or alter grade CALCULATION. Hostile review broke the first version
    // of this check twice — real weighted arithmetic containing none of the blocked
    // identifiers passed, and prefixing an EXECUTABLE line with a block comment made the
    // comment-skip swallow it. Both are closed below.
    const diff = execFileSync("git", ["diff", "--unified=0", "origin/main", "--", "server/grader.ts"], {
      encoding: "utf8",
    });
    if (!diff.trim()) return; // grader.ts untouched on this branch

    const identifiers =
      /computeMvgsScore|scoreMvgsV2|mvgsTierName|gradeFromMvgsScore|loadMvgsCalibration|isPristine|mvgs|calibration|WEIGHT|weight\s*[:=]|deduction\s*[:=]|penalt/i;
    // Arithmetic on any grade-ish quantity: a formula does not have to name a helper.
    const gradeIdent = /(grade|overall|centering|corners|edges|surface|subgrade|score)/i;
    const arithmetic = /[+\-*/]\s*-?\d|\d\s*[+\-*/]|Math\.(min|max|round|floor|ceil|abs|pow)/;

    // Both added AND removed lines, stripped by the shared scanner. Stripping the whole block
    // in one pass (rather than line-by-line regexes) is what closes hostile-review F2: a
    // template literal — single-line or multi-line, nested or not — can no longer hide code,
    // and a tagged sql`` keeps its SQL text where the guard can see it.
    for (const raw of addedCodeOf(diff, "both").split("\n")) {
      const code = raw.trim();
      if (!code || code === "*" || code.startsWith("*")) continue; // JSDoc continuation line

      expect(code, `grader workflow change must not name grade-calculation machinery: ${code}`).not.toMatch(
        identifiers
      );
      if (gradeIdent.test(code)) {
        expect(code, `grader workflow change must not do arithmetic on a grade value: ${code}`).not.toMatch(arithmetic);
      }
    }
  });

  it("that guard actually catches a disguised formula (self-test)", () => {
    // Pins the two bypasses hostile review demonstrated, so the guard cannot silently rot.
    const identifiers =
      /computeMvgsScore|scoreMvgsV2|mvgsTierName|gradeFromMvgsScore|loadMvgsCalibration|isPristine|mvgs|calibration|WEIGHT|weight\s*[:=]|deduction\s*[:=]|penalt/i;
    const gradeIdent = /(grade|overall|centering|corners|edges|surface|subgrade|score)/i;
    const arithmetic = /[+\-*/]\s*-?\d|\d\s*[+\-*/]|Math\.(min|max|round|floor|ceil|abs|pow)/;
    const judge = (line: string): boolean => {
      const code = stripNonCode(line).trim();
      if (!code) return true; // a pure comment is allowed
      if (identifiers.test(code)) return false;
      if (gradeIdent.test(code) && arithmetic.test(code)) return false;
      return true;
    };
    // These MUST be caught:
    expect(judge("const overall = Math.min(10, c * 0.35 + co * 0.25 + e * 0.2 + s * 0.2);")).toBe(false);
    expect(judge("const penalty = defects.length * 0.5; grade -= penalty;")).toBe(false);
    expect(judge("/* guard */ const s = computeMvgsScore(inputs);")).toBe(false);
    expect(judge("gradeOverall = gradeOverall - 1;")).toBe(false);
    // F2 — the template-literal bypasses, single-line and nested. Each of these passed the
    // previous per-line stripper because the whole literal was blanked.
    expect(
      judge("await db.execute(sql`UPDATE certificates SET grade = ${computeMvgsScore(x)} WHERE id = ${id}`);")
    ).toBe(false);
    expect(judge("const q = sql`SELECT ${inner ? sql`${isPristine(c)}` : sql`1`} FROM certificates`;")).toBe(false);
    expect(judge("const g = `${overall * 0.9}`;")).toBe(false);
    // These MUST be allowed (guards and plain comparisons are the whole point):
    expect(judge("if (!verdict.printable) return { ok: false as const, status: 409, error: verdict.message };")).toBe(
      true
    );
    expect(judge("// grade is recomputed by MVGS elsewhere")).toBe(true);
    expect(judge("const storedGradeType = normaliseGradeType(cert.gradeType);")).toBe(true);
    // An operator message may name the MVGS workstation, and may contain digits.
    expect(judge('error: "Re-run the MVGS workstation so the grade and 4 sub-grades populate.",')).toBe(true);
    // …but a dynamic import is still caught, because the member access is outside the quotes.
    expect(judge('const sc = (await import("@shared/mvgs-scoring")).computeMvgsScore;')).toBe(false);
  });

  it("signature D is narrow: all five tokens required, and SQL text cannot fake the JS half (self-test)", () => {
    // Pins the shape of the 2026-08-07 D-1 authorisation so it cannot silently widen. The
    // predicate below is the SAME expression the guard above evaluates; only its input changes.
    const asDiff = (lines: string[]) => lines.map((l) => `+${l}`).join("\n");
    const matchesD = (lines: string[]): boolean => {
      const diff = asDiff(lines);
      const addedCode = addedCodeOf(diff, "+");
      const addedJs = addedJsOf(diff, "+");
      return (
        /\bkeepStoredText\s*\(/.test(addedJs) &&
        /\breadUndeclaredAuthColumns\s*\(/.test(addedJs) &&
        /auth_status\s*=\s*COALESCE\(/.test(addedCode) &&
        /auth_notes\s*=\s*COALESCE\(/.test(addedCode) &&
        /private_notes\s*=\s*COALESCE\(/.test(addedCode)
      );
    };
    const full = [
      "const keepStoredText = (v: unknown): string | null => (v == null || v === '' ? null : String(v));",
      "async function readUndeclaredAuthColumns(certId: number) { return null; }",
      "const q = sql`UPDATE certificates SET",
      "  auth_status = COALESCE(${keepStoredText(body.auth_status)}, auth_status, 'genuine'),",
      "  auth_notes  = COALESCE(${keepStoredText(body.auth_notes)}, auth_notes),",
      "  private_notes = COALESCE(${keepStoredText(body.private_notes)}, private_notes)`;",
    ];
    expect(matchesD(full), "the authorised repair itself must satisfy signature D").toBe(true);
    // Conjunctive: dropping ANY ONE of the five tokens must stop it matching, so a partial or
    // unrelated edit can never ride in on this authorisation.
    const without = (needle: string, replacement: string) => full.map((l) => l.split(needle).join(replacement));
    for (const [needle, replacement] of [
      ["keepStoredText", "someOtherHelper"],
      ["readUndeclaredAuthColumns", "someOtherReader"],
      ["auth_status = COALESCE(", "auth_status = ("],
      ["auth_notes  = COALESCE(", "auth_notes  = ("],
      ["private_notes = COALESCE(", "private_notes = ("],
    ] as const) {
      expect(matchesD(without(needle, replacement)), `"${needle}" must be load-bearing`).toBe(false);
    }
    // N5: tagged-template TEXT naming the two helpers must NOT satisfy the JavaScript half.
    expect(
      matchesD([
        "const q = sql`keepStoredText( readUndeclaredAuthColumns(",
        "  auth_status = COALESCE(x, auth_status, 'genuine'),",
        "  auth_notes = COALESCE(x, auth_notes), private_notes = COALESCE(x, private_notes)`;",
      ])
    ).toBe(false);
  });
});
