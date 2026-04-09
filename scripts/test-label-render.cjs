/**
 * Renders a test back label to /tmp/test-back-label.png for visual inspection.
 */
const path = require("path");
const fs   = require("fs");

// Minimal cert record for testing
const testCert = {
  certId:       "MV-0000000001",
  cardName:     "Charizard",
  setName:      "Base Set",
  year:         "1999",
  gradeOverall: "9",
  gradeType:    "numeric",
  variant:      "HOLO",
  rarity:       "HOLO_RARE",
  cardNumber:   "4/102",
  language:     "English",
  labelType:    "Standard",
};

async function main() {
  // Add cwd shim so labels.ts paths resolve correctly
  process.chdir(path.join(__dirname, ".."));

  // Import label generator using the compiled TS (via tsx/ts-node workaround)
  // We'll call it indirectly via a quick inline implementation
  const { createCanvas, loadImage } = await import("canvas");

  // Constants from labels.ts
  const PX_W = 827, PX_H = 236;
  const BORDER_STROKE = 12, GOLD_CENTER = 9;
  const I_LEFT = GOLD_CENTER + BORDER_STROKE / 2;
  const I_RIGHT = PX_W - I_LEFT;
  const I_TOP = I_LEFT;
  const I_BOTTOM = PX_H - I_LEFT;
  const I_H = I_BOTTOM - I_TOP;
  const GOLD_LIGHT = "#D4AF37";
  const BLACK = "#000000", WHITE = "#FFFFFF";

  const canvas = createCanvas(PX_W, PX_H);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = BLACK;
  ctx.fillRect(0, 0, PX_W, PX_H);

  // Gold border
  ctx.strokeStyle = GOLD_LIGHT;
  ctx.lineWidth = BORDER_STROKE;
  ctx.strokeRect(GOLD_CENTER, GOLD_CENTER, PX_W - GOLD_CENTER*2, PX_H - GOLD_CENTER*2);

  // Dark gradient fill
  const bgGrad = ctx.createLinearGradient(I_LEFT, I_TOP, I_LEFT, I_BOTTOM);
  bgGrad.addColorStop(0, "#0A0A0A");
  bgGrad.addColorStop(1, "#000000");
  ctx.fillStyle = bgGrad;
  ctx.fillRect(I_LEFT, I_TOP, I_RIGHT - I_LEFT, I_H);

  // QR code (placeholder white box)
  const qrSize = 150, qrPad = 5;
  const qrX = I_RIGHT - qrSize;
  const wbLeft = qrX - qrPad, wbTop = I_TOP, wbW = qrSize + qrPad, wbH = qrSize + qrPad;
  ctx.fillStyle = WHITE;
  ctx.fillRect(wbLeft, wbTop, wbW, wbH);
  ctx.fillStyle = BLACK;
  ctx.font = "bold 14px Arial";
  ctx.textAlign = "center";
  ctx.fillText("QR CODE", wbLeft + wbW/2, wbTop + wbH/2);

  // Cert ID below QR
  ctx.fillStyle = WHITE;
  ctx.font = "bold 24px Arial";
  ctx.fillText(testCert.certId, wbLeft + wbW/2, wbTop + wbH + 30);

  // Logo (left side)
  const LOGO_PATH = path.join(process.cwd(), "public", "brand", "logo.png");
  const LOGO_DRAW = I_H - 10; // 196px — fits within inner content area
  const LOGO_LX = I_LEFT + 4;

  try {
    const logo = await loadImage(LOGO_PATH);
    const aspect = logo.width / logo.height;
    const drawH = LOGO_DRAW;
    const drawW = Math.round(drawH * aspect);
    const ly = I_TOP + Math.round((I_H - drawH) / 2);
    ctx.drawImage(logo, LOGO_LX, ly, drawW, drawH);
    console.log(`Logo drawn: ${drawW}×${drawH} at (${LOGO_LX},${ly})`);
  } catch (e) {
    console.error("Logo load failed:", e.message);
  }

  // NFC Icon (centre)
  const NFC_ICON_PATH = path.join(process.cwd(), "public", "brand", "nfc-tap-icon-white.png");
  const gfLeft = wbLeft; // 657
  const NFC_ICON_CX = Math.round((LOGO_LX + LOGO_DRAW + gfLeft) / 2);
  const iconSz = 100;

  try {
    const nfcImg = await loadImage(NFC_ICON_PATH);
    ctx.drawImage(nfcImg, NFC_ICON_CX - Math.round(iconSz/2), Math.round(PX_H/2) - Math.round(iconSz/2), iconSz, iconSz);
    console.log(`NFC icon drawn at cx=${NFC_ICON_CX}`);
  } catch (e) {
    console.error("NFC icon failed:", e.message);
  }

  // URL text (gold)
  const urlGrad = ctx.createLinearGradient(0, 10, 0, 50);
  urlGrad.addColorStop(0, "#FFF3B0");
  urlGrad.addColorStop(0.5, "#D4AF37");
  urlGrad.addColorStop(1, "#A67C00");
  ctx.font = "bold 38px Arial";
  ctx.fillStyle = urlGrad;
  ctx.textAlign = "center";
  ctx.fillText("mintvaultuk.com", NFC_ICON_CX, I_TOP + 24);

  // Redraw gold border on top
  ctx.strokeStyle = GOLD_LIGHT;
  ctx.lineWidth = BORDER_STROKE;
  ctx.shadowBlur = 0;
  ctx.strokeRect(GOLD_CENTER, GOLD_CENTER, PX_W - GOLD_CENTER*2, PX_H - GOLD_CENTER*2);

  const outPath = "/tmp/test-back-label.png";
  fs.writeFileSync(outPath, canvas.toBuffer("image/png"));
  console.log(`Saved → ${outPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
