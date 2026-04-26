/**
 * print-batch.ts
 * v419 — single-sheet print-and-cut batch generator for Brother ScanNCut CM300.
 *
 * Produces TWO files for one A4 sheet of up to 5 cards. Each card row
 * contains a front label + back label + claim insert, all cut in one pass.
 *
 * LAYOUT (mm, top-left origin, A4 portrait 210×297):
 *   Page margins: 10 on all sides.
 *   Universal cut gap: 4 mm between every cut line (between front/back
 *   labels, between label-block and insert, between rows).
 *   Cards per sheet: up to 5.
 *
 *   Per row (left to right):
 *     - Label block 72×48 mm (left)
 *         · Front label 72×22 (top)
 *         · 4 mm gap
 *         · Back label  72×22 (bottom)
 *     - 4 mm gap
 *     - Claim insert 114×48 mm (right, vertically aligned with label block)
 *
 *   Row pitch: 52 mm (48 mm row + 4 mm inter-row gap).
 *   First row top edge: Y = 10. Subsequent rows: Y = 10 + N×52.
 *
 *   5 rows × 52 + 10 top margin = 270 mm. Bottom margin: 27 mm.
 *
 * TWO OUTPUT FILES:
 *   A) generatePrintBatchPDF()    → A4 PDF with all artwork, no cut lines
 *   B) generatePrintBatchCutSVG() → A4 SVG with red hairline cut paths only
 *      (15 rectangles for a full 5-row sheet — 5 fronts + 5 backs + 5 inserts)
 *
 * ScanNCut workflow: print PDF → load printed sheet on cutting mat →
 * import SVG via USB → run Direct Cut (NOT Scan to Cut). The SVG cut paths
 * match the PDF coordinate system so the CM300's print-and-cut alignment
 * works out of the box.
 *
 * Cut-path bleed inset: 0.25 mm per side, matching the proven inset from
 * label-sheet.ts. This pushes the cut INSIDE the printed border so any
 * sub-mm cutter drift slices through the gold border rather than the
 * white paper outside it.
 */

import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import path from "path";
import { generateLabelPNG } from "./labels";
import { APP_BASE_URL } from "./app-url";
import type { CertificateRecord } from "@shared/schema";

// ── Unit conversion ──────────────────────────────────────────────────────────
const MM_TO_PT = 2.83464567;
const mm = (v: number) => v * MM_TO_PT;

// ── Page dimensions ──────────────────────────────────────────────────────────
const PAGE_W_MM = 210;
const PAGE_H_MM = 297;

// ── Layout (mm) ──────────────────────────────────────────────────────────────
const MARGIN_MM    = 10;
const GAP_MM       = 4;          // universal cut gap
const LABEL_W_MM   = 72;
const LABEL_H_MM   = 22;
const INSERT_W_MM  = 114;
const INSERT_H_MM  = 48;          // = label_H × 2 + gap = 22+4+22
const ROW_H_MM     = 48;          // label-block height = insert height
const ROW_PITCH_MM = ROW_H_MM + GAP_MM;  // 52

export const MAX_CERTS_PER_BATCH = 5;

// Per-side cut bleed inset — slices through the printed border, not the
// paper outside. Same pattern as label-sheet.ts.
const CUT_INSET_MM = 0.25;
const CUT_STROKE_MM = (0.5 * (1 / MM_TO_PT)).toFixed(4); // 0.5pt → mm

// ── Brand colours (hex strings for PDFKit) ───────────────────────────────────
const GOLD     = "#D4AF37";
const GOLD_DK  = "#B8960C";
const DARK     = "#1A1A1A";
const GRAY     = "#555555";
const GRAY_LT  = "#888888";
const GRAY_BG  = "#F5F0E8";
const CREAM    = "#FAF6ED"; // light tint behind the v423 cert+code data block

const CLAIM_BASE_URL = `${APP_BASE_URL}/claim`;
const LOGO_PATH = path.join(process.cwd(), "public", "brand", "logo.png");

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Position helper: given a row index (0-based), return the row's top Y in mm. */
function rowTopMm(rowIndex: number): number {
  return MARGIN_MM + rowIndex * ROW_PITCH_MM;
}

/** Format claim code "ABCD12345EFG" → "ABCD-1234-5EFG" (12 chars expected). */
function formatClaimCode(code: string): string {
  const c = code.toUpperCase();
  return c.length === 12 ? `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}` : c;
}

/** "MV-0000000003" → "MV3" (defensive — most callers pass already-normalised). */
function normaliseCertId(raw: string): string {
  const m = raw.match(/^MV-?0*(\d+)$/i);
  return m ? `MV${m[1]}` : raw;
}

async function qrPng(url: string, sizePx: number): Promise<Buffer> {
  return await QRCode.toBuffer(url, {
    width: sizePx,
    margin: 1,
    color: { dark: "#000000", light: "#FFFFFF" },
    errorCorrectionLevel: "M",
  });
}

