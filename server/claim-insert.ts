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

const BLACK   = "#000000";
const GOLD    = "#D4AF37";
const GOLD_DK = "#B8962E";
const GOLD_LT = "#FFD700";
const WHITE   = "#FFFFFF";
const GRAY    = "#888888";
const GRAY_LT = "#AAAAAA";

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

  ctx.fillStyle = BLACK;
  ctx.fillRect(0, 0, PX_W, PX_H);

  const borderW = 4;
  const goldGrad = ctx.createLinearGradient(0, 0, PX_W, 0);
  goldGrad.addColorStop(0, "#FFF3B0");
  goldGrad.addColorStop(0.25, "#F5D06F");
  goldGrad.addColorStop(0.55, GOLD);
  goldGrad.addColorStop(0.75, GOLD_DK);
  goldGrad.addColorStop(1, "#A67C00");
  ctx.strokeStyle = goldGrad;
  ctx.lineWidth = borderW;
  ctx.strokeRect(borderW / 2, borderW / 2, PX_W - borderW, PX_H - borderW);

  const pad = 30;
  const contentLeft = pad;
  const contentTop = pad;

  let logo: any = null;
  try { logo = await loadImage(LOGO_PATH); } catch {}

  let logoBottom = contentTop;
  if (logo) {
    const logoH = 65;
    const logoW = Math.round(logoH * (logo.width / logo.height));
    ctx.drawImage(logo, contentLeft, contentTop, logoW, logoH);
    logoBottom = contentTop + logoH;
  }

  let y = logoBottom + 18;

  ctx.font = "bold 28px Arial, Helvetica, sans-serif";
  ctx.fillStyle = GOLD;
  ctx.textAlign = "left";
  ctx.fillText("CLAIM YOUR CARD", contentLeft, y);
  y += 38;

  const thinLine = () => {
    ctx.strokeStyle = GOLD_DK + "60";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(contentLeft, y);
    ctx.lineTo(PX_W / 2 - 20, y);
    ctx.stroke();
    y += 14;
  };
  thinLine();

  ctx.font = "bold 22px Arial, Helvetica, sans-serif";
  ctx.fillStyle = GRAY_LT;
  ctx.fillText("Certificate No.", contentLeft, y);
  y += 30;

  ctx.font = "bold 36px 'Courier New', Courier, monospace";
  ctx.fillStyle = WHITE;
  ctx.fillText(normalCertId, contentLeft, y);
  y += 44;

  ctx.font = "bold 22px Arial, Helvetica, sans-serif";
  ctx.fillStyle = GRAY_LT;
  ctx.fillText("Claim Code", contentLeft, y);
  y += 30;

  ctx.font = "bold 34px 'Courier New', Courier, monospace";
  ctx.fillStyle = GOLD_LT;
  ctx.fillText(formattedCode, contentLeft, y);
  y += 46;

  thinLine();

  ctx.font = "17px Arial, Helvetica, sans-serif";
  ctx.fillStyle = GRAY;
  const steps = [
    "1. Visit mintvaultuk.com/claim",
    "2. Enter your cert number & claim code",
    "3. Verify your email to claim ownership",
  ];
  for (const step of steps) {
    ctx.fillText(step, contentLeft, y);
    y += 24;
  }
  y += 8;

  ctx.font = "italic 14px Arial, Helvetica, sans-serif";
  ctx.fillStyle = GRAY + "CC";
  ctx.fillText("This number matches the number on your slab.", contentLeft, y);
  y += 18;
  ctx.fillText("Claim code can only be used once.", contentLeft, y);

  const qrSize = 200;
  const qrBuf = await generateQR(claimUrl, qrSize);
  const qrImg = await loadImage(qrBuf);

  const qrPad = 8;
  const qrBoxSize = qrSize + qrPad * 2;
  const qrX = PX_W - pad - qrBoxSize;
  const qrY = Math.round(PX_H / 2 - qrBoxSize / 2) + 10;

  ctx.fillStyle = WHITE;
  roundRect(ctx, qrX, qrY, qrBoxSize, qrBoxSize, 6);
  ctx.fill();

  ctx.drawImage(qrImg, qrX + qrPad, qrY + qrPad, qrSize, qrSize);

  ctx.font = "13px Arial, Helvetica, sans-serif";
  ctx.fillStyle = GRAY;
  ctx.textAlign = "center";
  ctx.fillText("mintvaultuk.com/claim", qrX + qrBoxSize / 2, qrY + qrBoxSize + 18);
  ctx.textAlign = "left";

  return canvas.toBuffer("image/png");
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

  const gapH = 0;
  const gapV = 0;

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
        const x = marginLeft + col * (cardW + gapH);
        const y = marginTop + row * (cardH + gapV);
        doc.image(pageInserts[i], x, y, { width: cardW, height: cardH });
      }
    }

    doc.end();
  });
}
