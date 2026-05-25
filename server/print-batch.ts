/**
 * print-batch.ts
 * v525 — single-sheet print-and-cut batch generator.
 *
 * Sized to the Cricut Explore 4 Print Then Cut max printable area
 * (165.9 × 234.7mm). A4 (210 × 297mm) forces Cricut Design Space's
 * Auto-Resize, which distorts the label dimensions — so we render at
 * Cricut's exact ceiling and let the home-printer PDF render small on
 * the A4 paper (right and bottom whitespace, no functional impact).
 *
 * LAYOUT (mm, top-left origin):
 *   Page margins: 2mm on all sides (Cricut's printable area is tight —
 *     content row width = 70 + 4 + 85.6 = 159.6mm, page width 165.9mm).
 *   Universal cut gap: 4mm between cells.
 *   Cards per sheet: up to 4 (MAX_CERTS_PER_BATCH).
 *
 *   Per row (left column stacked, right column full row):
 *     - Front label 70×20mm  (top of left column)
 *     - 4mm gap
 *     - Back label  70×20mm  (below front in left column)
 *     - 4mm gap (between columns)
 *     - Claim insert 85.6×54mm (right; row height = insert height)
 *
 *   Row pitch: 58mm (54mm row + 4mm inter-row gap).
 *   4 rows × 54 + 3 × 4 inter-row gaps + 2 × 2mm margins = 232mm — fits
 *   inside the 234.7mm PNG height with 2.7mm spare.
 *
 * THREE OUTPUT FILES (all share batchId in filename):
 *   A) generatePrintBatchPDF()    → 165.9×297mm PDF with artwork only.
 *      Home-printer fallback prints small on A4 paper (right + bottom
 *      whitespace), no cut lines on the PDF — those live in the SVG.
 *   B) generatePrintBatchCutSVG() → 165.9×297mm SVG with cut rectangles only.
 *      Magenta hairline (#FF00FF) on a <g id="cut"> layer. ScanNCut Direct
 *      Cut and Cricut SVG cut path both consume this.
 *   C) generatePrintBatchPNG()    → 165.9×234.7mm Cricut canvas @ 144 DPI
 *      = 941×1331px PNG composite. Cricut Design Space ignores the pHYs
 *      DPI chunk and renders ALL PNGs at 144 DPI internally — sizing the
 *      canvas to 144 DPI is what actually controls the print dimensions on
 *      the Cricut mat. (Earlier 300 / 600 DPI canvases got displayed at
 *      ~87×123cm / ~69×97cm because Cricut reinterpreted them.)
 *
 * Single source of truth: buildLayout() returns the cell array consumed by
 * all three renderers — PDF, SVG and PNG cannot drift from each other.
 *
 * Cut-path bleed inset: 0.25mm per side. Pushes the cut INSIDE the printed
 * gold border so any sub-mm cutter drift slices through the gold rather than
 * the white paper outside it.
 */

import { createHash } from "crypto";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import { generateLabelPNG } from "./labels";
import { generateClaimInsertPNG } from "./claim-insert";
import { uploadToR2 } from "./r2";
import type { CertificateRecord } from "@shared/schema";

// ── Unit conversion ──────────────────────────────────────────────────────────
const MM_TO_PT = 2.83464567;
const mm = (v: number) => v * MM_TO_PT;
const DPI = 144;
const MM_TO_PX = DPI / 25.4;
const mmPx = (v: number) => Math.round(v * MM_TO_PX);

// ── Page dimensions ──────────────────────────────────────────────────────────
// Width is Cricut Explore 4's Print Then Cut max (165.9mm) — shared by all
// three outputs. PDF height stays full A4 (297mm) for home-printer use; PNG
// height matches Cricut's vertical ceiling (234.7mm) to prevent Auto-Resize.
const PAGE_W_MM = 165.9;
const PDF_PAGE_H_MM = 297;
const PNG_PAGE_H_MM = 234.7;

// ── Layout (mm) ──────────────────────────────────────────────────────────────
// MARGIN_MM dropped from 10 → 2 because Cricut's 165.9mm width minus row
// content (70 + 4 + 85.6 = 159.6mm) leaves only 6.3mm total horizontal
// budget for margins. 2mm per side gives 2.3mm spare for cutter tolerance.
const MARGIN_MM = 2;
const GAP_MM = 4;
const LABEL_W_MM = 70;
const LABEL_H_MM = 20;
const INSERT_W_MM = 85.6;
const INSERT_H_MM = 54;
const ROW_H_MM = INSERT_H_MM;
const ROW_PITCH_MM = ROW_H_MM + GAP_MM;

export const MAX_CERTS_PER_BATCH = 4;
export const SHEET_LAYOUT_VERSION = "v2";