// ── Insert renderer (vector + embedded QR PNG) ───────────────────────────────
//
// Renders the 114×48 mm claim insert at the given (x, y) in mm onto an
// already-open PDFKit document. Uses PDFKit's vector primitives + a single
// embedded QR PNG, so output stays sharp at print resolution and the
// rendering is fast enough to run 5×/sheet without canvas overhead.

async function drawInsert(
  doc: any,
  xMm: number,
  yMm: number,
  certId: string,
  claimCode: string,
): Promise<void> {
  const x = mm(xMm);
  const y = mm(yMm);
  const w = mm(INSERT_W_MM);
  const h = mm(INSERT_H_MM);
  const pad = mm(2.5); // v423: tightened from 3mm to buy 1mm extra usable width

  const nCertId = normaliseCertId(certId);
  const formattedCode = formatClaimCode(claimCode);
  const claimUrl = `${CLAIM_BASE_URL}?cert=${encodeURIComponent(nCertId)}&code=${encodeURIComponent(claimCode)}`;

  // White background
  doc.save();
  doc.rect(x, y, w, h).fill("#FFFFFF");

  // Subtle gold outer border (just inside the cut path so it gets sliced
  // cleanly rather than left as a thin frame on the paper).
  doc.lineWidth(0.6);
  doc.strokeColor(GOLD);
  doc.rect(x + 1, y + 1, w - 2, h - 2).stroke();

  // ── Right-side QR block ────────────────────────────────────────────────────
  // v423: QR bumped 38→42mm. Vertically centred, flush right inside padding.
  const qrSizeMm = 42;
  const qrX = x + w - mm(qrSizeMm) - pad;
  const qrY = y + (h - mm(qrSizeMm)) / 2;

  // Cream tile behind the QR for visual separation
  doc.fillColor(GRAY_BG);
  doc.rect(qrX - 2, qrY - 2, mm(qrSizeMm) + 4, mm(qrSizeMm) + 4).fill();

  const qrBuf = await qrPng(claimUrl, 600);
  doc.image(qrBuf, qrX, qrY, { width: mm(qrSizeMm), height: mm(qrSizeMm) });

  // "Scan to claim" caption under the QR
  doc.fillColor(GRAY_LT);
  doc.font("Helvetica");
  doc.fontSize(5);
  doc.text("Scan to claim", qrX, qrY + mm(qrSizeMm) + 1, {
    width: mm(qrSizeMm),
    align: "center",
  });

  // ── Left-side text column ──────────────────────────────────────────────────
  // v423: explicit-Y zoned layout (title / data block / instructions) instead
  // of cumulative ty increments. Hardcoded offsets in mm so the visual
  // rhythm is predictable regardless of font metric drift.
  const tx = x + pad;
  const tw = qrX - tx - mm(2); // 2mm gutter between text col and QR tile

  // Zone 1 — Title at top (y + 4mm)
  const titleY = y + mm(4);
  doc.fillColor(GOLD);
  doc.font("Helvetica-Bold");
  doc.fontSize(11);
  doc.text("CLAIM YOUR CARD", tx, titleY, { width: tw });

  // Thin gold divider directly under title (y + 9mm). 50mm wide, 0.4pt.
  const dividerY1 = y + mm(9);
  doc.lineWidth(0.4);
  doc.strokeColor(GOLD);
  doc.moveTo(tx, dividerY1).lineTo(tx + mm(50), dividerY1).stroke();

  // Zone 2 — Data block (cert + claim code, side-by-side) at y + 13mm.
  // Cream-tinted background behind the data block to make it the focal
  // point. ~14mm tall, spans the full text column.
  const dataY = y + mm(13);
  const dataH = mm(14);
  doc.fillColor(CREAM);
  doc.rect(tx - mm(0.5), dataY - mm(0.5), tw + mm(1), dataH).fill();

  // Two columns inside the data block:
  //   Cert No. on the left (~22mm wide), Claim Code on the right (~46mm wide)
  const certColX = tx + mm(1);
  const certColW = mm(22);
  const codeColX = certColX + certColW + mm(2);
  const codeColW = tw - (codeColX - tx) - mm(1);

  // Labels (5.5pt grey)
  doc.fillColor(GRAY_LT);
  doc.font("Helvetica-Bold");
  doc.fontSize(5.5);
  doc.text("CERT NO.", certColX, dataY + mm(1), { width: certColW });
  doc.text("CLAIM CODE", codeColX, dataY + mm(1), { width: codeColW });

  // Cert No. value (14pt bold Courier dark)
  doc.fillColor(DARK);
  doc.font("Courier-Bold");
  doc.fontSize(14);
  doc.text(nCertId, certColX, dataY + mm(4.5), { width: certColW });

  // Claim Code value (10pt bold Courier gold-dark)
  doc.fillColor(GOLD_DK);
  doc.font("Courier-Bold");
  doc.fontSize(10);
  doc.text(formattedCode, codeColX, dataY + mm(5.5), { width: codeColW });

  // Zone 3 — Instructions strip at bottom. Thin grey divider above
  // (y + 30mm), instructions begin y + 32.5mm.
  const dividerY2 = y + mm(30);
  doc.lineWidth(0.3);
  doc.strokeColor(GRAY_LT);
  doc.moveTo(tx, dividerY2).lineTo(tx + mm(50), dividerY2).stroke();

  // Three steps inline at 6pt — step 3 absorbs the single-use note so we
  // free up a row.
  doc.fillColor(GRAY);
  doc.font("Helvetica");
  doc.fontSize(6);
  const steps = [
    "1. Visit mintvaultuk.com/claim",
    "2. Enter cert no. & claim code",
    "3. Verify email • Code is single-use",
  ];
  let stepY = y + mm(32.5);
  for (const step of steps) {
    doc.text(step, tx, stepY, { width: tw });
    stepY += mm(3.8);
  }

  doc.restore();
}

