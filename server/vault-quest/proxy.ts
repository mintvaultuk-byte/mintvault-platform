// Vault Quest — proxy sheet builder (Phase 11). DB-driven port of the CLI
// proxy-sheets.ts layout: A4, 3×3, true 63×88mm cards (bleed cropped from the
// 69×94 master render), guillotine cut ticks, playtest footer. Takes already
// rendered master PNGs (route renders via renderCard) and returns the PDF buffer.
import PDFDocument from "pdfkit";
import sharp from "sharp";
import type { Writable } from "stream";

const MM = 72 / 25.4;
const PAGE_W = 210;
const CARD_W = 63, CARD_H = 88;
const CANVAS_W = 69, CANVAS_H = 94, BLEED = 3;
const COLS = 3, ROWS = 3;
const GRID_W = COLS * CARD_W;
const MARGIN_X = (PAGE_W - GRID_W) / 2; // 10.5mm
const MARGIN_TOP = 13;
const TICK = 4;

async function trimCrop(masterPng: Buffer): Promise<Buffer> {
  const img = sharp(masterPng);
  const meta = await img.metadata();
  const W = meta.width ?? 0, H = meta.height ?? 0;
  const left = Math.round((BLEED / CANVAS_W) * W);
  const top = Math.round((BLEED / CANVAS_H) * H);
  const w = Math.round((CARD_W / CANVAS_W) * W);
  const h = Math.round((CARD_H / CANVAS_H) * H);
  return img.extract({ left, top, width: w, height: h }).png().toBuffer();
}

export interface ProxyCard { cardId: string; masterPng: Buffer }

/**
 * Lazy card source for the proxy builder. `get(i)` renders/returns the master PNG
 * for card index `i` just-in-time (or null to skip a non-rendering card), so the
 * builder never holds more than one page (9 cards) of imagery in memory.
 */
export interface ProxyProvider {
  count: number;
  get(index: number): Promise<ProxyCard | null>;
}

/**
 * Stream an A4 3×3 proxy sheet PDF to `out`, pulling cards from `provider` one
 * page at a time. Memory is bounded to a single page of cropped images and the
 * PDF is piped straight to the destination (a temp file in the export job) rather
 * than buffered whole. Returns the number of cards actually placed.
 */
export async function buildProxyPdf(
  provider: ProxyProvider,
  opts: { rulesVersion?: string; date?: string; label?: string } = {},
  out: Writable,
): Promise<number> {
  const rulesVersion = opts.rulesVersion ?? "v0.1";
  const date = opts.date ?? "";
  const label = opts.label ?? "Genesis Vault (GNV)";
  const perPage = COLS * ROWS;

  const doc = new PDFDocument({ size: "A4", margin: 0 });
  const finished = new Promise<void>((resolve, reject) => {
    out.on("finish", () => resolve());
    out.on("error", reject);
    doc.on("error", reject);
  });
  doc.pipe(out);

  const drawPage = (pageCards: { cardId: string; png: Buffer }[], pageNum: number, first: boolean) => {
    if (!first) doc.addPage({ size: "A4", margin: 0 });
    pageCards.forEach((card, i) => {
      const col = i % COLS, row = Math.floor(i / COLS);
      const xmm = MARGIN_X + col * CARD_W;
      const ymm = MARGIN_TOP + row * CARD_H;
      doc.image(card.png, xmm * MM, ymm * MM, { width: CARD_W * MM, height: CARD_H * MM });
    });
    doc.lineWidth(0.25).strokeColor("#000000");
    for (let c = 0; c <= COLS; c++) {
      const xmm = MARGIN_X + c * CARD_W;
      doc.moveTo(xmm * MM, (MARGIN_TOP - TICK) * MM).lineTo(xmm * MM, MARGIN_TOP * MM).stroke();
      doc.moveTo(xmm * MM, (MARGIN_TOP + ROWS * CARD_H) * MM).lineTo(xmm * MM, (MARGIN_TOP + ROWS * CARD_H + TICK) * MM).stroke();
    }
    for (let r = 0; r <= ROWS; r++) {
      const ymm = MARGIN_TOP + r * CARD_H;
      doc.moveTo((MARGIN_X - TICK) * MM, ymm * MM).lineTo(MARGIN_X * MM, ymm * MM).stroke();
      doc.moveTo((MARGIN_X + COLS * CARD_W) * MM, ymm * MM).lineTo((MARGIN_X + COLS * CARD_W + TICK) * MM, ymm * MM).stroke();
    }
    const footY = (MARGIN_TOP + ROWS * CARD_H + 8) * MM;
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#000000").text("PLAYTEST PROXY — NOT FINAL PRINT", MARGIN_X * MM, footY, { width: GRID_W * MM, align: "center" });
    doc.font("Helvetica").fontSize(8).fillColor("#444444").text(`${label} · Rules ${rulesVersion} · true 63×88mm · exported ${date} · page ${pageNum}`, MARGIN_X * MM, footY + 12, { width: GRID_W * MM, align: "center" });
  };

  let placed = 0;
  let cursor = 0;
  let pageNum = 0;
  while (cursor < provider.count) {
    // Collect up to one page of rendered cards, skipping any that don't render.
    const pageCards: { cardId: string; png: Buffer }[] = [];
    while (cursor < provider.count && pageCards.length < perPage) {
      const c = await provider.get(cursor);
      cursor++;
      if (!c) continue;
      pageCards.push({ cardId: c.cardId, png: await trimCrop(c.masterPng) });
    }
    if (pageCards.length === 0) break;
    pageNum++;
    drawPage(pageCards, pageNum, pageNum === 1);
    placed += pageCards.length;
  }

  doc.end();
  await finished;
  return placed;
}
