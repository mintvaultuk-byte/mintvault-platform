/**
 * Instagram share-image generator — feed (1080×1080) and story (1080×1920).
 *
 * Dramatic glow layout: the background glow + card frame are auto-tinted from
 * the card art's dominant colour (extractDominantColor), the grade badge uses
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

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h, s, l };
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  };
}

/**
 * Dominant colour of the card ART — saturation-weighted average of the
 * centre crop (28%–72% both axes, cutting well inside the card border/mat),
 * ignoring near-greys and extreme lights/darks, then saturation-boosted so
 * even pale cards produce a vivid glow. Falls back to brand gold when the
 * art is effectively monochrome.
 */
async function extractDominantColor(cardBuffer: Buffer): Promise<{ r: number; g: number; b: number }> {
  const { data, info } = await sharp(cardBuffer)
    .resize(60, 84, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width,
    h = info.height;
  const xStart = Math.floor(w * 0.28);
  const xEnd = Math.floor(w * 0.72);
  const yStart = Math.floor(h * 0.28);
  const yEnd = Math.floor(h * 0.72);

  let sumR = 0,
    sumG = 0,
    sumB = 0,
    totalWeight = 0;

  for (let y = yStart; y < yEnd; y++) {
    for (let x = xStart; x < xEnd; x++) {
      const i = (y * w + x) * 3;
      const r = data[i],
        g = data[i + 1],
        b = data[i + 2];
      const max = Math.max(r, g, b),
        min = Math.min(r, g, b);
      const lightness = (max + min) / 2;
      const sat = max === min ? 0 : (max - min) / (255 - Math.abs(2 * lightness - 255));
      if (sat > 0.22 && lightness > 35 && lightness < 215) {
        const w2 = sat * sat;
        sumR += r * w2;
        sumG += g * w2;
        sumB += b * w2;
        totalWeight += w2;
      }
    }
  }

  if (totalWeight === 0) return { r: 212, g: 175, b: 55 };

  // Boost saturation so even pale cards produce a vivid glow. Clamp
  // lightness 0.35–0.60 so the glow is neither murky nor washed out.
  const hsl = rgbToHsl(Math.round(sumR / totalWeight), Math.round(sumG / totalWeight), Math.round(sumB / totalWeight));
  return hslToRgb(hsl.h, Math.max(hsl.s, 0.65), Math.min(Math.max(hsl.l, 0.35), 0.6));
}

async function fetchR2Buffer(key: string): Promise<Buffer> {
  const result = await getR2Client().send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: key }));
  if (!result.Body) throw new Error(`Empty R2 body for ${key}`);
  const chunks: Buffer[] = [];
  for await (const chunk of result.Body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Grade badge — radial outer glow, gradient disc, border, inset highlight,
 *  grade number + tier label. Shared by both formats (sizes differ). */
function drawBadge(
  ctx: any,
  cert: ShareCertData,
  cx: number,
  cy: number,
  radius: number,
  numberPx: number,
  labelPx: number
) {
  // Outer glow — tight halo, not a second background (was 1.8r @ 0.55)
  const badgeGlow = ctx.createRadialGradient(cx, cy, radius * 0.4, cx, cy, radius * 1.25);
  badgeGlow.addColorStop(0, `rgba(${gradeRgb(cert.grade)}, 0.35)`);
  badgeGlow.addColorStop(1, `rgba(${gradeRgb(cert.grade)}, 0)`);
  ctx.fillStyle = badgeGlow;
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 1.25, 0, Math.PI * 2);
  ctx.fill();

  // Badge fill gradient
  const badgeFill = ctx.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius);
  badgeFill.addColorStop(0, gradeHex(cert.grade));
  badgeFill.addColorStop(1, gradeDarkHex(cert.grade));
  ctx.fillStyle = badgeFill;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();

  // Border
  ctx.strokeStyle = "rgba(255,255,255,0.28)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();

  // Inset highlight
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, radius - 6, 0, Math.PI * 2);
  ctx.stroke();

  // Grade number (dark text on the gold tiers)
  const badgeTxt = cert.grade >= 9.5 ? "#0a0a08" : "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = badgeTxt;
  ctx.font = `900 ${numberPx}px sans-serif`;
  ctx.fillText(String(cert.grade), cx, cy - 12);

  // Grade tier label
  ctx.font = `600 ${labelPx}px sans-serif`;
  ctx.fillStyle = cert.grade >= 9.5 ? "rgba(10,10,8,0.75)" : "rgba(255,255,255,0.82)";
  ctx.fillText(cert.gradeLabel.toUpperCase(), cx, cy + 34, radius * 1.7);
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

  // Extract card colour — drives the background glow + card frame
  const { r: dr, g: dg, b: db } = await extractDominantColor(scanBuffer);
  const glowRgb = `${dr},${dg},${db}`;

  // ── BACKGROUND ──
  ctx.fillStyle = "#0a0a08";
  ctx.fillRect(0, 0, W, H);

  // Large colour glow — auto-matched to card art, centred behind the card
  const glow = ctx.createRadialGradient(W / 2, H * 0.48, 0, W / 2, H * 0.48, W * 0.64);
  glow.addColorStop(0, `rgba(${glowRgb}, 0.72)`);
  glow.addColorStop(0.35, `rgba(${glowRgb}, 0.35)`);
  glow.addColorStop(0.7, `rgba(${glowRgb}, 0.10)`);
  glow.addColorStop(1, `rgba(${glowRgb}, 0)`);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // Floor darkening
  const floor = ctx.createLinearGradient(0, H * 0.68, 0, H);
  floor.addColorStop(0, "rgba(0,0,0,0)");
  floor.addColorStop(1, "rgba(0,0,0,0.6)");
  ctx.fillStyle = floor;
  ctx.fillRect(0, 0, W, H);

  // ── CARD IMAGE ── fit into 580×812, centred horizontally, top at y=58
  const cardImg = await loadImage(await sharp(scanBuffer).png().toBuffer());
  const CARD_MAX_W = 580,
    CARD_MAX_H = 812;
  const scale = Math.min(CARD_MAX_W / cardImg.width, CARD_MAX_H / cardImg.height);
  const drawnW = Math.round(cardImg.width * scale);
  const drawnH = Math.round(cardImg.height * scale);
  const cardX = Math.round((W - drawnW) / 2);
  const cardY = 58;
  ctx.drawImage(cardImg, cardX, cardY, drawnW, drawnH);

  // Coloured frame around card (uses card's own colour)
  ctx.strokeStyle = `rgba(${glowRgb}, 0.65)`;
  ctx.lineWidth = 3;
  roundRectPath(ctx, cardX - 5, cardY - 5, drawnW + 10, drawnH + 10, 10);
  ctx.stroke();

  // ── GRADE BADGE ──
  drawBadge(ctx, cert, cardX + drawnW - 24, cardY + drawnH - 24, 82, cert.grade % 1 !== 0 ? 62 : 72, 19);

  // ── CARD NAME + SET ──
  const TEXT_Y = cardY + drawnH + 50;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  // Card name — large bold white, truncated with ellipsis past 820px
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 52px sans-serif";
  let nameText = cert.cardName.toUpperCase();
  while (ctx.measureText(nameText).width > 820 && nameText.length > 4) nameText = nameText.slice(0, -1);
  if (nameText !== cert.cardName.toUpperCase()) nameText += "…";
  ctx.fillText(nameText, 54, TEXT_Y);

  // Set name
  if (cert.setName) {
    ctx.fillStyle = "rgba(255,255,255,0.65)";
    ctx.font = "400 28px sans-serif";
    ctx.fillText(cert.setName, 56, TEXT_Y + 46);
  }

  // ── MVGS SCORE BAR (only if score not null) ──
  if (cert.gradeStrengthScore != null) {
    const score = Math.max(0, Math.min(100, cert.gradeStrengthScore));
    const BAR_Y = TEXT_Y + (cert.setName ? 82 : 54);
    ctx.fillStyle = "rgba(255,255,255,0.07)";
    roundRectPath(ctx, 54, BAR_Y, 480, 5, 3);
    ctx.fill();
    ctx.fillStyle = gradeHex(cert.grade);
    roundRectPath(ctx, 54, BAR_Y, 480 * (score / 100), 5, 3);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.font = "400 17px sans-serif";
    ctx.fillText(`MVGS SCORE  ${cert.gradeStrengthScore}/100`, 54, BAR_Y + 26);
  }

  // ── MINTVAULT HEADER ──
  const hdrGrad = ctx.createLinearGradient(0, 0, 0, 72);
  hdrGrad.addColorStop(0, "rgba(0,0,0,0.72)");
  hdrGrad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = hdrGrad;
  ctx.fillRect(0, 0, W, 72);

  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#D4AF37";
  ctx.font = "bold 26px sans-serif";
  ctx.fillText("MINTVAULT", 54, 38);
  const mvWidth = ctx.measureText("MINTVAULT").width;
  ctx.fillStyle = "rgba(255,255,255,0.38)";
  ctx.font = "400 17px sans-serif";
  ctx.fillText("CERTIFIED GRADING", 54 + mvWidth + 16, 38);

  // ── CERT + URL (bottom right) ──
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.fillStyle = `rgba(${glowRgb}, 0.75)`;
  ctx.font = "500 17px monospace";
  ctx.fillText(cert.certNumber, W - 50, H - 28);
  ctx.fillStyle = "rgba(255,255,255,0.22)";
  ctx.font = "400 14px sans-serif";
  ctx.fillText("mintvaultuk.com/cert/" + cert.certNumber, W - 50, H - 50);

  // ── GOLD BOTTOM LINE ──
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

  // Extract card colour — same sampling as the feed
  const { r: dr, g: dg, b: db } = await extractDominantColor(scanBuffer);
  const glowRgb = `${dr},${dg},${db}`;

  // ── BACKGROUND ── same technique as the feed, taller glow
  ctx.fillStyle = "#0a0a08";
  ctx.fillRect(0, 0, SW, SH);

  const glow = ctx.createRadialGradient(SW / 2, SH * 0.48, 0, SW / 2, SH * 0.48, SW * 0.8);
  glow.addColorStop(0, `rgba(${glowRgb}, 0.72)`);
  glow.addColorStop(0.35, `rgba(${glowRgb}, 0.35)`);
  glow.addColorStop(0.7, `rgba(${glowRgb}, 0.10)`);
  glow.addColorStop(1, `rgba(${glowRgb}, 0)`);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, SW, SH);

  const floor = ctx.createLinearGradient(0, SH * 0.68, 0, SH);
  floor.addColorStop(0, "rgba(0,0,0,0)");
  floor.addColorStop(1, "rgba(0,0,0,0.6)");
  ctx.fillStyle = floor;
  ctx.fillRect(0, 0, SW, SH);

  // ── "JUST CERTIFIED" header with flanking gold lines ──
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#D4AF37";
  ctx.font = "bold 60px sans-serif";
  ctx.fillText("JUST CERTIFIED", SW / 2, 195);
  ctx.strokeStyle = "rgba(212,175,55,0.4)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(60, 195);
  ctx.lineTo(360, 195);
  ctx.moveTo(720, 195);
  ctx.lineTo(1020, 195);
  ctx.stroke();

  // ── CARD IMAGE ── fit into 820×1148, centred, top at y=255
  const cardImg = await loadImage(await sharp(scanBuffer).png().toBuffer());
  const CARD_MAX_W = 820,
    CARD_MAX_H = 1148;
  const scale = Math.min(CARD_MAX_W / cardImg.width, CARD_MAX_H / cardImg.height);
  const drawnW = Math.round(cardImg.width * scale);
  const drawnH = Math.round(cardImg.height * scale);
  const cardX = Math.round((SW - drawnW) / 2);
  const cardY = 255;
  ctx.drawImage(cardImg, cardX, cardY, drawnW, drawnH);

  ctx.strokeStyle = `rgba(${glowRgb}, 0.65)`;
  ctx.lineWidth = 3;
  roundRectPath(ctx, cardX - 5, cardY - 5, drawnW + 10, drawnH + 10, 10);
  ctx.stroke();

  // ── GRADE BADGE — larger ──
  drawBadge(ctx, cert, cardX + drawnW - 28, cardY + drawnH - 28, 96, cert.grade % 1 !== 0 ? 70 : 84, 22);

  // ── CARD NAME + SET — centred ──
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 60px sans-serif";
  ctx.fillText(cert.cardName.toUpperCase(), SW / 2, cardY + drawnH + 90, 920);
  if (cert.setName) {
    ctx.fillStyle = "rgba(255,255,255,0.65)";
    ctx.font = "400 32px sans-serif";
    ctx.fillText(cert.setName, SW / 2, cardY + drawnH + 158, 920);
  }

  // ── MVGS SCORE BAR — centred (only if score not null) ──
  if (cert.gradeStrengthScore != null) {
    const score = Math.max(0, Math.min(100, cert.gradeStrengthScore));
    const BAR_Y = cardY + drawnH + 200;
    ctx.fillStyle = "rgba(255,255,255,0.07)";
    roundRectPath(ctx, 240, BAR_Y, 600, 5, 3);
    ctx.fill();
    ctx.fillStyle = gradeHex(cert.grade);
    roundRectPath(ctx, 240, BAR_Y, 600 * (score / 100), 5, 3);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.font = "400 17px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`MVGS SCORE  ${cert.gradeStrengthScore}/100`, SW / 2, BAR_Y + 30);
  }

  // ── FOOTER ──
  ctx.textAlign = "center";
  ctx.font = "500 28px sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.fillText("Graded by MINTVAULT UK", SW / 2, 1840);
  ctx.font = "400 22px sans-serif";
  ctx.fillStyle = "rgba(212,175,55,0.5)";
  ctx.fillText("mintvaultuk.com", SW / 2, 1878);

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
