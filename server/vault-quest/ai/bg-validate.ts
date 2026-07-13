/**
 * Studio-background validation for the MASTER REFERENCE and ACTION REFERENCE
 * (permanent production reference library assets — not finished illustration art).
 *
 * Both must sit on the exact same plain approved studio backdrop (pure white, very
 * light cream, or very light neutral grey — a single flat colour). This runs AFTER
 * each generation: it samples the outer edge band (the region outside the centred
 * creature) and fails the image if that region isn't a plain approved colour, or if
 * more than 5% of it deviates (scenery / texture / gradient / flames / coloured
 * backdrop / vignette). Deterministic + free — no model call.
 *
 * The edge band is a pragmatic proxy for "outside the creature silhouette": the
 * creature is composed to fill ~70% centred, so the outer frame is background.
 */
import sharp from "sharp";

export interface BgValidation {
  ok: boolean;
  offBackgroundFraction: number;
  backgroundColor: [number, number, number];
  reason?: string;
}

const OFF_BG_THRESHOLD = 0.05; // >5% of edge pixels off-background ⇒ reject
const COLOUR_DISTANCE = 26; // per-pixel deviation from the plain backdrop that counts as "off"

export async function validateStudioBackground(png: Buffer): Promise<BgValidation> {
  // Downscale to a small raw buffer for a fast, resolution-independent check.
  const { data, info } = await sharp(png)
    .resize({ width: 200, height: 200, fit: "inside" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width,
    h = info.height,
    ch = info.channels;
  const at = (x: number, y: number): [number, number, number] => {
    const i = (y * w + x) * ch;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const border = Math.max(2, Math.round(Math.min(w, h) * 0.05)); // outer 5% frame

  // Reference backdrop colour = median of the corners + top/bottom edge midpoints
  // (the pixels most reliably outside the creature).
  const anchors: [number, number, number][] = [
    at(0, 0),
    at(w - 1, 0),
    at(0, h - 1),
    at(w - 1, h - 1),
    at(Math.floor(w / 2), 0),
    at(Math.floor(w / 2), h - 1),
    at(0, Math.floor(h / 2)),
    at(w - 1, Math.floor(h / 2)),
  ];
  const median = (vals: number[]) => {
    const s = [...vals].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const bg: [number, number, number] = [
    median(anchors.map((c) => c[0])),
    median(anchors.map((c) => c[1])),
    median(anchors.map((c) => c[2])),
  ];

  // Is the backdrop an APPROVED plain studio colour? white / cream / light grey =
  // bright on every channel, low overall saturation (warm cream allowed, spread ≤ 42),
  // and NOT blue-dominant (a cool tint means a coloured, non-approved backdrop).
  const minC = Math.min(...bg),
    maxC = Math.max(...bg);
  const blueDominant = bg[2] > bg[0] + 8;
  if (minC < 200 || maxC - minC > 42 || blueDominant) {
    return {
      ok: false,
      offBackgroundFraction: 1,
      backgroundColor: bg,
      reason: `backdrop is not a plain white/cream/light-grey studio colour (rgb ${bg.join(",")})`,
    };
  }

  // Fraction of the edge band that deviates from the plain backdrop.
  let band = 0,
    off = 0;
  const dist = (c: [number, number, number]) => Math.hypot(c[0] - bg[0], c[1] - bg[1], c[2] - bg[2]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= border && x < w - border && y >= border && y < h - border) continue; // interior (creature)
      band++;
      if (dist(at(x, y)) > COLOUR_DISTANCE) off++;
    }
  }
  const frac = band ? off / band : 0;
  return {
    ok: frac <= OFF_BG_THRESHOLD,
    offBackgroundFraction: frac,
    backgroundColor: bg,
    reason:
      frac > OFF_BG_THRESHOLD
        ? `${(frac * 100).toFixed(1)}% of the edge is off-background (scenery / texture / gradient / effect)`
        : undefined,
  };
}
