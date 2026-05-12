/**
 * Instagram post image generator.
 *
 * Strategy: sharp creates a 1080×1080 background buffer (no rasterisation
 * of fonts), then composites a pre-built SVG layer on top. SVG handles
 * all text + shapes; sharp handles the final raster.
 *
 * This intentionally does NOT use node-canvas — that's already used heavily
 * for slab labels (server/labels.ts) and the claim insert (server/claim-insert.ts).
 * Reusing the same renderer here would invite font/cache cross-contamination
 * and make memory profiling harder; sharp + inline SVG keeps the IG pipeline
 * isolated.
 *
 * Font: Bodoni Moda 900 is base64-embedded inside the SVG (see svg-builders.ts)
 * specifically for the MintVault wordmark. Other text falls back to system
 * Helvetica / Arial / Georgia. On Fly/Debian-slim runtime these resolve to
 * DejaVu equivalents.
 */
import sharp from "sharp";
import { BRAND, buildSvg } from "./svg-builders";
import type { IgPostData } from "./types";

export async function generateIgImage(data: IgPostData): Promise<Buffer> {
  const svg = buildSvg(data);
  const svgBuffer = Buffer.from(svg, "utf-8");

  // sharp composes the SVG directly onto a coloured background. The SVG
  // already paints its own full-bleed rect so the create-background colour
  // is just a fallback if the SVG fails to parse for any reason.
  const png = await sharp({
    create: {
      width:    1080,
      height:   1080,
      channels: 4,
      background: BRAND.dark,
    },
  })
    .composite([{ input: svgBuffer, top: 0, left: 0 }])
    .png({ compressionLevel: 9 })
    .toBuffer();

  return png;
}

// Re-export so callers don't need to import from svg-builders directly.
export { buildSvg } from "./svg-builders";
export type { IgPostData } from "./types";
