import { readFileSync } from "fs";
import { join } from "path";
import { describe, it, expect } from "vitest";
import {
  catalogueConflict,
  effectiveCatalogueCode,
  isLiveCatalogueRow,
  codeNamespaceFor,
  invalidCatalogueCode,
  catalogueSearchMatch,
  parseImportItems,
  type CatalogueEntryLike,
} from "../shared/catalogue-validate";
import { buildSnapshotFromRows, type CatalogueRowLike } from "../shared/catalogue-snapshot";
import { canReadCatalogue } from "../shared/catalogue-access";
import { buildPreviewFields } from "../shared/label-preview-fields";
import {
  rarityByValue,
  finishByValue,
  promoByValue,
  searchCatalogue,
  buildStructuredVariant,
  SEED_CATALOGUE,
  POKEMON_DESIGNATIONS,
  type CatalogueSnapshot,
} from "../shared/pokemon-rarity-catalogue";
import { validateStructuredVariant } from "../shared/structured-variant-validate";

const rows: CatalogueEntryLike[] = [
  { id: 1, category: "rarity", value: "rare", label: "Rare", abbreviation: "R", aliases: ["star"] },
  { id: 2, category: "finish", value: "holo", label: "Holo", abbreviation: null, aliases: ["foil"] },
  { id: 3, category: "promo", value: "black_star_promo", label: "Black Star Promo", abbreviation: "BSP" },
];

