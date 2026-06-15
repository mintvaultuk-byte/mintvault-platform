/**
 * print-batch.ts
 * v3 — guillotine PDF on full A4; PNG/SVG stay on the Cricut sheet.
 *
 * THE PDF IS NO LONGER CUT ON THE CRICUT. It's a guillotine sheet now, so it
 * uses full A4 (210×297mm) with margins above the inkjet's unprintable edge.
 * The PNG + SVG (Cricut Explore 4 Print Then Cut max area, 165.9×234.7mm)
 * are still emitted for any downstream Cricut tooling and produce the same
 * output as before for ≤4-cert inputs — they're explicitly held byte-stable.
 *
 * PDF LAYOUT (mm, top-left origin, FULL A4):
 *   Page: 210 × 297mm (A4).
 *   Top + bottom margins: 16.5mm each — clear of the inkjet's ~3–5mm
 *     unprintable edge (the previous 2mm top landed inside it; MV78 lost
 *     its top border).
 *   Rows: 5 cert rows, slab-pair-driven row height (44mm).
 *   Inter-row gap: 11mm — clear guillotine lane between every label.
 *   Per row: [front 70×20mm stacked over back 70×20mm with 4mm gap]
 *            | 8mm horizontal gap | claim insert 69.74×44mm (aspect 1.585
 *            preserved; shrunk from 85.6×54 so it fits the row height
 *            without overflowing into the next row's guillotine lane).
 *   Block is centred horizontally; left + right margins = 31.13mm each.
 *   Vertical sum: 16.5 + 5×44 + 4×11 + 16.5 = 297mm (exact A4 fit, asserted
 *     at module load).
 *
 * CRICUT LAYOUT (mm, PNG + SVG) — UNCHANGED:
 *   165.9 × 234.7mm canvas, 2mm margins, 4mm gaps, 4-row sheet.
 *   Row pitch 58mm, content height 232mm with 2.7mm spare. See buildLayout().
 *
 * THREE OUTPUT FILES (all share batchId in filename):
 *   A) generatePrintBatchPDF()    → 210×297mm A4 PDF, 5 cert rows,
 *      drawLabelCropMarks on every slab label for guillotine alignment.
 *   B) generatePrintBatchCutSVG() → 165.9×297mm Cricut SVG cut path.
 *      Magenta hairline (#FF00FF) on a <g id="cut"> layer.
 *   C) generatePrintBatchPNG()    → 165.9×234.7mm Cricut canvas @ 144 DPI
 *      = 941×1331px PNG composite. Cricut Design Space ignores the pHYs
 *      DPI chunk and applies a fixed 144 DPI to the raw pixel count — so the
 *      canvas pixel count at 144 DPI is what controls the print dimensions on
 *      the Cricut mat. (Measured: a 3919px-wide canvas with a 600 DPI pHYs
 *      chunk rendered at 69.13cm = 3919÷144, confirming pHYs is ignored and a
 *      fixed 144 DPI is applied. The v4 627px/"96 DPI" canvas printed
 *      undersized at 11.06cm.)
 *
 * Two layout builders: buildPdfLayout() for the A4 guillotine sheet,
 * buildLayout() for the Cricut PNG/SVG path. The two can drift safely now
 * that they target different physical sheets and tooling.
 *
 * Cut-path bleed inset (SVG only): 0.25mm per side. Pushes the cut INSIDE
 * the printed gold border so any sub-mm cutter drift slices through the gold
 * rather than the white paper outside it.
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
// Cricut Design Space ignores the PNG pHYs DPI chunk and applies a fixed 144
// DPI to the raw pixel count. So the canvas must be sized at 144 DPI for the
// print to land at its true mm dimensions on the Cricut mat. At 144 DPI:
// 165.9mm → 941px, 234.7mm → 1331px (16.59×23.47cm — Print Then Cut max area).
const DPI = 144;
const MM_TO_PX = DPI / 25.4;
const mmPx = (v: number) => Math.round(v * MM_TO_PX);

// High-quality print PNG DPI — separate from the Cricut-sizing DPI above. Used
// only by generatePrintBatchPrintPNG (165.9mm → 2613px, 234.7mm → 3697px).
const PRINT_DPI = 400;
const PRINT_MM_TO_PX = PRINT_DPI / 25.4;
const printMmPx = (v: number) => Math.round(v * PRINT_MM_TO_PX);

// ── Page dimensions ──────────────────────────────────────────────────────────
// PNG + SVG (Cricut Explore 4 Print Then Cut max area, 165.9×234.7mm) keep
// their existing dimensions — guillotine-only now, but the Cricut output is
// still emitted for downstream tooling and must be byte-identical for ≤4-cert
// inputs. PDF moves to FULL A4 (210×297mm) because it's no longer cut on the
// Cricut, so the 165.9mm safe-area constraint no longer applies to this path.
const PAGE_W_MM = 165.9;
const PDF_PAGE_W_MM = 210; // full A4 — guillotine PDF only
const PDF_PAGE_H_MM = 297;
const PNG_PAGE_H_MM = 234.7;

// ── Layout (mm) — PNG + SVG (Cricut) ─────────────────────────────────────────
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

// ── Cricut PNG 5-up layout (slab labels + NFC backs only, NO claim insert) ───
// The Cricut PNG drops the claim insert, so each row only needs the slab pair
// (front + 4mm gap + back = 44mm) — not the insert-driven 54mm row. That frees
// enough vertical room to fit 5 certs in PNG_PAGE_H_MM (234.7mm), where the old
// 58mm pitch capped the sheet at 4. Vertical sum: 2 (top) + 5×44 + 4×2.5 = 232mm,
// leaving 2.7mm bottom spare for Cricut's registration marks. The SVG + PDF
// paths use their own builders and are unaffected.
// Cricut-specific slab-label size — taller (21mm) than the global LABEL_H_MM
// (20mm, shared with the PDF + slab rendering, which must NOT change). 4-up now.
const CRICUT_LABEL_W_MM = 70;
const CRICUT_LABEL_H_MM = 21;
const CRICUT_PNG_ROW_COUNT = 5;
const CRICUT_PNG_SLAB_PAIR_H_MM = CRICUT_LABEL_H_MM + 2 + CRICUT_LABEL_H_MM; // 44 (2mm gap)
const CRICUT_PNG_INTER_ROW_GAP_MM = 2.5; // more spacing with only 4 rows
const CRICUT_PNG_ROW_PITCH_MM = CRICUT_PNG_SLAB_PAIR_H_MM + CRICUT_PNG_INTER_ROW_GAP_MM; // 54

// Static assertion — the 5-up Cricut PNG column MUST fit within PNG_PAGE_H_MM.
// Throws at import time if a constant edit breaks the fit (mirrors the PDF guard).
{
  const vSum =
    MARGIN_MM +
    CRICUT_PNG_ROW_COUNT * CRICUT_PNG_SLAB_PAIR_H_MM +
    (CRICUT_PNG_ROW_COUNT - 1) * CRICUT_PNG_INTER_ROW_GAP_MM;
  if (vSum > PNG_PAGE_H_MM) {
    throw new Error(
      `print-batch.ts: Cricut PNG ${CRICUT_PNG_ROW_COUNT}-up layout sums to ${vSum}mm, exceeds ${PNG_PAGE_H_MM}mm`
    );
  }
}

// ── Layout (mm) — Guillotine PDF (A4, 5 rows, spread for cutting) ────────────
// Replaces the Cricut-tight 2mm margin + 4mm gap layout with a full-A4 page
// that puts a clear guillotine lane between every label. Top/bottom margins
// sit above the inkjet's ~3–5mm unprintable-edge floor (the previous 2mm top
// margin landed inside it — MV78 lost its top border).
//
// Slab label dimensions are PRESERVED (70 × 20mm) per spec. Row height is
// driven by the slab pair (front + 4mm + back = 44mm), NOT by the claim
// insert: the insert is rescaled to fit the same 44mm row height with its
// 1.585 aspect preserved (→ 69.74 × 44mm). Without this rescale, 5 rows of
// 54mm-tall inserts + 10mm margins would force the inter-row gap to 1.75mm —
// well below the 10mm guillotine-blade clearance the operator needs.
//
// Vertical sum: 16.5 + 5×44 + 4×11 + 16.5 = 297mm (exact A4 fit).
// Horizontal sum: 31.13 + 70 + 8 + 69.74 + 31.13 = 210mm (block centred).
const PDF_ROW_COUNT = 5;
const PDF_TOP_MARGIN_MM = 16.5;
const PDF_BOTTOM_MARGIN_MM = 16.5;
const PDF_INTER_ROW_GAP_MM = 11; // mid-target of the spec's 10–12mm range
const PDF_HORIZ_GAP_MM = 8; // spec floor for vertical-cut clearance
const PDF_SLAB_PAIR_H_MM = LABEL_H_MM + GAP_MM + LABEL_H_MM; // 44
const PDF_INSERT_W_MM = 69.74; // 44 × (85.6 / 54), aspect preserved
const PDF_INSERT_H_MM = 44;

// Cricut PNG claim-insert column — reuses the PDF's reduced insert size so the
// insert is the SAME height as the slab pair (44mm). Row height/pitch and the
// 5-up vertical fit are therefore unchanged. Declared here (not beside the
// CRICUT_PNG block above) because it references PDF_INSERT_*, defined just above.
const CRICUT_INSERT_W_MM = PDF_INSERT_W_MM; // 69.74mm
const CRICUT_INSERT_H_MM = PDF_INSERT_H_MM; // 44mm
const CRICUT_HORIZ_GAP_MM = GAP_MM; // 4mm
const PDF_ROW_H_MM = Math.max(PDF_SLAB_PAIR_H_MM, PDF_INSERT_H_MM); // 44
const PDF_CONTENT_W_MM = LABEL_W_MM + PDF_HORIZ_GAP_MM + PDF_INSERT_W_MM; // 147.74
const PDF_LEFT_MARGIN_MM = (PDF_PAGE_W_MM - PDF_CONTENT_W_MM) / 2; // 31.13

// Static assertion — the vertical layout MUST close to 297mm on module load.
// If anyone edits a constant above without rebalancing, this throws at import
// time rather than silently producing a clipped or oversized PDF.
{
  const vSum =
    PDF_TOP_MARGIN_MM +
    PDF_ROW_COUNT * PDF_ROW_H_MM +
    (PDF_ROW_COUNT - 1) * PDF_INTER_ROW_GAP_MM +
    PDF_BOTTOM_MARGIN_MM;
  if (Math.abs(vSum - PDF_PAGE_H_MM) > 0.5) {
    throw new Error(`print-batch.ts: PDF vertical layout sums to ${vSum}mm, expected ${PDF_PAGE_H_MM}mm`);
  }
}

// ── 9-up edge-to-edge guillotine PDF (3 cols × 3 rows, stacked units) ────────
// Each unit is one 70mm-wide vertical column: front 21mm / back 21mm / insert
// 44mm = 86mm tall. NO page margins — units start at x=0,70,140 and y=0,86,172.
// Used height = 3×86 = 258mm, leaving the bottom 39mm of the A4 page empty.
const PDF9_LABEL_W_MM = 70;
const PDF9_FRONT_H_MM = 21;
const PDF9_BACK_H_MM = 21;
const PDF9_INSERT_H_MM = 44;
const PDF9_UNIT_H_MM = PDF9_FRONT_H_MM + PDF9_BACK_H_MM + PDF9_INSERT_H_MM; // 86
const PDF9_COLS = 3;
const PDF9_ROWS = 3;
const PDF9_INSERT_W_MM = 70;
const MAX_CERTS_PER_PDF9 = PDF9_COLS * PDF9_ROWS; // 9

// Public cap — the route validator + UI use this. Bumped 4 → 5 for the new
// PDF row count. The Cricut PNG/SVG path keeps its own internal cap (4) below
// so the Cricut sheet stays untouched even if a caller passes 5.
export const MAX_CERTS_PER_BATCH = 9;
const MAX_CERTS_PER_CRICUT_SHEET = 4;
export const SHEET_LAYOUT_VERSION = "v20";

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
  // Cricut PNG + SVG cap — held separate from MAX_CERTS_PER_BATCH (which
  // grew to 5 for the A4 PDF) so the Cricut sheet stays at its byte-stable
  // 4-row form. 5-cert callers get a 4-cert Cricut sheet; the PDF carries
  // the 5th cert.
  const n = Math.max(1, Math.min(MAX_CERTS_PER_CRICUT_SHEET, itemCount | 0));
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

// Cricut PNG layout — 5-up, slab labels (front) + NFC backs ONLY, no claim
// insert. Deliberately NOT buildLayout(): that builder is shared with the 4-up
// SVG cut path, which must stay untouched. This own builder caps at 5 and uses
// the reduced CRICUT_PNG_ROW_PITCH_MM (46.5mm) so 5 slab pairs fit the Cricut
// canvas height. Left-column label + back structure is identical to buildLayout;
// only the insert column and the row cap/pitch differ.
function buildCricutPNGLayout(itemCount: number): CellSpec[] {
  const n = Math.max(1, Math.min(CRICUT_PNG_ROW_COUNT, itemCount | 0));
  const cells: CellSpec[] = [];
  for (let i = 0; i < n; i++) {
    const rowTopY = MARGIN_MM + i * CRICUT_PNG_ROW_PITCH_MM;
    // Front label — left column, top-aligned. Cricut-specific 70×21mm size.
    cells.push({
      kind: "label",
      itemIndex: i,
      xMm: MARGIN_MM,
      yMm: rowTopY,
      wMm: CRICUT_LABEL_W_MM,
      hMm: CRICUT_LABEL_H_MM,
    });
    // Back label (NFC chip + QR) — left column, stacked below the front.
    cells.push({
      kind: "back",
      itemIndex: i,
      xMm: MARGIN_MM,
      yMm: rowTopY + CRICUT_LABEL_H_MM + GAP_MM,
      wMm: CRICUT_LABEL_W_MM,
      hMm: CRICUT_LABEL_H_MM,
    });
    // Claim insert — right column, top-aligned. Reduced size (69.74×44mm) so it
    // matches the slab-pair height; horizontal fit: 2 + 70 + 4 + 69.74 = 145.74mm
    // ≤ 165.9mm canvas width.
    cells.push({
      kind: "insert",
      itemIndex: i,
      xMm: MARGIN_MM + LABEL_W_MM + CRICUT_HORIZ_GAP_MM,
      yMm: rowTopY,
      wMm: CRICUT_INSERT_W_MM,
      hMm: CRICUT_INSERT_H_MM,
    });
  }
  return cells;
}

// Cricut cut guide that matches the Cricut PNG EXACTLY — same canvas
// (PAGE_W_MM × PNG_PAGE_H_MM) and the same cells from buildCricutPNGLayout, so
// when imported into Design Space on a Cut layer over the printed PNG, every
// label + insert gets a cut path pixel-aligned to its printed artwork. One
// <rect> per cell at the cell's exact mm coords. Hairline black stroke —
// Design Space uses the path geometry, not the stroke appearance. NO bleed
// inset (unlike generatePrintBatchCutSVG): the cut sits on the cell edge so it
// lines up with the PNG, not inside a printed border.
export function generateCricutSVG(items: PrintBatchItem[]): string {
  const layout = buildCricutPNGLayout(items.length);
  const rect = (c: CellSpec) =>
    `    <rect x="${c.xMm.toFixed(4)}" y="${c.yMm.toFixed(4)}" ` +
    `width="${c.wMm.toFixed(4)}" height="${c.hMm.toFixed(4)}" ` +
    `fill="none" stroke="#000000" stroke-width="0.1"/>`;
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!-- MintVault Cricut Cut Guide (${SHEET_LAYOUT_VERSION}) — ${layout.length} cut paths, aligned to the Cricut PNG -->`,
    `<svg xmlns="http://www.w3.org/2000/svg"`,
    `     width="${PAGE_W_MM}mm" height="${PNG_PAGE_H_MM}mm"`,
    `     viewBox="0 0 ${PAGE_W_MM} ${PNG_PAGE_H_MM}">`,
    `  <g id="cut">`,
    ...layout.map(rect),
    `  </g>`,
    `</svg>`,
  ].join("\n");
}

// Guillotine PDF layout — 5 rows on full A4, slab pair + insert per row.
// Mirrors buildLayout's `kind` semantics so drawLabelCropMarks works without
// modification. Coordinates are computed from the PDF_* constants above so
// changing the spec (margins, gap, row count) only touches the constants —
// the static assertion at import time catches any breakage in the sum.
function buildPdfLayout(itemCount: number): CellSpec[] {
  const n = Math.max(1, Math.min(PDF_ROW_COUNT, itemCount | 0));
  const pitch = PDF_ROW_H_MM + PDF_INTER_ROW_GAP_MM;
  const cells: CellSpec[] = [];
  for (let i = 0; i < n; i++) {
    const rowTopY = PDF_TOP_MARGIN_MM + i * pitch;
    cells.push({
      kind: "label",
      itemIndex: i,
      xMm: PDF_LEFT_MARGIN_MM,
      yMm: rowTopY,
      wMm: LABEL_W_MM,
      hMm: LABEL_H_MM,
    });
    cells.push({
      kind: "back",
      itemIndex: i,
      xMm: PDF_LEFT_MARGIN_MM,
      yMm: rowTopY + LABEL_H_MM + GAP_MM,
      wMm: LABEL_W_MM,
      hMm: LABEL_H_MM,
    });
    cells.push({
      kind: "insert",
      itemIndex: i,
      xMm: PDF_LEFT_MARGIN_MM + LABEL_W_MM + PDF_HORIZ_GAP_MM,
      yMm: rowTopY,
      wMm: PDF_INSERT_W_MM,
      hMm: PDF_INSERT_H_MM,
    });
  }
  return cells;
}

// 9-up edge-to-edge layout — 3 cols × 3 rows of stacked units (front/back/insert),
// no margins. Caps at 9 (MAX_CERTS_PER_PDF9). cellX = col×70, unitTopY = row×86.
function buildPdf9Layout(itemCount: number): CellSpec[] {
  const n = Math.max(1, Math.min(MAX_CERTS_PER_PDF9, itemCount | 0));
  const cells: CellSpec[] = [];
  for (let i = 0; i < n; i++) {
    const col = i % PDF9_COLS;
    const row = Math.floor(i / PDF9_COLS);
    const cellX = col * PDF9_LABEL_W_MM;
    const unitTopY = row * PDF9_UNIT_H_MM;
    cells.push({
      kind: "label",
      itemIndex: i,
      xMm: cellX,
      yMm: unitTopY,
      wMm: PDF9_LABEL_W_MM,
      hMm: PDF9_FRONT_H_MM,
    });
    cells.push({
      kind: "back",
      itemIndex: i,
      xMm: cellX,
      yMm: unitTopY + PDF9_FRONT_H_MM,
      wMm: PDF9_LABEL_W_MM,
      hMm: PDF9_BACK_H_MM,
    });
    cells.push({
      kind: "insert",
      itemIndex: i,
      xMm: cellX,
      yMm: unitTopY + PDF9_FRONT_H_MM + PDF9_BACK_H_MM,
      wMm: PDF9_INSERT_W_MM,
      hMm: PDF9_INSERT_H_MM,
    });
  }
  return cells;
}

// Render the per-item PNGs in parallel. Used by the PDF, PNG and print-PNG
// paths. `cap` defaults to MAX_CERTS_PER_BATCH (5) so the Cricut PNG/print-PNG
// callers (which pass no cap) render exactly 5 — unchanged. The 9-up PDF passes
// MAX_CERTS_PER_PDF9 (9). The Cricut PNG layout still caps its own cells at 5,
// so even if more buffers exist it indexes the same 0–4.
async function renderItemBuffers(
  items: PrintBatchItem[],
  cap: number = MAX_CERTS_PER_BATCH
): Promise<{
  fronts: Buffer[];
  backs: Buffer[];
  inserts: Buffer[];
}> {
  const slice = items.slice(0, cap);
  const [fronts, backs, inserts] = await Promise.all([
    Promise.all(slice.map((it) => generateLabelPNG(it.cert, "front"))),
    Promise.all(slice.map((it) => generateLabelPNG(it.cert, "back"))),
    Promise.all(slice.map((it) => generateClaimInsertPNG((it.cert as any).certId || "", it.claimCode))),
  ]);
  return { fronts, backs, inserts };
}

// ── Crop marks (PDF only) ────────────────────────────────────────────────────
// Corner trim guides for guillotine cutting of the 70×20mm slab labels. Each
// label corner gets an outward "L" of two short ticks that lie ON the label's
// edge lines, offset 0.3mm clear of the artwork so ink never touches the label.
// Ticks sit entirely in the 2mm page margins / 4mm inter-cell gaps — verified
// clear of the claim insert (x ≥ 76mm) and of adjacent rows. The claim insert is
// intentionally NOT marked: it stays on the Cricut Print-Then-Cut / SVG path.
const CROP_MARK_LEN_MM = 1.5;
const CROP_MARK_OFFSET_MM = 0.3;
const CROP_MARK_STROKE_PT = 0.3;
const CROP_MARK_HEX = "#000000";

function drawLabelCropMarks(doc: InstanceType<typeof PDFDocument>, cell: CellSpec): void {
  const x0 = cell.xMm;
  const y0 = cell.yMm;
  const x1 = cell.xMm + cell.wMm;
  const y1 = cell.yMm + cell.hMm;
  const off = CROP_MARK_OFFSET_MM;
  const len = CROP_MARK_LEN_MM;
  // Four corners with outward direction signs (sx, sy).
  const corners = [
    { cx: x0, cy: y0, sx: -1, sy: -1 }, // top-left
    { cx: x1, cy: y0, sx: 1, sy: -1 }, // top-right
    { cx: x0, cy: y1, sx: -1, sy: 1 }, // bottom-left
    { cx: x1, cy: y1, sx: 1, sy: 1 }, // bottom-right
  ];
  doc.save();
  doc.lineWidth(CROP_MARK_STROKE_PT).strokeColor(CROP_MARK_HEX);
  for (const c of corners) {
    // Horizontal tick — lies on the cy edge line, extends outward along x.
    doc
      .moveTo(mm(c.cx + c.sx * off), mm(c.cy))
      .lineTo(mm(c.cx + c.sx * (off + len)), mm(c.cy))
      .stroke();
    // Vertical tick — lies on the cx edge line, extends outward along y.
    doc
      .moveTo(mm(c.cx), mm(c.cy + c.sy * off))
      .lineTo(mm(c.cx), mm(c.cy + c.sy * (off + len)))
      .stroke();
  }
  doc.restore();
}

// Full-length guillotine cut lines for the 9-up edge-to-edge PDF. Unlike the
// per-label corner ticks, these are continuous straight lines spanning the
// whole used area at every cut boundary, so the operator can guillotine the
// whole sheet in straight passes. Vertical lines at the column splits (x=70,140)
// run y=0→258; horizontal lines at every front|back, back|insert and unit
// boundary run x=0→210 (y = 21,42,86,107,128,172,193,214,258).
const GUILLOTINE_STROKE_PT = 0.2;
const GUILLOTINE_HEX = "#000000";

function drawGuillotineLines(doc: InstanceType<typeof PDFDocument>): void {
  const usedH = PDF9_ROWS * PDF9_UNIT_H_MM; // 258
  doc.save();
  doc.lineWidth(GUILLOTINE_STROKE_PT).strokeColor(GUILLOTINE_HEX);
  // Vertical column splits — full used height.
  for (let c = 1; c < PDF9_COLS; c++) {
    const x = c * PDF9_LABEL_W_MM; // 70, 140
    doc.moveTo(mm(x), mm(0)).lineTo(mm(x), mm(usedH)).stroke();
  }
  // Horizontal splits — full page width, three per unit row (front|back,
  // back|insert, unit bottom).
  for (let r = 0; r < PDF9_ROWS; r++) {
    const top = r * PDF9_UNIT_H_MM;
    const ys = [top + PDF9_FRONT_H_MM, top + PDF9_FRONT_H_MM + PDF9_BACK_H_MM, top + PDF9_UNIT_H_MM];
    for (const y of ys) {
      doc.moveTo(mm(0), mm(y)).lineTo(mm(PDF_PAGE_W_MM), mm(y)).stroke();
    }
  }
  doc.restore();
}

// ── PDF generator (full A4, guillotine sheet) ────────────────────────────────

export async function generatePrintBatchPDF(items: PrintBatchItem[]): Promise<Buffer> {
  const layout = buildPdf9Layout(items.length);
  const { fronts, backs, inserts } = await renderItemBuffers(items, MAX_CERTS_PER_PDF9);

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: [mm(PDF_PAGE_W_MM), mm(PDF_PAGE_H_MM)],
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
      doc.rect(0, 0, mm(PDF_PAGE_W_MM), mm(PDF_PAGE_H_MM)).fill("#FFFFFF");
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
      // Full-length guillotine cut lines at every boundary (drawn after the
      // artwork so they sit on top), replacing the per-label corner ticks.
      drawGuillotineLines(doc);
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
  // Use the SAME layout as the Cricut PNG (buildCricutPNGLayout) so the cut
  // paths line up exactly with the printed labels. Slab labels only (front +
  // back) — the claim insert is a paper insert, not cut on the Cricut. Canvas
  // is the Cricut sheet (PAGE_W_MM × PNG_PAGE_H_MM), NOT the A4 PDF height.
  const layout = buildCricutPNGLayout(itemCount).filter((c) => c.kind === "label" || c.kind === "back");
  const insetRect = (cell: CellSpec) =>
    `    <rect x="${(cell.xMm + CUT_INSET_MM).toFixed(4)}" y="${(cell.yMm + CUT_INSET_MM).toFixed(4)}" ` +
    `width="${(cell.wMm - 2 * CUT_INSET_MM).toFixed(4)}" height="${(cell.hMm - 2 * CUT_INSET_MM).toFixed(4)}" ` +
    `fill="none" stroke="${CUT_STROKE_HEX}" stroke-width="${CUT_STROKE_MM}"/>`;

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!-- MintVault Print Batch Cut Guide (${SHEET_LAYOUT_VERSION}) — ${layout.length} cut paths -->`,
    `<!-- Cricut ${PAGE_W_MM}×${PNG_PAGE_H_MM}mm | ${CUT_INSET_MM}mm bleed inset per side | stroke ${CUT_STROKE_HEX} -->`,
    `<svg xmlns="http://www.w3.org/2000/svg"`,
    `     width="${PAGE_W_MM}mm" height="${PNG_PAGE_H_MM}mm"`,
    `     viewBox="0 0 ${PAGE_W_MM} ${PNG_PAGE_H_MM}">`,
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
// and applies a fixed 144 DPI to the raw pixel count, so the canvas pixel size
// at 144 DPI is what actually controls the printed dimensions on the mat. 4
// rows × 54mm + 3 × 4mm gaps + 2 × 2mm margins = 232mm content height,
// 2.7mm spare at the bottom for Cricut's registration marks.

export async function generatePrintBatchPNG(items: PrintBatchItem[]): Promise<Buffer> {
  const { createCanvas, loadImage } = await import("canvas");
  // Cricut PNG uses its OWN 5-up layout (slab labels + NFC backs, no insert).
  // Not buildLayout() — that's shared with the 4-up SVG and must stay untouched.
  const layout = buildCricutPNGLayout(items.length);
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
  // count at its own fixed 144 DPI, which is why the canvas above is
  // sized at 144 DPI to begin with.
  const rawBuffer = canvas.toBuffer("image/png");
  return sharp(rawBuffer).withMetadata({ density: DPI }).toBuffer();
}

// High-quality PRINT PNG — same layout/cells as generatePrintBatchPNG but
// rendered at PRINT_DPI (400) for crisp home/photo printing, NOT for Cricut
// sizing. Canvas: 165.9mm → 2613px, 234.7mm → 3697px. pHYs density = 400 DPI.
export async function generatePrintBatchPrintPNG(items: PrintBatchItem[]): Promise<Buffer> {
  const { createCanvas, loadImage } = await import("canvas");
  const layout = buildCricutPNGLayout(items.length);
  const { fronts, backs, inserts } = await renderItemBuffers(items);

  const widthPx = printMmPx(PAGE_W_MM);
  const heightPx = printMmPx(PNG_PAGE_H_MM);

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
    ctx.drawImage(img, printMmPx(cell.xMm), printMmPx(cell.yMm), printMmPx(cell.wMm), printMmPx(cell.hMm));
  }

  const rawBuffer = canvas.toBuffer("image/png");
  return sharp(rawBuffer).withMetadata({ density: PRINT_DPI }).toBuffer();
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
// v4 (2026-05-26): DPI dropped 144 → 96. Cricut treats imported PNGs as 96
//   DPI (not 144), so a 144 DPI canvas rendered ~1.5× too large
//   (24.9×35.2cm). 96 DPI canvas (627×887px) lands at 16.59×23.47cm.
// v5 (2026-05-26): PDF gains guillotine crop marks at each corner of the
//   70×20mm slab labels (front + back). PNG/Cricut path unchanged; key bumped
//   to invalidate cached v4 PDFs so new batches serve the crop-marked PDF.
// v6 (2026-05-26): PNG DPI reverted 96 → 144. Measurement proved Cricut applies
//   a fixed 144 DPI to raw pixels (ignores pHYs): the v4 96 DPI / 627px canvas
//   printed undersized at 11.06cm. 144 DPI / 941×1331px lands at 16.59×23.47cm.
//   Crop marks (v5) retained.
// Cache key folds SHEET_LAYOUT_VERSION so a layout bump (e.g. v2 → v3) writes
// to a NEW R2 object and the route's idempotent HEAD fast-path can't serve a
// stale older-layout PDF for the same batchId. Same dance the PNG history did
// inline historically (-v2 / -v3 / -v6) — now centralised so the version
// flows from one constant to every read+write site.
export function r2KeyForPrintBatch(batchId: string, ext: "pdf" | "png" | "print-png"): string {
  // "print-png" → the 400-DPI print variant at a distinct -print.png suffix;
  // "pdf"/"png" keep their existing {batchId}-{VERSION}.{ext} form.
  if (ext === "print-png") return `print-batches/${batchId}-${SHEET_LAYOUT_VERSION}-print.png`;
  return `print-batches/${batchId}-${SHEET_LAYOUT_VERSION}.${ext}`;
}

export async function uploadPrintBatchArtifacts(
  batchId: string,
  pdfBuf: Buffer,
  pngBuf: Buffer,
  printPngBuf?: Buffer
): Promise<void> {
  await Promise.all([
    uploadToR2(r2KeyForPrintBatch(batchId, "pdf"), pdfBuf, "application/pdf"),
    uploadToR2(r2KeyForPrintBatch(batchId, "png"), pngBuf, "image/png"),
    // 400-DPI print variant — only when the caller supplies it (main handler).
    ...(printPngBuf ? [uploadToR2(r2KeyForPrintBatch(batchId, "print-png"), printPngBuf, "image/png")] : []),
  ]);
}

// Cricut cut-guide SVG R2 key — separate key/suffix from the pdf/png artefacts,
// version-folded so a layout bump writes a fresh object (same as the others).
export function r2KeyForCricutSvg(batchId: string): string {
  return `print-batches/${batchId}-${SHEET_LAYOUT_VERSION}-cricut-cut.svg`;
}

export async function uploadCricutSvg(batchId: string, svg: string): Promise<void> {
  await uploadToR2(r2KeyForCricutSvg(batchId), Buffer.from(svg, "utf8"), "image/svg+xml");
}

export function deriveBatchId(certIds: string[], adminUser: string): string {
  // createHash imported at top level
  const sorted = [...certIds].sort();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  const input = `${adminUser}|${today}|${sorted.join(",")}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}
