import { describe, it, expect } from "vitest";
import {
  deriveVariantFromIdentification,
  mapVariantTextToCode,
  splitSetDesignation,
} from "../shared/variant-derive";

describe("mapVariantTextToCode", () => {
  it("maps known finish text case-insensitively", () => {
    expect(mapVariantTextToCode("Full Art")).toBe("FULL_ART");
    expect(mapVariantTextToCode("reverse holo")).toBe("REVERSE_HOLO");
    expect(mapVariantTextToCode("  HOLO  ")).toBe("HOLO");
  });

  it("returns empty for empty input and OTHER for unknown text", () => {
    expect(mapVariantTextToCode("")).toBe("");
    expect(mapVariantTextToCode("Holo Rare")).toBe("OTHER");
  });
});

describe("deriveVariantFromIdentification", () => {
  it("prefers a clean card_type match", () => {
    expect(deriveVariantFromIdentification({ card_type: "Secret Rare", is_holo: true })).toBe("SECRET_RARE");
  });

  it("falls back to finish booleans in priority order", () => {
    expect(deriveVariantFromIdentification({ card_type: "Holo Rare", is_reverse_holo: true })).toBe("REVERSE_HOLO");
    expect(deriveVariantFromIdentification({ is_full_art: true, is_holo: true })).toBe("FULL_ART");
    expect(deriveVariantFromIdentification({ is_textured: true })).toBe("TEXTURED");
    expect(deriveVariantFromIdentification({ is_holo: true })).toBe("HOLO");
    expect(deriveVariantFromIdentification({ is_foil: true })).toBe("HOLO");
  });

  it("returns empty when no usable signal", () => {
    expect(deriveVariantFromIdentification({})).toBe("");
    expect(deriveVariantFromIdentification(null)).toBe("");
    expect(deriveVariantFromIdentification({ card_type: "Holo Rare" })).toBe("");
  });
});

describe("splitSetDesignation", () => {
  it("splits Trainer Gallery (space and dash separated)", () => {
    expect(splitSetDesignation("Brilliant Stars Trainer Gallery")).toEqual({
      baseSet: "Brilliant Stars",
      designation: "TRAINER_GALLERY",
    });
    expect(splitSetDesignation("lost origin - trainer gallery")).toEqual({
      baseSet: "lost origin",
      designation: "TRAINER_GALLERY",
    });
    expect(splitSetDesignation("silver tempest – trainer gallery")).toEqual({
      baseSet: "silver tempest",
      designation: "TRAINER_GALLERY",
    });
  });

  it("splits Galarian Gallery", () => {
    expect(splitSetDesignation("crown zenith - galarian gallery")).toEqual({
      baseSet: "crown zenith",
      designation: "GALARIAN_GALLERY",
    });
    expect(splitSetDesignation("Crown Zenith Galarian Gallery")).toEqual({
      baseSet: "Crown Zenith",
      designation: "GALARIAN_GALLERY",
    });
  });

  it("splits Black Star Promos (plural and singular) as PROMO", () => {
    expect(splitSetDesignation("Scarlet & Violet Black Star Promos")).toEqual({
      baseSet: "Scarlet & Violet",
      designation: "PROMO",
    });
    expect(splitSetDesignation("XY Black Star Promo")).toEqual({
      baseSet: "XY",
      designation: "PROMO",
    });
  });

  it("expands a bare abbreviation left behind by the split", () => {
    expect(splitSetDesignation("SWSH Black Star Promos")).toEqual({
      baseSet: "Sword & Shield",
      designation: "PROMO",
    });
    expect(splitSetDesignation("SM Black Star Promos")).toEqual({
      baseSet: "Sun & Moon",
      designation: "PROMO",
    });
  });

  it("leaves ordinary set names untouched", () => {
    expect(splitSetDesignation("Surging Sparks")).toEqual({ baseSet: "Surging Sparks", designation: null });
    expect(splitSetDesignation("Pokémon GO")).toEqual({ baseSet: "Pokémon GO", designation: null });
    // "Gallery" alone must not match — only the full designation phrase does.
    expect(splitSetDesignation("Art Gallery")).toEqual({ baseSet: "Art Gallery", designation: null });
  });

  it("keeps the full name when stripping would leave nothing", () => {
    expect(splitSetDesignation("Black Star Promos")).toEqual({
      baseSet: "Black Star Promos",
      designation: "PROMO",
    });
  });

  it("handles null/undefined/empty", () => {
    expect(splitSetDesignation(null)).toEqual({ baseSet: "", designation: null });
    expect(splitSetDesignation(undefined)).toEqual({ baseSet: "", designation: null });
    expect(splitSetDesignation("   ")).toEqual({ baseSet: "", designation: null });
  });
});

describe("splitSetDesignation word boundaries", () => {
  it("never splits mid-word", () => {
    expect(splitSetDesignation("Retrainer Gallery")).toEqual({ baseSet: "Retrainer Gallery", designation: null });
    expect(splitSetDesignation("Strainer Gallery")).toEqual({ baseSet: "Strainer Gallery", designation: null });
  });

  it("strips a unicode-minus separator", () => {
    expect(splitSetDesignation("Crown Zenith − Galarian Gallery")).toEqual({
      baseSet: "Crown Zenith",
      designation: "GALARIAN_GALLERY",
    });
  });
});
