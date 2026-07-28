/**
 * Pokémon Knowledge Engine — pure knowledge-layer tests (no DOM, no DB, no network).
 * Covers provenance, checksum/versioning, era timeline, language guide,
 * comparison pairs, catalogue extensions, accessibility labels, the shared
 * set-code normaliser, starter-seed discipline and the AI v2 stub.
 */
import { describe, it, expect } from "vitest";
import {
  POKEMON_RARITIES,
  POKEMON_FINISHES,
  POKEMON_PROMOS,
  POKEMON_ERAS,
  describeSymbol,
  rarityByValue,
  finishByValue,
  promoByValue,
  mapLegacyVariant,
} from "../shared/pokemon-rarity-catalogue";
import {
  KNOWLEDGE_CATALOGUE_VERSION,
  catalogueChecksum,
  provenanceFor,
  DEFAULT_CATALOGUE_PROVENANCE,
  ERA_TIMELINE,
  LANGUAGE_GUIDE,
  COMPARISON_PAIRS,
  KNOWLEDGE_NOTES,
  catalogueCounts,
  SOURCE_TYPES,
  REVIEW_STATUSES_KNOWLEDGE,
} from "../shared/pokemon-knowledge";
import { normalizeSetCode } from "../shared/set-code";
import { STARTER_SETS } from "../shared/pokemon-starter-sets";
import { identifyCardFromImages, suggestRarityFromImage } from "../shared/rarity-ai-suggestion";

describe("provenance (Phase 2)", () => {
  it("every catalogue record resolves to a provenance with source, status and confidence", () => {
    for (const r of POKEMON_RARITIES) {
      const p = provenanceFor("rarity", r.value);
      expect(p.sources.length).toBeGreaterThan(0);
      expect(REVIEW_STATUSES_KNOWLEDGE).toContain(p.status);
      expect(["high", "medium", "low"]).toContain(p.confidence);
      for (const s of p.sources) expect(SOURCE_TYPES).toContain(s.sourceType);
    }
  });
  it("default provenance is PROVISIONAL community terminology — never presented as official", () => {
    expect(DEFAULT_CATALOGUE_PROVENANCE.status).toBe("provisional");
    expect(DEFAULT_CATALOGUE_PROVENANCE.sources[0].sourceType).toBe("community");
  });
  it("founder-confirmed records are verified; region-specific code systems are needs_review", () => {
    expect(provenanceFor("rarity", "common").status).toBe("verified");
    expect(provenanceFor("finish", "reverse_holo").status).toBe("verified");
    expect(provenanceFor("rarity", "bw_rare").status).toBe("needs_review");
    expect(provenanceFor("rarity", "mega_ultra_rare").confidence).toBe("low");
  });
});

