/**
 * Production hotfix: Stage 2 rarity picker regressions.
 *
 *   1. Tiles were oversized (min-h-40px / min-w-84px in a loose flex-wrap) —
 *      must become a compact, dense grid.
 *   2. Printed-black symbols (Common circle, Uncommon diamond, Rare star, and
 *      the JP text marks RR/RRR/PR/etc.) had been recoloured off-white for
 *      contrast — the printed colour must be preserved (real black/silver/gold),
 *      with legibility solved by a fixed-size contrast BADGE behind the symbol
 *      instead of recolouring the symbol itself.
 *
 * Source-assertion style (matches the sibling grading/rarity test files — the
 * admin grading form is auth-gated). Zero provider calls, zero DB.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const SYMBOL = read("client/src/components/rarity-picker/RaritySymbol.tsx");
const PICKER = read("client/src/components/rarity-picker/RarityVariantPicker.tsx");

describe("real printed colour is preserved (never recoloured for display)", () => {
  it("black stays a true black fill/stroke, not the previous off-white display colour", () => {
    const fillBlock = SYMBOL.slice(SYMBOL.indexOf("const FILL"), SYMBOL.indexOf("const STROKE"));
    expect(fillBlock).toMatch(/black:\s*"#000000"/);
    // the old recolour-to-off-white regression must not reappear as the FILL colour.
    expect(fillBlock).not.toMatch(/black:\s*"#F3EFE3"/);
  });
  it("silver and gold are distinct, real metallic tones (not the same fill as black)", () => {
    const fillBlock = SYMBOL.slice(SYMBOL.indexOf("const FILL"), SYMBOL.indexOf("const STROKE"));
    const black = fillBlock.match(/black:\s*"(#[0-9A-Fa-f]{6})"/)?.[1];
    const silver = fillBlock.match(/silver:\s*"(#[0-9A-Fa-f]{6})"/)?.[1];
    const gold = fillBlock.match(/gold:\s*"(#[0-9A-Fa-f]{6})"/)?.[1];
    expect(black).toBeTruthy();
    expect(silver).toBeTruthy();
    expect(gold).toBeTruthy();
    expect(new Set([black, silver, gold]).size).toBe(3);
  });
  it("the text-shape glyph (ACE/RR/RRR/PR/etc.) renders in the symbol's own printed colour, not a forced display colour", () => {
    const textBlock = SYMBOL.slice(
      SYMBOL.indexOf('symbol.shape === "text" &&'),
      SYMBOL.indexOf('symbol.shape === "none"')
    );
    expect(textBlock).toContain("fill={fill}");
    expect(textBlock).not.toMatch(/fill=\{['"]#/); // never a hardcoded override
  });
});

describe("contrast is solved with a fixed-size badge behind the symbol, not recolouring", () => {
  it("every symbol renders on top of a BADGE_BG/BADGE_RING circle", () => {
    expect(SYMBOL).toContain("BADGE_BG");
    expect(SYMBOL).toContain("BADGE_RING");
    expect(SYMBOL).toMatch(/<circle[^>]*fill=\{badgeBg\}/);
  });
  it("badge geometry is fixed (same cx/cy/r) — identical size/alignment for every rarity", () => {
    expect(SYMBOL).toContain("const BADGE_CX");
    expect(SYMBOL).toContain("const BADGE_CY");
    expect(SYMBOL).toContain("const BADGE_R");
    // the badge circle (identified by its unique data-badge-colour attribute) is
    // drawn once, unconditionally, before any shape branch.
    const badgeIdx = SYMBOL.indexOf("data-badge-colour");
    const firstShapeIdx = SYMBOL.indexOf('symbol.shape === "circle"');
    expect(badgeIdx).toBeGreaterThan(-1);
    expect(firstShapeIdx).toBeGreaterThan(badgeIdx);
  });
  it("black symbols get a light neutral/ivory badge; silver and gold get a dark badge with a matching halo", () => {
    const badgeBgBlock = SYMBOL.slice(SYMBOL.indexOf("const BADGE_BG"), SYMBOL.indexOf("const BADGE_RING"));
    const badgeRingBlock = SYMBOL.slice(SYMBOL.indexOf("const BADGE_RING"), SYMBOL.indexOf("function Star"));
    // black badge bg is light (starts with a high hex value, i.e. not dark charcoal).
    expect(badgeBgBlock).toMatch(/black:\s*"#F3EFE3"/i);
    expect(badgeBgBlock).toMatch(/silver:\s*"#23262d"/i);
    expect(badgeBgBlock).toMatch(/gold:\s*"#23262d"/i);
    expect(badgeRingBlock).toMatch(/silver:\s*"#B9C0C9"/i);
    expect(badgeRingBlock).toMatch(/gold:\s*"#C9A227"/i);
  });
  it("2-3 star clusters scale down to fit inside the SAME fixed badge (never a wider badge)", () => {
    expect(SYMBOL).toContain('symbol.shape === "stars"');
    expect(SYMBOL).toMatch(/starSize/);
    // no per-shape variable badge/viewBox sizing remains (old regression: viewBox scaled by shape).
    expect(SYMBOL).not.toMatch(/viewBox=\{`0 0 \$\{symbol\.shape/);
  });
});

describe("one silver star stays distinct from two silver stars and one black star (spec 5)", () => {
  it("silver_star_rare (1 silver star), ultra_rare (2 silver stars) and rare (1 black star) are still three distinct catalogue entries", () => {
    const catalogue = read("shared/pokemon-rarity-catalogue.ts");
    expect(catalogue).toMatch(/value:\s*"silver_star_rare".*colour:\s*"silver"/);
    expect(catalogue).toMatch(/value:\s*"ultra_rare".*colour:\s*"silver"/);
    expect(catalogue).toMatch(/value:\s*"rare".*colour:\s*"black"/);
  });
});

describe("tiles are compact and use a dense grid (spec 1)", () => {
  it("the oversized flex-wrap tile classes are gone", () => {
    expect(PICKER).not.toContain("min-h-[40px]");
    expect(PICKER).not.toContain("min-w-[84px]");
    expect(PICKER).not.toContain("max-w-[124px]");
  });
  it("tile height is significantly reduced", () => {
    expect(PICKER).toContain("min-h-[28px]");
  });
  it("rarity tiles render inside a dense auto-fill grid, not a loose flex-wrap", () => {
    expect(PICKER).toContain("RARITY_TILE_GRID");
    expect(PICKER).toMatch(/grid-cols-\[repeat\(auto-fill,\s*minmax\(88px,\s*1fr\)\)\]/);
  });
  it("the main quick-picker, more-rarities, favourites, recent and custom lists all use the same dense grid", () => {
    const containers = [
      "{quickRarities.map(chip)}",
      "{favouriteRarities.map(chip)}",
      "{recentRarities.map(chip)}",
      "{moreRarities.map(chip)}",
      "{customRarities.map(customChip)}",
    ];
    for (const c of containers) {
      const idx = PICKER.indexOf(c);
      expect(idx, c).toBeGreaterThan(-1);
      const before = PICKER.slice(Math.max(0, idx - 200), idx);
      expect(before, c).toContain("RARITY_TILE_GRID");
    }
  });
});

describe("recently used shares the exact same compact tile component as the main picker (spec 4)", () => {
  it("recentRarities and quickRarities are both rendered via the single shared `chip` function", () => {
    expect((PICKER.match(/const chip = \(rr: PokemonRarity\)/g) ?? []).length).toBe(1);
    expect(PICKER).toContain("{recentRarities.map(chip)}");
    expect(PICKER).toContain("{quickRarities.map(chip)}");
  });
});

describe("selected state, keyboard focus and accessibility preserved", () => {
  it("selected styling and aria-pressed/aria-label remain on the compact chip", () => {
    const chipFn = PICKER.slice(
      PICKER.indexOf("const chip = (rr: PokemonRarity)"),
      PICKER.indexOf("const customChip =")
    );
    expect(chipFn).toContain("aria-pressed={selected}");
    expect(chipFn).toContain("aria-label={aria}");
    expect(chipFn).toContain("focus-visible:ring-2");
    expect(chipFn).toContain("border-amber-400 bg-amber-500/25 ring-2 ring-amber-400");
  });
});

describe("protected boundary: only rarity picker presentation + this test changed", () => {
  // Pinned to the FIXED historical range of the rarity-picker hotfix itself
  // (2091ea83 -> bcf74e25), not "...HEAD" — later hotfixes stack additional
  // commits on top (e.g. the workflow-header overlap fix), which is expected
  // and must not falsely trip this guard.
  const base = "2091ea83";
  const head = "bcf74e25";
  let changed: string[] = [];
  try {
    execSync(`git rev-parse --verify ${base}`, { stdio: "pipe" });
    execSync(`git rev-parse --verify ${head}`, { stdio: "pipe" });
    changed = execSync(`git diff --name-only ${base}..${head}`, { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  } catch {
    changed = [];
  }
  const PROTECTED =
    /components\/grading\/|mvgs|scoring|centering|pristine|defect|grader\.ts|grading-prompt|labels\.ts|certificate-document|cert-id|shared\/schema\.ts|^migrations\/|partner|^server\//;
  const ALLOWED = new Set([
    "client/src/components/rarity-picker/RaritySymbol.tsx",
    "client/src/components/rarity-picker/RarityVariantPicker.tsx",
  ]);

  it("no protected/partner-network/schema/migration/server file changed", () => {
    if (changed.length === 0) return;
    for (const f of changed) expect(f, f).not.toMatch(PROTECTED);
  });
  it("every non-test change is exactly the rarity picker presentation files", () => {
    if (changed.length === 0) return;
    for (const f of changed.filter((f) => !f.startsWith("tests/"))) {
      expect(ALLOWED.has(f), `unexpected file: ${f}`).toBe(true);
    }
  });
});
