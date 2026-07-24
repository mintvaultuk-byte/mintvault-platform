/**
 * Server apply-layer: applyStructuredVariantFromBody + stale-tab guard coverage +
 * static proof that the structured save path never writes a certificate's legacy
 * columns or performs a backfill. Pure (no DB, no network).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { applyStructuredVariantFromBody } from "../server/lib/structured-variant";
import { CONFLICT_GUARDED_FIELDS } from "@shared/edit-conflict";
import { STRUCTURED_VARIANT_VERSION } from "@shared/structured-variant-validate";

describe("applyStructuredVariantFromBody — opt-in by key presence (test 28-30)", () => {
  it("does nothing when the request carries no structured keys (partial PUT can't erase)", () => {
    const data: Record<string, unknown> = { variant: "REVERSE_HOLO", rarity: null, gradeOverall: "9.5" };
    const result = applyStructuredVariantFromBody({ gradeOverall: "9.5" }, data);
    expect(result.applied).toBe(false);
    expect(data).toEqual({ variant: "REVERSE_HOLO", rarity: null, gradeOverall: "9.5" }); // untouched
  });

  it("merges derived columns when structured keys are present, leaving legacy variant/rarity intact", () => {
    const data: Record<string, unknown> = { variant: "REVERSE_HOLO", rarity: null };
    const result = applyStructuredVariantFromBody(
      { rarityCode: "special_illustration_rare", finishVariant: "holo", language: "English", era: "sv" },
      data,
    );
    expect(result.ok).toBe(true);
    expect(result.applied).toBe(true);
    expect(data.rarityCode).toBe("special_illustration_rare");
    expect(data.printedSymbolColour).toBe("gold");
    expect(data.printedSymbolCount).toBe(2);
    expect(data.region).toBe("western");
    expect(data.structuredVariantVersion).toBe(STRUCTURED_VARIANT_VERSION);
    // Legacy columns are never touched by the structured apply.
    expect(data.variant).toBe("REVERSE_HOLO");
    expect(data.rarity).toBeNull();
  });

  it("clearing (structured keys present but empty) writes nulls, still leaving legacy intact", () => {
    const data: Record<string, unknown> = { variant: "REVERSE_HOLO" };
    const result = applyStructuredVariantFromBody(
      { rarityCode: "", finishVariant: "", promoType: "", subsetName: "", era: "" },
      data,
    );
    expect(result.applied).toBe(true);
    expect(data.rarityCode).toBeNull();
    expect(data.structuredVariantVersion).toBeNull();
    expect(data.variant).toBe("REVERSE_HOLO");
  });

  it("rejects an invalid catalogue value without mutating data (server is authoritative)", () => {
    const data: Record<string, unknown> = { variant: "HOLO" };
    const result = applyStructuredVariantFromBody({ rarityCode: "totally_made_up" }, data);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(data.rarityCode).toBeUndefined(); // not merged on error
    expect(data.variant).toBe("HOLO");
  });
});

describe("stale-tab guard extends to the structured fields", () => {
  it("CONFLICT_GUARDED_FIELDS includes the new structured columns", () => {
    for (const f of ["rarityCode", "finishVariant", "promoType", "subsetName", "era"]) {
      expect(CONFLICT_GUARDED_FIELDS).toContain(f);
    }
  });
  it("still guards the legacy fields it always did", () => {
    for (const f of ["variant", "rarity", "language"]) {
      expect(CONFLICT_GUARDED_FIELDS).toContain(f);
    }
  });
});

describe("the structured save path never writes a certificate or backfills (tests 14,30)", () => {
  const read = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), "utf8");
  it("the apply helper and mapping store contain no certificate write SQL", () => {
    for (const file of ["server/lib/structured-variant.ts", "server/lib/rarity-mapping-store.ts"]) {
      const src = read(file);
      expect(src, `${file} must not update certificates`).not.toMatch(/update\(\s*certificates\s*\)/i);
      expect(src, `${file} must not insert certificates`).not.toMatch(/insert\(\s*certificates\s*\)/i);
      expect(src).not.toMatch(/UPDATE\s+certificates|DELETE\s+FROM\s+certificates/i);
    }
  });
  it("the decision route writes only the review table + audit, never a cert", () => {
    const src = read("server/routes/rarity-mapping.ts");
    expect(src).not.toMatch(/update\(\s*certificates\s*\)|insert\(\s*certificates\s*\)/i);
    expect(src).toMatch(/upsertRarityMappingReviewDecision/);
  });
});
