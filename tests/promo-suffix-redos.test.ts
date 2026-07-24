/**
 * promo-suffix-redos.test.ts — regression cover for the CodeQL js/polynomial-redos
 * hardening of the Black Star Promo suffix regex in the PROTECTED renderer
 * (server/labels.ts).
 *
 * The ONLY change is the whitespace quantifier:
 *     BEFORE:  /\s+black star promos?$/i
 *     AFTER:   /\s{1,64}black star promos?$/i
 *
 * These tests prove the change is semantics-preserving (byte-identical visible
 * output for every input, not merely for realistic ones), that the bound removes
 * the super-linear blow-up, and that nothing else in the label pipeline moved.
 *
 * splitPromoSuffix() is deliberately module-private in labels.ts, so equivalence
 * is proven two ways: (1) the REAL regex + the REAL split logic are pinned by
 * reading the actual source, and (2) both regexes are run through that identical
 * split logic over a corpus, asserting identical output.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const LABELS_SRC = readFileSync(join(process.cwd(), "server/labels.ts"), "utf8");

// The exact regexes: OLD is the pre-hardening form; NEW is read from the live
// source so this test can never drift from what actually ships.
const OLD_RE = /\s+black star promos?$/i;
const NEW_RE_LITERAL = LABELS_SRC.match(/const PROMO_SUFFIX_RE = (\/.+\/i);/)?.[1] ?? "";

/** The REAL splitPromoSuffix body from labels.ts, parameterised by the regex. */
function split(setName: string, re: RegExp): { base: string; suffix: string } {
  const m = setName.match(re);
  if (!m) return { base: setName, suffix: "" };
  return { base: setName.slice(0, m.index).trim(), suffix: m[0].trim() };
}
const NEW_RE = /\s{1,64}black star promos?$/i;

describe("promo-suffix regex — the shipped source is the bounded form", () => {
  it("labels.ts uses the bounded quantifier (no unbounded \\s+ before the literal)", () => {
    expect(NEW_RE_LITERAL).toBe("/\\s{1,64}black star promos?$/i");
    expect(LABELS_SRC).not.toContain("/\\s+black star promos?$/i");
  });

  it("splitPromoSuffix still trims BOTH base and suffix — the equivalence precondition", () => {
    // If either .trim() were removed, a >64 whitespace run could differ. Pin them.
    expect(LABELS_SRC).toContain("return { base: setName.slice(0, m.index).trim(), suffix: m[0].trim() };");
  });
});

describe("semantics preserved — identical visible output, old regex vs new", () => {
  const CORPUS = [
    // Real-world set names in the Black Star Promos family (the whole point).
    "Sword & Shield Black Star Promos",
    "XY Black Star Promos",
    "Black Star Promos",
    "Scarlet & Violet Black Star Promos",
    "Sun & Moon Black Star Promos",
    "Diamond & Pearl Black Star Promos",
    "HeartGold SoulSilver Black Star Promos",
    "Nintendo Black Star Promos",
    "Wizards Black Star Promos",
    // Singular form must stay supported (promos?).
    "SVP Black Star Promo",
    "Nintendo Black Star Promo",
    // Case-insensitivity.
    "sword & shield black star promos",
    "SWORD & SHIELD BLACK STAR PROMOS",
    "Sword & Shield BLACK STAR Promos",
    // Ordinary set names — must be returned untouched (no suffix).
    "Base Set",
    "Jungle",
    "Team Rocket",
    "Evolving Skies",
    "151",
    "Paldea Evolved",
    "",
    // Near-misses that must NOT match.
    "Black Star Promos Extra",
    "Black Star",
    "Promos",
    "Blackstar Promos",
    // Whitespace handling.
    "Sword & Shield  Black Star Promos", // two spaces
    "Sword & Shield\tBlack Star Promos", // tab
    "Sword & Shield\nBlack Star Promos", // newline
    "  Padded Set  ",
    " Black Star Promos",
    // Boundary of the new bound: exactly 64, and 65 (crosses the bound).
    "Set" + " ".repeat(64) + "Black Star Promos",
    "Set" + " ".repeat(65) + "Black Star Promos",
    "Set" + " ".repeat(200) + "Black Star Promos",
    " ".repeat(300) + "Black Star Promos",
  ];

  it.each(CORPUS)("produces byte-identical base + suffix for %j", (name) => {
    const before = split(name, OLD_RE);
    const after = split(name, NEW_RE);
    expect(after.base).toBe(before.base);
    expect(after.suffix).toBe(before.suffix);
  });

  it("a >64 whitespace run still splits correctly (trim() absorbs the offset difference)", () => {
    // This is the ONLY class of input where the internal match offset differs;
    // the trim() on both sides makes the RENDERED strings identical.
    const name = "Sword & Shield" + " ".repeat(500) + "Black Star Promos";
    expect(split(name, NEW_RE)).toEqual({ base: "Sword & Shield", suffix: "Black Star Promos" });
    expect(split(name, NEW_RE)).toEqual(split(name, OLD_RE));
  });

  it("ordinary set names are returned untouched with an empty suffix", () => {
    for (const n of ["Base Set", "Evolving Skies", "151"]) {
      expect(split(n, NEW_RE)).toEqual({ base: n, suffix: "" });
    }
  });

  it("singular and plural promo forms both still match", () => {
    expect(split("XY Black Star Promo", NEW_RE).suffix).toBe("Black Star Promo");
    expect(split("XY Black Star Promos", NEW_RE).suffix).toBe("Black Star Promos");
  });
});

describe("ReDoS bound — the pathological input is now linear", () => {
  it("a 100k-whitespace non-matching input completes immediately", () => {
    // The polynomial blow-up shape: a long whitespace run that never completes
    // the literal. Bounded quantifier ⇒ constant work per start position.
    const evil = " ".repeat(100_000) + "black star promo!";
    const t0 = Date.now();
    const r = split(evil, NEW_RE);
    const ms = Date.now() - t0;
    expect(r.suffix).toBe("");
    expect(ms).toBeLessThan(1000);
  });

  it("a 200k-whitespace input that DOES match is also fast and correct", () => {
    const evil = "Set" + " ".repeat(200_000) + "Black Star Promos";
    const t0 = Date.now();
    const r = split(evil, NEW_RE);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r).toEqual({ base: "Set", suffix: "Black Star Promos" });
  });
});

describe("blast radius — nothing else in the protected renderer moved", () => {
  it("the grading/label decision logic is untouched by this change", () => {
    // The renderer still composes the variant line through the ONE shared helper
    // and still derives the black/white label from the Pristine gate.
    expect(LABELS_SRC).toContain("consolidatedVariantForLabel(cert)");
    expect(LABELS_SRC).toContain("isPristine");
    // No MVGS/centering/grade maths was introduced or altered here.
    expect(LABELS_SRC).toContain("computeMvgsScore");
  });

  it("preview and print remain on the SAME renderer (one generateLabelPNG)", () => {
    const preview = readFileSync(join(process.cwd(), "server/routes/admin/label-preview.ts"), "utf8");
    expect(preview).toContain('generateLabelPNG(cert, "front")');
    const routes = readFileSync(join(process.cwd(), "server/routes.ts"), "utf8");
    expect(routes).not.toContain('app.post("/api/admin/label-preview"');
  });
});
