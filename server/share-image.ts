/**
 * Instagram share-image generator — feed (1080×1080) and story (1080×1920).
 *
 * Dramatic glow layout: the background glow + card frame are auto-tinted from
 * the grade tier's colour (glowFromGrade), the grade badge uses
 * the grade-tier colour with a radial glow, and MintVault branding + the
 * verify URL anchor the frame. node-canvas for drawing, sharp for the colour
 * sampling, scan decode and final JPEG encode — same toolchain as the label
 * pipeline (server/labels.ts).
 *
 * Images are cached permanently in R2 (public/share/{cert}/{format}.jpg);
 * the approve endpoint deletes the keys on re-grade so the next request
 * regenerates with the new grade.
 *
 * No PII: cert number, grade, card identity only.
 */
import sharp from "sharp";
import { uploadToR2, headR2 } from "./r2";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getR2Client } from "./r2";

export interface ShareCertData {
  certNumber: string;
  grade: number;
  gradeLabel: string;
  gradeStrengthScore: number | null;
  cardName: string;
  setName: string | null;
}

export type ShareFormat = "feed" | "story";

// Same mapping as the client gradeColor (SlabShowcase.tsx).
function gradeHex(grade: number): string {
  if (grade >= 10) return "#D4AF37";
  if (grade >= 9.5) return "#c8a020";
  if (grade >= 9) return "#22c55e";
  if (grade >= 8) return "#16a34a";
  if (grade >= 7) return "#3b82f6";
  if (grade >= 6) return "#f59e0b";
  if (grade >= 5) return "#ea580c";
  if (grade >= 4) return "#ef4444";
  return "#991b1b";
}

/** "r,g,b" string of the grade colour — for rgba() gradient stops. */
function gradeRgb(grade: number): string {
  const hex = gradeHex(grade).replace("#", "");
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `${r},${g},${b}`;
}