describe("catalogueConflict — duplicate + one-category validation", () => {
  it("rejects a duplicate value within the same category", () => {
    expect(catalogueConflict(rows, { category: "rarity", value: "rare" })).toMatch(/already exists in rarity/);
    // case-insensitive
    expect(catalogueConflict(rows, { category: "rarity", value: " RARE " })).toBeTruthy();
  });

  it("allows the same value in the SAME category when it is the row being edited (excludeId)", () => {
    expect(catalogueConflict(rows, { id: 1, category: "rarity", value: "rare" }, 1)).toBeNull();
  });

  it("rejects a duplicate abbreviation within an ABBREVIATION-PERSISTING category", () => {
    // The dedicated abbreviation-only rule was folded into the broader
    // PERSISTED-CODE rule (it was a strict subset: equal abbreviations always
    // produce equal effective codes). The rejection still happens — the message
    // now names the stored code, which is the thing that actually collides.
    // HIGH-2: this applies to `designation`/`attribute`, the only categories
    // whose persisted code is `abbreviation || value`.
    const withAbbr = [
      ...rows,
      { id: 4, category: "designation", value: "first_edition", label: "1st Edition", abbreviation: "FE" },
    ];
    expect(catalogueConflict(withAbbr, { category: "designation", value: "new_one", abbreviation: "fe" })).toMatch(
      /unique stored code/i,
    );
  });

  it("HIGH-2: rarity rows MAY share a display abbreviation — it is not their persisted code", () => {
    // These are the REAL live staging rows. `rarity` persists `value`
    // (rarityCode); `abbreviation` is only the printed glyph, and EN/JP pairs
    // deliberately share one. The old over-broad rule rejected all of these.
    const rarities: CatalogueEntryLike[] = [
      { id: 9, category: "rarity", value: "hyper_rare", label: "Hyper Rare", abbreviation: "HR" },
      { id: 20, category: "rarity", value: "jp_hyper_rare", label: "JP Hyper Rare", abbreviation: "HR" },
      { id: 3, category: "rarity", value: "rare", label: "Rare", abbreviation: "R" },
      { id: 13, category: "rarity", value: "rare_holo", label: "Rare Holo", abbreviation: "R" },
    ];
    // Editing an existing JP row (label change only) is allowed.
    expect(
      catalogueConflict(rarities, {
        id: 20,
        category: "rarity",
        value: "jp_hyper_rare",
        label: "JP Hyper Rare (renamed)",
        abbreviation: "HR",
      }, 20),
    ).toBeNull();
    // Creating a NEW rarity that shares an existing printed abbreviation is allowed.
    expect(
      catalogueConflict(rarities, { category: "rarity", value: "jp_shiny_rare", label: "JP Shiny Rare", abbreviation: "R" }),
    ).toBeNull();
  });

  it("HIGH-2: a duplicate rarity VALUE is still rejected by the per-category value rule", () => {
    const rarities: CatalogueEntryLike[] = [
      { id: 9, category: "rarity", value: "hyper_rare", label: "Hyper Rare", abbreviation: "HR" },
    ];
    expect(catalogueConflict(rarities, { category: "rarity", value: "hyper_rare", abbreviation: "XX" })).toMatch(
      /already exists in rarity/,
    );
  });

  it("HIGH-2: other value-keyed categories may also share abbreviations", () => {
    for (const category of ["finish", "promo", "subset", "language", "era"]) {
      const existing: CatalogueEntryLike[] = [{ id: 1, category, value: "alpha", label: "Alpha", abbreviation: "X" }];
      expect(
        catalogueConflict(existing, { category, value: "beta", label: "Beta", abbreviation: "X" }),
        `${category} must allow a shared display abbreviation`,
      ).toBeNull();
    }
  });

  it("enforces one-classification-only across categories by default", () => {
    // 'holo' already exists as a finish; adding it as a rarity must be rejected.
    expect(catalogueConflict(rows, { category: "rarity", value: "holo" })).toMatch(/already exists as a finish/);
  });

  it("permits a cross-category value ONLY when BOTH sides opt in (symmetric)", () => {
    const crossFinish: CatalogueEntryLike[] = [
      { id: 9, category: "finish", value: "first_edition", label: "First Edition", allowCrossCategory: true },
    ];
    // both opt in → allowed
    expect(
      catalogueConflict(crossFinish, { category: "designation", value: "first_edition", allowCrossCategory: true }),
    ).toBeNull();
    // existing opts in but candidate does NOT → still rejected (no single-sided bypass)
    expect(catalogueConflict(crossFinish, { category: "designation", value: "first_edition" })).toMatch(/BOTH entries/);
    // candidate opts in but existing does NOT → rejected
    const nonCross: CatalogueEntryLike[] = [{ id: 9, category: "finish", value: "first_edition", label: "FE" }];
    expect(
      catalogueConflict(nonCross, { category: "designation", value: "first_edition", allowCrossCategory: true }),
    ).toMatch(/BOTH entries/);
    // neither opts in → rejected
    expect(catalogueConflict(nonCross, { category: "designation", value: "first_edition" })).toMatch(/one category only/);
  });

  it("does not treat aliases as values (aliases never collide)", () => {
    expect(catalogueConflict(rows, { category: "rarity", value: "star" })).toBeNull();
  });
});

describe("catalogueSearchMatch — search across name/abbr/aliases/description", () => {
  const item: CatalogueEntryLike = {
    category: "rarity",
    value: "special_illustration_rare",
    label: "Special Illustration Rare",
    abbreviation: "SAR",
    aliases: ["sir", "gold double"],
    description: "Two gold stars.",
  };
  it("matches on label", () => expect(catalogueSearchMatch(item, "illustration")).toBe(true));
  it("matches on abbreviation (case-insensitive)", () => expect(catalogueSearchMatch(item, "sar")).toBe(true));
  it("matches on alias", () => expect(catalogueSearchMatch(item, "gold double")).toBe(true));
  it("matches on description", () => expect(catalogueSearchMatch(item, "two gold")).toBe(true));
  it("empty query matches everything", () => expect(catalogueSearchMatch(item, "  ")).toBe(true));
  it("non-match returns false", () => expect(catalogueSearchMatch(item, "reverse holo")).toBe(false));
});