// ── PDF generator ────────────────────────────────────────────────────────────

export interface PrintBatchItem {
  cert: CertificateRecord;
  claimCode: string;
}

export async function generatePrintBatchPDF(items: PrintBatchItem[]): Promise<Buffer> {
  const slice = items.slice(0, MAX_CERTS_PER_BATCH);

  // Render front + back label PNGs in parallel
  const [frontBuffers, backBuffers] = await Promise.all([
    Promise.all(slice.map(it => generateLabelPNG(it.cert, "front"))),
    Promise.all(slice.map(it => generateLabelPNG(it.cert, "back"))),
  ]);

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: [mm(PAGE_W_MM), mm(PAGE_H_MM)],
      margin: 0,
      info: {
        Title: "MintVault Print Batch (v419)",
        Author: "MintVault Trading Card Grading",
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    (async () => {
      try {
        // Background — clean white. No detection marks; cut paths live in SVG.
        doc.rect(0, 0, mm(PAGE_W_MM), mm(PAGE_H_MM)).fill("#FFFFFF");

        for (let i = 0; i < slice.length; i++) {
          const it = slice[i];
          const rowTop = rowTopMm(i);

          // Front label — top of label block (X=10, W=72, H=22)
          doc.image(frontBuffers[i], mm(MARGIN_MM), mm(rowTop), {
            width: mm(LABEL_W_MM),
            height: mm(LABEL_H_MM),
          });

          // Back label — bottom of label block (X=10, Y+=22+4, W=72, H=22)
          doc.image(backBuffers[i], mm(MARGIN_MM), mm(rowTop + LABEL_H_MM + GAP_MM), {
            width: mm(LABEL_W_MM),
            height: mm(LABEL_H_MM),
          });

          // Insert — right of label block, vertically aligned (X=10+72+4=86)
          await drawInsert(
            doc,
            MARGIN_MM + LABEL_W_MM + GAP_MM,
            rowTop,
            (it.cert as any).certId || "",
            it.claimCode,
          );
        }

        doc.end();
      } catch (err) {
        reject(err);
      }
    })();
  });
}

// ── SVG cut-path generator ───────────────────────────────────────────────────
//
// 15 rectangles (5 fronts + 5 backs + 5 inserts), each inset by 0.25 mm on
// every side. Same coord system as the PDF (mm, top-left origin).

export function generatePrintBatchCutSVG(itemCount: number): string {
  const n = Math.max(1, Math.min(MAX_CERTS_PER_BATCH, itemCount | 0));
  const rects: string[] = [];

  const insetRect = (xMm: number, yMm: number, wMm: number, hMm: number) =>
    `  <rect x="${(xMm + CUT_INSET_MM).toFixed(4)}" y="${(yMm + CUT_INSET_MM).toFixed(4)}" ` +
    `width="${(wMm - 2 * CUT_INSET_MM).toFixed(4)}" height="${(hMm - 2 * CUT_INSET_MM).toFixed(4)}" ` +
    `fill="none" stroke="#FF0000" stroke-width="${CUT_STROKE_MM}"/>`;

  for (let i = 0; i < n; i++) {
    const rowTop = rowTopMm(i);

    // Front label: X=10, Y=rowTop, 72×22
    rects.push(insetRect(MARGIN_MM, rowTop, LABEL_W_MM, LABEL_H_MM));

    // Back label: X=10, Y=rowTop+22+4, 72×22
    rects.push(insetRect(MARGIN_MM, rowTop + LABEL_H_MM + GAP_MM, LABEL_W_MM, LABEL_H_MM));

    // Insert: X=10+72+4=86, Y=rowTop, 114×48
    rects.push(insetRect(MARGIN_MM + LABEL_W_MM + GAP_MM, rowTop, INSERT_W_MM, INSERT_H_MM));
  }

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!-- MintVault Print Batch Cut Guide (v419) — ${n} row(s) × 3 = ${n * 3} cut paths -->`,
    `<!-- A4 210×297mm | 0.25mm bleed inset | ScanNCut CM300 → Direct Cut -->`,
    `<svg xmlns="http://www.w3.org/2000/svg"`,
    `     width="210mm" height="297mm"`,
    `     viewBox="0 0 210 297">`,
    ...rects,
    `</svg>`,
  ].join("\n");
}
