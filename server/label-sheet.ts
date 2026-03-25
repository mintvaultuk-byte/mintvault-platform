/**
 * label-sheet.ts
 * Generates an A4 PDF print sheet + companion SVG cut guide.
 *
 * Layout (portrait A4):
 *   Col 0 (left)  = FRONT label
 *   Col 1 (right) = BACK label
 *   Row n:  Front N | Back N   (one row per certificate)
 *
 * Approved dimensions (exact PDF points, 1 mm = 2.83464567 pt):
 *   Page:          595.28 × 841.89 pt  (A4 portrait)
 *   Label:         198.43 × 56.69 pt   (70 × 20 mm)
 *   Columns:       2  (col 0 = front, col 1 = back)
 *   Rows:          10 max
 *   H gap:         28.35 pt            (10 mm — gap between columns)
 *   V gap:         24.25 pt            (8.56 mm — row pitch)
 *   Top margin:    28.35 pt            (10 mm)
 *   Left margin:   85.04 pt            (30 mm)
 *
 * Verification:
 *   Width:  85.04 + 198.43 + 28.35 + 198.43 + 85.04 = 595.29 ≈ 595.28 pt ✓
 *   Height: 28.35 + 10×56.69 + 9×24.25 + 28.35 = 841.95 ≈ 841.89 pt ✓
 *
 * TWO OUTPUT FILES:
 *   A) generateLabelSheet()  → A4 PDF, artwork only, no cut lines
 *   B) generateCutSheetSVG() → A4 SVG, red hairline cut rectangles only
 *
 * ScanNCut workflow: import SVG → use Direct Cut (NOT Scan to Cut).
 *
 * ISOLATED MODULE — does not touch any certificate/grading/QR logic.
 */

import PDFDocument from "pdfkit";
import { generateLabelPNG } from "./labels";
import type { CertificateRecord } from "@shared/schema";

// ── Exact approved dimensions in PDF points ───────────────────────────────────
const A4_W        = 595.28;  // pt (210 mm)
const A4_H        = 841.89;  // pt (297 mm)

const LABEL_W     = 198.43;  // pt (70 mm)
const LABEL_H     =  56.69;  // pt (20 mm)

const COLS        = 2;       // col 0 = front, col 1 = back
const ROWS        = 10;      // 10 rows → 20 labels with 9 mm row spacing

const H_GAP       =  28.35;  // pt (10 mm) — centre gap between columns
const V_GAP       =  24.25;  // pt (8.56 mm) — row spacing for ScanNCut tracking (~9 mm)

const MARGIN_TOP  =  28.35;  // pt (10 mm) — (297 - 10×20 - 9×8.56) / 2
const MARGIN_LEFT =  85.04;  // pt (30 mm) — (210 - 70 - 10 - 70) / 2

// mm equivalents (for SVG cut guide — SVG uses mm units)
const PT_TO_MM    = 1 / 2.83464567;
const LW_MM       = LABEL_W * PT_TO_MM;  // 70.00 mm
const LH_MM       = LABEL_H * PT_TO_MM;  // 20.00 mm
const ML_MM       = MARGIN_LEFT * PT_TO_MM; // 30.00 mm
const MT_MM       = MARGIN_TOP  * PT_TO_MM; // 10.00 mm
const HG_MM       = H_GAP * PT_TO_MM;    // 10.00 mm
const VG_MM       = V_GAP * PT_TO_MM;    // ~8.56 mm
// 0.5pt hairline in mm: 0.5 / 2.83464567 ≈ 0.1764 mm
const CUT_SW_MM   = (0.5 * PT_TO_MM).toFixed(4); // SVG stroke-width in mm

/** Maximum number of *certificates* per sheet (one cert = one row). */
export const CERTS_PER_SHEET  = ROWS;                   // 10
/** Total labels per sheet (front + back per cert). */
export const LABELS_PER_SHEET = CERTS_PER_SHEET * COLS; // 20

/**
 * Returns the top-left (x, y) in points for the label cell at [col, row].
 * col 0 → front, col 1 → back.
 */
