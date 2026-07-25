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
import { execFileSync } from "child_process";
import { join } from "path";
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
    expect(PICKER).toContain("setFinish(finish === x.value ? null : x.value)");
  });
  it("promo/subset is a single value cleared by re-click", () => {
    expect(PICKER).toContain("setPromoOrSubset(promoOrSubset === x.value ? null : x.value)");
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
    const changed = execFileSync("git", ["diff", "--name-only", "origin/main"], { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean);
    const calcEngine = /mvgs-scoring|shared\/pristine|shared\/centering|mvgs-input-builder|grading-prompt/;
    for (const f of changed) expect(f, `unexpected change to grading engine: ${f}`).not.toMatch(calcEngine);
  });

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

    for (const raw of diff.split("\n")) {
      if (!/^[+-]/.test(raw) || raw.startsWith("+++") || raw.startsWith("---")) continue;
      let code = raw.slice(1);
      // Strip comments FIRST, then judge what remains — so a leading /* … */ can no longer
      // be used to hide an executable statement from this check.
      code = code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/, "");
      // Then strip STRING LITERALS: an operator-facing message may legitimately mention the
      // MVGS workstation, and a message containing digits must not read as arithmetic. A
      // dynamic import is still caught, because the member access sits outside the quotes.
      code = code
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
        .replace(/`(?:[^`\\]|\\.)*`/g, "``");
      code = code.trim();
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
      const code = line
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\s)\/\/.*$/, "")
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
        .replace(/`(?:[^`\\]|\\.)*`/g, "``")
        .trim();
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
});
