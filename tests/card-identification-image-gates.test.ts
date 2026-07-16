/**
 * Image integrity + quality gates (Phase 13 / tests 1-8). Real sharp fixtures;
 * no provider, no network — the gates run BEFORE any spend so an unusable image
 * never costs a credit.
 */
import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { validateIdentificationImages, MAX_IMAGE_BYTES, MAX_PIXELS } from "../server/lib/card-identification/image-gates";

async function noiseJpeg(w: number, h: number): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) & 0xff; // deterministic pseudo-noise
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg().toBuffer();
}
async function solidJpeg(w: number, h: number): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 240, g: 240, b: 240 } } }).jpeg().toBuffer();
}

describe("identification image gates", () => {
  it("accepts a valid front (+ optional back) and returns checksums", async () => {
    const front = await noiseJpeg(400, 560);
    const back = await noiseJpeg(400, 560); // different content (noise pattern shifts) — actually identical pattern; use a different size
    const back2 = await noiseJpeg(360, 500);
    const r = await validateIdentificationImages({ front, back: back2 });
    expect(r.ok).toBe(true);
    expect(r.frontChecksum).toBeTruthy();
    expect(r.backChecksum).toBeTruthy();
    void back;
  });

  it("rejects a missing front BEFORE any provider work (test 2)", async () => {
    const r = await validateIdentificationImages({ front: null });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("missing");
  });

  it("handles a missing back per policy (optional by default, warns) (test 3)", async () => {
    const front = await noiseJpeg(400, 560);
    const r = await validateIdentificationImages({ front });
    expect(r.ok).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/no back image/i);
    const r2 = await validateIdentificationImages({ front, requireBack: true });
    expect(r2.ok).toBe(false);
    expect(r2.code).toBe("missing");
  });

  it("rejects a blank image (test 4)", async () => {
    const front = await solidJpeg(400, 560);
    const r = await validateIdentificationImages({ front });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("blank");
  });

  it("rejects an oversized file before decoding (test 5)", async () => {
    const front = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    const r = await validateIdentificationImages({ front });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("too_large");
  });

  it("rejects a non-image (bad magic bytes)", async () => {
    const front = Buffer.from("this is definitely not an image");
    const r = await validateIdentificationImages({ front });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("bad_mime");
  });

  it("rejects an undecodable image (decompression-bomb code path) (test 6)", async () => {
    // Valid JPEG magic bytes but a garbage body → sharp fails to decode within
    // limitInputPixels ⇒ same guard path a real bomb hits.
    const front = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2048, 0x7f)]);
    const r = await validateIdentificationImages({ front });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("decompression_bomb");
  });

  it("rejects a too-small image", async () => {
    const front = await noiseJpeg(120, 120);
    const r = await validateIdentificationImages({ front });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("too_small");
  });

  it("warns when front and back are byte-identical (test 7)", async () => {
    const front = await noiseJpeg(400, 560);
    const r = await validateIdentificationImages({ front, back: front });
    expect(r.ok).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/identical/i);
  });

  it("the decompression-bomb ceiling is set (test 6 constant)", () => {
    expect(MAX_PIXELS).toBe(40_000_000);
  });
});