function labelPos(col: number, row: number): [number, number] {
  const x = MARGIN_LEFT + col * (LABEL_W + H_GAP);
  const y = MARGIN_TOP  + row * (LABEL_H + V_GAP);
  return [x, y];
}

/**
 * Generates an A4 PDF sheet.
 * Each certificate occupies exactly one row: front in col 0, back in col 1.
 * Pass at most CERTS_PER_SHEET (10) certificates.
 */
export async function generateLabelSheet(
  certs: CertificateRecord[]
): Promise<Buffer> {
  const slice = certs.slice(0, CERTS_PER_SHEET);

  // Render fronts and backs in parallel — all 26 PNGs at once
  const [frontBuffers, backBuffers] = await Promise.all([
    Promise.all(slice.map((cert) => generateLabelPNG(cert, "front"))),
    Promise.all(slice.map((cert) => generateLabelPNG(cert, "back"))),
  ]);

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size:   [A4_W, A4_H],
      margin: 0,
      info: {
        Title:  "MintVault Label Sheet",
        Author: "MintVault Trading Card Grading",
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data",  (c: Buffer) => chunks.push(c));
    doc.on("end",   () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      // ── Page background — clean white, no detection elements ─────────────
      // No corner marks, no hairlines — cut paths are provided separately via
      // the SVG cut guide (use Direct Cut mode on ScanNCut CM300).
      doc.rect(0, 0, A4_W, A4_H).fill("white");

      // ── Labels — paired by certificate, one row per cert ──────────────
      // Positions are rounded to 2 decimal places to avoid sub-pixel PDF
      // rendering fringe at label edges.
      for (let row = 0; row < slice.length; row++) {
        // Col 0: FRONT label
        const [fx, fy] = labelPos(0, row).map(v => Math.round(v * 100) / 100) as [number, number];
        doc.image(frontBuffers[row], fx, fy, { width: LABEL_W, height: LABEL_H });

        // Col 1: BACK label (same certificate)
        const [bx, by] = labelPos(1, row).map(v => Math.round(v * 100) / 100) as [number, number];
        doc.image(backBuffers[row], bx, by, { width: LABEL_W, height: LABEL_H });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Generates an A4 SVG cut guide for use with Brother ScanNCut CM300.
 *
 * Contains ONLY red hairline rectangles (70mm × 20mm) at exact label positions.
 * No artwork, no text, no fill. Import into CM300 and use DIRECT CUT mode.
 *
 * @param nRows  Number of certificate rows (1–10). Each row = 2 rects (front + back).
 */
export function generateCutSheetSVG(nRows: number): string {
  const rows = Math.min(Math.max(Math.round(nRows), 1), ROWS);

  const rects: string[] = [];

  for (let row = 0; row < rows; row++) {
    const y = MT_MM + row * (LH_MM + VG_MM);

    // Col 0 — FRONT label
    rects.push(
      `  <rect x="${ML_MM.toFixed(4)}" y="${y.toFixed(4)}" ` +
      `width="${LW_MM.toFixed(4)}" height="${LH_MM.toFixed(4)}" ` +
      `fill="none" stroke="#FF0000" stroke-width="${CUT_SW_MM}"/>`
    );

    // Col 1 — BACK label
    const x1 = ML_MM + LW_MM + HG_MM;
    rects.push(
      `  <rect x="${x1.toFixed(4)}" y="${y.toFixed(4)}" ` +
      `width="${LW_MM.toFixed(4)}" height="${LH_MM.toFixed(4)}" ` +
      `fill="none" stroke="#FF0000" stroke-width="${CUT_SW_MM}"/>`
    );
  }

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!-- MintVault Label Cut Guide — ${rows} row(s) × 2 = ${rows * 2} cut paths -->`,
    `<!-- Page: A4 210×297mm | Labels: 70×20mm | Import to ScanNCut CM300 → Direct Cut -->`,
    `<svg xmlns="http://www.w3.org/2000/svg"`,
    `     width="210mm" height="297mm"`,
    `     viewBox="0 0 210 297">`,
    ...rects,
    `</svg>`,
  ].join("\n");
}
