/**
 * Regenerates nfc-tap-icon-white.png from nfc-tap-icon.png.
 * Converts the dark-on-light icon to white-on-transparent for use on dark label backgrounds.
 * Dark pixels → white; light/transparent pixels → transparent.
 */
const path = require("path");
const fs   = require("fs");

const BRAND_DIR  = path.join(__dirname, "..", "public", "brand");
const SRC_PATH   = path.join(BRAND_DIR, "nfc-tap-icon.png");
const DEST_PATH  = path.join(BRAND_DIR, "nfc-tap-icon-white.png");

async function main() {
  const { createCanvas, loadImage } = await import("canvas");

  const img = await loadImage(SRC_PATH);
  const { width, height } = img;

  const canvas = createCanvas(width, height);
  const ctx    = canvas.getContext("2d");

  // Draw original icon
  ctx.drawImage(img, 0, 0, width, height);

  const imageData = ctx.getImageData(0, 0, width, height);
  const d = imageData.data;

  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];

    // Skip fully transparent pixels
    if (a < 10) {
      d[i + 3] = 0;
      continue;
    }

    // Luminance (weighted)
    const lum = (r * 299 + g * 587 + b * 114) / 1000;

    if (lum > 180) {
      // Light pixels (white background, oval fill) → fully transparent
      d[i]     = 0;
      d[i + 1] = 0;
      d[i + 2] = 0;
      d[i + 3] = 0;
    } else {
      // Dark pixels (lines, icon strokes) → white, keep original alpha
      d[i]     = 255;
      d[i + 1] = 255;
      d[i + 2] = 255;
      d[i + 3] = a;
    }
  }

  ctx.putImageData(imageData, 0, 0);

  const buffer = canvas.toBuffer("image/png");
  fs.writeFileSync(DEST_PATH, buffer);

  console.log(`Written ${buffer.length} bytes → ${DEST_PATH}`);
  console.log(`Image: ${width}×${height} RGBA`);
}

main().catch(err => { console.error(err); process.exit(1); });
