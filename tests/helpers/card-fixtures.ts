/**
 * Deterministic synthetic card fixtures for the crop-integrity harness.
 *
 * Why synthetic: the real MV602/MV608/MV609 scans are customer card images and
 * are NOT committed. They were used read-only from R2 during verification (see
 * docs/front-crop-integrity.md); these fixtures reproduce the *optical
 * properties* that break the coverage detector:
 *
 *   - a PALE lower information panel (MV602: ex-Rule box + illustrator + number)
 *   - a PALE white/silver outer border      (MV609)
 *   - a fully saturated full-art front      (MV608 — must keep working)
 *   - yellow / dark / borderless fronts     (regression breadth)
 *   - a saturated Pokémon-style back        (must keep working)
 *
 * Content that must never be destroyed is marked with pure-hue SENTINEL blocks,
 * so "the card number survived" is a machine-checkable assertion rather than an
 * eyeball judgement.
 */
import sharp from "sharp";

/** Physical card aspect (63x88). Fixtures are built at an exact multiple. */
export const FIXTURE_CARD_W = 880;
export const FIXTURE_CARD_H = 1229; // 880 / (63/88) = 1229.0 -> aspect 0.71603
/** Mat strip on each side, mirroring the centredUnpadded safety pad. */
export const FIXTURE_MAT_PX = 30;

export const SENTINELS = {
  /** Card number (MV602's "154/190"). */
  cardNumber: { r: 255, g: 0, b: 255 },
  /** Illustrator credit line. */
  illustrator: { r: 0, g: 255, b: 255 },
  /** ex-Rule box inside the pale lower panel. */
  ruleBox: { r: 0, g: 255, b: 0 },
  /** Regulation marks, bottom edge. */
  regulation: { r: 255, g: 128, b: 0 },
  /** Just inside each of the four card corners. */
  corner: { r: 255, g: 0, b: 0 },
} as const;

export type BorderStyle = "pale_white" | "silver" | "yellow" | "dark" | "borderless" | "back_blue";

export interface FixtureSpec {
  border: BorderStyle;
  /** MV602's failure mode: a large low-saturation panel in the lower third. */
  paleLowerPanel?: boolean;
  cardW?: number;
  cardH?: number;
  matPx?: number;
}

export const BORDER_RGB: Record<BorderStyle, { r: number; g: number; b: number }> = {
  // Deliberately near-white / low-saturation: this is what the coverage
  // detector cannot distinguish from mat.
  pale_white: { r: 248, g: 247, b: 244 },
  silver: { r: 226, g: 228, b: 231 },
  yellow: { r: 240, g: 205, b: 40 },
  dark: { r: 22, g: 22, b: 26 },
  borderless: { r: 120, g: 40, b: 90 },
  back_blue: { r: 40, g: 70, b: 165 },
};

/** Solid RGB rect as a raw-pixel sharp overlay. */
function rect(w: number, h: number, c: { r: number; g: number; b: number }) {
  const buf = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    buf[i * 3] = c.r;
    buf[i * 3 + 1] = c.g;
    buf[i * 3 + 2] = c.b;
  }
  return { input: buf, raw: { width: w, height: h, channels: 3 as const } };
}

/**
 * Build a fixture: white mat canvas + card + border + sentinels.
 * Fully deterministic — no randomness, no Date, no I/O.
 */
