#!/usr/bin/env tsx
/**
 * Fix 2 verification — reCentreBitmap measures actual card edges (colour
 * distance > 45 from mat colour) and shifts bounds when L/R or T/B margins
 * differ by >4px.
 *
 * Synthesises a PNG with a blue card centred inside a white mat with
 * asymmetric margins, runs reCentreBitmap, and checks the reported
 * pre/post margins and shift.
 *
 *   npx tsx scripts/verify-recentre.ts
 */
import sharp from "sharp";
import { reCentreBitmap } from "../server/image-processing";

async function makePNG(
  imgW: number, imgH: number,
  cardX: number, cardY: number, cardW: number, cardH: number,
  matRgb: [number, number, number], cardRgb: [number, number, number],
): Promise<Buffer> {
  const buf = Buffer.alloc(imgW * imgH * 3);
  for (let i = 0; i < imgW * imgH; i++) {
    buf[i * 3] = matRgb[0]; buf[i * 3 + 1] = matRgb[1]; buf[i * 3 + 2] = matRgb[2];
  }
  for (let y = cardY; y < cardY + cardH; y++) {
    for (let x = cardX; x < cardX + cardW; x++) {
      const i = (y * imgW + x) * 3;
      buf[i] = cardRgb[0]; buf[i + 1] = cardRgb[1]; buf[i + 2] = cardRgb[2];
    }
  }
  return sharp(buf, { raw: { width: imgW, height: imgH, channels: 3 } }).png().toBuffer();
}

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { console.error(`  ✗ ${msg}`); failures++; }
}

async function run(label: string, fn: () => Promise<void>) {
  console.log(`\n=== ${label} ===`);
  await fn();
}

await run("Case A — asymmetric card (L:12 R:24 T:14 B:14) shifts +6x, 0y", async () => {
  const imgW = 640, imgH = 880;
  // Card 604×852, positioned with L=12, R=24, T=14, B=14
  const cardW = imgW - 12 - 24, cardH = imgH - 14 - 14;
  const png = await makePNG(imgW, imgH, 12, 14, cardW, cardH, [255, 255, 255], [0, 0, 255]);
  const result = await reCentreBitmap(png, { matRgb: { r: 255, g: 255, b: 255 }, certId: "TEST-A" });
  const pp = result.pre_padding_px;
  const pa = result.post_asymmetry_px;
  console.log(`  pre_padding: L:${pp.left} R:${pp.right} T:${pp.top} B:${pp.bottom}`);
  console.log(`  shift: ${pa.horizontal}x, ${pa.vertical}y`);
  assert(pp.left === 12, `pre L=12 (got ${pp.left})`);
  assert(pp.right === 24, `pre R=24 (got ${pp.right})`);
  assert(pp.top === 14, `pre T=14 (got ${pp.top})`);
  assert(pp.bottom === 14, `pre B=14 (got ${pp.bottom})`);
  assert(pa.horizontal === 6, `shift x=+6 (got ${pa.horizontal})`);
  assert(pa.vertical === 0, `shift y=0 (got ${pa.vertical})`);
  // Bitmap size preserved
  const outMeta = await sharp(result.buffer).metadata();
  assert(outMeta.width === imgW && outMeta.height === imgH, `bitmap preserved ${outMeta.width}×${outMeta.height}`);
});

await run("Case B — symmetric card (L:20 R:20 T:20 B:20) no shift", async () => {
  const imgW = 640, imgH = 880;
  const cardW = imgW - 40, cardH = imgH - 40;
  const png = await makePNG(imgW, imgH, 20, 20, cardW, cardH, [255, 255, 255], [0, 0, 255]);
  const result = await reCentreBitmap(png, { matRgb: { r: 255, g: 255, b: 255 }, certId: "TEST-B" });
  const pp = result.pre_padding_px;
  const pa = result.post_asymmetry_px;
  console.log(`  pre_padding: L:${pp.left} R:${pp.right} T:${pp.top} B:${pp.bottom}`);
  console.log(`  shift: ${pa.horizontal}x, ${pa.vertical}y, extended=${result.extended}`);
  assert(pa.horizontal === 0 && pa.vertical === 0, `no shift applied`);
  assert(result.extended === false, `extended=false`);
});

await run("Case C — small asymmetry within ±4px tolerance (L:10 R:13) no shift", async () => {
  const imgW = 640, imgH = 880;
  const cardW = imgW - 10 - 13, cardH = imgH - 20 - 20;
  const png = await makePNG(imgW, imgH, 10, 20, cardW, cardH, [255, 255, 255], [0, 0, 255]);
  const result = await reCentreBitmap(png, { matRgb: { r: 255, g: 255, b: 255 }, certId: "TEST-C" });
  const pp = result.pre_padding_px;
  const pa = result.post_asymmetry_px;
  console.log(`  pre_padding: L:${pp.left} R:${pp.right} T:${pp.top} B:${pp.bottom}`);
  console.log(`  shift: ${pa.horizontal}x, ${pa.vertical}y`);
  assert(Math.abs(pp.left - pp.right) <= 4, `L/R diff within tolerance`);
  assert(pa.horizontal === 0 && pa.vertical === 0, `no shift (diff ≤ 4)`);
});

await run("Case D — top-heavy card (T:10 B:30) shifts 0x, +10y", async () => {
  const imgW = 640, imgH = 880;
  const cardW = imgW - 20 - 20, cardH = imgH - 10 - 30;
  const png = await makePNG(imgW, imgH, 20, 10, cardW, cardH, [255, 255, 255], [0, 0, 255]);
  const result = await reCentreBitmap(png, { matRgb: { r: 255, g: 255, b: 255 }, certId: "TEST-D" });
  const pp = result.pre_padding_px;
  const pa = result.post_asymmetry_px;
  console.log(`  pre_padding: L:${pp.left} R:${pp.right} T:${pp.top} B:${pp.bottom}`);
  console.log(`  shift: ${pa.horizontal}x, ${pa.vertical}y`);
  assert(pp.top === 10 && pp.bottom === 30, `pre T=10 B=30`);
  assert(pa.vertical === 10, `shift y=+10 (got ${pa.vertical})`);
  assert(pa.horizontal === 0, `shift x=0`);
});

if (failures > 0) {
  console.error(`\n${failures} FAILED`);
  process.exit(1);
} else {
  console.log(`\nAll assertions passed ✓`);
}
