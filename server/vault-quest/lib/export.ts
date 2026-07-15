import sharp from "sharp";
import PDFDocument from "pdfkit";
import type { TemplateLock } from "./types";

const MM_TO_PT = 72 / 25.4;
const MM_TO_IN = 1 / 25.4;

/**
 * PNG from the final SVG — one renderer, zero drift between preview and print master.
 * density is set so the 69mm canvas rasterises at the requested DPI.
 */
export async function svgToPng(svg: string, lock: TemplateLock, dpi: number): Promise<Buffer> {
  const [wMm, hMm] = lock.canvas_mm;
  const widthPx = Math.round(wMm * MM_TO_IN * dpi);
  return sharp(Buffer.from(svg), { density: dpi })
    .resize(widthPx, Math.round(hMm * MM_TO_IN * dpi), { fit: "fill" })
    .png()
    .toBuffer();
}

/**
 * Print-ready PDF: true 69×94mm page (63×88 trim + 3mm bleed), 600-DPI master
 * raster full-bleed, hairline crop marks in the bleed corners aligned with the
 * trim edges (stopping 1mm short of the trim corner).
 */
export function cardPdf(masterPng: Buffer, lock: TemplateLock): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const [cw, ch] = lock.canvas_mm;
    const [tw, th] = lock.trim_mm;
    const b = lock.bleed_mm;
    const W = cw * MM_TO_PT,
      H = ch * MM_TO_PT;
    const t = { x: b * MM_TO_PT, y: b * MM_TO_PT, w: tw * MM_TO_PT, h: th * MM_TO_PT };
    const markLen = (b - 1) * MM_TO_PT;

    const doc = new PDFDocument({ size: [W, H], margin: 0 });
    const pageBoxes = doc.page.dictionary.data as Record<string, unknown>;
    pageBoxes.TrimBox = [t.x, t.y, t.x + t.w, t.y + t.h];
    pageBoxes.BleedBox = [0, 0, W, H];
    pageBoxes.CropBox = [0, 0, W, H];
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.image(masterPng, 0, 0, { width: W, height: H });

    doc.lineWidth(0.25).strokeColor("#000000");
    const marks: [number, number, number, number][] = [
      [t.x, 0, t.x, markLen],
      [0, t.y, markLen, t.y], // top-left
      [t.x + t.w, 0, t.x + t.w, markLen],
      [W, t.y, W - markLen, t.y], // top-right
      [t.x, H, t.x, H - markLen],
      [0, t.y + t.h, markLen, t.y + t.h], // bottom-left
      [t.x + t.w, H, t.x + t.w, H - markLen],
      [W, t.y + t.h, W - markLen, t.y + t.h], // bottom-right
    ];
    for (const [x1, y1, x2, y2] of marks) doc.moveTo(x1, y1).lineTo(x2, y2).stroke();

    doc.end();
  });
}