describe("parseImportItems — accepts export object or bare array", () => {
  it("accepts { items: [...] }", () => expect(parseImportItems({ items: [{ category: "rarity", value: "x" }] })).toHaveLength(1));
  it("accepts a bare array", () => expect(parseImportItems([{ category: "finish", value: "y" }])).toHaveLength(1));
  it("rejects anything else", () => {
    expect(parseImportItems(null)).toBeNull();
    expect(parseImportItems({ nope: true })).toBeNull();
    expect(parseImportItems("string")).toBeNull();
  });
});

describe("buildSnapshotFromRows — DB rows → canonical picker snapshot", () => {
  const dbRows: CatalogueRowLike[] = [
    {
      category: "rarity",
      value: "special_illustration_rare",
      label: "Special Illustration Rare",
      abbreviation: "SAR",
      aliases: ["sir"],
      description: "Two gold stars.",
      metadata: { symbol: { shape: "stars", count: 2, colour: "gold", glyph: "★★" }, codes: ["SIR", "SAR"], regions: ["western"], eras: ["sv"] },
    },
    { category: "finish", value: "reverse_holo", label: "Reverse Holo", aliases: ["reverse"], metadata: {} },
    { category: "promo", value: "black_star_promo", label: "Black Star Promo", metadata: { kind: "promo" } },
    { category: "subset", value: "trainer_gallery", label: "Trainer Gallery", metadata: { kind: "subset" } },
    { category: "language", value: "ja", label: "Japanese", aliases: ["jp"], metadata: { region: "japan" } },
    { category: "era", value: "sv", label: "Scarlet & Violet", metadata: {} },
  ];
  const snap = buildSnapshotFromRows(dbRows);

  it("maps a rarity with full symbol metadata", () => {
    const r = snap.rarities.find((x) => x.value === "special_illustration_rare")!;
    expect(r.symbol).toEqual({ shape: "stars", count: 2, colour: "gold", glyph: "★★" });
    expect(r.codes).toContain("SAR");
    expect(r.regions).toEqual(["western"]);
    expect(r.eras).toEqual(["sv"]);
  });

  it("maps promo vs subset kind from category", () => {
    expect(snap.promos.find((p) => p.value === "black_star_promo")!.kind).toBe("promo");
    expect(snap.promos.find((p) => p.value === "trainer_gallery")!.kind).toBe("subset");
  });

  it("maps language region", () => {
    expect(snap.languages.find((l) => l.value === "ja")!.region).toBe("japan");
  });

  it("falls back to the seed for an empty category", () => {
    // No designation rows given → not part of snapshot; finishes present → mapped, not seed.
    expect(snap.finishes.some((f) => f.value === "reverse_holo")).toBe(true);
    const empty = buildSnapshotFromRows([]);
    expect(empty.rarities).toBe(SEED_CATALOGUE.rarities);
  });

  it("a deliberately-emptied category yields an EMPTY picker, not the resurrected seed", () => {
    // Category was seeded (rows exist in ANY state) but all active rows are gone
    // → empty, NOT seed. Contrast: a never-seeded category falls back to seed.
    const activeRows: CatalogueRowLike[] = [{ category: "finish", value: "holo", label: "Holo", metadata: {} }];
    const seeded = new Set(["rarity", "finish"]); // rarity seeded but has no active rows now
    const snap2 = buildSnapshotFromRows(activeRows, seeded);
    expect(snap2.rarities).toEqual([]); // deliberately emptied → empty
    expect(snap2.finishes.map((f) => f.value)).toEqual(["holo"]);
    expect(snap2.languages).toBe(SEED_CATALOGUE.languages); // never seeded → seed fallback
  });

  it("gives a founder-added rarity with no symbol a safe default", () => {
    const custom = buildSnapshotFromRows([{ category: "rarity", value: "brand_new", label: "Brand New", abbreviation: "BN" }]);
    const r = custom.rarities[0];
    expect(r.symbol.colour).toBe("white");
    expect(r.symbol.glyph).toBe("BN");
  });
});

