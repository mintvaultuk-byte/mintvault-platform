/**
 * Deterministic, ZERO-CREDIT Action-Pose studio-background finishing.
 *
 * A single paid provider generation sometimes returns the exact creature we asked
 * for but on a not-quite-clean backdrop (limbs/effects/shadow reaching the outer
 * edge band, a faint gradient, a hint of scene). Prompt-only containment is not
 * reliable enough (two real paid attempts still measured 7.9% / 7.7% edge
 * off-background vs the 5% ceiling). Rather than spend another credit, this module
 * turns that ONE provider image into a clean pure-white studio candidate LOCALLY:
 *
 *   A) transparent output  → composite the subject onto solid white
 *   B) plain near-white bg  → remove ONLY the border-connected backdrop (a
 *                             connected-component fill, never a global "erase all
 *                             white" — enclosed white/pale creature details are
 *                             kept), then re-centre the subject on a solid-white
 *                             canvas with a generous margin
 *   C) low confidence       → refuse; the caller keeps the quarantined source and
 *                             offers Manual Upload / explicit Generate Again
 *
 * It NEVER invents, redraws or crops creature detail — it only removes backdrop and
 * re-pads. It is self-validating: `ok` is true ONLY when the composed output passes
 * the EXISTING studio-background validator (5% threshold, unchanged) with the
 * subject preserved. Pure image processing — no provider call, no network, no DB.
 */
import { createHash } from "node:crypto";
import sharp from "sharp";
import { validateStudioBackground, OFF_BG_THRESHOLD } from "./bg-validate";

export type StudioFinishMethod = "alpha" | "chroma";
export type StudioFinishFailure =
  | "input_too_large"
  | "decode_failed"
  | "invalid_dimensions"
  | "backdrop_not_plain"
  | "no_background_removed"
  | "subject_lost"
  | "still_off_background";

export interface StudioFinishResult {
  ok: boolean;
  method: StudioFinishMethod | null;
  /** 0..1 — headroom below the 5% edge threshold after cleanup (audit only). */
  confidence: number;
  reason?: StudioFinishFailure;
  /** Cleaned, re-centred pure-white PNG — present only when ok. */
  png: Buffer | null;
  width: number;
  height: number;
  /** Fraction of pixels kept as foreground (subject) after masking. */
  subjectFraction: number;
  /** Fraction of pixels removed as border-connected backdrop. */
  backgroundFraction: number;
  /** Measured edge off-background fraction of the FINAL composed image. */
  finalEdgeOffFraction: number;
  sourceChecksum: string;
  cleanedChecksum: string | null;
}

// ── Bounds (Phase 9: DoS / decompression-bomb / memory) ─────────────────────────
export const FINISH_MAX_INPUT_BYTES = 25 * 1024 * 1024; // 25 MB hard input cap
const MAX_PIXELS = 40_000_000; // sharp decode ceiling
const ANALYSIS_MAX_DIM = 1400; // work resolution cap (bounded flood-fill + memory)
const MIN_DIMENSION = 64;

// ── Tuning (all conservative; the 5% VALIDATOR threshold is NOT touched) ─────────
const FILL_TOLERANCE = 34; // colour distance from the estimated backdrop that counts as removable background
const ALPHA_BG_MAX = 40; // alpha ≤ this (0..255) is treated as transparent background (Path A)
const ALPHA_PRESENCE_MIN = 0.02; // ≥2% meaningfully-transparent pixels ⇒ use Path A
const SAFE_SUBJECT_FRACTION = 0.8; // subject fills ≤80% of the canvas ⇒ ≥10% white margin each side (wider than the validator's 5% band)
const MIN_SUBJECT_FRACTION = 0.015; // <1.5% foreground left ⇒ cleanup ate the subject
const MIN_BACKGROUND_FRACTION = 0.02; // <2% removed ⇒ nothing separable was removed

const fail = (
  reason: StudioFinishFailure,
  extra?: Partial<StudioFinishResult>,
): StudioFinishResult => ({
  ok: false,
  method: null,
  confidence: 0,
  reason,
  png: null,
  width: 0,
  height: 0,
  subjectFraction: 0,
  backgroundFraction: 0,
  finalEdgeOffFraction: 1,
  sourceChecksum: extra?.sourceChecksum ?? "",
  cleanedChecksum: null,
  ...extra,
});

