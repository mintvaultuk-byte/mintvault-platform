/**
 * Grading-workflow compaction: AI Card Identification removed from the daily UI +
 * compact rarity/finish/promo picker. Source-assertion tests (the admin grading
 * form is auth-gated, so we assert on the committed source the way the repo tests
 * other admin UI). Zero provider calls, zero credits.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const FORM = read("client/src/components/certificate-form.tsx");
const LEARNING = read("client/src/pages/admin-learning.tsx");
const PICKER = read("client/src/components/rarity-picker/RarityVariantPicker.tsx");
const FLAGS = read("server/config/feature-flags.ts");

describe("AI Card Identification removed from the daily grading UI", () => {
  it("the grading form no longer imports or renders the AI panel", () => {
    expect(FORM).not.toContain("CardIdentifyPanel");
    expect(FORM).not.toContain("card-identification/CardIdentifyPanel");
    expect(FORM).not.toMatch(/AI Card Identification \(optional\)/);
  });
  it("the AI Learning page hides the AI_CARD_IDENTIFICATION toggle", () => {
    expect(LEARNING).toContain('f.name !== "AI_CARD_IDENTIFICATION_ENABLED"');
  });
  it("the feature flag stays default OFF (opt-in only)", () => {
    expect(FLAGS).toMatch(/AI_CARD_IDENTIFICATION_ENABLED:\s*process\.env\.AI_CARD_IDENTIFICATION_ENABLED === "true"/);
  });
  it("manual TCGdex lookup + Knowledge Hub link remain in the form", () => {
    expect(FORM.toLowerCase()).toMatch(/tcgdex|identify|lookup/);
    expect(FORM).toContain("/admin/pokemon-knowledge"); // Knowledge Hub link kept
  });
  it("the picker component itself is untouched by removal (still imported)", () => {
    expect(FORM).toContain("RarityVariantPicker");
  });
});

describe("compact rarity picker (Phase 5/8/9)", () => {
  it("rarity tiles use compact chip dimensions (not oversized cards)", () => {
    // v5 hotfix: tiles got even more compact (28px min-height, dense
    // auto-fill grid) after the v4 fixed min/max width regressed to feeling
    // oversized again on a 13" viewport.
    expect(PICKER).toContain("min-h-[28px]");
    expect(PICKER).toContain("RARITY_TILE_GRID");
    expect(PICKER).not.toContain("min-w-[140px] flex-col"); // old tall card layout gone
    expect(PICKER).not.toContain("min-h-[40px]"); // v4 oversized tile gone
  });
  it("descriptions are NOT on every tile — moved to tooltip + a selected-info line", () => {
    expect(PICKER).toContain('data-testid="rarity-selected-info"');
    // The per-tile description span was removed from the chip body.
    expect(PICKER).not.toContain('className="text-[10px] leading-tight text-slate-400">{rr.description}');
  });
  it("plain-language section labels", () => {
    expect(PICKER).toContain("Choose the symbol printed on the card");
    expect(PICKER).toContain("Choose the finish");
    expect(PICKER).toContain("Does the card have a promo or gallery mark?");
  });
  it("Show all options + More rarities remain (manual choices never permanently hidden)", () => {
    expect(PICKER).toContain("Show all options");
    expect(PICKER).toContain("More rarities");
    expect(PICKER).toContain('data-testid="rarity-show-all"');
  });
  it("gold/silver/black + star-count distinction is preserved (symbol renderer unchanged)", () => {
    const SYMBOL = read("client/src/components/rarity-picker/RaritySymbol.tsx");
    expect(SYMBOL).toContain("symbol.colour"); // fill still driven by stored colour, not text
    expect(SYMBOL).toContain("describeSymbol"); // accessible label retained
    expect(PICKER).toContain("aria-label={aria}"); // per-tile accessible label kept
  });
});
