import QRCode from "qrcode";
import PDFDocument from "pdfkit";
import { APP_BASE_URL } from "./app-url";

const DPI = 300;
const MM = DPI / 25.4;

const CARD_W_MM = 85.6;
const CARD_H_MM = 54;
const PX_W = Math.round(CARD_W_MM * MM);
const PX_H = Math.round(CARD_H_MM * MM);

const MM_TO_PT = 2.83465;
const PDF_W = CARD_W_MM * MM_TO_PT;
const PDF_H = CARD_H_MM * MM_TO_PT;

// ── Colour palette ────────────────────────────────────────────────────────
// PR #88 typography overhaul: design principle is "black text on white,
// yellow only in the single footer band". Inkjet printers cannot reliably
// render small light-coloured text on white, so the redesign respects that
// physical constraint by anchoring all readable text to #111111 / #222222 /
// #555555. Yellow is the brand signal but never sits behind body text.
const WHITE = "#FFFFFF";
const GOLD  = "#FFCB05";   // Pikachu Yellow — footer band only

const CLAIM_BASE_URL = `${APP_BASE_URL}/claim`;

function formatClaimCode(code: string): string {
  const c = code.toUpperCase();
  if (c.length === 12) return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}`;
  return c;
}

function normalizeCertId(raw: string): string {
  const m = raw.match(/^MV-?0*(\d+)$/i);
  if (m) return `MV${m[1]}`;
  return raw;
}

async function generateQR(url: string, size: number): Promise<Buffer> {
  return await QRCode.toBuffer(url, {
    width: size,
    margin: 1,
    color: { dark: "#000000", light: "#FFFFFF" },
    errorCorrectionLevel: "M",
  });
}

export async function generateClaimInsertPNG(
  certId: string,
  claimCode: string,
): Promise<Buffer> {
  const { createCanvas, loadImage } = await import("canvas");

  const canvas = createCanvas(PX_W, PX_H);
  const ctx = canvas.getContext("2d");

  const normalCertId  = normalizeCertId(certId);
  const formattedCode = formatClaimCode(claimCode);
  const claimUrl      = `${CLAIM_BASE_URL}?cert=${encodeURIComponent(normalCertId)}`;

  // ── 300 DPI conversion helpers ──────────────────────────────────────────
  const px      = (mm: number) => Math.round(mm * MM);
  const ptToPx  = (pt: number) => Math.round(pt * (DPI / 72));   // 1pt = 4.167px @ 300DPI

  // ── Yellow border frame (PR #90 follow-up) ──────────────────────────────
  // Symmetric 2mm yellow #FFCB05 border on all four sides. The 3mm footer
  // band sits INSIDE the inner content area (just above the bottom border)
  // so the bottom edge stacks: 2mm border → 3mm yellow band → content
  // above. Reads as a single yellow frame from a glance.
  //
  // Layout (canvas mm):
  //   Yellow border        outer 2mm on all 4 sides
  //   Inner content area   x=2..83.6, y=2..49  (81.6 × 47mm)
  //   Yellow footer band   y=49..52 (3mm, inside the inner area)
  //   Yellow bottom border y=52..54
  //
  // The SVG cut layer in print-batch.ts traces the outer 85.6×54mm with a
  // 0.25mm bleed inset, which puts the cut INSIDE the yellow border — any
  // sub-mm registration drift slices through yellow rather than white.
  const BORDER_MM        = 2;
  const FOOTER_BAND_MM   = 3;

  // Step 1 — fill entire canvas yellow (border base layer).
  ctx.fillStyle = GOLD;
  ctx.fillRect(0, 0, PX_W, PX_H);

  // Step 2 — paint inner white content area on top of the yellow.
  const innerX = px(BORDER_MM);
  const innerY = px(BORDER_MM);
  const innerW = PX_W - 2 * px(BORDER_MM);
  const innerH = PX_H - 2 * px(BORDER_MM);
  ctx.fillStyle = WHITE;
  ctx.fillRect(innerX, innerY, innerW, innerH);

  // textBaseline="alphabetic" — y values are baselines (caps sit above).
  // The approved spec gives mm-from-canvas-top baselines for each element.
  // PR #90 follow-up uniformly shifts every element by +1mm so the 9-element
  // stack fits the 47mm inner content area with the steps ending 1mm above
  // the footer band: 18pt header baseline 7mm→8mm, …, last step 47mm→48mm,
  // footer band starts at canvas y=49mm.
  ctx.textBaseline = "alphabetic";

  const leftX = px(4);   // 4mm from canvas edge = 2mm from inner white edge

  // ── 1. "CLAIM YOUR CARD" header — 18pt extra-bold, #111111, y=8mm ───────
  ctx.font      = `800 ${ptToPx(18)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.fillStyle = "#111111";
  ctx.textAlign = "left";
  ctx.fillText("CLAIM YOUR CARD", leftX, px(8));

  // ── 2. Subheader at 11.5mm — 7pt Helvetica-Bold #111111 ─────────────────
  ctx.font      = `bold ${ptToPx(7)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.fillStyle = "#111111";
  try { (ctx as any).letterSpacing = "0px"; } catch {}
  ctx.fillText("UK TRADING CARD AUTHENTICATION REGISTRY", leftX, px(11.5));

  // ── 3. "CERTIFICATE NO." label at 16mm — 7pt bold #555555 ───────────────
  ctx.font      = `bold ${ptToPx(7)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.fillStyle = "#555555";
  ctx.fillText("CERTIFICATE NO.", leftX, px(16));

  // ── 4. Cert ID HERO at 24.5mm — 28pt Helvetica-Black #111111 ────────────
  ctx.font      = `900 ${ptToPx(28)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.fillStyle = "#111111";
  ctx.fillText(normalCertId, leftX, px(24.5));

  // ── 5. "CLAIM CODE" label at 30mm — 7pt bold #555555 ────────────────────
  ctx.font      = `bold ${ptToPx(7)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.fillStyle = "#555555";
  ctx.fillText("CLAIM CODE", leftX, px(30));

  // ── 6. Claim code HERO at 36mm — 14pt Courier-Bold (900) #111111 ────────
  ctx.font      = `900 ${ptToPx(14)}px "Courier New", Courier, monospace`;
  ctx.fillStyle = "#111111";
  ctx.fillText(formattedCode, leftX, px(36));

  // ── 7. Three numbered steps starting at 42mm, line-height 3mm ──────────
  // Last step baseline at 48mm; footer band top at 49mm → 1mm clearance.
  ctx.font      = `bold ${ptToPx(7)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.fillStyle = "#222222";
  const steps = [
    "1. Visit mintvaultuk.com/claim",
    "2. Enter cert no. & claim code",
    "3. Verify email to claim ownership",
  ];
  for (let i = 0; i < steps.length; i++) {
    ctx.fillText(steps[i], leftX, px(42 + i * 3));
  }

  // ── 8. QR code — 25mm × 25mm, right side, slightly below centre ─────────
  // Pure black on white for max inkjet scan reliability. Right edge sits
  // 1mm inside the right yellow border (canvas x = 83.6 - 1 = 82.6mm).
  // Vertical: centred between subheader baseline + 2mm "slightly below"
  // nudge — clears the bottom step horizontally and the footer vertically.
  const qrSize    = px(25);
  const qrBuf     = await generateQR(claimUrl, qrSize);
  const qrImg     = await loadImage(qrBuf);
  const qrX       = PX_W - px(BORDER_MM + 1) - qrSize;
  const footerTop = PX_H - px(BORDER_MM + FOOTER_BAND_MM);   // canvas y=49mm
  const zoneTop   = px(14);                                  // just below subheader caps
  const qrCY      = (zoneTop + footerTop) / 2 + px(2);
  const qrY       = Math.round(qrCY - qrSize / 2);
  ctx.drawImage(qrImg, qrX, qrY, qrSize, qrSize);

  // ── 9. Footer band — 3mm tall yellow strip INSIDE the inner area, with
  // #111111 text centred. Sits just above the 2mm bottom border. ──────────
  const footerY  = footerTop;
  const footerH  = px(FOOTER_BAND_MM);
  ctx.fillStyle  = GOLD;
  ctx.fillRect(innerX, footerY, innerW, footerH);

  ctx.textBaseline = "middle";
  ctx.font         = `bold ${ptToPx(5.5)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.fillStyle    = "#111111";
  ctx.textAlign    = "center";
  ctx.fillText(
    "mintvaultuk.com  —  MintVault UK  —  UK Trading Card Authentication",
    PX_W / 2,
    footerY + footerH / 2,
  );
  ctx.textAlign    = "left";
  ctx.textBaseline = "alphabetic";

  return canvas.toBuffer("image/png");
}

export async function generateClaimInsertPDF(
  certId: string,
  claimCode: string,
): Promise<Buffer> {
  const png = await generateClaimInsertPNG(certId, claimCode);

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: [PDF_W, PDF_H], margin: 0 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.image(png, 0, 0, { width: PDF_W, height: PDF_H });
    doc.end();
  });
}

export async function generateClaimInsertSheet(
  inserts: Array<{ certId: string; claimCode: string }>,
): Promise<Buffer> {
  const A4_W = 595.28;
  const A4_H = 841.89;

  const COLS = 2;
  const ROWS = 5;
  const PER_PAGE = COLS * ROWS;

  const cardW = PDF_W;
  const cardH = PDF_H;

  const totalW = COLS * cardW;
  const totalH = ROWS * cardH;
  const marginLeft = (A4_W - totalW) / 2;
  const marginTop = (A4_H - totalH) / 2;

  const pngs: Buffer[] = [];
  for (const ins of inserts) {
    pngs.push(await generateClaimInsertPNG(ins.certId, ins.claimCode));
  }

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 0 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    for (let pageStart = 0; pageStart < pngs.length; pageStart += PER_PAGE) {
      if (pageStart > 0) doc.addPage();
      const pageInserts = pngs.slice(pageStart, pageStart + PER_PAGE);

      for (let i = 0; i < pageInserts.length; i++) {
        const col = i % COLS;
        const row = Math.floor(i / COLS);
        const x = marginLeft + col * cardW;
        const y = marginTop + row * cardH;
        doc.image(pageInserts[i], x, y, { width: cardW, height: cardH });
      }
    }

    doc.end();
  });
}