describe("picker helpers over a DB snapshot (live pickers, not hard-coded arrays)", () => {
  const snapshot: CatalogueSnapshot = buildSnapshotFromRows([
    { category: "rarity", value: "double_rare", label: "Double Rare", abbreviation: "RR", metadata: { symbol: { shape: "stars", count: 2, colour: "black", glyph: "★★" } } },
    { category: "finish", value: "holo", label: "Holo", aliases: ["foil"], metadata: {} },
    { category: "promo", value: "league_promo", label: "League Promo", metadata: { kind: "promo" } },
    { category: "language", value: "en", label: "English", metadata: { region: "western" } },
    { category: "era", value: "sv", label: "Scarlet & Violet", metadata: {} },
  ]);

  it("resolves values from the passed snapshot, not the seed", () => {
    expect(rarityByValue("double_rare", snapshot)?.label).toBe("Double Rare");
    expect(finishByValue("holo", snapshot)?.label).toBe("Holo");
    expect(promoByValue("league_promo", snapshot)?.kind).toBe("promo");
  });

  it("search runs over the snapshot", () => {
    expect(searchCatalogue("foil", snapshot).finishes.map((f) => f.value)).toContain("holo");
  });

  it("buildStructuredVariant derives the symbol from the snapshot", () => {
    const v = buildStructuredVariant({ language: "en", rarity: "double_rare", finish: "holo" }, snapshot);
    expect(v.printedSymbol).toBe("★★");
    expect(v.symbolColour).toBe("black");
    expect(v.finish).toBe("holo");
  });

  it("still works with the default seed catalogue (backward compatible)", () => {
    expect(rarityByValue("common")?.label).toBe("Common");
  });
});

describe("validateStructuredVariant against a DB catalogue", () => {
  const snap: CatalogueSnapshot = buildSnapshotFromRows([
    { category: "rarity", value: "future_rare", label: "Future Rare", abbreviation: "FR", metadata: { symbol: { shape: "star", count: 1, colour: "gold", glyph: "★" }, regions: "all", eras: "all" } },
    { category: "finish", value: "holo", label: "Holo", metadata: {} },
    { category: "promo", value: "event_promo", label: "Event Promo", metadata: { kind: "promo" } },
    { category: "subset", value: "shiny_vault", label: "Shiny Vault", metadata: { kind: "subset" } },
    { category: "language", value: "en", label: "English", metadata: { region: "western" } },
    { category: "era", value: "sv", label: "Scarlet & Violet", metadata: {} },
  ]);

  it("accepts a brand-new DB rarity and derives its symbol (single source of truth)", () => {
    const res = validateStructuredVariant({ rarityCode: "future_rare", language: "en" }, snap);
    expect(res.ok).toBe(true);
    expect(res.columns.printedSymbolColour).toBe("gold");
    expect(res.columns.rarityLabel).toBe("Future Rare");
  });

  it("rejects a rarity that is NOT in the catalogue", () => {
    const res = validateStructuredVariant({ rarityCode: "does_not_exist" }, snap);
    expect(res.ok).toBe(false);
    expect(res.errors.join(" ")).toMatch(/Unknown rarity/);
  });

  it("rejects a subset value used as a promo", () => {
    const res = validateStructuredVariant({ promoType: "shiny_vault" }, snap);
    expect(res.ok).toBe(false);
    expect(res.errors.join(" ")).toMatch(/is a subset, not a promo/);
  });
});

