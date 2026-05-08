#!/usr/bin/env node
/**
 * One-shot builder for the menu-bar tray PNGs. Renders simple SVG glyphs
 * to 16×16 + 32×32 PNGs in scripts/scanner-app/assets/. Reuses sharp
 * from the parent project's node_modules so we don't need to add a
 * runtime dep to the app.
 *
 * Usage (from repo root):
 *   node scripts/scanner-app/build-tray-icons.js
 *
 * Re-run after editing the SVG strings below — outputs are .gitignored
 * elsewhere are NOT (the PNGs are committed so install.sh doesn't need
 * sharp on the operator machine).
 *
 * macOS template-image rules (Apple HIG): pure black on transparent,
 * no anti-aliased grey along edges, no colour. The menu bar inverts
 * the black to white in dark mode automatically.
 */

const path = require("node:path");
const fs   = require("node:fs");

// Resolve sharp from project root.
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const sharp = require(path.join(REPO_ROOT, "node_modules", "sharp"));

const ASSETS = path.join(__dirname, "assets");
fs.mkdirSync(ASSETS, { recursive: true });

// ── SVG glyphs ───────────────────────────────────────────────────────────
// 16×16 viewBox. Stroke widths chosen so 16px renders crisply without
// blur. All shapes are pure black on transparent — macOS handles the
// dark/light invert when setTemplateImage(true) is set.

const idleSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
  <!-- "MV" monogram. M strokes + V notch. Bold, dense — reads at 16px. -->
  <path d="M2 3 L2 13 L4 13 L4 7 L8 12 L12 7 L12 13 L14 13 L14 3 L12 3 L8 9 L4 3 Z" fill="black"/>
</svg>`;

// busy/uploading: same M outline, plus an arrow chevron above-right pixels.
const busySvg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
  <path d="M2 5 L2 13 L4 13 L4 9 L8 13 L12 9 L12 13 L14 13 L14 5 L12 5 L8 10 L4 5 Z" fill="black"/>
  <!-- Up-arrow indicator at top -->
  <path d="M6 1 L8 3 L10 1 L9 1 L9 4 L7 4 L7 1 Z" fill="black"/>
</svg>`;

// error: M with a small dot/exclamation indicator above
const errorSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
  <path d="M2 5 L2 13 L4 13 L4 9 L8 13 L12 9 L12 13 L14 13 L14 5 L12 5 L8 10 L4 5 Z" fill="black"/>
  <!-- Exclamation glyph above -->
  <rect x="7" y="0" width="2" height="3" fill="black"/>
</svg>`;

// ── Render ───────────────────────────────────────────────────────────────

async function render(name, svg) {
  const sources = [
    { suffix: "",     w: 16, h: 16 },
    { suffix: "@2x",  w: 32, h: 32 },
  ];
  for (const s of sources) {
    const out = path.join(ASSETS, `${name}${s.suffix}.png`);
    await sharp(Buffer.from(svg))
      .resize(s.w, s.h, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toFile(out);
    console.log(`✓ wrote ${path.relative(REPO_ROOT, out)} (${s.w}×${s.h})`);
  }
}

(async () => {
  await render("tray-idle",  idleSvg);
  await render("tray-busy",  busySvg);
  await render("tray-error", errorSvg);
  console.log("done.");
})().catch(err => {
  console.error("build-tray-icons failed:", err);
  process.exit(1);
});