export async function makeCardFixture(spec: FixtureSpec): Promise<Buffer> {
  const cardW = spec.cardW ?? FIXTURE_CARD_W;
  const cardH = spec.cardH ?? FIXTURE_CARD_H;
  const mat = spec.matPx ?? FIXTURE_MAT_PX;
  const W = cardW + 2 * mat;
  const H = cardH + 2 * mat;
  const borderRgb = BORDER_RGB[spec.border];
  const borderPx = spec.border === "borderless" ? 0 : Math.round(cardW * 0.038); // ~3.8% per side

  const layers: sharp.OverlayOptions[] = [];
  // Card body = border colour, then an inner art panel on top.
  layers.push({ ...rect(cardW, cardH, borderRgb), left: mat, top: mat });

  const innerX = mat + borderPx;
  const innerY = mat + borderPx;
  const innerW = cardW - 2 * borderPx;
  const innerH = cardH - 2 * borderPx;

  if (spec.border === "back_blue") {
    // Saturated back field — high contrast against mat on every edge.
    layers.push({ ...rect(innerW, innerH, { r: 55, g: 90, b: 200 }), left: innerX, top: innerY });
  } else {
    // Dark, saturated artwork occupying the upper portion.
    const artH = spec.paleLowerPanel ? Math.round(innerH * 0.62) : innerH;
    layers.push({ ...rect(innerW, artH, { r: 38, g: 28, b: 64 }), left: innerX, top: innerY });
    if (spec.paleLowerPanel) {
      // MV602's killer: a large PALE panel (near-white, desaturated) filling the
      // lower third. Indistinguishable from mat to a saturation/coverage rule.
      const panelY = innerY + artH;
      const panelH = innerH - artH;
      layers.push({ ...rect(innerW, panelH, { r: 243, g: 242, b: 238 }), left: innerX, top: panelY });
      // Rule box + text lines living INSIDE that pale panel.
      layers.push({
        ...rect(Math.round(innerW * 0.5), 26, SENTINELS.ruleBox),
        left: innerX + Math.round(innerW * 0.25),
        top: panelY + Math.round(panelH * 0.22),
      });
    }
  }

  // Sentinels that mark content which must NEVER be cropped away.
  const S = 16;
  const bottomInner = mat + cardH - borderPx;
  if (spec.border !== "back_blue") {
    layers.push({ ...rect(60, S, SENTINELS.cardNumber), left: mat + cardW - borderPx - 74, top: bottomInner - 30 });
    layers.push({ ...rect(70, S, SENTINELS.illustrator), left: innerX + 8, top: bottomInner - 30 });
    layers.push({
      ...rect(40, 10, SENTINELS.regulation),
      left: mat + Math.round(cardW / 2) - 20,
      top: bottomInner - 12,
    });
  }
  // Corner sentinels just inside the card corners (all four).
  for (const [dx, dy] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ] as const) {
    const x = dx === 0 ? mat + borderPx + 4 : mat + cardW - borderPx - 4 - S;
    const y = dy === 0 ? mat + borderPx + 4 : mat + cardH - borderPx - 4 - S;
    layers.push({ ...rect(S, S, SENTINELS.corner), left: x, top: y });
  }

  return await sharp({ create: { width: W, height: H, channels: 3, background: "#ffffff" } })
    .composite(layers)
    .jpeg({ quality: 95 })
    .toBuffer();
}

/** Fraction of pixels within `tol` (per channel) of a target colour. */
export async function colourFraction(
  buf: Buffer,
  target: { r: number; g: number; b: number },
  tol = 70
): Promise<number> {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const n = info.width * info.height;
  let hit = 0;
  for (let i = 0; i < n; i++) {
    const o = i * ch;
    if (
      Math.abs(data[o] - target.r) <= tol &&
      Math.abs(data[o + 1] - target.g) <= tol &&
      Math.abs(data[o + 2] - target.b) <= tol
    ) {
      hit++;
    }
  }
  return hit / n;
}

/** True when a sentinel colour is still present in meaningful quantity. */
export async function sentinelPresent(
  buf: Buffer,
  target: { r: number; g: number; b: number },
  minFraction = 0.00005
): Promise<boolean> {
  return (await colourFraction(buf, target)) >= minFraction;
}

/** Mean saturation of the outermost `ringPx` ring — high means mat was removed. */
export async function outerRingSaturation(buf: Buffer, ringPx = 3): Promise<number> {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: ch } = info;
  let sum = 0;
  let n = 0;
  const sat = (o: number) => Math.max(data[o], data[o + 1], data[o + 2]) - Math.min(data[o], data[o + 1], data[o + 2]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const onRing = x < ringPx || y < ringPx || x >= w - ringPx || y >= h - ringPx;
      if (!onRing) continue;
      sum += sat((y * w + x) * ch);
      n++;
    }
  }
  return n > 0 ? sum / n : 0;
}

/** Fraction of the outermost ring that is near-white (i.e. residual mat). */
export async function outerRingMatFraction(buf: Buffer, ringPx = 3): Promise<number> {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: ch } = info;
  let mat = 0;
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const onRing = x < ringPx || y < ringPx || x >= w - ringPx || y >= h - ringPx;
      if (!onRing) continue;
      const o = (y * w + x) * ch;
      const r = data[o],
        g = data[o + 1],
        b = data[o + 2];
      const satv = Math.max(r, g, b) - Math.min(r, g, b);
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (satv < 30 && lum > 200) mat++;
      n++;
    }
  }
  return n > 0 ? mat / n : 0;
}

// ── Sleeved / top-loader scan fixtures ──────────────────────────────────────
//
// These model the SCANNER FRAME, not the already-cropped card: white scanner
// bed, an optional sleeve or top-loader around the card, and optional scanner
// hardware (a dark jig strip along one edge, a guide rail along the bottom).
// This is the geometry that breaks a global min/max bounding box — every piece
// of hardware is non-mat, so one pixel of it per side returns the whole frame.
//
// Proportions are taken from the MV642/front reference failure (1474×2000
// source, card 1313×1832 at (100,128), jig strip on the left, guide along the
// bottom), scaled down so the fixtures stay cheap to build.

