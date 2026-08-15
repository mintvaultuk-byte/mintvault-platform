/**
 * GOLD STAR CLASSIFICATION SAFETY.
 *
 * THE DEFECT. A grader working a vintage EX-era card searched the structured rarity
 * picker for "gold star" and was offered Illustration Rare, Special Illustration Rare
 * and Hyper Rare — all Scarlet & Violet rarities — plus plain Rare. None of them is the
 * classic ☆ Gold Star chase card. Three independent causes:
 *
 *   1. `searchCatalogue` took NO card context, so its results bypassed the era/region
 *      eligibility that the browse lists apply through `filterRarities`, and every hit
 *      rendered as a directly selectable chip.
 *   2. The alias matcher was bidirectional, so the one-word alias "star" on plain Rare
 *      matched any query containing that word — including "gold star".
 *   3. `gold_star` had no structured value at all. It was the ONLY printed rarity with
 *      a legacy code (GOLD_STAR) and no structured counterpart, so even a perfect search
 *      had nothing correct to return.
 *
 * These tests pin all three closed. They are deliberately behavioural: they assert what
 * a grader can SELECT in a given card context, not how the matcher is implemented.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  searchCatalogue,
  filterRarities,
  SEED_CATALOGUE,
  POKEMON_RARITIES,
  POKEMON_FINISHES,
  type PokemonEra,
} from "@shared/pokemon-rarity-catalogue";

const cat = SEED_CATALOGUE;
const EN = "en";
const values = (era: PokemonEra | null, q: string): string[] =>
  searchCatalogue(q, cat, { language: EN, era }).rarities.map((r) => r.value);

const MODERN_GOLD_STAR_RARITIES = ["illustration_rare", "special_illustration_rare", "hyper_rare"];

describe("EX-era Gold Star is selectable and is its own rarity", () => {
  it("exists as a structured value, scoped to the EX era only", () => {
    const gs = POKEMON_RARITIES.find((r) => r.value === "gold_star");
    expect(gs).toBeDefined();
    expect(gs!.eras).toEqual(["ex-dp"]);
    for (const era of ["vintage", "bw-xy", "sm", "swsh", "sv"] as const) {
      expect(filterRarities({ language: EN, era }, cat).some((r) => r.value === "gold_star")).toBe(false);
    }
    expect(filterRarities({ language: EN, era: "ex-dp" }, cat).some((r) => r.value === "gold_star")).toBe(true);
  });

  it("searching 'gold star' on an EX-era card offers Gold Star and NOTHING modern", () => {
    const hits = values("ex-dp", "gold star");
    expect(hits).toContain("gold_star");
    for (const modern of MODERN_GOLD_STAR_RARITIES) expect(hits).not.toContain(modern);
  });

  it("searching 'gold star' on an EX-era card does not surface plain Rare via the 'star' alias", () => {
    expect(values("ex-dp", "gold star")).not.toContain("rare");
  });

  it("is a DISTINCT value from every modern gold-star rarity", () => {
    expect(MODERN_GOLD_STAR_RARITIES).not.toContain("gold_star");
    // Same printed symbol as Illustration Rare (one gold star) — the ERA is what
    // separates them, which is exactly why search must be era-aware.
    const gs = POKEMON_RARITIES.find((r) => r.value === "gold_star")!;
    const ir = POKEMON_RARITIES.find((r) => r.value === "illustration_rare")!;
    expect(gs.symbol.colour).toBe(ir.symbol.colour);
    expect(gs.eras).not.toEqual(ir.eras);
  });
});

describe("modern cards are unaffected (negative case)", () => {
  it("a Scarlet & Violet card is NOT offered the legacy EX Gold Star", () => {
    expect(values("sv", "gold star")).not.toContain("gold_star");
  });

  it("a Scarlet & Violet card still gets its real gold-star rarities", () => {
    const hits = values("sv", "gold star");
    for (const modern of MODERN_GOLD_STAR_RARITIES) expect(hits).toContain(modern);
  });

  it("Illustration Rare is still reachable by its own name on an eligible card", () => {
    expect(values("sv", "illustration rare")).toContain("illustration_rare");
  });
});

describe("search respects the same eligibility as the browse list (no bypass)", () => {
  it.each(["vintage", "ex-dp", "bw-xy", "sm", "swsh", "sv"] as const)(
    "every search hit in era %s is also browse-eligible",
    (era) => {
      const eligible = new Set(filterRarities({ language: EN, era }, cat).map((r) => r.value));
      for (const q of ["gold star", "rare", "holo", "star", "illustration", "ace"]) {
        for (const hit of values(era, q)) expect(eligible.has(hit)).toBe(true);
      }
    }
  );

  it("'Show all compatible options' still reaches otherwise-filtered rarities", () => {
    const shown = searchCatalogue("gold star", cat, { language: EN, era: "sv", showAll: true }).rarities.map(
      (r) => r.value
    );
    expect(shown).toContain("gold_star");
  });
});

describe("alias matching is intentional (no false positives)", () => {
  it("a one-word alias no longer reverse-matches a longer query", () => {
    // "star" is an alias of plain Rare; it must not match the phrase "gold star".
    const rare = POKEMON_RARITIES.find((r) => r.value === "rare")!;
    expect(rare.aliases).toContain("star");
    expect(values("ex-dp", "gold star")).not.toContain("rare");
  });

  it("multi-word reverse matching still works, so longer phrases find their entry", () => {
    expect(searchCatalogue("reverse holo foil", cat).finishes.map((f) => f.value)).toContain("reverse_holo");
    expect(searchCatalogue("master ball reverse pattern", cat).finishes.map((f) => f.value)).toContain(
      "masterball_reverse"
    );
  });

  it("a single-word query still matches single-word aliases", () => {
    expect(values("sv", "rare")).toContain("rare");
  });
});

describe("existing rarity behaviour is unchanged", () => {
  const MATRIX: Array<[string, string, PokemonEra]> = [
    ["common", "common", "sv"],
    ["uncommon", "uncommon", "sv"],
    ["rare", "rare", "sv"],
    ["rare holo", "rare_holo", "vintage"],
    ["double rare", "double_rare", "sv"],
    ["illustration rare", "illustration_rare", "sv"],
    ["ultra rare", "ultra_rare", "sv"],
    ["special illustration rare", "special_illustration_rare", "sv"],
    ["hyper rare", "hyper_rare", "sv"],
    ["silver star", "silver_star_rare", "swsh"],
    ["ace spec", "ace_spec", "sv"],
  ];

  it.each(MATRIX)("searching %s on an eligible card still offers %s", (q, expected, era) => {
    expect(values(era, q)).toContain(expected);
  });

  it("Silver Star and Gold Star are separate rarities that never collide", () => {
    expect(values("swsh", "silver star")).not.toContain("gold_star");
    expect(values("ex-dp", "gold star")).not.toContain("silver_star_rare");
  });

  it("the finish model stays separate — Gold Star is a rarity, never a finish", () => {
    expect(POKEMON_FINISHES.some((f) => f.value === "gold_star")).toBe(false);
    expect(POKEMON_FINISHES.some((f) => f.value === "holo")).toBe(true);
    expect(POKEMON_FINISHES.some((f) => f.value === "reverse_holo")).toBe(true);
  });

  it("clearing the query yields no results (unchanged)", () => {
    expect(searchCatalogue("   ", cat).rarities).toHaveLength(0);
  });
});

describe("one canonical picker — the fix cannot diverge per role", () => {
  const read = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), "utf8");

  it("only ONE component renders the rarity picker, so all five roles share this fix", () => {
    const picker = "components/rarity-picker/RarityVariantPicker";
    const mounts = ["client/src/components/certificate-form.tsx", "client/src/components/grading/grading-panel.tsx"];
    for (const m of mounts) expect(read(m)).toContain("RarityVariantPicker");
    // No role-specific fork of the picker exists.
    const forks = fs
      .readdirSync(path.resolve(process.cwd(), "client/src/components/rarity-picker"))
      .filter((f) => /picker/i.test(f) && f !== "RarityVariantPicker.tsx");
    expect(forks).toHaveLength(0);
    expect(picker).toBeTruthy();
  });

  it("the picker passes card context into search, so eligibility cannot be bypassed", () => {
    const src = read("client/src/components/rarity-picker/RarityVariantPicker.tsx");
    expect(src).toMatch(/searchCatalogue\(\s*query,\s*cat,\s*\{[^}]*era[^}]*\}/s);
    expect(src).toMatch(/showAll/);
  });
});
