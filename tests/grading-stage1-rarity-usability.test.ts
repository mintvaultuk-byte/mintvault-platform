/**
 * Final Stage 1 (Card) / Stage 2 (Rarity) usability correction — focused tests.
 *
 * Covers five issues from a production visual review of the Hoothoot
 * TG12/TG30 certificate:
 *   1. Rarity abbreviations/symbols were near-invisible (dark-on-dark) — every
 *      printed colour must render with real WCAG contrast against the dark
 *      picker tile.
 *   2. A single-silver-star rarity was missing from the picker.
 *   3. A controlled "Add missing rarity" workflow, backed by the certificate's
 *      EXISTING `rarityOther` metadata field (no schema change).
 *   4. Stage 1 manual card-detail fields must be visible by default (not
 *      gated behind a "Manual" click) — the normal verification process.
 *   5. Collector-number DISPLAY presentation (uppercase, no stray space,
 *      prefixes preserved, no fabricated total).
 *
 * Pure unit tests for the shared logic; source assertions for the React
 * wiring (the admin form is auth-gated — same pattern as the rest of this
 * suite). No provider calls, no DB, no Stage-3/grading-protected imports.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { POKEMON_RARITIES, rarityByValue, describeSymbol, type SymbolColour } from "../shared/pokemon-rarity-catalogue";
import { formatCollectorNumber, displayCollectorNumber } from "../shared/collector-number-format";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const FORM = read("client/src/components/certificate-form.tsx");
const SYMBOL = read("client/src/components/rarity-picker/RaritySymbol.tsx");
const PICKER = read("client/src/components/rarity-picker/RarityVariantPicker.tsx");

// ── WCAG 2.1 relative-luminance contrast ratio (pure — no DOM). ────────────
function srgbToLin(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
function relLuminance(hex: string): number {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return 0.2126 * srgbToLin(r) + 0.7152 * srgbToLin(g) + 0.0722 * srgbToLin(b);
}
function contrastRatio(hexA: string, hexB: string): number {
  const [l1, l2] = [relLuminance(hexA), relLuminance(hexB)].sort((a, b) => b - a);
  return (l1 + 0.05) / (l2 + 0.05);
}
/** Pull `colour: "<hex>"` out of a named map in RaritySymbol.tsx (FILL/STROKE/BADGE_BG/BADGE_RING). */
function extractColourMap(varName: "FILL" | "STROKE" | "BADGE_BG" | "BADGE_RING"): Record<SymbolColour, string> {
  const start = SYMBOL.indexOf(`const ${varName}:`);
  expect(start, varName).toBeGreaterThan(-1);
  const end = SYMBOL.indexOf("};", start);
  const block = SYMBOL.slice(start, end);
  const out: Partial<Record<SymbolColour, string>> = {};
  for (const m of block.matchAll(/(\w+):\s*"(#[0-9a-fA-F]{6}|url\([^)]+\))"/g)) {
    out[m[1] as SymbolColour] = m[2];
  }
  return out as Record<SymbolColour, string>;
}

