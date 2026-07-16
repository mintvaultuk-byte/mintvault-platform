/**
 * Structured Pokémon rarity/variant catalogue — pure tests (no DOM, no DB, no network).
 * Covers the four-classification separation, the visual symbol distinctions (gold vs
 * silver, 2★ vs 1★), region/era filtering, search aliases, favourites/recent, the
 * certificate-preview selection, legacy old-value mapping, and canonical uniqueness.
 */
import { describe, it, expect } from "vitest";
import {
  POKEMON_RARITIES,
  POKEMON_FINISHES,
  POKEMON_PROMOS,
  POKEMON_LANGUAGES,
  rarityByValue,
  finishByValue,
  promoByValue,
  filterRarities,
  searchCatalogue,
  mapLegacyVariant,
  addRecent,
  toggleFavourite,
  buildStructuredVariant,
} from "../shared/pokemon-rarity-catalogue";

describe("visual symbol distinctions (not text-colour alone)", () => {
  it("gold vs silver two-star rarities are DATA-distinct", () => {
    const sir = rarityByValue("special_illustration_rare")!; // ★★ gold
    const ur = rarityByValue("ultra_rare")!; // ★★ silver
    expect(sir.symbol.count).toBe(2);
    expect(ur.symbol.count).toBe(2);
    expect(sir.symbol.colour).toBe("gold");
    expect(ur.symbol.colour).toBe("silver");
    expect(sir.symbol.colour).not.toBe(ur.symbol.colour); // clearly different, by data
  });
  it("two-star vs one-star are distinguished by count", () => {
    expect(rarityByValue("rare")!.symbol.count).toBe(1);
    expect(rarityByValue("illustration_rare")!.symbol.count).toBe(1); // 1 gold star
    expect(rarityByValue("double_rare")!.symbol.count).toBe(2);
    expect(rarityByValue("hyper_rare")!.symbol.count).toBe(3); // 3 gold stars
  });
  it("common/uncommon/rare use circle/diamond/star shapes", () => {
    expect(rarityByValue("common")!.symbol.shape).toBe("circle");
    expect(rarityByValue("uncommon")!.symbol.shape).toBe("diamond");
    expect(rarityByValue("rare")!.symbol.shape).toBe("star");
  });
});

describe("four independent classifications (nothing mixed)", () => {
  it("Reverse Holo is a FINISH, not a rarity or promo", () => {
    expect(finishByValue("reverse_holo")).toBeTruthy();
    expect(rarityByValue("reverse_holo")).toBeUndefined();
    expect(promoByValue("reverse_holo")).toBeUndefined();
  });
  it("Black Star Promo is a PROMO, not a rarity or finish", () => {
    const promo = promoByValue("black_star_promo");
    expect(promo?.kind).toBe("promo");
    expect(rarityByValue("black_star_promo")).toBeUndefined();
    expect(finishByValue("black_star_promo")).toBeUndefined();
  });
  it("Trainer Gallery is a SUBSET", () => {
    expect(promoByValue("trainer_gallery")?.kind).toBe("subset");
  });
  it("no value collides across rarity / finish / promo catalogues", () => {
    const rv = new Set(POKEMON_RARITIES.map((x) => x.value));
    const fv = new Set(POKEMON_FINISHES.map((x) => x.value));
    const pv = new Set(POKEMON_PROMOS.map((x) => x.value));
    for (const v of fv) expect(rv.has(v)).toBe(false);
    for (const v of pv) expect(rv.has(v) || fv.has(v)).toBe(false);
  });
});

describe("no duplicate canonical values within each classification", () => {
  it("rarity/finish/promo/language values are each unique", () => {
    for (const list of [POKEMON_RARITIES, POKEMON_FINISHES, POKEMON_PROMOS, POKEMON_LANGUAGES]) {
      const values = list.map((x) => x.value);
      expect(new Set(values).size).toBe(values.length);
    }
  });
});

describe("region / era filtering", () => {
  it("English (western) never shows Japanese-only code rarities", () => {
    const en = filterRarities({ language: "en" }).map((x) => x.value);
    expect(en).toContain("double_rare");
    expect(en).not.toContain("character_super_rare"); // CSR is Japan/Korea/China only
    expect(en).not.toContain("jp_shiny_super_rare");
  });
  it("Japanese shows the CHR/CSR/SR code rarities", () => {
    const jp = filterRarities({ language: "ja" }).map((x) => x.value);
    expect(jp).toContain("character_super_rare");
    expect(jp).toContain("jp_super_rare");
  });
  it("era filter hides rarities that did not exist in that era", () => {
    const svEnglish = filterRarities({ language: "en", era: "sv" }).map((x) => x.value);
    const vintageEnglish = filterRarities({ language: "en", era: "vintage" }).map((x) => x.value);
    expect(svEnglish).toContain("double_rare"); // SV-only rarity present in SV
    expect(vintageEnglish).not.toContain("double_rare"); // absent in vintage
  });
});

