import QRCode from "qrcode";
import PDFDocument from "pdfkit";
import path from "path";

const DPI = 300;
const MM = DPI / 25.4;

const CARD_W_MM = 85.6;
const CARD_H_MM = 54;
const PX_W = Math.round(CARD_W_MM * MM);
const PX_H = Math.round(CARD_H_MM * MM);

const MM_TO_PT = 2.83465;
const PDF_W = CARD_W_MM * MM_TO_PT;
const PDF_H = CARD_H_MM * MM_TO_PT;

const LOGO_PATH = path.join(process.cwd(), "public", "brand", "logo.png");

// ── Colour palette (white background, matches certificate style) ──────────────
const WHITE   = "#FFFFFF";
const DARK    = "#1A1A1A";   // replaces BLACK text on white bg
const GOLD    = "#D4AF37";
const GOLD_DK = "#B8960C";
const GOLD_LT = "#FFD700";   // claim code highlight
const GRAY    = "#555555";   // body text on white
const GRAY_LT = "#888888";   // labels/captions on white
const GRAY_BG = "#F5F0E8";   // alternating row bg (matches certificate)

const CLAIM_BASE_URL = "https://mintvaultuk.com/claim";

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

// Draw a solid gold border frame on the canvas (matches certificate style)
function drawBorderFrame(ctx: any, w: number, h: number) {
  const bw = 8;    // outer bar width (px)
  const gap = 5;   // gap between outer bar and inner line
  const inner = 3; // inner line thickness (px)

  // Outer gold bars
  ctx.fillStyle = GOLD;
  ctx.fillRect(0, 0, w, bw);           // top
  ctx.fillRect(0, h - bw, w, bw);      // bottom
  ctx.fillRect(0, 0, bw, h);           // left
  ctx.fillRect(w - bw, 0, bw, h);      // right

  // Inner lines (vertical only, matching the certificate style)
  const offset = bw + gap;
  ctx.fillStyle = GOLD_DK;
  ctx.globalAlpha = 0.7;
  ctx.fillRect(offset, offset, inner, h - offset * 2);              // left inner
  ctx.fillRect(w - offset - inner, offset, inner, h - offset * 2);  // right inner
  ctx.globalAlpha = 1;

  // Corner ornaments
  const cs = 12;
  const co = bw + 1;
  ctx.fillStyle = GOLD;
  const corners = [
    [co, co], [w - co - cs, co],
    [co, h - co - cs], [w - co - cs, h - co - cs],
  ] as [number, number][];
  for (const [cx, cy] of corners) {
    ctx.fillRect(cx, cy, cs, cs);
  }
}

