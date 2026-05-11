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

  // ── White background — no gold border frame ─────────────────────────────
  ctx.fillStyle = WHITE;
  ctx.fillRect(0, 0, PX_W, PX_H);

  // textBaseline="alphabetic" — y values are baselines (caps sit above).
  // The approved spec gives mm-from-top values per element which read most
  // cleanly when interpreted as baselines: e.g. 18pt header baseline at 7mm
  // puts its caps ~5mm to 7mm, the 7pt subheader baseline at 10.5mm puts
  // its caps ~9.4mm to 10.5mm — clean separation. textBaseline="top" would
  // overlap the bottoms of the 18pt header into the 7pt subheader's caps.
  ctx.textBaseline = "alphabetic";

  // Left margin = 4mm; safe inset on the other edges = 3mm.
  const leftX     = px(4);
  const safeInset = px(3);

  // ── 1. "CLAIM YOUR CARD" header — 18pt extra-bold, #111111, y=7mm ───────
  ctx.font      = `800 ${ptToPx(18)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.fillStyle = "#111111";
  ctx.textAlign = "left";
  ctx.fillText("CLAIM YOUR CARD", leftX, px(7));

  // ── 2. Subheader at 10.5mm — 7pt Helvetica-Bold #111111, tight tracking ─
  ctx.font      = `bold ${ptToPx(7)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.fillStyle = "#111111";
  try { (ctx as any).letterSpacing = "0px"; } catch {}
  ctx.fillText("UK TRADING CARD AUTHENTICATION REGISTRY", leftX, px(10.5));

  // ── 3. "CERTIFICATE NO." label at 15mm — 7pt bold #555555 ───────────────
  ctx.font      = `bold ${ptToPx(7)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.fillStyle = "#555555";
  ctx.fillText("CERTIFICATE NO.", leftX, px(15));

  // ── 4. Cert ID HERO at 23.5mm — 28pt Helvetica-Black #111111 ────────────
  ctx.font      = `900 ${ptToPx(28)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.fillStyle = "#111111";
  ctx.fillText(normalCertId, leftX, px(23.5));

  // ── 5. "CLAIM CODE" label at 29mm — 7pt bold #555555 ────────────────────
  ctx.font      = `bold ${ptToPx(7)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.fillStyle = "#555555";
  ctx.fillText("CLAIM CODE", leftX, px(29));

  // ── 6. Claim code HERO at 35mm — 14pt Courier-Bold (900) #111111 ────────
  ctx.font      = `900 ${ptToPx(14)}px "Courier New", Courier, monospace`;
  ctx.fillStyle = "#111111";
  ctx.fillText(formattedCode, leftX, px(35));

  // ── 7. Three numbered steps starting at 41mm, line-height 3mm ───────────
  ctx.font      = `bold ${ptToPx(7)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.fillStyle = "#222222";
  const steps = [
    "1. Visit mintvaultuk.com/claim",
    "2. Enter cert no. & claim code",
    "3. Verify email to claim ownership",
  ];
  for (let i = 0; i < steps.length; i++) {
    ctx.fillText(steps[i], leftX, px(41 + i * 3));
  }

  // ── 8. QR code — 25mm x 25mm, right side, slightly below centre ─────────
  // Pure black on white for max inkjet scan reliability. Right edge sits at
  // the 3mm safe inset; vertical anchor nudges down ~2mm from the geometric
  // centre of the content zone (between subheader and footer band).
  const qrSize  = px(25);
  const qrBuf   = await generateQR(claimUrl, qrSize);
  const qrImg   = await loadImage(qrBuf);
  const qrX     = PX_W - safeInset - qrSize;
  const zoneTop = px(13);                    // just below subheader
  const zoneBot = PX_H - px(3);              // footer band top edge
  const qrCY    = (zoneTop + zoneBot) / 2 + px(2);
  const qrY     = Math.round(qrCY - qrSize / 2);
  ctx.drawImage(qrImg, qrX, qrY, qrSize, qrSize);

  // ── 9. Footer band — 3mm tall, edge-to-edge yellow, #111111 text ────────
  const footerY = PX_H - px(3);
  const footerH = px(3);
  ctx.fillStyle = GOLD;
  ctx.fillRect(0, footerY, PX_W, footerH);

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
