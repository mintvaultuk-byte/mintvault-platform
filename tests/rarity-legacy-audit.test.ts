/**
 * Read-only legacy variant audit — pure tests (no DB, no network).
 * Covers clear vs ambiguous classification, confidence tiers, label/code
 * resilience, the "never auto-applied" guarantee, and static proof that the
 * audit path performs NO database writes.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  classifyLegacyValue,
  buildAuditRows,
  buildReviewQueueRows,
  summariseAudit,
  confidenceFor,
} from "@shared/rarity-legacy-audit";
import { mapLegacyVariant } from "@shared/pokemon-rarity-catalogue";
import { VARIANT_OPTIONS } from "@/lib/variantOptions";

describe("clear legacy mappings (map cleanly, no review)", () => {
  const cases: Array<[string, "rarity" | "finish" | "promo" | "subset", string]> = [
    ["REVERSE_HOLO", "finish", "reverse_holo"],
    ["TRAINER_GALLERY", "subset", "trainer_gallery"],
    ["DOUBLE_RARE", "rarity", "double_rare"],
    ["BLACK_STAR_PROMO", "promo", "black_star_promo"],
  ];
  it.each(cases)("%s -> %s (%s), high confidence, no review", (raw, classification, value) => {
    const row = classifyLegacyValue(raw);
    expect(row.classification).toBe(classification);
    expect(row.proposedValue).toBe(value);
    expect(row.confidence).toBe("high");
    expect(row.reviewRequired).toBe(false);
  });
});

describe("ambiguous legacy values (must remain review-required)", () => {
  it.each(["FULL_ART", "ALT_ART", "RAINBOW", "GOLD", "EX", "OTHER", "SOME_CUSTOM_XYZ"])(
    "%s is flagged for review with no proposed value",
    (raw) => {
      const row = classifyLegacyValue(raw);
      expect(row.reviewRequired).toBe(true);
      expect(row.proposedValue).toBeNull();
      expect(row.confidence).toBe("low");
      expect(row.reason).toBeTruthy();
    },
  );
});

describe("storage-form resilience (code form AND label form)", () => {
  it.each([
    ["Reverse Holo", "finish", "reverse_holo"],
    ["None / Regular", "finish", "non_holo"],
    ["1st Edition", "finish", "first_edition"],
    ["Special Illustration Rare", "rarity", "special_illustration_rare"],
  ])("label %s classifies like its code", (raw, classification, value) => {
    const row = classifyLegacyValue(raw);
    expect(row.classification).toBe(classification);
    expect(row.proposedValue).toBe(value);
  });
});

describe("confidence tiers", () => {
  it("clear=high, best-guess-with-value=medium, none=low", () => {
    expect(confidenceFor(mapLegacyVariant("REVERSE_HOLO"))).toBe("high");
    // PROMO maps to a best-guess value (other_promo) but is flagged ambiguous.
    expect(confidenceFor(mapLegacyVariant("PROMO"))).toBe("medium");
    expect(classifyLegacyValue("PROMO").reviewRequired).toBe(true);
    expect(confidenceFor(mapLegacyVariant("FULL_ART"))).toBe("low");
  });
});

describe("buildAuditRows", () => {
  it("sorts by record count desc, drops empty values", () => {
    const rows = buildAuditRows([
      { value: "REVERSE_HOLO", count: 3 },
      { value: "", count: 99 },
      { value: "FULL_ART", count: 10 },
      { value: "DOUBLE_RARE", count: 1 },
    ]);
    expect(rows.map((r) => r.legacyValue)).toEqual(["FULL_ART", "REVERSE_HOLO", "DOUBLE_RARE"]);
    expect(rows[0].recordCount).toBe(10);
  });
});

describe("review-queue rows are proposals only (nothing auto-applied)", () => {
  it("every review row is status='pending' and carries its review flag", () => {
    const rows = buildAuditRows([
      { value: "REVERSE_HOLO", count: 2 },
      { value: "FULL_ART", count: 5 },
    ]);
    const review = buildReviewQueueRows(rows);
    expect(review.every((r) => r.status === "pending")).toBe(true);
    expect(review.find((r) => r.legacyValue === "FULL_ART")?.reviewRequired).toBe(true);
    expect(review.find((r) => r.legacyValue === "REVERSE_HOLO")?.reviewRequired).toBe(false);
  });
});

describe("every known VARIANT_OPTIONS code classifies without throwing", () => {
  it("no duplicate legacy codes, and each maps to a defined classification", () => {
    const codes = VARIANT_OPTIONS.map((v) => v.code);
    expect(new Set(codes).size).toBe(codes.length); // no duplicate canonical legacy codes
    const rows = buildAuditRows(codes.map((c) => ({ value: c, count: 0 })));
    expect(rows.length).toBe(codes.length);
    for (const r of rows) {
      expect(["rarity", "finish", "promo", "subset", "ambiguous"]).toContain(r.classification);
    }
    const summary = summariseAudit(rows);
    // Sanity: some high-confidence and some review-required exist in the space.
    expect(summary.high).toBeGreaterThan(0);
    expect(summary.reviewRequired).toBeGreaterThan(0);
    expect(summary.high + summary.medium + summary.low).toBe(codes.length);
  });
});

describe("the audit path performs NO database writes (static guard)", () => {
  it("the pure module never imports a DB driver", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "shared/rarity-legacy-audit.ts"), "utf8");
    expect(src).not.toMatch(/from ["']pg["']/);
    expect(src).not.toMatch(/server\/db/);
  });
  it("the runner script issues only a SELECT — no write SQL", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "scripts/rarity-legacy-audit.ts"), "utf8");
    // No mutation verbs in SQL position anywhere in the runner.
    expect(src).not.toMatch(/\b(INSERT INTO|UPDATE\s+\w|DELETE FROM|DROP\s+(TABLE|COLUMN|INDEX)|ALTER TABLE|TRUNCATE)\b/i);
    expect(src).toMatch(/SELECT variant AS value/);
  });
});
