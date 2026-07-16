/**
 * Authoritative structured-variant validation + symbol semantics — pure tests.
 * Covers gold/silver + star-count distinction, the four-classification split,
 * server-side symbol derivation, catalogue validation, region/era derivation +
 * "show all" semantics, soft warnings, and the column→cert-field mapping.
 */
import { describe, it, expect } from "vitest";
import {
  validateStructuredVariant,
  structuredColumnsToCertFields,
  hasStructuredData,
  STRUCTURED_VARIANT_VERSION,
} from "@shared/structured-variant-validate";
import { describeSymbol, rarityByValue, filterRarities } from "@shared/pokemon-rarity-catalogue";

describe("accessible symbol descriptions name COUNT and COLOUR (Phase 3 / test 9)", () => {
  it.each([
    ["special_illustration_rare", "two gold stars"],
    ["ultra_rare", "two silver stars"],
    ["hyper_rare", "three gold stars"],
    ["illustration_rare", "one gold star"],
    ["rare", "one black star"],
    ["double_rare", "two black stars"],
    ["common", "black circle"],
  ])("%s → “%s”", (value, expected) => {
    expect(describeSymbol(rarityByValue(value)!.symbol)).toBe(expected);
  });
});

describe("gold vs silver + star count are server-derived from the catalogue (tests 6-8,10)", () => {
  it("two gold stars vs two silver stars store different colours, same count", () => {
    const sir = validateStructuredVariant({ rarityCode: "special_illustration_rare" }).columns;
    const ur = validateStructuredVariant({ rarityCode: "ultra_rare" }).columns;
    expect(sir.printedSymbolColour).toBe("gold");
    expect(ur.printedSymbolColour).toBe("silver");
    expect(sir.printedSymbolCount).toBe(2);
    expect(ur.printedSymbolCount).toBe(2);
    expect(sir.printedSymbolColour).not.toBe(ur.printedSymbolColour);
  });
  it("1★/2★/3★ store distinct counts and the canonical glyph", () => {
    expect(validateStructuredVariant({ rarityCode: "rare" }).columns.printedSymbolCount).toBe(1);
    expect(validateStructuredVariant({ rarityCode: "double_rare" }).columns.printedSymbolCount).toBe(2);
    expect(validateStructuredVariant({ rarityCode: "hyper_rare" }).columns.printedSymbolCount).toBe(3);
    expect(validateStructuredVariant({ rarityCode: "special_illustration_rare" }).columns.printedSymbol).toBe("★★");
  });
  it("client cannot spoof the symbol — only rarityCode is read, colour/count are derived", () => {
    // Even though no symbol fields are accepted as input, the output is correct.
    const cols = validateStructuredVariant({ rarityCode: "ultra_rare" }).columns;
    expect(cols.printedSymbolColour).toBe("silver"); // never "gold"
  });
});

describe("four independent classifications (tests 11-16)", () => {
  it("Reverse Holo stores as finish only", () => {
    const c = validateStructuredVariant({ finishVariant: "reverse_holo" }).columns;
    expect(c.finishVariant).toBe("reverse_holo");
    expect(c.rarityCode).toBeNull();
    expect(c.promoType).toBeNull();
    expect(c.subsetName).toBeNull();
  });
  it("Black Star Promo stores as promo only", () => {
    const c = validateStructuredVariant({ promoType: "black_star_promo" }).columns;
    expect(c.promoType).toBe("black_star_promo");
    expect(c.subsetName).toBeNull();
  });
  it("Trainer Gallery stores as subset only", () => {
    const c = validateStructuredVariant({ subsetName: "trainer_gallery" }).columns;
    expect(c.subsetName).toBe("trainer_gallery");
    expect(c.promoType).toBeNull();
  });
  it("all four can coexist on one card (rarity + finish + promo + subset)", () => {
    const c = validateStructuredVariant({
      rarityCode: "special_illustration_rare",
      finishVariant: "holo",
      subsetName: "trainer_gallery",
    }).columns;
    expect(c.rarityCode).toBe("special_illustration_rare");
    expect(c.finishVariant).toBe("holo");
    expect(c.subsetName).toBe("trainer_gallery");
  });
});

describe("catalogue validation is authoritative (unknown/mismatch → hard error)", () => {
  it("rejects an unknown rarity code", () => {
    const r = validateStructuredVariant({ rarityCode: "not_a_rarity" });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });
  it("rejects a subset value placed in the promo field (and vice-versa)", () => {
    expect(validateStructuredVariant({ promoType: "trainer_gallery" }).ok).toBe(false);
    expect(validateStructuredVariant({ subsetName: "black_star_promo" }).ok).toBe(false);
  });
  it("rejects an unknown era", () => {
    expect(validateStructuredVariant({ rarityCode: "rare", era: "kanto" }).ok).toBe(false);
  });
});

describe("region + era derivation and show-all semantics (tests 18-22)", () => {
  it("region is derived from language (code or display name)", () => {
    expect(validateStructuredVariant({ rarityCode: "rare", language: "en" }).columns.region).toBe("western");
    expect(validateStructuredVariant({ rarityCode: "rare", language: "English" }).columns.region).toBe("western");
    expect(validateStructuredVariant({ rarityCode: "rare", language: "Japanese" }).columns.region).toBe("japan");
  });
  it("era filter narrows rarities; showing all (no era) is a superset", () => {
    const withEra = filterRarities({ language: "en", era: "vintage" }).map((r) => r.value);
    const all = filterRarities({ language: "en" }).map((r) => r.value);
    expect(all.length).toBeGreaterThanOrEqual(withEra.length);
    expect(all).toContain("double_rare"); // SV rarity visible when era filter is off
    expect(withEra).not.toContain("double_rare");
  });
});

describe("soft warnings do not block saving (Phase 9 / test 23)", () => {
  it("warns on an unsupported rarity/region pairing but still ok", () => {
    const r = validateStructuredVariant({ rarityCode: "ultra_rare", language: "Japanese" });
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => /region/i.test(w))).toBe(true);
  });
  it("warns on an unsupported era pairing", () => {
    const r = validateStructuredVariant({ rarityCode: "double_rare", era: "vintage" });
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => /era/i.test(w))).toBe(true);
  });
  it("warns when an existing legacy value is ambiguous and nothing structured is chosen", () => {
    const r = validateStructuredVariant({ legacyVariant: "FULL_ART" });
    expect(r.warnings.some((w) => /ambiguous/i.test(w))).toBe(true);
  });
});

describe("empty selection + column mapping", () => {
  it("no structured input → all columns null, version null, ok", () => {
    const r = validateStructuredVariant({});
    expect(r.ok).toBe(true);
    expect(hasStructuredData(r.columns)).toBe(false);
    expect(r.columns.structuredVariantVersion).toBeNull();
  });
  it("any structured field stamps the version", () => {
    expect(validateStructuredVariant({ finishVariant: "holo" }).columns.structuredVariantVersion).toBe(
      STRUCTURED_VARIANT_VERSION,
    );
  });
  it("maps rarityLabel onto the rarityLabelStructured cert field", () => {
    const cols = validateStructuredVariant({ rarityCode: "rare" }).columns;
    const fields = structuredColumnsToCertFields(cols);
    expect(fields.rarityLabelStructured).toBe("Rare");
    expect((fields as Record<string, unknown>).rarityLabel).toBeUndefined();
    // The mapper never emits legacy variant/rarity keys.
    expect((fields as Record<string, unknown>).variant).toBeUndefined();
    expect((fields as Record<string, unknown>).rarity).toBeUndefined();
  });
});
