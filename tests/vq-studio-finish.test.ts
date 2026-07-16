/**
 * Deterministic local Action-Pose finishing (studio-finish.ts) — Phase 7 fixtures.
 *
 * Proves the zero-credit cleanup: border-connected near-white backdrop is removed and
 * the subject is re-centred on pure white so the result passes the EXISTING 5%
 * studio-background gate — WITHOUT cropping the creature, WITHOUT removing enclosed
 * pale/white detail, and WITHOUT ever "correcting" a gradient/scenic image into a
 * false candidate. No provider, no network, no credits.
 */
import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { finishStudioBackground, FINISH_MAX_INPUT_BYTES } from "../server/vault-quest/ai/studio-finish";
import { validateStudioBackground } from "../server/vault-quest/ai/bg-validate";

const W = 240;
const H = 240;
const WHITE: [number, number, number] = [248, 248, 248]; // near-white studio backdrop

async function rgba(fill: (x: number, y: number) => [number, number, number, number]): Promise<Buffer> {
  const buf = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const [r, g, b, a] = fill(x, y);
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      buf[i + 3] = a;
    }
  return sharp(buf, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
}
const rgb = (fill: (x: number, y: number) => [number, number, number]) => rgba((x, y) => [...fill(x, y), 255]);

// A body disc centred at (cx,cy) radius r in a distinct colour.
function disc(x: number, y: number, cx: number, cy: number, r: number): boolean {
  return Math.hypot(x - cx, y - cy) <= r;
}

async function passesGate(png: Buffer): Promise<boolean> {
  const v = await validateStudioBackground(png);
  return v.ok && v.offBackgroundFraction <= 0.05;
}