/** Darkened (×0.65) grade colour — bottom stop of the badge fill gradient. */
function gradeDarkHex(grade: number): string {
  const hex = gradeHex(grade).replace("#", "");
  const r = Math.round(parseInt(hex.slice(0, 2), 16) * 0.65);
  const g = Math.round(parseInt(hex.slice(2, 4), 16) * 0.65);
  const b = Math.round(parseInt(hex.slice(4, 6), 16) * 0.65);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

/** Manual rounded-rect path — node-canvas roundRect support varies by build. */
function roundRectPath(ctx: any, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Glow colour by grade tier — same palette as the grade badge / client
 * gradeColor. Replaces the old card-art colour extraction: grade-based is
 * guaranteed vivid on every card and always coheres with the badge.
 */
function glowFromGrade(grade: number): string {
  if (grade >= 10) return "212,175,55"; // gold
  if (grade >= 9.5) return "200,160,32"; // deep gold
  if (grade >= 9) return "34,197,94"; // green
  if (grade >= 8) return "22,163,74"; // dark green
  if (grade >= 7) return "59,130,246"; // blue
  if (grade >= 6) return "245,158,11"; // amber
  if (grade >= 5) return "234,88,12"; // orange
  if (grade >= 4) return "239,68,68"; // red
  return "153,27,27"; // dark red
}

async function fetchR2Buffer(key: string): Promise<Buffer> {
  const result = await getR2Client().send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: key }));
  if (!result.Body) throw new Error(`Empty R2 body for ${key}`);
  const chunks: Buffer[] = [];
  for await (const chunk of result.Body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Gold gradient hairline along the bottom edge — shared by both formats. */
function drawGoldBottomLine(ctx: any, w: number, h: number) {
  const goldLine = ctx.createLinearGradient(0, 0, w, 0);
  goldLine.addColorStop(0, "transparent");
  goldLine.addColorStop(0.25, "#D4AF37");
  goldLine.addColorStop(0.75, "#f0d070");
  goldLine.addColorStop(1, "transparent");
  ctx.strokeStyle = goldLine;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(0, h - 2);
  ctx.lineTo(w, h - 2);
  ctx.stroke();
}

// ── Format A: 1080×1080 feed ───────────────────────────────────────────────

async function renderFeed(cert: ShareCertData, scanBuffer: Buffer): Promise<Buffer> {
  const { createCanvas, loadImage } = await import("canvas");
  const W = 1080;
  const H = 1080;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  const glowRgb = glowFromGrade(cert.grade);
  const glowHex = gradeHex(cert.grade);

  // ── 1. BACKGROUND — near black ──
  ctx.fillStyle = "#050504";
  ctx.fillRect(0, 0, W, H);

  // ── 2. CARD IMAGE — fills almost the full frame ──
  const cardImg = await loadImage(await sharp(scanBuffer).png().toBuffer());
  const CARD_Y = 50; // header margin
  const CARD_W = W - 52; // 26px side margins
  const CARD_H = H - 118; // 50 top + 68 footer
  const scale = Math.min(CARD_W / cardImg.width, CARD_H / cardImg.height);
  const drawnW = Math.round(cardImg.width * scale);
  const drawnH = Math.round(cardImg.height * scale);
  const drawX = Math.round((W - drawnW) / 2);
  const drawY = Math.round(CARD_Y + (CARD_H - drawnH) / 2);

  // ── 3. CARD EDGE GLOW — layered shadowBlur passes behind the card ──
  for (const blur of [80, 40, 16]) {
    ctx.save();
    ctx.shadowColor = glowHex;
    ctx.shadowBlur = blur;
    ctx.fillStyle = glowHex;
    roundRectPath(ctx, drawX, drawY, drawnW, drawnH, 10);
    ctx.fill();
    ctx.restore();
  }

  // ── 4. CARD IMAGE (clipped to rounded rect) ──
  ctx.save();
  roundRectPath(ctx, drawX, drawY, drawnW, drawnH, 10);
  ctx.clip();
  ctx.drawImage(cardImg, drawX, drawY, drawnW, drawnH);
  ctx.restore();

  // Card border (thin, grade coloured)
  ctx.strokeStyle = `rgba(${glowRgb}, 0.85)`;
  ctx.lineWidth = 2.5;
  roundRectPath(ctx, drawX, drawY, drawnW, drawnH, 10);
  ctx.stroke();

  // ── 5. GRADE BADGE — overlaps the card's bottom-right corner ──
  const BADGE_R = 80;
  const BADGE_CX = drawX + drawnW - 18;
  const BADGE_CY = drawY + drawnH - 18;

  ctx.save();
  ctx.shadowColor = glowHex;
  ctx.shadowBlur = 30;
  ctx.fillStyle = gradeHex(cert.grade);
  ctx.beginPath();
  ctx.arc(BADGE_CX, BADGE_CY, BADGE_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const bFill = ctx.createLinearGradient(
    BADGE_CX - BADGE_R,
    BADGE_CY - BADGE_R,
    BADGE_CX + BADGE_R,
    BADGE_CY + BADGE_R
  );
  bFill.addColorStop(0, gradeHex(cert.grade));
  bFill.addColorStop(1, gradeDarkHex(cert.grade));
  ctx.fillStyle = bFill;
  ctx.beginPath();
  ctx.arc(BADGE_CX, BADGE_CY, BADGE_R, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "rgba(255,255,255,0.28)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(BADGE_CX, BADGE_CY, BADGE_R, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = "rgba(255,255,255,0.1)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(BADGE_CX, BADGE_CY, BADGE_R - 7, 0, Math.PI * 2);
  ctx.stroke();

  const badgeTxt = cert.grade >= 9.5 ? "#0a0a08" : "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = badgeTxt;
  ctx.font = `900 ${cert.grade % 1 !== 0 ? 60 : 70}px sans-serif`;
  ctx.fillText(String(cert.grade), BADGE_CX, BADGE_CY - 12);
  ctx.font = "600 20px sans-serif";
  ctx.fillStyle = cert.grade >= 9.5 ? "rgba(10,10,8,0.78)" : "rgba(255,255,255,0.85)";
  ctx.fillText(cert.gradeLabel.toUpperCase(), BADGE_CX, BADGE_CY + 34);

  // ── 6. HEADER STRIP ──
  const hdrGrad = ctx.createLinearGradient(0, 0, 0, 52);
  hdrGrad.addColorStop(0, "rgba(0,0,0,0.85)");
  hdrGrad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = hdrGrad;
  ctx.fillRect(0, 0, W, 52);

  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#D4AF37";
  ctx.font = "bold 22px sans-serif";
  ctx.fillText("MINTVAULT", 28, 28);
  const mvW = ctx.measureText("MINTVAULT").width;
  ctx.fillStyle = "rgba(255,255,255,0.4)";
  ctx.font = "400 15px sans-serif";
  ctx.fillText("CERTIFIED GRADING", 28 + mvW + 14, 28);

  // ── 7. FOOTER STRIP ──
  const ftrGrad = ctx.createLinearGradient(0, H - 70, 0, H);
  ftrGrad.addColorStop(0, "rgba(0,0,0,0)");
  ftrGrad.addColorStop(1, "rgba(0,0,0,0.92)");
  ctx.fillStyle = ftrGrad;
  ctx.fillRect(0, H - 70, W, 70);

  // Card name — left aligned, ellipsis-truncated
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 38px sans-serif";
  let nameText = cert.cardName.toUpperCase();
  while (ctx.measureText(nameText).width > 680 && nameText.length > 4) nameText = nameText.slice(0, -1);
  if (nameText !== cert.cardName.toUpperCase()) nameText += "…";
  ctx.fillText(nameText, 28, H - 30);

  if (cert.setName) {
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = "400 22px sans-serif";
    ctx.fillText(cert.setName, 30, H - 8);
  }

  // Cert number + URL — right aligned
  ctx.textAlign = "right";
  ctx.fillStyle = `rgba(${glowRgb}, 0.8)`;
  ctx.font = "500 16px monospace";
  ctx.fillText(cert.certNumber, W - 28, H - 30);
  ctx.fillStyle = "rgba(255,255,255,0.22)";
  ctx.font = "400 13px sans-serif";
  ctx.fillText("mintvaultuk.com/cert/" + cert.certNumber, W - 28, H - 10);

  // ── 8. GOLD BOTTOM LINE ──
  drawGoldBottomLine(ctx, W, H);

  return sharp(canvas.toBuffer("image/png")).jpeg({ quality: 88, progressive: true, mozjpeg: true }).toBuffer();
}

// ── Format B: 1080×1920 story ──────────────────────────────────────────────

async function renderStory(cert: ShareCertData, scanBuffer: Buffer): Promise<Buffer> {
  const { createCanvas, loadImage } = await import("canvas");
  const SW = 1080;
  const SH = 1920;
  const canvas = createCanvas(SW, SH);
  const ctx = canvas.getContext("2d");

  const glowRgb = glowFromGrade(cert.grade);
  const glowHex = gradeHex(cert.grade);

  // ── BACKGROUND — near black ──
  ctx.fillStyle = "#050504";
  ctx.fillRect(0, 0, SW, SH);

  // ── "JUST CERTIFIED" header with flanking gold lines ──
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#D4AF37";
  ctx.font = "bold 52px sans-serif";
  ctx.fillText("JUST CERTIFIED", SW / 2, 110);
  ctx.strokeStyle = "rgba(212,175,55,0.45)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(60, 110);
  ctx.lineTo(330, 110);
  ctx.moveTo(750, 110);
  ctx.lineTo(1020, 110);
  ctx.stroke();

  // ── CARD IMAGE — fills the top ~78% of the frame ──
  const cardImg = await loadImage(await sharp(scanBuffer).png().toBuffer());
  const CARD_Y = 148;
  const CARD_W = 1020;
  const CARD_H = 1380;
  const scale = Math.min(CARD_W / cardImg.width, CARD_H / cardImg.height);
  const drawnW = Math.round(cardImg.width * scale);
  const drawnH = Math.round(cardImg.height * scale);
  const drawX = Math.round((SW - drawnW) / 2);
  const drawY = Math.round(CARD_Y + (CARD_H - drawnH) / 2);

  // Card edge glow — same three-pass bloom as the feed
  for (const blur of [80, 40, 16]) {
    ctx.save();
    ctx.shadowColor = glowHex;
    ctx.shadowBlur = blur;
    ctx.fillStyle = glowHex;
    roundRectPath(ctx, drawX, drawY, drawnW, drawnH, 10);
    ctx.fill();
    ctx.restore();
  }

  ctx.save();
  roundRectPath(ctx, drawX, drawY, drawnW, drawnH, 10);
  ctx.clip();
  ctx.drawImage(cardImg, drawX, drawY, drawnW, drawnH);
  ctx.restore();

  ctx.strokeStyle = `rgba(${glowRgb}, 0.85)`;
  ctx.lineWidth = 2.5;
  roundRectPath(ctx, drawX, drawY, drawnW, drawnH, 10);
  ctx.stroke();

  // ── GRADE BADGE — larger, overlaps the card corner ──
  const BADGE_R = 96;
  const BADGE_CX = drawX + drawnW - 22;
  const BADGE_CY = drawY + drawnH - 22;

  ctx.save();
  ctx.shadowColor = glowHex;
  ctx.shadowBlur = 30;
  ctx.fillStyle = gradeHex(cert.grade);
  ctx.beginPath();
  ctx.arc(BADGE_CX, BADGE_CY, BADGE_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const bFill = ctx.createLinearGradient(
    BADGE_CX - BADGE_R,
    BADGE_CY - BADGE_R,
    BADGE_CX + BADGE_R,
    BADGE_CY + BADGE_R
  );
  bFill.addColorStop(0, gradeHex(cert.grade));
  bFill.addColorStop(1, gradeDarkHex(cert.grade));
  ctx.fillStyle = bFill;
  ctx.beginPath();
  ctx.arc(BADGE_CX, BADGE_CY, BADGE_R, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "rgba(255,255,255,0.28)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(BADGE_CX, BADGE_CY, BADGE_R, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = "rgba(255,255,255,0.1)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(BADGE_CX, BADGE_CY, BADGE_R - 7, 0, Math.PI * 2);
  ctx.stroke();

  const badgeTxt = cert.grade >= 9.5 ? "#0a0a08" : "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = badgeTxt;
  ctx.font = `900 ${cert.grade % 1 !== 0 ? 68 : 82}px sans-serif`;
  ctx.fillText(String(cert.grade), BADGE_CX, BADGE_CY - 14);
  ctx.font = "600 22px sans-serif";
  ctx.fillStyle = cert.grade >= 9.5 ? "rgba(10,10,8,0.78)" : "rgba(255,255,255,0.85)";
  ctx.fillText(cert.gradeLabel.toUpperCase(), BADGE_CX, BADGE_CY + 40);

  // ── CARD NAME + SET — centred below the card ──
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 52px sans-serif";
  ctx.fillText(cert.cardName.toUpperCase(), SW / 2, drawY + drawnH + 72, 980);
  if (cert.setName) {
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = "400 30px sans-serif";
    ctx.fillText(cert.setName, SW / 2, drawY + drawnH + 130, 980);
  }

  // ── MVGS SCORE BAR — centred (only if score not null) ──
  if (cert.gradeStrengthScore != null) {
    const score = Math.max(0, Math.min(100, cert.gradeStrengthScore));
    const BAR_Y = drawY + drawnH + 160;
    ctx.fillStyle = "rgba(255,255,255,0.07)";
    roundRectPath(ctx, (SW - 600) / 2, BAR_Y, 600, 5, 3);
    ctx.fill();
    ctx.fillStyle = gradeHex(cert.grade);
    roundRectPath(ctx, (SW - 600) / 2, BAR_Y, 600 * (score / 100), 5, 3);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.font = "400 17px sans-serif";
    ctx.fillText(`MVGS SCORE  ${cert.gradeStrengthScore}/100`, SW / 2, BAR_Y + 22 + 5);
  }

  // ── FOOTER ──
  ctx.textAlign = "center";
  ctx.font = "500 26px sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.fillText("Graded by MINTVAULT UK", SW / 2, 1850);
  ctx.font = "400 20px sans-serif";
  ctx.fillStyle = "rgba(212,175,55,0.5)";
  ctx.fillText("mintvaultuk.com", SW / 2, 1884);

  // ── GOLD BOTTOM LINE ──
  drawGoldBottomLine(ctx, SW, SH);

  return sharp(canvas.toBuffer("image/png")).jpeg({ quality: 88, progressive: true, mozjpeg: true }).toBuffer();
}

// ── Public API: cached generate ─────────────────────────────────────────────

/**
 * Returns the share image for a cert/format — from R2 when cached, freshly
 * rendered (and uploaded) otherwise. scanKey is the R2 key of the front scan.
 */
export async function getOrCreateShareImage(
  cert: ShareCertData,
  scanKey: string,
  format: ShareFormat
): Promise<Buffer> {
  const r2Key = `public/share/${cert.certNumber}/${format}.jpg`;

  const cached = await headR2(r2Key).catch(() => null);
  if (cached) return fetchR2Buffer(r2Key);

  const scanBuffer = await fetchR2Buffer(scanKey);
  const image = format === "feed" ? await renderFeed(cert, scanBuffer) : await renderStory(cert, scanBuffer);

  await uploadToR2(r2Key, image, "image/jpeg");
  console.log(
    `[share-image] generated ${format} for ${cert.certNumber} (${(image.length / 1024).toFixed(0)}KB → ${r2Key})`
  );
  return image;
}
