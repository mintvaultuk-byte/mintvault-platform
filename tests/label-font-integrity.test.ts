/**
 * Bundled-font integrity (hostile-review N2) and CJK coverage (N3).
 *
 * N2: an `existsSync` check let a CORRUPT, ZERO-BYTE, UNREADABLE or SUBSTITUTED font through.
 *     `registerFont` then failed quietly and the label rendered with host fonts — a different
 *     typeface on a physical product, with no error. Measured: valid 9efe0f6669d3a022 vs
 *     corrupt 87b58cc65f474b2f.
 * N3: the Latin faces cover no Japanese, so Japanese card names fell back to host fonts.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { BUNDLED_FONT_MANIFEST } from "../server/labels";

const FONT_DIR = join(process.cwd(), "public", "brand", "fonts");
const LABELS_SRC = readFileSync(join(process.cwd(), "server", "labels.ts"), "utf8");

describe("N2 — the bundled font manifest", () => {
  it("covers every registered face, with no unlisted file in the directory", () => {
    const listed = new Set(BUNDLED_FONT_MANIFEST.map((f) => f.file));
    // Every face the renderer registers must be in the manifest.
    for (const m of LABELS_SRC.matchAll(/file:\s*"([^"]+\.(?:ttf|otf))"/g)) {
      expect(listed.has(m[1]), `${m[1]} is registered but not in BUNDLED_FONT_MANIFEST`).toBe(true);
    }
    expect(BUNDLED_FONT_MANIFEST.length).toBe(9);
  });

  it("matches the bytes actually committed", () => {
    for (const entry of BUNDLED_FONT_MANIFEST) {
      const file = join(FONT_DIR, entry.file);
      expect(statSync(file).size, `${entry.file} size`).toBe(entry.bytes);
      expect(createHash("sha256").update(readFileSync(file)).digest("hex"), `${entry.file} sha256`).toBe(entry.sha256);
    }
  });

  it("is an immutable reviewed constant — it CANNOT regenerate itself at runtime", () => {
    // The whole protection collapses if the expected hashes are ever computed from the files
    // being verified, so the source is asserted to contain literal hex digests and no
    // self-derivation next to the manifest.
    const manifest = LABELS_SRC.slice(
      LABELS_SRC.indexOf("BUNDLED_FONT_MANIFEST"),
      LABELS_SRC.indexOf("BundledFontIntegrityError")
    );
    expect(manifest).toMatch(/sha256: "[0-9a-f]{64}"/);
    expect(manifest).not.toMatch(/createHash|readFileSync|digest\(/);
    // Every manifest hash is a 64-char literal, not an expression.
    expect(BUNDLED_FONT_MANIFEST.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
    expect(BUNDLED_FONT_MANIFEST.every((f) => Number.isInteger(f.bytes) && f.bytes > 0)).toBe(true);
  });

  it("verifies integrity BEFORE registering, and does not rely on registerFont throwing", () => {
    const verifyAt = LABELS_SRC.indexOf("verifyBundledFonts();");
    const registerAt = LABELS_SRC.indexOf("registerFont(BODONI_PATH");
    expect(verifyAt).toBeGreaterThan(0);
    expect(registerAt).toBeGreaterThan(0);
    expect(verifyAt).toBeLessThan(registerAt);
    // size + hash, not mere existence
    expect(LABELS_SRC).toContain("stat.size !== entry.bytes");
    expect(LABELS_SRC).toMatch(/digest !== entry\.sha256/);
  });

  it("re-throws integrity failures instead of swallowing them", () => {
    expect(LABELS_SRC).toMatch(/if \(err instanceof BundledFontIntegrityError\)[\s\S]{0,120}throw err;/);
  });
});

describe("N3 — the CJK face is present, registered and last in every stack", () => {
  it("bundles the exact face production resolves for Japanese, with its licence", () => {
    const cjk = BUNDLED_FONT_MANIFEST.find((f) => f.file === "DroidSansFallbackFull.ttf");
    expect(cjk, "DroidSansFallbackFull.ttf must be bundled").toBeTruthy();
    expect(cjk!.bytes).toBe(4033420);
    // Apache-2.0 licence text is committed next to the font.
    expect(readFileSync(join(FONT_DIR, "DroidSansFallback-LICENSE.txt"), "utf8")).toMatch(/Apache-2/);
  });

  /**
   * PORTABLE glyph-coverage golden. Advance widths come from the font file, not the
   * rasteriser, so these hold on macOS and Linux alike — measured identical on both. If the
   * CJK face is removed, substituted or dropped from a stack, the widths move (a missing glyph
   * falls back to a different face) and this fails on every platform, not just in CI.
   */
  it("renders Japanese from the bundled face, with the expected portable metrics", async () => {
    const { createCanvas } = await import("canvas");
    const { ensureFontsRegistered, MV_SANS } = await import("../server/labels");
    await ensureFontsRegistered();
    // Droid Sans Fallback is a full-width CJK face: each ideograph/kana advances exactly the
    // em, so at 40px a 5-character katakana name is 200px and a 3-character kanji name 120px.
    const cases: [string, string, number][] = [
      ["katakana", "リザードン", 200],
      ["kanji", "炎の竜", 120],
      ["hiragana", "ポケモン", 160],
      ["fullwidth latin", "ＭＡＸ", 120],
      ["japanese punctuation", "「」・（）", 200],
    ];
    for (const [label, text, expected] of cases) {
      const ctx = createCanvas(10, 10).getContext("2d");
      ctx.font = `bold 40px ${MV_SANS}`;
      expect(ctx.measureText(text).width, `${label} advance width`).toBeCloseTo(expected, 1);
    }
  });

  it("draws real Japanese glyphs, not tofu and not blanks", async () => {
    const { createCanvas } = await import("canvas");
    const { ensureFontsRegistered, MV_SANS } = await import("../server/labels");
    await ensureFontsRegistered();
    const render = (text: string) => {
      const c = createCanvas(400, 80);
      const x = c.getContext("2d");
      x.fillStyle = "#fff";
      x.fillRect(0, 0, 400, 80);
      x.fillStyle = "#000";
      x.font = `bold 40px ${MV_SANS}`;
      x.fillText(text, 5, 55);
      const d = c.toBuffer("raw");
      let dark = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 128) dark++;
      return { ink: dark, png: c.toBuffer("image/png").toString("base64") };
    };
    // Private-use code points that NO font supplies form the tofu reference. Ink VOLUME alone
    // cannot separate tofu from kana — a notdef box is often heavier than thin kana, which is
    // exactly how an earlier version of this check produced a false failure on Linux. So the
    // assertion is: each Japanese string draws ink, and renders as something OTHER than tofu.
    // Correct FACE selection is proven by the advance-width golden above, which only the
    // bundled CJK file satisfies.
    const tofu = render("\uE000\uE001\uE002");
    const blank = render("");
    for (const s of ["リザードン", "炎の竜", "ポケモンカードゲーム", "ＭＡＸ"]) {
      const r = render(s);
      expect(r.ink, `${s} must draw ink`).toBeGreaterThan(blank.ink);
      expect(r.png, `${s} must not render as tofu`).not.toBe(tofu.png);
    }
    // …and the tofu reference is itself distinct from blank, so the check is not vacuous.
    expect(tofu.png).not.toBe(blank.png);
  });

  it("appends the CJK family AFTER the Latin face in every stack, never before", () => {
    // Order matters: Latin glyphs must still come from Nimbus/DejaVu byte-for-byte.
    for (const stack of ["MV_SANS", "MV_SERIF", "MV_MONO", "MV_BLACK"]) {
      const line = LABELS_SRC.split("\n").find((l) => l.includes(`export const ${stack} =`));
      expect(line, `${stack} declaration`).toBeTruthy();
      expect(line!, `${stack} must end with the CJK fallback`).toMatch(/,\s*\$\{MV_CJK\}`;$/);
    }
    expect(LABELS_SRC).toMatch(/export const MV_CJK = '"MV Slab CJK"'/);
  });
});