describe("studio-finish — deterministic cleanup + composition", () => {
  it("1. pure-white clean background with a centred creature → ok, passes the gate", async () => {
    const src = await rgb((x, y) => (disc(x, y, 120, 120, 55) ? [40, 90, 160] : [255, 255, 255]));
    const r = await finishStudioBackground(src);
    expect(r.ok).toBe(true);
    expect(await passesGate(r.png!)).toBe(true);
    expect(r.sourceChecksum).toHaveLength(64);
    expect(r.cleanedChecksum).toHaveLength(64);
  });

  it("2. near-white studio backdrop, subject touching an edge → removes backdrop, re-centres, passes", async () => {
    // body centred but a wide arm reaches the right edge (raw would fail the gate)
    const src = await rgb((x, y) => {
      if (disc(x, y, 110, 120, 45)) return [200, 60, 60];
      if (y > 100 && y < 140 && x > 110) return [200, 60, 60]; // wide arm to the right edge
      return WHITE;
    });
    const r = await finishStudioBackground(src);
    expect(r.ok).toBe(true);
    expect(r.method).toBe("chroma");
    expect(r.backgroundFraction).toBeGreaterThan(0.2); // outer backdrop removed
    expect(await passesGate(r.png!)).toBe(true);
  });

  it("3. white-to-grey gradient → refused (not a flat studio backdrop)", async () => {
    const r = await finishStudioBackground(await rgb((x) => {
      const v = Math.round(255 - (x / W) * 80);
      return [v, v, v];
    }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("backdrop_not_plain");
  });

  it("4. textured / scenic backdrop → refused", async () => {
    const r = await finishStudioBackground(await rgb((x, y) => (disc(x, y, 120, 120, 40) ? [200, 60, 60] : [40, 130, 55])));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("backdrop_not_plain");
  });

  it("5. pale-blue aquatic creature on white → ok, the pale-blue body is kept as subject", async () => {
    const paleBlue: [number, number, number] = [175, 205, 235];
    const src = await rgb((x, y) => (disc(x, y, 120, 120, 60) ? paleBlue : WHITE));
    const r = await finishStudioBackground(src);
    expect(r.ok).toBe(true);
    // πr²/(W·H) ≈ π·60²/57600 ≈ 0.196 — the pale-blue body must survive as foreground
    expect(r.subjectFraction).toBeGreaterThan(0.15);
    expect(await passesGate(r.png!)).toBe(true);
  });

  it("6. creature with an ENCLOSED white belly → the enclosed white is preserved (not flood-removed)", async () => {
    // dark ring (r≤60) with a white core (r≤30). The white core is the SAME colour as
    // the backdrop but is enclosed by the dark body ⇒ must NOT be removed.
    const src = await rgb((x, y) => {
      const d = Math.hypot(x - 120, y - 120);
      if (d <= 30) return [252, 252, 252]; // enclosed near-white belly
      if (d <= 60) return [30, 40, 60]; // dark body ring
      return WHITE;
    });
    const r = await finishStudioBackground(src);
    expect(r.ok).toBe(true);
    // Whole body disc (r≤60) must survive: π·60²/57600 ≈ 0.196. If the enclosed white
    // had been wrongly removed, subjectFraction would collapse toward the ring area.
    expect(r.subjectFraction).toBeGreaterThan(0.18);
  });

  it("7. transparent / anti-aliased edges → Path A composites the subject onto white", async () => {
    const src = await rgba((x, y) => {
      const d = Math.hypot(x - 120, y - 120);
      if (d <= 55) return [60, 140, 90, 255];
      if (d <= 60) return [60, 140, 90, Math.round(255 * (60 - d) / 5)]; // AA falloff
      return [0, 0, 0, 0]; // transparent background
    });
    const r = await finishStudioBackground(src);
    expect(r.ok).toBe(true);
    expect(r.method).toBe("alpha");
    expect(await passesGate(r.png!)).toBe(true);
  });

  it("8. long thin tail reaching an edge → tail is preserved (not cropped)", async () => {
    const bodyArea = (Math.PI * 42 * 42) / (W * H);
    const src = await rgb((x, y) => {
      if (disc(x, y, 100, 120, 42)) return [150, 80, 30];
      if (y > 116 && y < 124 && x >= 100) return [150, 80, 30]; // tail to the right edge
      return WHITE;
    });
    const r = await finishStudioBackground(src);
    expect(r.ok).toBe(true);
    expect(r.subjectFraction).toBeGreaterThan(bodyArea); // body + tail retained
    expect(await passesGate(r.png!)).toBe(true);
  });

  it("9. wing reaching the top edge → preserved, passes", async () => {
    const src = await rgb((x, y) => {
      if (disc(x, y, 120, 140, 40)) return [120, 60, 160];
      if (x > 100 && x < 140 && y < 140) return [120, 60, 160]; // wing up to the top edge
      return WHITE;
    });
    const r = await finishStudioBackground(src);
    expect(r.ok).toBe(true);
    expect(await passesGate(r.png!)).toBe(true);
  });

  it("10. multiple tentacles reaching several edges → preserved, passes", async () => {
    const src = await rgb((x, y) => {
      if (disc(x, y, 120, 120, 35)) return [40, 120, 120];
      if (Math.abs(x - 120) < 6 && y < 120) return [40, 120, 120]; // up
      if (Math.abs(y - 120) < 6 && x > 120) return [40, 120, 120]; // right
      if (Math.abs(x - 120) < 6 && y > 120) return [40, 120, 120]; // down
      return WHITE;
    });
    const r = await finishStudioBackground(src);
    expect(r.ok).toBe(true);
    expect(await passesGate(r.png!)).toBe(true);
  });

  it("11. small contained contact shadow → ok, passes", async () => {
    const src = await rgb((x, y) => {
      if (disc(x, y, 120, 110, 45)) return [180, 90, 40];
      if (Math.hypot((x - 120) / 30, (y - 158) / 8) < 1) return [205, 205, 205]; // faint shadow
      return WHITE;
    });
    const r = await finishStudioBackground(src);
    expect(r.ok).toBe(true);
    expect(await passesGate(r.png!)).toBe(true);
  });

  it("12. large dark shadow filling the bottom edge → SAFELY REFUSED (non-uniform backdrop, never a false candidate)", async () => {
    const src = await rgb((x, y) => {
      if (disc(x, y, 120, 100, 45)) return [180, 90, 40];
      if (y > 150) return [200, 200, 200]; // broad dark shadow to the bottom edge
      return WHITE;
    });
    const r = await finishStudioBackground(src);
    // Either it is cleaned to a gate-passing result, or it is safely refused — never a
    // silent bad candidate. A dark shadow occupying a whole edge makes the backdrop
    // non-uniform, so the deterministic choice is to refuse and keep the quarantine.
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("backdrop_not_plain");
  });

  it("13. bright particles/effects touching the edge → gate-passing result", async () => {
    const src = await rgb((x, y) => {
      if (disc(x, y, 120, 120, 40)) return [200, 120, 40];
      if (disc(x, y, 20, 20, 8) || disc(x, y, 225, 30, 7)) return [255, 160, 40]; // edge sparks
      return WHITE;
    });
    const r = await finishStudioBackground(src);
    expect(r.ok).toBe(true);
    expect(await passesGate(r.png!)).toBe(true);
  });

  it("14. low-confidence: a near-white subject on white cannot be safely isolated → refused", async () => {
    // creature colour is within the backdrop tolerance ⇒ inseparable ⇒ must refuse,
    // never eat the subject and pretend success.
    const src = await rgb((x, y) => (disc(x, y, 120, 120, 55) ? [250, 250, 251] : WHITE));
    const r = await finishStudioBackground(src);
    expect(r.ok).toBe(false);
    expect(["subject_lost", "no_background_removed"]).toContain(r.reason);
  });

  it("15. subject touching the frame edge on multiple sides → re-centred, passes", async () => {
    const src = await rgb((x, y) => (disc(x, y, 120, 120, 95) ? [70, 110, 40] : WHITE)); // big disc near all edges
    const r = await finishStudioBackground(src);
    expect(r.ok).toBe(true);
    expect(await passesGate(r.png!)).toBe(true);
  });

  it("16. multiple disconnected legitimate coloured details → all kept, passes", async () => {
    const src = await rgb((x, y) => {
      if (disc(x, y, 120, 120, 35)) return [160, 60, 60]; // body
      if (disc(x, y, 70, 70, 12) || disc(x, y, 175, 80, 12) || disc(x, y, 150, 175, 10)) return [60, 60, 170]; // orbs
      return WHITE;
    });
    const r = await finishStudioBackground(src);
    expect(r.ok).toBe(true);
    expect(await passesGate(r.png!)).toBe(true);
    // the three orbs (disconnected, coloured) are retained as part of the subject
    expect(r.subjectFraction).toBeGreaterThan((Math.PI * 35 * 35) / (W * H));
  });

  it("never crops: the composed output preserves the full subject aspect (no limb loss)", async () => {
    const src = await rgb((x, y) => {
      if (disc(x, y, 120, 120, 30)) return [150, 80, 30];
      if (Math.abs(y - 120) < 5) return [150, 80, 30]; // full-width horizontal limb, edge to edge
      return WHITE;
    });
    const r = await finishStudioBackground(src);
    expect(r.ok).toBe(true);
    // a full-width limb means the subject bbox aspect is very wide; after fit-inside
    // scaling it is preserved (not stretched/cropped) ⇒ still passes the gate.
    expect(await passesGate(r.png!)).toBe(true);
  });

  it("security: oversized input is refused before decode", async () => {
    const r = await finishStudioBackground(Buffer.alloc(FINISH_MAX_INPUT_BYTES + 1));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("input_too_large");
  });

  it("security: garbage / undecodable bytes are refused safely", async () => {
    const r = await finishStudioBackground(Buffer.from("this is not an image"));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("decode_failed");
  });
});

describe("studio-finish — REVIEW: disconnected-detail preservation (Phase 2)", () => {
  // Vault Quest art is cel-shaded with crisp DARK linework. A legitimate disconnected
  // detail therefore has its own dark outline, which STOPS the border flood-fill — so
  // the detail's (even white) interior is enclosed and preserved. This is the core
  // reason the "white-on-white" limitation is not material for the real art style.
  it("a disconnected detail WITH a dark outline keeps its enclosed white core (outline blocks the fill)", async () => {
    const outlined = await rgb((x, y) => {
      if (disc(x, y, 120, 120, 34)) return [150, 70, 40]; // body
      const d = Math.hypot(x - 60, y - 62); // separate detail, far from the body
      if (d <= 16 && d > 11) return [20, 20, 30]; // dark outline ring
      if (d <= 11) return [252, 252, 252]; // enclosed near-white core
      return WHITE;
    });
    const outlinedR = await finishStudioBackground(outlined);
    // Same detail but with NO outline — a plain near-white blob on white (the documented
    // limitation): its core is indistinguishable from backdrop and is removed.
    const plain = await rgb((x, y) => {
      if (disc(x, y, 120, 120, 34)) return [150, 70, 40];
      if (disc(x, y, 60, 62, 16)) return [252, 252, 252]; // outline-less near-white blob
      return WHITE;
    });
    const plainR = await finishStudioBackground(plain);
    expect(outlinedR.ok).toBe(true);
    expect(plainR.ok).toBe(true);
    // The outlined detail retains materially MORE foreground (its enclosed core survives)
    // than the outline-less blob — proving the cel-outline preservation mechanism.
    expect(outlinedR.subjectFraction).toBeGreaterThan(plainR.subjectFraction);
  });

  it("a CLEARLY-COLOURED detail is NEVER removed, even disconnected and far from the body", async () => {
    // Anything unambiguously not-backdrop (distance ≫ tolerance) must survive wherever it is.
    const src = await rgb((x, y) => {
      if (disc(x, y, 120, 120, 30)) return [150, 70, 40];
      if (disc(x, y, 40, 40, 10) || disc(x, y, 200, 205, 9)) return [30, 60, 200]; // far blue details
      return WHITE;
    });
    const r = await finishStudioBackground(src);
    expect(r.ok).toBe(true);
    // body + both blue details retained: π(30²)+π(10²)+π(9²) ≈ 3400 → ~0.059
    expect(r.subjectFraction).toBeGreaterThan(0.055);
  });
});

describe("studio-finish — REVIEW: memory / decompression safety (Phase 4)", () => {
  it("zero-length buffer refuses safely", async () => {
    const r = await finishStudioBackground(Buffer.alloc(0));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("decode_failed");
  });

  it("a single-channel (grayscale) image is handled via ensureAlpha (no crash)", async () => {
    const gray = await sharp(Buffer.alloc(W * H, 248), { raw: { width: W, height: H, channels: 1 } })
      .png()
      .toBuffer();
    const r = await finishStudioBackground(gray);
    // A blank grey field has no separable subject → refuses safely (never throws).
    expect(typeof r.ok).toBe("boolean");
    expect(r.ok).toBe(false);
  });

  it("a large valid image is DOWNSCALED before raw extraction (bounded memory)", async () => {
    const big = await sharp({ create: { width: 3000, height: 3000, channels: 3, background: { r: 255, g: 255, b: 255 } } })
      .composite([{ input: await rgb((x, y) => (disc(x, y, 120, 120, 55) ? [40, 90, 160] : WHITE)).then((b) => b), gravity: "centre" }])
      .png()
      .toBuffer();
    const r = await finishStudioBackground(big);
    expect(r.width).toBeLessThanOrEqual(1400); // ANALYSIS_MAX_DIM cap
    expect(r.height).toBeLessThanOrEqual(1400);
  });

  it("an oversized-pixel image (decompression bomb) is refused before allocation", async () => {
    // 6500×6500 = 42.25M pixels > MAX_PIXELS (40M): sharp's limitInputPixels refuses to
    // decode it, so we never allocate the raw buffer. Compresses tiny (solid colour).
    const bomb = await sharp({ create: { width: 6500, height: 6500, channels: 3, background: { r: 255, g: 255, b: 255 } } })
      .png()
      .toBuffer();
    const r = await finishStudioBackground(bomb);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("decode_failed");
  });
});