describe("catalogue version + checksum", () => {
  it("checksum is deterministic and version is stamped", () => {
    expect(catalogueChecksum()).toBe(catalogueChecksum());
    expect(catalogueChecksum()).toMatch(/^[0-9a-f]{8}$/);
    expect(KNOWLEDGE_CATALOGUE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(catalogueCounts().checksum).toBe(catalogueChecksum());
  });
});

describe("era timeline (Phase 14)", () => {
  it("every period maps to a stable catalogue era (the deployed DB CHECK vocabulary)", () => {
    const valid = new Set(POKEMON_ERAS.map((e) => e.value));
    for (const p of ERA_TIMELINE) expect(valid.has(p.catalogueEra)).toBe(true);
  });
  it("covers the required historical periods and supports future eras via data", () => {
    const keys = ERA_TIMELINE.map((p) => p.key);
    for (const k of ["wotc-base", "neo", "e-reader", "ex", "dp", "bw", "xy", "sm", "swsh", "sv", "future"]) {
      expect(keys).toContain(k);
    }
  });
});

describe("language guide (Phase 13)", () => {
  it("includes the required languages incl. European ones", () => {
    const keys = LANGUAGE_GUIDE.map((l) => l.key);
    for (const k of ["en", "ja", "ko", "zh-cn", "zh-tw", "th", "id", "fr", "de", "it", "es", "pt"]) {
      expect(keys).toContain(k);
    }
  });
  it("every entry maps to a real picker language value (safe filtering)", () => {
    const pickerValues = new Set(["en", "ja", "ko", "zh-cn", "zh-tw", "id", "th", "fr", "de", "it", "es", "pt", "other"]);
    for (const l of LANGUAGE_GUIDE) expect(pickerValues.has(l.pickerValue)).toBe(true);
  });
});

describe("comparison pairs (Phase 12)", () => {
  it("every pair references records that actually exist in the ONE shared catalogue", () => {
    const resolve = (kind: string, value: string) =>
      kind === "rarity" ? rarityByValue(value) : kind === "finish" ? finishByValue(value) : promoByValue(value);
    for (const c of COMPARISON_PAIRS) {
      expect(resolve(c.left.kind, c.left.value), `${c.key} left`).toBeTruthy();
      expect(resolve(c.right.kind, c.right.value), `${c.key} right`).toBeTruthy();
      expect(c.howToTell.length).toBeGreaterThan(10);
    }
  });
  it("covers the required confusions (gold vs silver, TG vs GG, promo vs rare…)", () => {
    const keys = COMPARISON_PAIRS.map((c) => c.key);
    for (const k of ["sir-vs-ur", "ir-vs-rare", "sir-vs-sar", "ir-vs-ar", "sr-vs-ur", "reverse-vs-holo", "pokeball-vs-masterball", "tg-vs-gg", "promo-vs-rare"]) {
      expect(keys).toContain(k);
    }
  });
});

describe("catalogue extensions (Phases 5-7) — additive, no duplicates", () => {
  it("new finishes exist and are finishes only", () => {
    for (const v of ["mirror_holo", "crosshatch_holo", "confetti_holo", "glitter_holo", "textured", "full_texture", "gold_foil", "silver_foil", "championship_stamp"]) {
      expect(finishByValue(v), v).toBeTruthy();
      expect(rarityByValue(v)).toBeUndefined();
      expect(promoByValue(v)).toBeUndefined();
    }
  });
  it("Prism Star exists as an SM-era rarity", () => {
    const ps = rarityByValue("prism_star")!;
    expect(ps.eras).toContain("sm");
    expect(ps.symbol.shape).toBe("diamond");
  });
  it("new promo programmes exist with kind=promo", () => {
    for (const v of ["world_championships_promo", "play_pokemon_promo", "illustration_contest_promo", "ana_promo", "corocoro_promo", "cd_promo"]) {
      expect(promoByValue(v)?.kind, v).toBe("promo");
    }
  });
  it("upgraded legacy mappings now resolve to the dedicated finishes", () => {
    expect(mapLegacyVariant("MIRROR_HOLO")).toMatchObject({ value: "mirror_holo", ambiguous: false });
    expect(mapLegacyVariant("GLITTER_HOLO")).toMatchObject({ value: "glitter_holo", ambiguous: false });
    expect(mapLegacyVariant("TEXTURED")).toMatchObject({ value: "textured", ambiguous: false });
    expect(mapLegacyVariant("PATTERN_HOLO").ambiguous).toBe(true);
  });
  it("still no value collisions across classifications and no duplicates", () => {
    const all = [...POKEMON_RARITIES.map((x) => x.value), ...POKEMON_FINISHES.map((x) => x.value), ...POKEMON_PROMOS.map((x) => x.value)];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("accessible symbol labels (test 9/22)", () => {
  it("describeSymbol always names count AND colour for stars", () => {
    expect(describeSymbol(rarityByValue("special_illustration_rare")!.symbol)).toBe("two gold stars");
    expect(describeSymbol(rarityByValue("ultra_rare")!.symbol)).toBe("two silver stars");
    expect(describeSymbol(rarityByValue("hyper_rare")!.symbol)).toBe("three gold stars");
    expect(describeSymbol(rarityByValue("rare")!.symbol)).toBe("one black star");
  });
  it("gold/silver/black can never be confused by stored data", () => {
    const sir = rarityByValue("special_illustration_rare")!.symbol;
    const ur = rarityByValue("ultra_rare")!.symbol;
    const dr = rarityByValue("double_rare")!.symbol;
    expect(new Set([sir.colour, ur.colour, dr.colour]).size).toBe(3);
  });
});

describe("shared set-code normaliser", () => {
  it("normalises case + whitespace and is idempotent", () => {
    expect(normalizeSetCode(" SV 8 ")).toBe("sv8");
    expect(normalizeSetCode("SWSH12pt5")).toBe("swsh12pt5");
    expect(normalizeSetCode(normalizeSetCode("SV 8"))).toBe("sv8");
    expect(normalizeSetCode(null)).toBe("");
  });
});

describe("starter seed discipline (KE-6)", () => {
  it("every record is era/region-valid, has a normalised key, and NEVER guesses counts", () => {
    const eras = new Set(POKEMON_ERAS.map((e) => e.value));
    const withCounts = STARTER_SETS.filter((r) => r.mainCount != null);
    // Only the whitelisted well-established counts are present.
    expect(withCounts.map((r) => r.setKey).sort()).toEqual(["base1", "base2", "base3"]);
    for (const r of STARTER_SETS) {
      expect(r.setKey).toBe(normalizeSetCode(r.setKey));
      expect(eras.has(r.era)).toBe(true);
      expect(["western", "japan"]).toContain(r.region);
    }
  });
  it("regional equivalents are separate records linked by parentSetKey, never merged", () => {
    const en151 = STARTER_SETS.find((r) => r.setKey === "sv3pt5")!;
    const jp151 = STARTER_SETS.find((r) => r.setKey === "sv2a")!;
    expect(en151.parentSetKey).toBe("sv2a");
    expect(jp151.language).toBe("ja");
    expect(en151.language).toBe("en");
  });
  it("no duplicate (setKey, language) pairs", () => {
    const keys = STARTER_SETS.map((r) => `${r.setKey}:${r.language}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("AI suggestion contract (Phase 16) — zero calls, zero credits", () => {
  it("v1 and v2 resolvers are pure no-ops returning null", () => {
    expect(suggestRarityFromImage({ certId: "MV1" })).toBeNull();
    expect(identifyCardFromImages({ frontImageKey: "images/x/front.jpg" })).toBeNull();
  });
  it("the AI stub module contains no provider imports (static proof)", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("shared/rarity-ai-suggestion.ts", "utf8");
    expect(src).not.toMatch(/anthropic|higgsfield|openai|fetch\(|axios/i);
  });
});

describe("knowledge notes reference real catalogue values", () => {
  it("every KNOWLEDGE_NOTES key resolves", () => {
    for (const key of Object.keys(KNOWLEDGE_NOTES)) {
      const [kind, value] = key.split(":");
      const found = kind === "rarity" ? rarityByValue(value) : kind === "finish" ? finishByValue(value) : promoByValue(value);
      expect(found, key).toBeTruthy();
    }
  });
});
