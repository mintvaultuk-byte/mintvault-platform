#!/usr/bin/env tsx
/**
 * Fix 1 verification — aspect-tighten to Pokémon card ratio (0.716 ±0.005).
 *
 * Runs detectCardBoundary on synthetic raw-RGB pixel buffers and checks the
 * returned bounds are inside the tolerance band. No test framework in this
 * repo; this script is the standalone verification.
 *
 *   npx tsx scripts/verify-aspect-tighten.ts
 */
import { detectCardBoundary } from "../server/image-processing";

function buildCanvas(
  imgW: number, imgH: number,
  cardX: number, cardY: number, cardW: number, cardH: number,
  matRgb: [number, number, number], cardRgb: [number, number, number],
): Uint8Array {
  const buf = new Uint8Array(imgW * imgH * 3);
  // Fill mat
  for (let i = 0; i < imgW * imgH; i++) {
    buf[i * 3] = matRgb[0];
    buf[i * 3 + 1] = matRgb[1];
    buf[i * 3 + 2] = matRgb[2];
  }
  // Paint card rectangle
  for (let y = cardY; y < cardY + cardH; y++) {
    for (let x = cardX; x < cardX + cardW; x++) {
      const i = (y * imgW + x) * 3;
      buf[i] = cardRgb[0];
      buf[i + 1] = cardRgb[1];
      buf[i + 2] = cardRgb[2];
    }
  }
  return buf;
}

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { console.error(`  ✗ ${msg}`); failures++; }
}

function run(label: string, fn: () => void) {
  console.log(`\n=== ${label} ===`);
  fn();
}

run("Case A — over-wide bounds (1640×2240, ratio 0.732) tighten to Pokémon band", () => {
  const imgW = 1700, imgH = 2300;
  const cardW = 1640, cardH = 2240;
  const cardX = (imgW - cardW) / 2, cardY = (imgH - cardH) / 2;
  const buf = buildCanvas(imgW, imgH, cardX, cardY, cardW, cardH, [255, 255, 255], [0, 0, 255]);
  const bounds = detectCardBoundary(buf, imgW, imgH, 3, "TEST-A");
  if (!bounds) { console.error("  ✗ detectCardBoundary returned null"); failures++; return; }
  const bw = bounds.maxX - bounds.minX + 1;
  const bh = bounds.maxY - bounds.minY + 1;
  const ratio = bw / bh;
  console.log(`  detected bounds: ${bw}×${bh}, ratio=${ratio.toFixed(4)}`);
  assert(ratio >= 0.711 && ratio <= 0.721, `ratio ${ratio.toFixed(4)} within [0.711, 0.721]`);
  assert(bw < cardW, `width shrunk from ${cardW} to ${bw}`);
  assert(bh === cardH, `height unchanged (${bh}px)`);
});

run("Case B — already-in-range bounds (1604×2240, ratio 0.716) returned unchanged", () => {
  const imgW = 1700, imgH = 2300;
  const cardW = 1604, cardH = 2240;
  const cardX = (imgW - cardW) / 2, cardY = (imgH - cardH) / 2;
  const buf = buildCanvas(imgW, imgH, cardX, cardY, cardW, cardH, [255, 255, 255], [0, 0, 255]);
  const bounds = detectCardBoundary(buf, imgW, imgH, 3, "TEST-B");
  if (!bounds) { console.error("  ✗ detectCardBoundary returned null"); failures++; return; }
  const bw = bounds.maxX - bounds.minX + 1;
  const bh = bounds.maxY - bounds.minY + 1;
  const ratio = bw / bh;
  console.log(`  detected bounds: ${bw}×${bh}, ratio=${ratio.toFixed(4)}`);
  assert(ratio >= 0.711 && ratio <= 0.721, `ratio ${ratio.toFixed(4)} within [0.711, 0.721]`);
  assert(Math.abs(bw - cardW) <= 1, `width preserved (${bw} ≈ ${cardW})`);
});

run("Case C — fat card (1500×2240, ratio 0.670): 2% pixel-loss safeguard trips before target band", () => {
  const imgW = 1600, imgH = 2300;
  const cardW = 1500, cardH = 2240;
  const cardX = (imgW - cardW) / 2, cardY = (imgH - cardH) / 2;
  const buf = buildCanvas(imgW, imgH, cardX, cardY, cardW, cardH, [255, 255, 255], [0, 0, 255]);
  const bounds = detectCardBoundary(buf, imgW, imgH, 3, "TEST-C");
  if (!bounds) { console.error("  ✗ detectCardBoundary returned null"); failures++; return; }
  const bw = bounds.maxX - bounds.minX + 1;
  const bh = bounds.maxY - bounds.minY + 1;
  const ratio = bw / bh;
  const originalCardPx = cardW * cardH;
  const finalCardPx = bw * bh;
  const lossPct = ((originalCardPx - finalCardPx) / originalCardPx) * 100;
  console.log(`  detected bounds: ${bw}×${bh}, ratio=${ratio.toFixed(4)}, card-area loss ${lossPct.toFixed(2)}%`);
  // Safeguard: max 2% of original card pixels sacrificed. Card rect is ~100%
  // card pixels inside bounds, so integral-image loss ≈ area loss. Allow small
  // overshoot from last-step trim (up to ~3%) before flagging.
  assert(lossPct <= 3.0, `card-area loss ${lossPct.toFixed(2)}% at or under 3% (2% target + 1 step slack)`);
  assert(ratio < 0.711, `ratio ${ratio.toFixed(4)} still below band (safeguard stopped before target)`);
  assert(bw === cardW, `width unchanged (${bw}px — spec shrinks height for tall-card mismatch)`);
});

if (failures > 0) {
  console.error(`\n${failures} FAILED`);
  process.exit(1);
} else {
  console.log(`\nAll assertions passed ✓`);
}