describe("buildPreviewFields — certificate preview builder", () => {
  it("uses a non-empty placeholder cert id and default grade type", () => {
    const f = buildPreviewFields({});
    expect(f.certId).toBe("MV-PREVIEW");
    expect(f.gradeType).toBe("numeric");
  });

  it("coerces grade overall to a number and passes display fields through", () => {
    const f = buildPreviewFields({ gradeOverall: "9", cardName: "Charizard", setName: "Base", rarity: "rare" });
    expect(f.gradeOverall).toBe(9);
    expect(f.cardName).toBe("Charizard");
    expect(f.rarity).toBe("rare");
  });

  it("passes optional grading fields + defects only when present", () => {
    const f = buildPreviewFields({ gradeCentering: "9.5", defects: [{ mvgsCode: "x" }] });
    expect(f.gradeCentering).toBe(9.5);
    expect(Array.isArray(f.defects)).toBe(true);
    const g = buildPreviewFields({});
    expect("gradeCentering" in g).toBe(false);
    expect("defects" in g).toBe(false);
  });

  it("truncates over-long strings", () => {
    const f = buildPreviewFields({ cardName: "x".repeat(500) });
    expect((f.cardName as string).length).toBe(200);
  });

  it("collapses whitespace runs (neutralises the label-renderer polynomial ReDoS)", () => {
    const f = buildPreviewFields({ setName: "Base" + " ".repeat(5000) + "Black Star Promo" });
    // No long run of spaces survives to reach the protected renderer's regex.
    expect(f.setName).not.toMatch(/ {2,}/);
    expect((f.setName as string).length).toBeLessThanOrEqual(200);
  });
});

describe("canReadCatalogue — role permission (read gate)", () => {
  it("allows admin and grader/staff", () => {
    expect(canReadCatalogue({ isAdmin: true })).toBe(true);
    expect(canReadCatalogue({ isGrader: true })).toBe(true);
  });
  it("denies anonymous / empty sessions", () => {
    expect(canReadCatalogue(undefined)).toBe(false);
    expect(canReadCatalogue(null)).toBe(false);
    expect(canReadCatalogue({})).toBe(false);
  });
});

describe("designation + attribute categories reach the pickers (consolidation 2026-07-26)", () => {
  it("designation rows map to chips, with abbreviation as the PERSISTED code", () => {
    const snap = buildSnapshotFromRows(
      [
        { category: "designation", value: "first_edition", label: "1st Edition", abbreviation: "FIRST_EDITION", description: "WOTC 1st Ed." },
      ],
      new Set(["designation"]),
    );
    expect(snap.designations).toEqual([
      { code: "FIRST_EDITION", label: "1st Edition", help: "WOTC 1st Ed." },
    ]);
  });

  it("falls back to `value` only when no abbreviation is set", () => {
    const snap = buildSnapshotFromRows(
      [{ category: "designation", value: "custom_thing", label: "Custom Thing" }],
      new Set(["designation"]),
    );
    expect(snap.designations[0].code).toBe("custom_thing");
  });

  it("an unseeded designation category falls back to the seed list (never empty)", () => {
    const snap = buildSnapshotFromRows([], new Set([]));
    expect(snap.designations.length).toBeGreaterThan(0);
    expect(snap.designations.map((d) => d.code)).toContain("FIRST_EDITION");
  });

  it("attributes are NEVER seed-filled — an unseeded catalogue yields an empty list", () => {
    expect(buildSnapshotFromRows([], new Set([])).attributes).toEqual([]);
    const snap = buildSnapshotFromRows(
      [{ category: "attribute", value: "signed", label: "Signed", abbreviation: "SIGNED" }],
      new Set(["attribute"]),
    );
    expect(snap.attributes).toEqual([{ code: "SIGNED", label: "Signed", help: "" }]);
  });

  it("REGRESSION: every seeded designation code matches a historical hard-coded code, so no stored value is orphaned", () => {
    // The seeder is the thing that populates the DB; if its codes drift from the
    // codes already persisted on certificates, existing designations silently
    // stop matching any chip. Assert the overlap explicitly.
    // The seeder module reaches the DB at import time, so assert on its SOURCE
    // (the repo's established pattern for scripts that cannot be imported pure).
    const seeder = readFileSync(join(process.cwd(), "scripts/db/seed-catalogue.ts"), "utf8");
    const block = seeder.slice(seeder.indexOf("const designations:"), seeder.indexOf("designations.forEach"));
    expect(block.length).toBeGreaterThan(0);
    const seederCodes = [...block.matchAll(/code:\s*"([A-Z_]+)"/g)].map((m) => m[1]);
    expect(seederCodes.length).toBeGreaterThan(0);
    // Every historical code the app has ever stored must still be seedable.
    for (const legacy of POKEMON_DESIGNATIONS.map((d) => d.code)) {
      expect(seederCodes, `historical designation "${legacy}" missing from the seeder`).toContain(legacy);
    }
    // And the mapper must read abbreviation first, else these codes never apply.
    const snapshotSrc = readFileSync(join(process.cwd(), "shared/catalogue-snapshot.ts"), "utf8");
    expect(snapshotSrc).toContain("row.abbreviation && row.abbreviation.trim()) || row.value");
  });
});

