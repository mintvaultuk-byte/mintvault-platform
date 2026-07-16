/**
 * Studio-background validator audit (Phase 3). Proves the EXISTING validateStudioBackground
 * (threshold + logic UNCHANGED) is correct for the cases the Action-Pose background
 * fix must respect: a clean pure-white studio shot with the creature contained and a
 * white margin passes; genuine scenery / gradients / textured or elemental edges fail.
 *
 * These are deterministic pixel fixtures — no provider, no network, no DB, no credits.
 */
import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { validateStudioBackground, OFF_BG_THRESHOLD } from "../server/vault-quest/ai/bg-validate";

const W = 240;
const H = 240;
const BORDER = 40; // white margin (≈17%) — wider than the validator's outer-5% edge band

// Build an opaque RGB PNG from a per-pixel fill function.
async function png(fill: (x: number, y: number) => [number, number, number]): Promise<Buffer> {
  const buf = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const [r, g, b] = fill(x, y);
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
    }
  }
  return sharp(buf, { raw: { width: W, height: H, channels: 3 } })
    .png()
    .toBuffer();
}

const inBorder = (x: number, y: number) => x < BORDER || x >= W - BORDER || y < BORDER || y >= H - BORDER;

// Deterministic pseudo-random so a "detailed" interior varies without Math.random().
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

describe("studio-background validator — correct for the studio-reference cases (unchanged logic)", () => {
  it("pure solid white passes", async () => {
    const r = await validateStudioBackground(await png(() => [255, 255, 255]));
    expect(r.ok).toBe(true);
  });

  it("a detailed centred creature with a clean white margin passes — intrinsic features are NOT falsely rejected", async () => {
    const rand = lcg(7);
    const r = await validateStudioBackground(
      await png((x, y) => {
        if (inBorder(x, y)) return [255, 255, 255]; // clean white margin (the sampled edge band)
        // busy, varied interior (fins/markings/eyes/aquatic detail) — never sampled
        const v = Math.max(0, Math.min(255, Math.round(120 + (rand() - 0.5) * 220)));
        return [v, Math.max(0, v - 40), Math.min(255, v + 30)];
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("near-white anti-aliased subject edges (on white) pass", async () => {
    const cx = W / 2;
    const cy = H / 2;
    const r = await validateStudioBackground(
      await png((x, y) => {
        // soft grey subject blob in the centre with anti-aliased near-white falloff;
        // fully inside the margin so the edge band stays white
        const d = Math.hypot(x - cx, y - cy);
        if (d < 60) return [90, 90, 100];
        if (d < 72) {
          const t = (72 - d) / 12; // 1 at inner edge → 0 at outer
          const v = Math.round(255 - t * 40); // 215..255 near-white AA
          return [v, v, v];
        }
        return [255, 255, 255];
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("a small faint contact shadow directly under the subject passes", async () => {
    const cx = W / 2;
    const footY = H / 2 + 55; // still inside the interior, above the bottom edge band
    const r = await validateStudioBackground(
      await png((x, y) => {
        const d = Math.hypot((x - cx) / 30, (y - footY) / 8); // small flat ellipse
        if (d < 1) return [210, 210, 210]; // faint soft shadow
        return [255, 255, 255];
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("a broad gradient background fails (off-background fraction over threshold)", async () => {
    const r = await validateStudioBackground(await png((x) => {
      const v = Math.round(255 - (x / W) * 75); // 255 → 180 left-to-right
      return [v, v, v];
    }));
    expect(r.ok).toBe(false);
    expect(r.offBackgroundFraction).toBeGreaterThan(OFF_BG_THRESHOLD);
  });

  it("a scenic / coloured backdrop fails (not a plain approved studio colour)", async () => {
    const r = await validateStudioBackground(await png(() => [40, 130, 55])); // forest green
    expect(r.ok).toBe(false);
  });

  it("texture / noise across the edge band fails (white corners, busy frame)", async () => {
    const rand = lcg(11);
    const r = await validateStudioBackground(
      await png((x, y) => {
        if (!inBorder(x, y)) return [255, 255, 255]; // clean interior
        // keep the 4 corners + edge midpoints (the anchors) white so the backdrop
        // still reads as white, but scatter dark textured pixels across the band
        const isAnchor =
          (x < 3 || x >= W - 3 || Math.abs(x - W / 2) < 3) && (y < 3 || y >= H - 3) ;
        if (isAnchor) return [255, 255, 255];
        return rand() < 0.6 ? [70, 70, 70] : [255, 255, 255];
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.offBackgroundFraction).toBeGreaterThan(OFF_BG_THRESHOLD);
  });

  it("elemental effects touching the frame edge fail", async () => {
    const r = await validateStudioBackground(
      await png((x, y) => {
        // bright orange flame reaching the top + left edges (touches the band)
        if (y < BORDER + 20 || x < BORDER + 20) {
          const isCorner = (x < 3 || x >= W - 3) && (y < 3 || y >= H - 3);
          if (isCorner) return [255, 255, 255]; // keep corner anchors white
          return [240, 120, 30];
        }
        return [255, 255, 255];
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("exposes the exact threshold used, for founder-facing reporting", () => {
    expect(OFF_BG_THRESHOLD).toBe(0.05);
  });
});
