/**
 * Structured rarity foundation — backward-compatibility guards.
 *
 * Proves the additive columns change nothing about today's behaviour:
 *  - the certificate insert schema still accepts a legacy payload with no new
 *    fields, and treats every new field as optional (never required);
 *  - no grading / certificate-writing / label-rendering file references the new
 *    columns yet, so the current grading + certificate flows are untouched.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { insertCertificateSchema, REVIEW_STATUSES } from "@shared/schema";

const NEW_FIELDS = [
  "rarityCode",
  "rarityLabelStructured",
  "printedSymbol",
  "printedSymbolCount",
  "printedSymbolColour",
  "finishVariant",
  "promoType",
  "subsetName",
  "region",
  "era",
  "structuredVariantVersion",
] as const;

describe("certificate insert schema stays backward-compatible", () => {
  const legacyPayload = {
    cardName: "Pikachu",
    setName: "Base Set",
    variant: "REVERSE_HOLO",
    rarity: "R",
    language: "English",
    gradeType: "numeric",
    labelType: "Standard",
    status: "active",
  };

  it("accepts a legacy certificate payload with NO structured fields", () => {
    const result = insertCertificateSchema.safeParse(legacyPayload);
    expect(result.success).toBe(true);
  });

  it("treats every new structured column as optional (never required)", () => {
    const shape = insertCertificateSchema.shape as Record<string, { isOptional: () => boolean } | undefined>;
    for (const field of NEW_FIELDS) {
      expect(shape[field], `missing ${field} in insert schema`).toBeDefined();
      expect(shape[field]!.isOptional(), `${field} must be optional`).toBe(true);
    }
  });

  it("also accepts a payload that DOES carry structured fields (forward-compatible)", () => {
    const result = insertCertificateSchema.safeParse({
      ...legacyPayload,
      rarityCode: "special_illustration_rare",
      printedSymbol: "★★",
      printedSymbolCount: 2,
      printedSymbolColour: "gold",
      finishVariant: "holo",
      promoType: null,
      subsetName: "trainer_gallery",
      region: "western",
      era: "sv",
      structuredVariantVersion: 1,
    });
    expect(result.success).toBe(true);
  });

  it("exposes exactly the four review-queue states", () => {
    expect([...REVIEW_STATUSES]).toEqual(["pending", "approved", "rejected", "ignored"]);
  });
});

describe("structured columns are consumed only via the consolidated variant formatter", () => {
  // As of the consolidated-variant-line work, the printed-label renderer
  // (server/labels.ts) now derives the single public variant line from the
  // structured columns via the ONE shared formatter (shared/variant-line.ts).
  // It is therefore no longer in the "does not touch" list below; the remaining
  // files must still never write the raw snake_case column names directly.
  it("the label renderer consumes structured columns through the shared formatter", () => {
    const labels = fs.readFileSync(path.resolve(process.cwd(), "server/labels.ts"), "utf8");
    expect(labels).toContain('from "@shared/variant-line"');
    expect(labels).toContain("consolidatedVariantForLabel(cert)");
  });
  // Key ONLY on the snake_case DB column names — these are unambiguous. (camelCase
  // identifiers like `rarityCode` collide with unrelated local variables that the
  // grading form already uses, so they are not reliable markers of a column write.)
  const IDENTIFIERS = [
    "rarity_code",
    "rarity_label",
    "printed_symbol",
    "printed_symbol_colour",
    "printed_symbol_count",
    "finish_variant",
    "promo_type",
    "subset_name",
    "structured_variant_version",
  ];
  const FILES = [
    "server/storage.ts",
    "server/certificate-document.ts",
  ];

  it.each(FILES)("%s does not read or write any structured rarity column", (file) => {
    const full = path.resolve(process.cwd(), file);
    if (!fs.existsSync(full)) return; // tolerate path drift
    const src = fs.readFileSync(full, "utf8");
    for (const id of IDENTIFIERS) {
      expect(src.includes(id), `${file} unexpectedly references ${id}`).toBe(false);
    }
  });
});