// Per-side cut bleed inset — slices through the printed border, not the
// paper outside.
const CUT_INSET_MM = 0.25;
const CUT_STROKE_MM = (0.5 * (1 / MM_TO_PT)).toFixed(4); // 0.5pt → mm
const CUT_STROKE_HEX = "#FF00FF";

// ── Layout spec — single source of truth ─────────────────────────────────────

export interface PrintBatchItem {
  cert: CertificateRecord;
  claimCode: string;
}

interface CellSpec {
  kind: "label" | "back" | "insert";
  itemIndex: number;
  xMm: number;
  yMm: number;
  wMm: number;
  hMm: number;
}

function buildLayout(itemCount: number): CellSpec[] {
  const n = Math.max(1, Math.min(MAX_CERTS_PER_BATCH, itemCount | 0));
  const cells: CellSpec[] = [];
  for (let i = 0; i < n; i++) {
    const rowTopY = MARGIN_MM + i * ROW_PITCH_MM;
    // Front label — left column, top-aligned. Stacked with the back label
    // below (front + 4mm gap + back = 44mm, fits inside the 54mm row height).
    cells.push({
      kind: "label",
      itemIndex: i,
      xMm: MARGIN_MM,
      yMm: rowTopY,
      wMm: LABEL_W_MM,
      hMm: LABEL_H_MM,
    });
    // Back label — left column, stacked below the front (4mm gap).
    // Carries the NFC chip + QR code that must be printed on the physical slab.
    cells.push({
      kind: "back",
      itemIndex: i,
      xMm: MARGIN_MM,
      yMm: rowTopY + LABEL_H_MM + GAP_MM,
      wMm: LABEL_W_MM,
      hMm: LABEL_H_MM,
    });
    // Claim insert — right column, top-aligned.
    cells.push({
      kind: "insert",
      itemIndex: i,
      xMm: MARGIN_MM + LABEL_W_MM + GAP_MM,
      yMm: rowTopY,
      wMm: INSERT_W_MM,
      hMm: INSERT_H_MM,
    });
  }
  return cells;
}

// Render the per-item PNGs in parallel. Used by both the PDF and PNG paths.
async function renderItemBuffers(items: PrintBatchItem[]): Promise<{
  fronts: Buffer[];
  backs: Buffer[];
  inserts: Buffer[];
}> {
  const slice = items.slice(0, MAX_CERTS_PER_BATCH);
  const [fronts, backs, inserts] = await Promise.all([
    Promise.all(slice.map((it) => generateLabelPNG(it.cert, "front"))),
    Promise.all(slice.map((it) => generateLabelPNG(it.cert, "back"))),
    Promise.all(slice.map((it) => generateClaimInsertPNG((it.cert as any).certId || "", it.claimCode))),
  ]);
  return { fronts, backs, inserts };
}

// ── PDF generator (A4 full page) ─────────────────────────────────────────────

