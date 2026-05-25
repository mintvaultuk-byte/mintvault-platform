/**
 * print-batch.ts
 * v525 — single-sheet print-and-cut batch generator.
 *
 * Produces THREE files for one A4 sheet of up to 4 cards. Each row contains
 * a front slab label + a claim insert. NFC back labels are not part of the
 * sheet — verification is encoded in the front-label QR + the claim insert
 * QR; a separate "back" print was redundant and wasted label stock.
 *
 * LAYOUT (mm, top-left origin):
 *   Page margins: 10mm top, 10mm left, no enforced bottom margin.
 *   Universal cut gap: 4mm between cells.
 *   Cards per sheet: up to 4 (MAX_CERTS_PER_BATCH).
 *
 *   Per row (left to right):
 *     - Front label 70×20mm (left, vertically centred in the row)
 *     - 4mm gap
 *     - Claim insert 85.6×54mm (right; row height = insert height)
 *
 *   Row pitch: 58mm (54mm row + 4mm inter-row gap).
 *   4 rows × 58mm + 10mm top = 242mm content height — fits both A4 PDF
 *   (297mm) and the 279.4mm PNG used for Cricut Print Then Cut.
 *
 * THREE OUTPUT FILES (all share batchId in filename):
 *   A) generatePrintBatchPDF()    → A4 (210×297mm) PDF with artwork only.
 *      Home-printer fallback. No cut lines on the PDF — those live in the SVG.
 *   B) generatePrintBatchCutSVG() → A4 SVG with cut rectangles only.
 *      Magenta hairline (#FF00FF) on a <g id="cut"> layer. ScanNCut Direct
 *      Cut and Cricut SVG cut path both consume this.
 *   C) generatePrintBatchPNG()    → 210×279.4mm (8.27"×11") @ 300 DPI
 *      = 2480×3300px PNG composite. Cricut Design Space Print Then Cut max
 *      printable area is 215×285mm, so we size slightly under that so the
 *      registration marks Cricut adds during print fit on the page.
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
import { generateLabelPNG } from "./labels";
import { generateClaimInsertPNG } from "./claim-insert";
import type { CertificateRecord } from "@shared/schema";

// ── Unit conversion ──────────────────────────────────────────────────────────
const MM_TO_PT = 2.83464567;
const mm = (v: number) => v * MM_TO_PT;
const DPI = 300;
const MM_TO_PX = DPI / 25.4;
const mmPx = (v: number) => Math.round(v * MM_TO_PX);

// ── Page dimensions ──────────────────────────────────────────────────────────
const PAGE_W_MM = 210;
const PDF_PAGE_H_MM = 297;
const PNG_PAGE_H_MM = 279.4;

// ── Layout (mm) ──────────────────────────────────────────────────────────────
const MARGIN_MM = 10;
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
  kind: "label" | "insert";
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
    // Front label — left column, vertically centred in row (insert is taller).
    cells.push({
      kind: "label",
      itemIndex: i,
      xMm: MARGIN_MM,
      yMm: rowTopY + (ROW_H_MM - LABEL_H_MM) / 2,
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
  inserts: Buffer[];
}> {
  const slice = items.slice(0, MAX_CERTS_PER_BATCH);
  const [fronts, inserts] = await Promise.all([
    Promise.all(slice.map((it) => generateLabelPNG(it.cert, "front"))),
    Promise.all(slice.map((it) => generateClaimInsertPNG((it.cert as any).certId || "", it.claimCode))),
  ]);
  return { fronts, inserts };
}

// ── PDF generator (A4 full page) ─────────────────────────────────────────────

export async function generatePrintBatchPDF(items: PrintBatchItem[]): Promise<Buffer> {
  const layout = buildLayout(items.length);
  const { fronts, inserts } = await renderItemBuffers(items);

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
        const buf = cell.kind === "label" ? fronts[cell.itemIndex] : inserts[cell.itemIndex];
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
// 210×279.4mm @ 300 DPI = 2480×3300px. 4-row layout (242mm content height)
// fits inside the canvas with ~37mm of bottom whitespace — leaves room for
// Cricut's registration marks (which it adds during print, outside the
// content area).

export async function generatePrintBatchPNG(items: PrintBatchItem[]): Promise<Buffer> {
  const { createCanvas, loadImage } = await import("canvas");
  const layout = buildLayout(items.length);
  const { fronts, inserts } = await renderItemBuffers(items);

  const widthPx = mmPx(PAGE_W_MM);
  const heightPx = mmPx(PNG_PAGE_H_MM);

  const canvas = createCanvas(widthPx, heightPx);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, widthPx, heightPx);

  for (const cell of layout) {
    const buf = cell.kind === "label" ? fronts[cell.itemIndex] : inserts[cell.itemIndex];
    const img = await loadImage(buf);
    ctx.drawImage(img, mmPx(cell.xMm), mmPx(cell.yMm), mmPx(cell.wMm), mmPx(cell.hMm));
  }

  return canvas.toBuffer("image/png");
}

// ── Deterministic batch ID for idempotency ───────────────────────────────────
//
// Hash sorted certIds + admin user + UTC day. Two clicks within the same
// UTC day from the same admin on the same set of certs yield the same
// batchId. Combined with a 5-minute window check in the route handler,
// this prevents duplicate audit_log / labelPrints writes from fat-fingered
// double-clicks. Format keeps `print_batch_${batchId}` searchable.

export function deriveBatchId(certIds: string[], adminUser: string): string {
  // createHash imported at top level
  const sorted = [...certIds].sort();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  const input = `${adminUser}|${today}|${sorted.join(",")}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}