describe("search aliases", () => {
  const cases: Array<[string, "rarity" | "finish" | "promo", string]> = [
    ["2 gold", "rarity", "special_illustration_rare"],
    ["two gold stars", "rarity", "special_illustration_rare"],
    ["SIR", "rarity", "special_illustration_rare"],
    ["SAR", "rarity", "special_illustration_rare"],
    ["2 silver", "rarity", "ultra_rare"],
    ["black star promo", "promo", "black_star_promo"],
    ["master ball", "finish", "masterball_reverse"],
    ["reverse holo", "finish", "reverse_holo"],
  ];
  it.each(cases)("'%s' resolves to the right %s (%s)", (query, kind, value) => {
    const res = searchCatalogue(query);
    const list = kind === "rarity" ? res.rarities : kind === "finish" ? res.finishes : res.promos;
    expect(list.map((x) => x.value)).toContain(value);
  });
  it("empty query returns nothing", () => {
    const res = searchCatalogue("   ");
    expect(res.rarities.length + res.finishes.length + res.promos.length).toBe(0);
  });
});

describe("favourites / recently-used (pure)", () => {
  it("addRecent moves to front, de-dupes, caps", () => {
    let recent: string[] = [];
    recent = addRecent(recent, "holo");
    recent = addRecent(recent, "reverse_holo");
    recent = addRecent(recent, "holo"); // re-selecting moves it to front, no dupe
    expect(recent).toEqual(["holo", "reverse_holo"]);
    for (let i = 0; i < 12; i++) recent = addRecent(recent, `v${i}`, 8);
    expect(recent.length).toBe(8);
  });
  it("toggleFavourite adds then removes", () => {
    let favs = toggleFavourite([], "special_illustration_rare");
    expect(favs).toContain("special_illustration_rare");
    favs = toggleFavourite(favs, "special_illustration_rare");
    expect(favs).not.toContain("special_illustration_rare");
  });
});

describe("certificate preview keeps every field SEPARATE", () => {
  it("builds a structured selection with rarity/symbol/colour/finish/promo/subset/language split out", () => {
    const sel = buildStructuredVariant({
      language: "en",
      era: "sv",
      rarity: "special_illustration_rare",
      finish: "holo",
      promoOrSubset: "trainer_gallery",
    });
    expect(sel).toMatchObject({
      language: "en",
      region: "western",
      era: "sv",
      rarity: "special_illustration_rare",
      printedSymbol: "★★",
      symbolColour: "gold",
      finish: "holo",
      promo: null, // trainer_gallery is a subset, not a promo
      subset: "trainer_gallery",
    });
  });
  it("a promo (not subset) lands in the promo field, subset stays null", () => {
    const sel = buildStructuredVariant({ rarity: "rare", promoOrSubset: "black_star_promo" });
    expect(sel.promo).toBe("black_star_promo");
    expect(sel.subset).toBeNull();
  });
});

describe("old-value compatibility (legacy variant mapping — never auto-applied)", () => {
  it("clear legacy codes map to the right classification", () => {
    expect(mapLegacyVariant("REVERSE_HOLO")).toMatchObject({ classification: "finish", value: "reverse_holo", ambiguous: false });
    expect(mapLegacyVariant("FIRST_EDITION")).toMatchObject({ classification: "finish", value: "first_edition" });
    expect(mapLegacyVariant("SPECIAL_ILLUSTRATION_RARE")).toMatchObject({ classification: "rarity", value: "special_illustration_rare" });
    expect(mapLegacyVariant("TRAINER_GALLERY")).toMatchObject({ classification: "subset", value: "trainer_gallery" });
    expect(mapLegacyVariant("DOUBLE_RARE")).toMatchObject({ classification: "rarity", value: "double_rare" });
  });
  it("genuinely ambiguous historical values are flagged for review, not silently mapped", () => {
    for (const code of ["FULL_ART", "ALT_ART", "RAINBOW", "GOLD", "EX", "OTHER"]) {
      const m = mapLegacyVariant(code);
      expect(m.ambiguous).toBe(true);
      expect(m.value).toBeNull();
      expect(m.note).toBeTruthy();
    }
  });
  it("an unknown legacy code is flagged for review (never crashes)", () => {
    const m = mapLegacyVariant("SOME_NEW_CODE_123");
    expect(m.classification).toBe("ambiguous");
    expect(m.ambiguous).toBe(true);
  });
});