function median(vals: number[]): number {
  const s = [...vals].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

export async function finishStudioBackground(src: Buffer): Promise<StudioFinishResult> {
  const sourceChecksum = createHash("sha256").update(src).digest("hex");
  if (!src || src.length === 0) return fail("decode_failed", { sourceChecksum });
  if (src.length > FINISH_MAX_INPUT_BYTES) return fail("input_too_large", { sourceChecksum });

  // Decode to bounded RGBA raw pixels (alpha kept so Path A can read transparency).
  let data: Buffer, w: number, h: number;
  try {
    const pipeline = sharp(src, { limitInputPixels: MAX_PIXELS })
      .rotate()
      .resize({ width: ANALYSIS_MAX_DIM, height: ANALYSIS_MAX_DIM, fit: "inside", withoutEnlargement: true })
      .ensureAlpha()
      .raw();
    const out = await pipeline.toBuffer({ resolveWithObject: true });
    data = out.data;
    w = out.info.width;
    h = out.info.height;
  } catch {
    return fail("decode_failed", { sourceChecksum });
  }
  if (w < MIN_DIMENSION || h < MIN_DIMENSION) return fail("invalid_dimensions", { sourceChecksum });

  const n = w * h;
  const idx = (x: number, y: number) => (y * w + x) * 4;

  // ── Choose the masking method ────────────────────────────────────────────────
  let transparentPixels = 0;
  for (let i = 0; i < n; i++) if (data[i * 4 + 3] <= ALPHA_BG_MAX) transparentPixels++;
  const method: StudioFinishMethod = transparentPixels / n >= ALPHA_PRESENCE_MIN ? "alpha" : "chroma";

  // Estimate the plain backdrop colour from the outer 1px ring (robust median).
  const ring: number[][] = [[], [], []];
  const pushRing = (x: number, y: number) => {
    const i = idx(x, y);
    ring[0].push(data[i]);
    ring[1].push(data[i + 1]);
    ring[2].push(data[i + 2]);
  };
  for (let x = 0; x < w; x++) {
    pushRing(x, 0);
    pushRing(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    pushRing(0, y);
    pushRing(w - 1, y);
  }
  const bg: [number, number, number] = [median(ring[0]), median(ring[1]), median(ring[2])];

  if (method === "chroma") {
    // Path B only runs on a plain, approved near-white studio backdrop — the same
    // rule the validator uses to accept a backdrop. A gradient / scenic / coloured
    // backdrop is NOT flood-fillable safely ⇒ refuse (Path C), never guess.
    const minC = Math.min(...bg);
    const maxC = Math.max(...bg);
    const blueDominant = bg[2] > bg[0] + 8;
    if (minC < 200 || maxC - minC > 42 || blueDominant) return fail("backdrop_not_plain", { sourceChecksum });

    // Uniformity: a smooth gradient can sit "near the median" everywhere yet not be a
    // flat studio backdrop. Estimate each edge's own median and refuse if the four
    // edges disagree (a gradient's opposite edges differ a lot; a real flat backdrop
    // with the subject touching ONE edge still leaves the other three in agreement).
    const edgeMedian = (pts: Array<[number, number]>): [number, number, number] => {
      const c: number[][] = [[], [], []];
      for (const [x, y] of pts) {
        const i = idx(x, y);
        c[0].push(data[i]);
        c[1].push(data[i + 1]);
        c[2].push(data[i + 2]);
      }
      return [median(c[0]), median(c[1]), median(c[2])];
    };
    const line = (fn: (t: number) => [number, number]): Array<[number, number]> =>
      Array.from({ length: Math.max(w, h) }, (_, t) => fn(t)).filter(([x, y]) => x < w && y < h);
    const edges = [
      edgeMedian(line((t) => [t, 0])),
      edgeMedian(line((t) => [t, h - 1])),
      edgeMedian(line((t) => [0, t])),
      edgeMedian(line((t) => [w - 1, t])),
    ];
    let maxEdgeDelta = 0;
    for (let a = 0; a < edges.length; a++)
      for (let b = a + 1; b < edges.length; b++) {
        const d = Math.sqrt(
          (edges[a][0] - edges[b][0]) ** 2 + (edges[a][1] - edges[b][1]) ** 2 + (edges[a][2] - edges[b][2]) ** 2,
        );
        if (d > maxEdgeDelta) maxEdgeDelta = d;
      }
    if (maxEdgeDelta > 30) return fail("backdrop_not_plain", { sourceChecksum });
  }

  // ── Border-connected background mask (BFS, 4-connectivity) ────────────────────
  // A pixel is background ONLY if it is (a) backdrop-like AND (b) reachable from the
  // image border through other background pixels. Enclosed white/pale creature
  // details (surrounded by the creature outline, not reachable from the border) are
  // therefore NEVER removed. This is the safety guarantee for pale-blue/white detail.
  const isBackdropLike = (i: number): boolean => {
    if (method === "alpha") return data[i * 4 + 3] <= ALPHA_BG_MAX;
    const o = i * 4;
    const dr = data[o] - bg[0];
    const dg = data[o + 1] - bg[1];
    const db = data[o + 2] - bg[2];
    return Math.sqrt(dr * dr + dg * dg + db * db) <= FILL_TOLERANCE;
  };
  const isBg = new Uint8Array(n);
  const queue = new Int32Array(n);
  let qh = 0,
    qt = 0;
  const enqueueIfBg = (x: number, y: number) => {
    const p = y * w + x;
    if (!isBg[p] && isBackdropLike(p)) {
      isBg[p] = 1;
      queue[qt++] = p;
    }
  };
  for (let x = 0; x < w; x++) {
    enqueueIfBg(x, 0);
    enqueueIfBg(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    enqueueIfBg(0, y);
    enqueueIfBg(w - 1, y);
  }
  while (qh < qt) {
    const p = queue[qh++];
    const x = p % w;
    const y = (p / w) | 0;
    if (x > 0) enqueueIfBg(x - 1, y);
    if (x < w - 1) enqueueIfBg(x + 1, y);
    if (y > 0) enqueueIfBg(x, y - 1);
    if (y < h - 1) enqueueIfBg(x, y + 1);
  }

  // ── Build the white-backdrop raw buffer + subject bbox ───────────────────────
  const outRaw = Buffer.alloc(n * 3);
  let fgCount = 0;
  let bgCount = 0;
  let minX = w,
    minY = h,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const o3 = p * 3;
      if (isBg[p]) {
        outRaw[o3] = 255;
        outRaw[o3 + 1] = 255;
        outRaw[o3 + 2] = 255;
        bgCount++;
      } else {
        const o4 = p * 4;
        // Composite the (possibly semi-transparent) subject pixel over white so
        // anti-aliased edges blend to white cleanly — never a grey halo.
        const a = data[o4 + 3] / 255;
        outRaw[o3] = Math.round(data[o4] * a + 255 * (1 - a));
        outRaw[o3 + 1] = Math.round(data[o4 + 1] * a + 255 * (1 - a));
        outRaw[o3 + 2] = Math.round(data[o4 + 2] * a + 255 * (1 - a));
        fgCount++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  const subjectFraction = fgCount / n;
  const backgroundFraction = bgCount / n;

  // Confidence gates BEFORE any expensive composition (never guess on a bad mask).
  if (backgroundFraction < MIN_BACKGROUND_FRACTION)
    return fail("no_background_removed", { sourceChecksum, subjectFraction, backgroundFraction });
  if (subjectFraction < MIN_SUBJECT_FRACTION || maxX < 0)
    return fail("subject_lost", { sourceChecksum, subjectFraction, backgroundFraction });

  // ── Compose: crop subject → scale to ≤SAFE_SUBJECT_FRACTION → centre on white ──
  const bboxW = maxX - minX + 1;
  const bboxH = maxY - minY + 1;
  const whiteFilled = await sharp(outRaw, { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toBuffer();
  const subject = await sharp(whiteFilled).extract({ left: minX, top: minY, width: bboxW, height: bboxH }).toBuffer();
  const targetW = Math.max(1, Math.round(w * SAFE_SUBJECT_FRACTION));
  const targetH = Math.max(1, Math.round(h * SAFE_SUBJECT_FRACTION));
  const scaled = await sharp(subject)
    .resize({ width: targetW, height: targetH, fit: "inside", withoutEnlargement: false, background: { r: 255, g: 255, b: 255 } })
    .toBuffer();
  const composed = await sharp({
    create: { width: w, height: h, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([{ input: scaled, gravity: "centre" }])
    .png()
    .toBuffer();

  // Self-validate: the finish only "succeeds" if the composed output actually passes
  // the EXISTING 5% studio-background gate. This never weakens the gate — it is the
  // gate, run on the cleaned image.
  const finalBg = await validateStudioBackground(composed);
  if (!finalBg.ok)
    return fail("still_off_background", {
      sourceChecksum,
      subjectFraction,
      backgroundFraction,
      finalEdgeOffFraction: finalBg.offBackgroundFraction,
    });

  const cleanedChecksum = createHash("sha256").update(composed).digest("hex");
  const confidence = Math.max(0, Math.min(1, 1 - finalBg.offBackgroundFraction / OFF_BG_THRESHOLD));
  return {
    ok: true,
    method,
    confidence,
    png: composed,
    width: w,
    height: h,
    subjectFraction,
    backgroundFraction,
    finalEdgeOffFraction: finalBg.offBackgroundFraction,
    sourceChecksum,
    cleanedChecksum,
  };
}