export interface SleevedScanSpec {
  /** Scanner frame size. */
  frameW?: number;
  frameH?: number;
  /** Card size; defaults to a 63×88 aspect card filling ~82% of the frame. */
  cardW?: number;
  cardH?: number;
  /** Card top-left inside the frame. */
  cardX?: number;
  cardY?: number;
  /** Draw a sleeve / top-loader rectangle around the card. */
  sleeve?: "none" | "penny_sleeve" | "toploader";
  /** Dark scanner-jig strip along the left edge. */
  jigLeft?: boolean;
  /** Dark guide rail along the bottom edge. */
  guideBottom?: boolean;
  /** Card body colour — pale borders are the hard case. */
  border?: BorderStyle;
}

/** Reference geometry, from MV642/front scaled to a 737×1000 frame. */
export const SLEEVED_REFERENCE = {
  frameW: 737,
  frameH: 1000,
  cardW: 657,
  cardH: 916, // 657 / (63/88) = 917.7 → 916 keeps aspect 0.7172
  cardX: 50,
  cardY: 64,
} as const;

export async function makeSleevedScanFixture(spec: SleevedScanSpec = {}): Promise<Buffer> {
  const W = spec.frameW ?? SLEEVED_REFERENCE.frameW;
  const H = spec.frameH ?? SLEEVED_REFERENCE.frameH;
  const cardW = spec.cardW ?? SLEEVED_REFERENCE.cardW;
  const cardH = spec.cardH ?? SLEEVED_REFERENCE.cardH;
  const cardX = spec.cardX ?? SLEEVED_REFERENCE.cardX;
  const cardY = spec.cardY ?? SLEEVED_REFERENCE.cardY;
  const border = spec.border ?? "yellow";
  const sleeve = spec.sleeve ?? "penny_sleeve";

  const layers: sharp.OverlayOptions[] = [];

  // Sleeve / top-loader: near-mat body with a faintly darker seam outline. It
  // is deliberately only just distinguishable from the bed — a detector that
  // treats it as the card is exactly the failure this fixture exists to catch.
  if (sleeve !== "none") {
    const pad = sleeve === "toploader" ? 22 : 11;
    const sx = Math.max(0, cardX - pad);
    const sy = Math.max(0, cardY - pad);
    const sw = Math.min(W - sx, cardW + 2 * pad);
    const sh = Math.min(H - sy, cardH + 2 * pad);
    const seam = sleeve === "toploader" ? { r: 214, g: 216, b: 219 } : { r: 233, g: 234, b: 236 };
    layers.push({ ...rect(sw, sh, seam), left: sx, top: sy });
    // Interior back to near-bed brightness, so only the 2 px seam differs.
    layers.push({ ...rect(sw - 4, sh - 4, { r: 250, g: 250, b: 251 }), left: sx + 2, top: sy + 2 });
  }

  // Scanner hardware. Partial coverage by construction: the jig spans 70% of
  // the frame height and the guide 100% of the width but only 2.5% of the
  // height, so neither can form a card-shaped plateau.
  if (spec.jigLeft) {
    layers.push({
      ...rect(Math.round(W * 0.035), Math.round(H * 0.7), { r: 26, g: 30, b: 52 }),
      left: 0,
      top: Math.round(H * 0.2),
    });
  }
  if (spec.guideBottom) {
    layers.push({
      ...rect(W, Math.round(H * 0.015), { r: 34, g: 34, b: 38 }),
      left: 0,
      top: H - Math.round(H * 0.015),
    });
  }

  // The card itself: solid border colour with a saturated art panel inside, so
  // every row and column it spans is strongly non-mat.
  const borderRgb = BORDER_RGB[border];
  const borderPx = border === "borderless" ? 0 : Math.round(cardW * 0.038);
  layers.push({ ...rect(cardW, cardH, borderRgb), left: cardX, top: cardY });
  layers.push({
    ...rect(cardW - 2 * borderPx, cardH - 2 * borderPx, { r: 38, g: 28, b: 64 }),
    left: cardX + borderPx,
    top: cardY + borderPx,
  });
  // Corner sentinels just inside the physical card corners.
  const S = 12;
  for (const [dx, dy] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ] as const) {
    layers.push({
      ...rect(S, S, SENTINELS.corner),
      left: dx === 0 ? cardX + borderPx + 3 : cardX + cardW - borderPx - 3 - S,
      top: dy === 0 ? cardY + borderPx + 3 : cardY + cardH - borderPx - 3 - S,
    });
  }

  return await sharp({ create: { width: W, height: H, channels: 3, background: "#f4f6f8" } })
    .composite(layers)
    .jpeg({ quality: 95 })
    .toBuffer();
}

/** Decode a fixture to the raw form the detectors consume. */
export async function toRaw(buf: Buffer): Promise<{ pixels: Uint8Array; w: number; h: number; ch: number }> {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { pixels: new Uint8Array(data), w: info.width, h: info.height, ch: info.channels };
}