export async function generatePrintBatchPDF(items: PrintBatchItem[]): Promise<Buffer> {
  const layout = buildLayout(items.length);
  const { fronts, backs, inserts } = await renderItemBuffers(items);

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: [mm(PAGE_W_MM), mm(PDF_PAGE_H_MM)],
      margin: 0,
      info: {
        Title: `MintVault Print Batch (${SHEET_LAYOUT_VERSION})`,
        Author: "MintVault Trading Card Grading",
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      doc.rect(0, 0, mm(PAGE_W_MM), mm(PDF_PAGE_H_MM)).fill("#FFFFFF");
      for (const cell of layout) {
        const buf =
          cell.kind === "label"
            ? fronts[cell.itemIndex]
            : cell.kind === "back"
              ? backs[cell.itemIndex]
              : inserts[cell.itemIndex];
        doc.image(buf, mm(cell.xMm), mm(cell.yMm), {
          width: mm(cell.wMm),
          height: mm(cell.hMm),
        });
      }
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ── SVG cut-path generator ───────────────────────────────────────────────────
//
// Magenta (#FF00FF) hairline cut rects on a <g id="cut"> layer. Same coord
// system as the PDF (mm, top-left origin). 8 rectangles for a full 4-row
// sheet — 4 fronts + 4 inserts.

export function generatePrintBatchCutSVG(itemCount: number): string {
  const layout = buildLayout(itemCount);
  const insetRect = (cell: CellSpec) =>
    `    <rect x="${(cell.xMm + CUT_INSET_MM).toFixed(4)}" y="${(cell.yMm + CUT_INSET_MM).toFixed(4)}" ` +
    `width="${(cell.wMm - 2 * CUT_INSET_MM).toFixed(4)}" height="${(cell.hMm - 2 * CUT_INSET_MM).toFixed(4)}" ` +
    `fill="none" stroke="${CUT_STROKE_HEX}" stroke-width="${CUT_STROKE_MM}"/>`;

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!-- MintVault Print Batch Cut Guide (${SHEET_LAYOUT_VERSION}) — ${layout.length} cut paths -->`,
    `<!-- A4 ${PAGE_W_MM}×${PDF_PAGE_H_MM}mm | ${CUT_INSET_MM}mm bleed inset per side | stroke ${CUT_STROKE_HEX} -->`,
    `<svg xmlns="http://www.w3.org/2000/svg"`,
    `     width="${PAGE_W_MM}mm" height="${PDF_PAGE_H_MM}mm"`,
    `     viewBox="0 0 ${PAGE_W_MM} ${PDF_PAGE_H_MM}">`,
    `  <g id="cut">`,
    ...layout.map(insetRect),
    `  </g>`,
    `</svg>`,
  ].join("\n");
}

// ── PNG composite — Cricut Print Then Cut ────────────────────────────────────
//
// 165.9×234.7mm (Cricut Explore 4 Print Then Cut max printable area) @ 144
// DPI = 941×1331px. Cricut Design Space ignores the embedded pHYs DPI chunk
// and renders every PNG at 144 DPI internally, so the canvas pixel size at
// 144 DPI is what actually controls the printed dimensions on the mat. 4
// rows × 54mm + 3 × 4mm gaps + 2 × 2mm margins = 232mm content height,
// 2.7mm spare at the bottom for Cricut's registration marks.

export async function generatePrintBatchPNG(items: PrintBatchItem[]): Promise<Buffer> {
  const { createCanvas, loadImage } = await import("canvas");
  const layout = buildLayout(items.length);
  const { fronts, backs, inserts } = await renderItemBuffers(items);

  const widthPx = mmPx(PAGE_W_MM);
  const heightPx = mmPx(PNG_PAGE_H_MM);

  const canvas = createCanvas(widthPx, heightPx);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, widthPx, heightPx);

  for (const cell of layout) {
    const buf =
      cell.kind === "label"
        ? fronts[cell.itemIndex]
        : cell.kind === "back"
          ? backs[cell.itemIndex]
          : inserts[cell.itemIndex];
    const img = await loadImage(buf);
    ctx.drawImage(img, mmPx(cell.xMm), mmPx(cell.yMm), mmPx(cell.wMm), mmPx(cell.hMm));
  }

  // Embed PNG pHYs chunk for any downstream tool that respects it (e.g.
  // home printers reading the metadata to size A4 output). Cricut Design
  // Space itself does NOT honour pHYs — it sizes prints based on raw pixel
  // count at its own assumed 144 DPI, which is why the canvas above is
  // sized at 144 DPI to begin with.
  const rawBuffer = canvas.toBuffer("image/png");
  return sharp(rawBuffer).withMetadata({ density: DPI }).toBuffer();
}

// ── Deterministic batch ID for idempotency ───────────────────────────────────
//
// Hash sorted certIds + admin user + UTC day. Two clicks within the same
// UTC day from the same admin on the same set of certs yield the same
// batchId. Combined with a 5-minute window check in the route handler,
// this prevents duplicate audit_log / labelPrints writes from fat-fingered
// double-clicks. Format keeps `print_batch_${batchId}` searchable.

// ── R2 storage for generated print-batch artifacts ───────────────────────────
//
// PDF and PNG buffers are written to R2 keyed by batchId so the client can
// retrieve them via a stable URL instead of expiring blob URLs. SVG is small
// enough to keep returning inline as base64 in the POST response.
// Key version suffix — bump when the artwork changes in a way that
// invalidates cached objects.
// v2 (2026-05-25): canvas resized from A4 to Cricut Explore 4 max printable
//   area (165.9×234.7mm) so Auto-Resize doesn't distort labels.
// v3 (2026-05-25): DPI dropped 600 → 144 to match Cricut Design Space's
//   internal rendering (it ignores pHYs and assumes 144 DPI).
export function r2KeyForPrintBatch(batchId: string, ext: "pdf" | "png"): string {
  return `print-batches/${batchId}-v3.${ext}`;
}

export async function uploadPrintBatchArtifacts(batchId: string, pdfBuf: Buffer, pngBuf: Buffer): Promise<void> {
  await Promise.all([
    uploadToR2(r2KeyForPrintBatch(batchId, "pdf"), pdfBuf, "application/pdf"),
    uploadToR2(r2KeyForPrintBatch(batchId, "png"), pngBuf, "image/png"),
  ]);
}

export function deriveBatchId(certIds: string[], adminUser: string): string {
  // createHash imported at top level
  const sorted = [...certIds].sort();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  const input = `${adminUser}|${today}|${sorted.join(",")}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}