describe("persisted-code uniqueness at the service/validation layer (hostile-review MEDIUM)", () => {
  const row = (o: Partial<CatalogueEntryLike> & { id: number; category: string; value: string }) =>
    ({ label: o.value, ...o }) as CatalogueEntryLike;

  it("effectiveCatalogueCode is `abbreviation || value`, trimmed and case-folded", () => {
    expect(effectiveCatalogueCode({ value: "first_edition", abbreviation: "FIRST_EDITION" })).toBe("first_edition");
    expect(effectiveCatalogueCode({ value: "custom_thing", abbreviation: null })).toBe("custom_thing");
    expect(effectiveCatalogueCode({ value: "x", abbreviation: "  " })).toBe("x");
    expect(effectiveCatalogueCode({ value: " Spaced ", abbreviation: null })).toBe("spaced");
  });

  it("REJECTS a candidate whose VALUE collides with an existing row's ABBREVIATION", () => {
    // Existing row persists "PROMO" via its abbreviation; the candidate would
    // persist "PROMO" via its value. Different `value`s, so 0019's
    // (category,value) index cannot see this — the effective-code rule must.
    const existing = [row({ id: 1, category: "designation", value: "promotional", abbreviation: "PROMO" })];
    const msg = catalogueConflict(existing, row({ id: 0, category: "designation", value: "PROMO" }));
    expect(msg).toMatch(/unique stored code/i);
  });

  it("REJECTS a candidate whose ABBREVIATION collides with an existing row's VALUE", () => {
    const existing = [row({ id: 1, category: "designation", value: "promo" })];
    const msg = catalogueConflict(
      existing,
      row({ id: 0, category: "designation", value: "promotional", abbreviation: "PROMO" }),
    );
    expect(msg).toMatch(/unique stored code/i);
  });

  it("ALLOWS the same persisted code in a DIFFERENT category", () => {
    // The one-classification rule is SYMMETRIC: both sides must opt in.
    const existing = [
      row({ id: 1, category: "finish", value: "unlimited", abbreviation: "UNLIMITED", allowCrossCategory: true }),
    ];
    const msg = catalogueConflict(
      existing,
      row({ id: 0, category: "designation", value: "unlimited", abbreviation: "UNLIMITED", allowCrossCategory: true }),
    );
    expect(msg).toBeNull();
  });

  it("does not flag a row against ITSELF when editing", () => {
    const existing = [row({ id: 7, category: "designation", value: "promo", abbreviation: "PROMO" })];
    const msg = catalogueConflict(
      existing,
      row({ id: 7, category: "designation", value: "promo", abbreviation: "PROMO", label: "Promo (renamed)" }),
      7,
    );
    expect(msg).toBeNull();
  });

  it("the shipped seeder produces NO duplicate persisted codes within a category", () => {
    const seeder = readFileSync(join(process.cwd(), "scripts/db/seed-catalogue.ts"), "utf8");
    const block = seeder.slice(seeder.indexOf("const designations:"), seeder.indexOf("designations.forEach"));
    const codes = [...block.matchAll(/code:\s*"([A-Z_]+)"/g)].map((m) => m[1].toLowerCase());
    const values = [...block.matchAll(/value:\s*"([a-z_]+)"/g)].map((m) => m[1].toLowerCase());
    // Every designation carries an explicit code, and all effective codes are unique.
    expect(codes.length).toBe(values.length);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("CLEANUP: no test-only designation is present in production seed output", () => {
    const seeder = readFileSync(join(process.cwd(), "scripts/db/seed-catalogue.ts"), "utf8");
    const block = seeder.slice(seeder.indexOf("const designations:"), seeder.indexOf("designations.forEach"));
    expect(block).not.toMatch(/TEST_PRINT|test_print/);
    // And the seed fallback the pickers use offline carries none either.
    expect(POKEMON_DESIGNATIONS.map((d) => d.code)).not.toContain("TEST_PRINT");
  });
});

describe("M-2: archived catalogue-code policy (validator agrees with migration 0026)", () => {
  const row = (o: Partial<CatalogueEntryLike> & { id: number; category: string; value: string }) =>
    ({ label: o.value, ...o }) as CatalogueEntryLike;

  it("isLiveCatalogueRow treats absent flags as LIVE (matches the column defaults)", () => {
    expect(isLiveCatalogueRow({})).toBe(true);
    expect(isLiveCatalogueRow({ active: true, archived: false })).toBe(true);
    expect(isLiveCatalogueRow({ active: false })).toBe(false);
    expect(isLiveCatalogueRow({ archived: true })).toBe(false);
  });

  it("an ARCHIVED row does NOT block a new live entry reusing its code", () => {
    const existing = [row({ id: 1, category: "designation", value: "old", abbreviation: "PROMO", archived: true })];
    expect(catalogueConflict(existing, row({ id: 0, category: "designation", value: "promo", abbreviation: "PROMO" }))).toBeNull();
  });

  it("an INACTIVE row does NOT block a new live entry reusing its code", () => {
    const existing = [row({ id: 1, category: "designation", value: "old", abbreviation: "PROMO", active: false })];
    expect(catalogueConflict(existing, row({ id: 0, category: "designation", value: "promo", abbreviation: "PROMO" }))).toBeNull();
  });

  it("REACTIVATING an archived duplicate fails with a clear, actionable message", () => {
    const existing = [
      row({ id: 1, category: "designation", value: "retired", abbreviation: "PROMO", archived: true }),
      row({ id: 2, category: "designation", value: "live_one", abbreviation: "PROMO" }),
    ];
    // Restore row 1 → it would become a second LIVE row with code PROMO.
    const msg = catalogueConflict(existing, row({ id: 1, category: "designation", value: "retired", abbreviation: "PROMO", archived: false }), 1);
    expect(msg).toMatch(/Cannot make .* live/i);
    expect(msg).toMatch(/Retire or rename/i);
  });

  it("ARCHIVING a row is always allowed, even when its code duplicates a live one", () => {
    const existing = [row({ id: 2, category: "designation", value: "live_one", abbreviation: "PROMO" })];
    const msg = catalogueConflict(existing, row({ id: 1, category: "designation", value: "retired", abbreviation: "PROMO", archived: true }), 1);
    expect(msg).toBeNull(); // a non-live candidate is exempt
  });

  it("historical rows are never rewritten — the policy only gates what may be LIVE", () => {
    const archived = row({ id: 1, category: "designation", value: "old", abbreviation: "PROMO", archived: true });
    // Editing an archived row's label is unaffected by the live code being taken.
    const existing = [archived, row({ id: 2, category: "designation", value: "promo", abbreviation: "PROMO" })];
    expect(catalogueConflict(existing, { ...archived, label: "Old Promo (retired)" }, 1)).toBeNull();
  });
});

describe("M-3: designation and attribute share ONE persisted-code namespace", () => {
  const row = (o: Partial<CatalogueEntryLike> & { id: number; category: string; value: string }) =>
    ({ label: o.value, ...o }) as CatalogueEntryLike;

  it("codeNamespaceFor groups designation+attribute and isolates everything else", () => {
    expect([...codeNamespaceFor("designation")].sort()).toEqual(["attribute", "designation"]);
    expect([...codeNamespaceFor("attribute")].sort()).toEqual(["attribute", "designation"]);
    expect(codeNamespaceFor("finish")).toEqual(["finish"]);
    expect(codeNamespaceFor("rarity")).toEqual(["rarity"]);
  });

  it("designation PROMO + attribute PROMO cannot BOTH be live", () => {
    const existing = [row({ id: 1, category: "designation", value: "promo", abbreviation: "PROMO" })];
    const msg = catalogueConflict(existing, row({ id: 0, category: "attribute", value: "promo_attr", abbreviation: "PROMO" }));
    expect(msg).toMatch(/designations/i); // explains WHY they share a namespace
    expect(msg).toMatch(/PROMO/);
  });

  it("different codes across designation/attribute are allowed", () => {
    const existing = [row({ id: 1, category: "designation", value: "promo", abbreviation: "PROMO" })];
    expect(catalogueConflict(existing, row({ id: 0, category: "attribute", value: "signed", abbreviation: "SIGNED" }))).toBeNull();
  });

  it("the shared namespace does not bleed into unrelated categories", () => {
    const existing = [row({ id: 1, category: "designation", value: "holo_d", abbreviation: "HOLO" })];
    // `finish` is its own namespace — the same code is fine there.
    expect(catalogueConflict(existing, row({ id: 0, category: "finish", value: "holo_f", abbreviation: "HOLO" }))).toBeNull();
  });

  it("an ARCHIVED cross-category row follows the same archived policy", () => {
    const existing = [row({ id: 1, category: "attribute", value: "old", abbreviation: "PROMO", archived: true })];
    expect(catalogueConflict(existing, row({ id: 0, category: "designation", value: "promo", abbreviation: "PROMO" }))).toBeNull();
  });

  it("existing stored certificate codes still resolve after the namespace rule", () => {
    // The rule constrains what may be CREATED; it never rewrites stored values.
    const snap = buildSnapshotFromRows(
      [
        { category: "designation", value: "first_edition", label: "1st Edition", abbreviation: "FIRST_EDITION" },
        { category: "attribute", value: "signed", label: "Signed", abbreviation: "SIGNED" },
      ],
      new Set(["designation", "attribute"]),
    );
    expect(snap.designations.map((d) => d.code)).toContain("FIRST_EDITION");
    expect(snap.attributes.map((a) => a.code)).toContain("SIGNED");
  });
});

describe("low-risk fix 3: persisted-code character validation", () => {
  const row = (o: Partial<CatalogueEntryLike> & { id: number; category: string; value: string }) =>
    ({ label: o.value, ...o }) as CatalogueEntryLike;

  it("accepts ordinary codes", () => {
    for (const v of ["promo", "FIRST_EDITION", "rare-holo", "1SS", "a"]) {
      expect(invalidCatalogueCode("value", v), v).toBeNull();
    }
  });

  it("rejects codes that would be ambiguous or unsafe to persist", () => {
    for (const v of ["has space", "semi;colon", "quote\"d", "sla/sh", "-leading", "emoji🎴"]) {
      expect(invalidCatalogueCode("value", v), v).toMatch(/not a valid persisted code/i);
    }
  });

  it("does NOT restrict human-readable labels or descriptions", () => {
    const existing: CatalogueEntryLike[] = [];
    const candidate = row({
      id: 0,
      category: "designation",
      value: "tournament_stamp",
      abbreviation: "TOURNAMENT_STAMP",
      label: "Tournament / Event Stamp (2005–2010) — “stamped”",
      description: "Any punctuation, accents & spaces are fine here.",
    });
    expect(catalogueConflict(existing, candidate)).toBeNull();
  });

  it("an empty abbreviation is legitimate (the value becomes the code)", () => {
    expect(invalidCatalogueCode("abbreviation", "")).toBeNull();
    expect(invalidCatalogueCode("abbreviation", null)).toBeNull();
  });

  it("rejects an over-long persisted code", () => {
    expect(invalidCatalogueCode("value", "a".repeat(65))).toMatch(/too long/i);
  });
});