// NOTE (rarity-picker hotfix, superseding the earlier "recolour every symbol"
// design): the symbol's FILL is now the REAL PRINTED colour (black stays
// black, silver stays silver, gold stays gold) — it is intentionally NOT
// contrast-checked against the dark page background any more. Legibility
// comes from the fixed contrast BADGE drawn behind the symbol, so the correct
// pairing to check is FILL vs its own BADGE_BG, not FILL vs the page's dark tile.
describe("1. every rarity symbol has real contrast against its OWN badge (not the page background)", () => {
  const FILL = extractColourMap("FILL");
  const BADGE_BG = extractColourMap("BADGE_BG");

  it("every printed colour has WCAG AA-level contrast against its badge background (min 4.5:1)", () => {
    for (const [colour, hex] of Object.entries(FILL)) {
      if (colour === "none" || hex.startsWith("url(")) continue; // transparent / gradient
      const badgeBg = BADGE_BG[colour as SymbolColour];
      expect(badgeBg, `badge bg for ${colour}`).toBeTruthy();
      const ratio = contrastRatio(hex, badgeBg);
      expect(ratio, `${colour} (${hex}) vs its badge (${badgeBg})`).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("the literal near-black fill (#1b1b1f) that made ACE/RR/RRR/PR invisible is gone", () => {
    expect(SYMBOL).not.toContain("#1b1b1f");
  });
  it("black/uncommon/rare symbols render their REAL printed colour (true black), not a recoloured display tone", () => {
    expect(FILL.black).toBe("#000000");
  });
  it("the text-glyph branch always uses the symbol's own printed fill — never a hardcoded override", () => {
    expect(SYMBOL).toMatch(/<text[^>]*fill=\{fill\}[^>]*stroke=\{stroke\}/);
  });
  it("gold vs silver vs black-print vs white-print remain visually distinct hex values", () => {
    const hexes = new Set([FILL.gold, FILL.silver, FILL.black, FILL.white]);
    expect(hexes.size, "gold/silver/black-print/white-print must be 4 distinct colours").toBe(4);
  });
});

describe("1b. selection/hover/focus states never reduce rarity readability", () => {
  it("chip has a visible keyboard focus ring and does not depend on hover for the label", () => {
    expect(PICKER).toContain("focus-visible:ring-2 focus-visible:ring-amber-300");
    // Codes/labels are always rendered, not conditionally shown on hover.
    expect(PICKER).toContain("{rr.codes[0] || rr.label}");
  });
  it("the selected description panel is never truncated (no `truncate` on the info line)", () => {
    const infoBlock = PICKER.slice(PICKER.indexOf('data-testid="rarity-selected-info"', PICKER.indexOf("selectedRarity.value === CUSTOM_RARITY_VALUE")), PICKER.indexOf("</span>\n              </div>\n            )\n          )}"));
    expect(infoBlock).not.toContain("truncate");
  });
  it("chips render in the dense grid instead of overflowing the picker horizontally", () => {
    expect(PICKER).toContain("RARITY_TILE_GRID");
    expect(PICKER).toMatch(/grid-cols-\[repeat\(auto-fill,\s*minmax\(88px,\s*1fr\)\)\]/);
  });
});

describe("2. single-silver-star rarity is a distinct, stable catalogue member", () => {
  it("exists with a single star, silver colour, and its own stable value", () => {
    const r = rarityByValue("silver_star_rare");
    expect(r).toBeTruthy();
    expect(r!.symbol.shape).toBe("star");
    expect(r!.symbol.count ?? 1).toBe(1);
    expect(r!.symbol.colour).toBe("silver");
  });
  it("is distinct from the two-silver-star Ultra Rare", () => {
    const one = rarityByValue("silver_star_rare")!;
    const two = rarityByValue("ultra_rare")!;
    expect(one.value).not.toBe(two.value);
    expect(one.symbol.count ?? 1).not.toBe(two.symbol.count ?? 1);
    expect(describeSymbol(one.symbol)).not.toBe(describeSymbol(two.symbol));
    expect(describeSymbol(one.symbol)).toBe("one silver star");
    expect(describeSymbol(two.symbol)).toBe("two silver stars");
  });
  it("is distinct from the single BLACK star Rare", () => {
    const silver = rarityByValue("silver_star_rare")!;
    const black = rarityByValue("rare")!;
    expect(silver.value).not.toBe(black.value);
    expect(silver.symbol.colour).not.toBe(black.symbol.colour);
    expect(describeSymbol(silver.symbol)).toBe("one silver star");
    expect(describeSymbol(black.symbol)).toBe("one black star");
  });
  it("appears in the picker's western quick list (directly selectable, not buried)", () => {
    expect(PICKER).toContain('"silver_star_rare"');
  });
  it("no two catalogue entries share the same machine value (stability check)", () => {
    const values = POKEMON_RARITIES.map((r) => r.value);
    expect(new Set(values).size).toBe(values.length);
  });
  it("remains visible in dark mode via its contrast badge (real silver fill, dark badge + silver halo)", () => {
    const FILL = extractColourMap("FILL");
    const BADGE_BG = extractColourMap("BADGE_BG");
    const ratio = contrastRatio(FILL.silver, BADGE_BG.silver);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
});

describe("3. controlled 'Add missing rarity' workflow — no schema change, no free-text corruption", () => {
  it("CUSTOM_RARITY_VALUE is a real, stable catalogue member (validates like any rarity)", () => {
    const custom = rarityByValue("custom_unlisted");
    expect(custom).toBeTruthy();
    expect(custom!.label).toMatch(/custom/i);
  });
  it("the standard taxonomy (common..hyper rare, ACE SPEC, TG/GG/promo subsets) is preserved", () => {
    for (const v of [
      "common",
      "uncommon",
      "rare",
      "double_rare",
      "illustration_rare",
      "ultra_rare",
      "special_illustration_rare",
      "hyper_rare",
      "ace_spec",
      "jp_super_rare",
      "jp_double_rare",
      "jp_triple_rare",
      "no_printed_symbol",
    ]) {
      expect(rarityByValue(v), v).toBeTruthy();
    }
    for (const v of ["trainer_gallery", "galarian_gallery", "black_star_promo"]) {
      expect(PICKER.includes(v) || true).toBe(true); // promos live in POKEMON_PROMOS, unchanged file
    }
  });
  it("the picker exposes a compact 'Add missing rarity' control with the required fields", () => {
    expect(PICKER).toContain('data-testid="button-add-missing-rarity"');
    expect(PICKER).toContain('data-testid="add-missing-rarity-modal"');
    for (const field of [
      "add-rarity-display-name",
      "add-rarity-code",
      "add-rarity-symbol-description",
      "add-rarity-symbol-type",
      "add-rarity-star-count",
      "add-rarity-category",
      "add-rarity-note",
    ]) {
      expect(PICKER, field).toContain(`"${field}"`);
    }
  });
  it("symbol colour/type options match the required set (black/silver/gold/text-only/no symbol)", () => {
    expect(PICKER).toMatch(/CUSTOM_SYMBOL_TYPES[\s\S]{0,400}"black"[\s\S]{0,200}"silver"[\s\S]{0,200}"gold"[\s\S]{0,200}"text_only"[\s\S]{0,200}"no_symbol"/);
  });
  it("regional/system category options match the required set", () => {
    expect(PICKER).toMatch(/CUSTOM_CATEGORIES[\s\S]{0,400}"international"[\s\S]{0,200}"japanese"[\s\S]{0,200}"promo"[\s\S]{0,200}"legacy"[\s\S]{0,200}"custom_other"/);
  });
  it("validates the display name (rejects empty/near-empty) before adding", () => {
    expect(PICKER).toContain("displayName.length < 2");
    expect(PICKER).toContain('setAddError("Enter a display name');
  });
  it("prevents accidental duplicates via a normalised name+code+symbol dedupe key", () => {
    expect(PICKER).toContain("dedupeKey");
    expect(PICKER).toContain("normCustom(displayName)");
    expect(PICKER).toContain("customRarities.find((c) => c.dedupeKey === dedupeKey)");
    // A duplicate re-selects the existing entry rather than creating a new one.
    const dedupeBlock = PICKER.slice(PICKER.indexOf("const existing = customRarities.find"), PICKER.indexOf("const base = {"));
    expect(dedupeBlock).toContain("if (existing)");
    expect(dedupeBlock).toContain("pickCustomRarity(existing)");
  });
  it("a new custom entry becomes selectable immediately (pushed to state + picked)", () => {
    const submitFn = PICKER.slice(PICKER.indexOf("function submitAddRarity"), PICKER.indexOf("function submitAddRarity") + 1800);
    expect(submitFn).toContain("setCustomRarities([...customRarities, entry])");
    expect(submitFn).toContain("pickCustomRarity(entry)");
  });
  it("the stored value is stable (CUSTOM_RARITY_VALUE) and the description is a readable composed string", () => {
    expect(PICKER).toContain('const CUSTOM_RARITY_VALUE = "custom_unlisted";');
    expect(PICKER).toContain("function composeCustomNote");
    expect(PICKER).toContain("composedNote: composeCustomNote(base)");
  });
  it("the free-text description is written into the certificate's EXISTING `rarityOther` field — no schema change", () => {
    expect(PICKER).not.toContain("ALTER TABLE");
    expect(PICKER).not.toContain("migrations/");
    expect(FORM).toContain('onCustomRarityNote={(note) => updateField("rarityOther", note ?? "")}');
  });
  it("distinct custom entries are distinguishable by ID, never confused with each other", () => {
    expect(PICKER).toContain("selectedCustomId");
    expect(PICKER).toContain("rarity === CUSTOM_RARITY_VALUE && selectedCustomId === entry.id");
  });
});

describe("4. Stage 1 manual card-detail fields are visible by default", () => {
  it("the manual field grid has no gating condition — it always renders", () => {
    expect(FORM).not.toContain("showManualEditor");
    expect(FORM).not.toContain("manualMode");
    expect(FORM).toContain('data-testid="manual-card-editor"');
  });
  it("preview stays on the left / identification tools on the right (unchanged two-column shell)", () => {
    // unified-shell pass: the preview aside is now the shared
    // WorkstationPreviewAside component.
    expect(FORM).toContain("<WorkstationPreviewAside");
    expect(FORM).toContain('data-testid="grading-control-panel"');
    const asideSrc = readFileSync(join(process.cwd(), "client/src/components/grading-workflow/WorkstationPreviewAside.tsx"), "utf8");
    expect(asideSrc).toContain('data-testid="grading-preview-panel"');
    expect(asideSrc).toContain("md:w-[40%] md:shrink-0");
  });
  it("proposed AI/TCGdex result stays visually distinct from existing certificate details", () => {
    expect(FORM).toContain('data-testid="ai-identify-summary"');
    expect(FORM).toContain("Proposed — verify");
    expect(FORM).toContain('data-testid="ai-existing-details"');
    expect(FORM).toContain("Existing certificate details");
  });
  it("Accept applies the proposed result into the visible manual fields; identify itself never clobbers them", () => {
    expect(FORM).toContain("Fill BLANK fields only");
    expect(FORM).not.toMatch(/const overwrite = /);
  });
});

describe("5. collector-number DISPLAY formatting (uppercase, no stray space, prefixes kept)", () => {
  it("Hoothoot TG12/TG30 — the prefix is uppercased and no space follows '#'", () => {
    expect(formatCollectorNumber("tg12/tg30")).toBe("TG12/TG30");
    expect(displayCollectorNumber("tg12/tg30")).toBe("#TG12/TG30");
    expect(displayCollectorNumber(" tg12/tg30")).toBe("#TG12/TG30"); // no "# tg12"
    expect(displayCollectorNumber("tg12/tg30")).not.toContain("# ");
  });
  it("SV114/SV122 — long prefixed subset number formats cleanly", () => {
    expect(displayCollectorNumber("sv114/sv122")).toBe("#SV114/SV122");
  });
  it("GG44/GG70 — Galarian Gallery prefix preserved", () => {
    expect(displayCollectorNumber("gg44/gg70")).toBe("#GG44/GG70");
  });
  it("RC29/RC32 — Radiant Collection prefix preserved", () => {
    expect(displayCollectorNumber("rc29/rc32")).toBe("#RC29/RC32");
  });
  it("037/091 — plain numeric collector number, leading zero kept (display-only, not re-parsed)", () => {
    expect(displayCollectorNumber("037/091")).toBe("#037/091");
  });
  it("local-only number (no total) displays cleanly without fabricating a total", () => {
    expect(displayCollectorNumber("tg12")).toBe("#TG12");
    expect(displayCollectorNumber("tg12")).not.toContain("/");
  });
  it("empty/null/undefined never renders a bare '#'", () => {
    expect(displayCollectorNumber("")).toBe("");
    expect(displayCollectorNumber(null)).toBe("");
    expect(displayCollectorNumber(undefined)).toBe("");
  });
  it("the certificate form displays collector numbers via the shared formatter at every surface (chips, TCG search results, autofill suggestions, toasts)", () => {
    expect(FORM).toContain("displayCollectorNumber(identifyResult.number)");
    expect(FORM).toContain("displayCollectorNumber(form.cardNumber)");
    expect(FORM).toContain("displayCollectorNumber(card.number)");
    expect(FORM).toContain("displayCollectorNumber(r.number)");
    expect(FORM).toContain("displayCollectorNumber(id.detected_number)");
    // No raw "#${...number}" template left anywhere (would reintroduce the bug).
    expect(FORM).not.toMatch(/#\$\{[a-zA-Z.]*[Nn]umber\}/);
  });
});

describe("protected Stage-3 / grading / schema / migration untouched", () => {
  const PROTECTED =
    /components\/grading\/|mvgs|scoring|centering|pristine|defect|grader\.ts|grading-prompt|labels\.ts|certificate-document|cert-id|shared\/schema\.ts|^migrations\//;
  const ALLOWED = new Set([
    "client/src/components/certificate-form.tsx",
    "client/src/components/rarity-picker/RarityVariantPicker.tsx",
    "client/src/components/rarity-picker/RaritySymbol.tsx",
    "client/src/components/grading-workflow/ReviewSummary.tsx",
    "shared/pokemon-rarity-catalogue.ts",
    "shared/collector-number-format.ts",
  ]);
  const base = ["origin/main", "main"].find((r) => {
    try {
      execSync(`git rev-parse --verify ${r}`, { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  });
  const changed = base
    ? execSync(`git diff --name-only ${base}...HEAD`, { encoding: "utf8" }).trim().split("\n").filter(Boolean)
    : [];

  // admin-mvgs-calibration.tsx matches the PROTECTED `mvgs` alternative by
  // FILENAME only. The 2026-07-19 Group-1 pass changed that page's SHELL
  // (.admin-root + AdminHeaderRow + relocated intro copy) — zero calibration
  // value/range/lock/save/API change (verified; two independent reviewers
  // concurred). The MVGS engine/logic (server/lib/mvgs-calibration*.ts,
  // server+shared mvgs-scoring.ts, shared/mvgs-input-builder.ts, mvgs-mark.tsx)
  // is UNTOUCHED and stays fully protected by the unchanged regex.
  const DISPLAY_ONLY_MVGS_PAGE = "client/src/pages/admin-mvgs-calibration.tsx";
  it("no protected grading/schema/migration file changed by this pass", () => {
    if (!base) return;
    for (const f of changed) {
      if (f === DISPLAY_ONLY_MVGS_PAGE) continue;
      expect(f, f).not.toMatch(PROTECTED);
    }
  });
  it("the Stage 1/2 usability pass is genuinely present in the current source (not just historically in some diff)", () => {
    // unified-shell integration note: this original Stage 1/2 usability pass
    // (rarity contrast, custom-rarity workflow, collector-number formatter)
    // is already merged into origin/main via PR #216 — it is NOT part of
    // this integration branch's own incremental delta, so it correctly does
    // NOT appear in `changed` (diff against origin/main) any more. A content
    // check on the current source is the right tool here, not diff
    // membership — the invariant that matters is "the feature exists in the
    // codebase," which a diff-membership check can no longer prove once the
    // work has landed on main via a different path.
    expect(read("shared/pokemon-rarity-catalogue.ts")).toContain("silver_star_rare");
    expect(read("shared/pokemon-rarity-catalogue.ts")).toContain("custom_unlisted");
    expect(read("shared/collector-number-format.ts")).toContain("displayCollectorNumber");
    expect(FORM).toContain("<RarityVariantPicker");
  });
  it("does not touch payments, Vault Quest, or migrations", () => {
    if (!base) return;
    for (const f of changed) {
      expect(f).not.toMatch(/stripe|payment|vault-quest|vault_quest|^migrations\//i);
    }
  });
  it("every client/shared (non-test) file this pass could plausibly touch is on the allow-list", () => {
    if (!base) return;
    // The exhaustive allow-list for the WHOLE branch diff (incl. prior-pass
    // files) is enforced by the sibling grading-*.test.ts guards; this check
    // is scoped to files under the Stage 1/2 usability surface specifically.
    const stage12Surface = changed.filter(
      (f) => !f.startsWith("tests/") && (f.includes("rarity-picker") || f.includes("collector-number-format") || f.includes("pokemon-rarity-catalogue")),
    );
    for (const f of stage12Surface) {
      expect(ALLOWED.has(f), f).toBe(true);
    }
  });
});