function roundRect(ctx: any, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

export async function generateClaimInsertPNG(
  certId: string,
  claimCode: string,
): Promise<Buffer> {
  const { createCanvas, loadImage } = await import("canvas");

  const canvas = createCanvas(PX_W, PX_H);
  const ctx = canvas.getContext("2d");

  const normalCertId = normalizeCertId(certId);
  const formattedCode = formatClaimCode(claimCode);
  const claimUrl = `${CLAIM_BASE_URL}?cert=${encodeURIComponent(normalCertId)}`;

  // ── White background ──────────────────────────────────────────────────────────
  ctx.fillStyle = WHITE;
  ctx.fillRect(0, 0, PX_W, PX_H);

  // ── Gold border frame (same style as certificate) ─────────────────────────────
  drawBorderFrame(ctx, PX_W, PX_H);

  // textBaseline="top" — y always refers to the TOP of the glyph cap-height.
  // y += fontSize + gap means exactly `gap` pixels of visible space below each element.
  ctx.textBaseline = "top";

  const pad = 32;

  // ── Logo: centered at top, up to 200px wide ───────────────────────────────────
  let logo: any = null;
  try { logo = await loadImage(LOGO_PATH); } catch {}

  const logoMaxW = 200;
  const logoMaxH = 68;
  let logoBottom = pad;
  if (logo) {
    const aspect = logo.width / logo.height;
    let dw = Math.min(logoMaxW, Math.round(logoMaxH * aspect));
    let dh = Math.round(dw / aspect);
    if (dh > logoMaxH) { dh = logoMaxH; dw = Math.round(dh * aspect); }
    const dx = Math.round((PX_W - dw) / 2);
    ctx.drawImage(logo, dx, pad, dw, dh);
    logoBottom = pad + dh;
  } else {
    ctx.font = "bold 38px Arial, Helvetica, sans-serif";
    ctx.fillStyle = GOLD;
    ctx.textAlign = "center";
    ctx.fillText("MINTVAULT UK", PX_W / 2, pad + 6);
    ctx.textAlign = "left";
    logoBottom = pad + 50;
  }

  // ── Registry subtitle (14px, centered) ─────────────────────────────────────
  // 12px gap below logo bottom → subtitle TOP at logoBottom + 12.
  // Subtitle is 14px tall → subtitle BOTTOM at logoBottom + 26.
  // 20px gap → header divider at logoBottom + 26 + 20 = logoBottom + 46.
  const subtitleY = logoBottom + 12;
  ctx.font = "bold 14px Arial, Helvetica, sans-serif";
  ctx.fillStyle = GRAY_LT;
  ctx.textAlign = "center";
  ctx.fillText("UK TRADING CARD AUTHENTICATION REGISTRY", PX_W / 2, subtitleY);
  ctx.textAlign = "left";

  // ── Header gold divider ───────────────────────────────────────────────────────
  // 20px clear gap below subtitle bottom (subtitleY + 14) before the 2px line.
  const headerDivY = subtitleY + 14 + 20;
  ctx.fillStyle = GOLD;
  ctx.globalAlpha = 0.6;
  ctx.fillRect(pad, headerDivY, PX_W - pad * 2, 2);
  ctx.globalAlpha = 1;

  // ── Two-column layout: left = text, right = QR ───────────────────────────────
  const rightColX = Math.round(PX_W * 0.56);
  const contentLeft = pad + 4;

  // y starts 22px below the BOTTOM of the header divider (headerDivY + 2 + 20 = +22)
  let y = headerDivY + 22;

  // "CLAIM YOUR CARD" (28px)
  ctx.font = "bold 28px Arial, Helvetica, sans-serif";
  ctx.fillStyle = GOLD;
  ctx.textAlign = "left";
  ctx.fillText("CLAIM YOUR CARD", contentLeft, y);
  y += 28 + 20; // 20px gap before next section

  // "Certificate No." label (16px)
  ctx.font = "bold 16px Arial, Helvetica, sans-serif";
  ctx.fillStyle = GRAY_LT;
  ctx.fillText("Certificate No.", contentLeft, y);
  y += 16 + 10; // 10px gap between label and its value

  // Certificate value (32px)
  ctx.font = "bold 32px 'Courier New', Courier, monospace";
  ctx.fillStyle = DARK;
  ctx.fillText(normalCertId, contentLeft, y);
  y += 32 + 20; // 20px gap before next section

  // "Claim Code" label (16px)
  ctx.font = "bold 16px Arial, Helvetica, sans-serif";
  ctx.fillStyle = GRAY_LT;
  ctx.fillText("Claim Code", contentLeft, y);
  y += 16 + 10; // 10px gap between label and its value

  // Claim code value (26px)
  ctx.font = "bold 26px 'Courier New', Courier, monospace";
  ctx.fillStyle = GOLD;
  ctx.fillText(formattedCode, contentLeft, y);
  y += 26 + 22; // 22px gap before divider

  // Section divider (left column only) — 1px line
  ctx.fillStyle = GOLD_DK;
  ctx.globalAlpha = 0.25;
  ctx.fillRect(contentLeft, y, rightColX - contentLeft - 20, 1);
  ctx.globalAlpha = 1;
  y += 1 + 20; // 20px clear gap below divider before steps

  // Steps (15px each, 10px between lines)
  ctx.font = "15px Arial, Helvetica, sans-serif";
  ctx.fillStyle = GRAY;
  const steps = [
    "1. Visit mintvaultuk.com/claim",
    "2. Enter cert no. & claim code",
    "3. Verify email to claim ownership",
  ];
  for (const step of steps) {
    ctx.fillText(step, contentLeft, y);
    y += 15 + 10;
  }

  y += 8; // extra gap before disclaimer
  ctx.font = "italic 12px Arial, Helvetica, sans-serif";
  ctx.fillStyle = GRAY_LT;
  ctx.fillText("Claim code is single-use.", contentLeft, y);

  // ── QR code — right column, vertically centred between header divider & footer ─
  const qrSize = 220;
  const qrBuf = await generateQR(claimUrl, qrSize);
  const qrImg = await loadImage(qrBuf);

  const qrPad = 8;
  const qrBoxSize = qrSize + qrPad * 2;
  const rightColW = (PX_W - pad) - rightColX;
  const qrX = rightColX + Math.round((rightColW - qrBoxSize) / 2);

  // Content zone: from just below the header divider to just above the footer
  const zoneTop = headerDivY + 2 + 22;
  const zoneBot = PX_H - pad - 34;       // leaves room for footer line + 20px gap + text
  const qrY = Math.round((zoneTop + zoneBot - qrBoxSize) / 2);

  // Warm cream background tile behind QR
  ctx.fillStyle = GRAY_BG;
  roundRect(ctx, qrX - 2, qrY - 2, qrBoxSize + 4, qrBoxSize + 4, 8);
  ctx.fill();
  ctx.drawImage(qrImg, qrX + qrPad, qrY + qrPad, qrSize, qrSize);

  // "Scan to claim" caption
  ctx.font = "12px Arial, Helvetica, sans-serif";
  ctx.fillStyle = GRAY_LT;
  ctx.textAlign = "center";
  ctx.fillText("Scan to claim", qrX + qrBoxSize / 2, qrY + qrBoxSize + 12);
  ctx.textAlign = "left";

  // ── Footer: thin gold line then text, both at bottom ─────────────────────────
  // footerTextTop = TOP of footer text (textBaseline="top").
  // footerLineY   = TOP of the 1px divider line.
  // Gap = footerTextTop - (footerLineY + 1) must be ≥ 20px.
  const footerTextTop = PX_H - pad - 14;
  const footerLineY   = footerTextTop - 22; // 21px clear gap between line bottom and text top
  console.log(`[claim-insert] PX_H=${PX_H} pad=${pad} footerTextTop=${footerTextTop} footerLineY=${footerLineY} gap=${footerTextTop - footerLineY - 1}px`);
  ctx.fillStyle = GOLD_DK;
  ctx.globalAlpha = 0.3;
  ctx.fillRect(pad, footerLineY, PX_W - pad * 2, 1);
  ctx.globalAlpha = 1;

  ctx.font = "11px Arial, Helvetica, sans-serif";
  ctx.fillStyle = GRAY_LT;
  ctx.textAlign = "center";
  ctx.fillText(
    "mintvaultuk.com  \u00b7  MintVault UK  \u00b7  UK Trading Card Authentication",
    PX_W / 2,
    footerTextTop,
  );
  ctx.textAlign = "left";

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
