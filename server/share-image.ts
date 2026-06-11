/**
 * Instagram share-image generator — feed (1080×1080) and story (1080×1920).
 *
 * Renders the cert's real front scan onto a dark branded canvas with a gold
 * frame, grade badge, MVGS bar, and verify URL. node-canvas for drawing,
 * sharp for the scan resize + final JPEG encode — same toolchain as the
 * label pipeline (server/labels.ts).
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
function gradeColor(grade: number): string {
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

async function fetchR2Buffer(key: string): Promise<Buffer> {
  const result = await getR2Client().send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: key }));
  if (!result.Body) throw new Error(`Empty R2 body for ${key}`);
  const chunks: Buffer[] = [];
  for await (const chunk of result.Body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/**
 * Draw the scan into an area (centred, aspect-preserved) with a gold frame.
 * Returns the drawn bounds so callers can anchor the badge/labels to them.
 */
async function drawCardWithFrame(
  ctx: any,
  loadImage: (src: Buffer) => Promise<any>,
  scanBuffer: Buffer,
  area: { x: number; y: number; w: number; h: number }
): Promise<{ x: number; y: number; w: number; h: number }> {
  // Resize to fit the area (sharp keeps aspect with fit:"inside")
  const resized = await sharp(scanBuffer)
    .resize(Math.round(area.w), Math.round(area.h), { fit: "inside", withoutEnlargement: false })
    .png()
    .toBuffer();
  const meta = await sharp(resized).metadata();
  const drawW = meta.width || area.w;
  const drawH = meta.height || area.h;
  const drawX = area.x + (area.w - drawW) / 2;
  const drawY = area.y + (area.h - drawH) / 2;

  const img = await loadImage(resized);
  ctx.drawImage(img, drawX, drawY, drawW, drawH);

  // Gold frame
  ctx.strokeStyle = "#D4AF37";
  ctx.lineWidth = 3;
  roundRectPath(ctx, drawX - 6, drawY - 6, drawW + 12, drawH + 12, 8);
  ctx.stroke();

  return { x: drawX, y: drawY, w: drawW, h: drawH };
}

/** Grade badge circle anchored to the card's bottom-right corner. */
function drawGradeBadge(ctx: any, cert: ShareCertData, cx: number, cy: number, radius: number, scale = 1) {
  const colour = gradeColor(cert.grade);
  ctx.save();

  // Disc
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = colour;
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.lineWidth = 3;
  ctx.stroke();

  // Inner highlight — white arc top-left
  ctx.beginPath();
  ctx.arc(cx, cy, radius - 6, Math.PI * 0.75, Math.PI * 1.45);
  ctx.strokeStyle = "rgba(255,255,255,0.2)";
  ctx.lineWidth = 4;
  ctx.stroke();

  const textColour = cert.grade >= 9.5 ? "#0c0c0a" : "#ffffff";
  ctx.fillStyle = textColour;
  ctx.textAlign = "center";

  ctx.font = `700 ${Math.round(64 * scale)}px sans-serif`;
  ctx.textBaseline = "middle";
  ctx.fillText(String(cert.grade), cx, cy - Math.round(8 * scale));

  ctx.globalAlpha = 0.85;
  ctx.font = `500 ${Math.round(18 * scale)}px sans-serif`;
  ctx.fillText(cert.gradeLabel.toUpperCase(), cx, cy + Math.round(34 * scale), radius * 1.7);
  ctx.restore();
}

// ── Format A: 1080×1080 feed ───────────────────────────────────────────────

async function renderFeed(cert: ShareCertData, scanBuffer: Buffer): Promise<Buffer> {
  const { createCanvas, loadImage } = await import("canvas");
  const W = 1080;
  const H = 1080;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // 1. Background
  ctx.fillStyle = "#0c0c0a";
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(540, 400, 0, 540, 400, 700);
  glow.addColorStop(0, "rgba(212,175,55,0.08)");
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // 2. Card image
  const card = await drawCardWithFrame(ctx, loadImage, scanBuffer, { x: 190, y: 120, w: 700, h: 680 });

  // 3. Grade badge
  drawGradeBadge(ctx, cert, card.x + card.w - 20, card.y + card.h - 20, 72);

  // 4. Header strip
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(0, 0, W, 90);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = "700 28px sans-serif";
  ctx.fillStyle = "#D4AF37";
  ctx.fillText("MINTVAULT", 54, 56);
  const brandWidth = ctx.measureText("MINTVAULT").width;
  ctx.font = "400 18px sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.fillText("CERTIFIED GRADING", 54 + brandWidth + 16, 56);
  ctx.strokeStyle = "rgba(212,175,55,0.3)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, 90);
  ctx.lineTo(W, 90);
  ctx.stroke();

  // 7. MVGS score bar (above identity text)
  if (cert.gradeStrengthScore != null) {
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    roundRectPath(ctx, 54, card.y + card.h + 20, 700, 6, 3);
    ctx.fill();
    ctx.fillStyle = gradeColor(cert.grade);
    roundRectPath(
      ctx,
      54,
      card.y + card.h + 20,
      700 * (Math.max(0, Math.min(100, cert.gradeStrengthScore)) / 100),
      6,
      3
    );
    ctx.fill();
  }

  // 5. Card identity
  ctx.textAlign = "left";
  ctx.font = "700 36px sans-serif";
  ctx.fillStyle = "#ffffff";
  ctx.fillText(cert.cardName, 54, card.y + card.h + 56, 700);
  if (cert.setName) {
    ctx.font = "400 24px sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.fillText(cert.setName, 54, card.y + card.h + 96, 700);
  }

  // 6. Footer strip
  ctx.fillStyle = "rgba(0,0,0,0.7)";
  ctx.fillRect(0, 990, W, 90);
  ctx.font = "500 20px monospace";
  ctx.fillStyle = "rgba(212,175,55,0.8)";
  ctx.fillText(cert.certNumber, 54, 1040);
  ctx.font = "400 18px sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.3)";
  ctx.textAlign = "right";
  ctx.fillText(`mintvaultuk.com/cert/${cert.certNumber}`, 1026, 1040);

  return sharp(canvas.toBuffer("image/png")).jpeg({ quality: 88, progressive: true, mozjpeg: true }).toBuffer();
}

// ── Format B: 1080×1920 story ──────────────────────────────────────────────

async function renderStory(cert: ShareCertData, scanBuffer: Buffer): Promise<Buffer> {
  const { createCanvas, loadImage } = await import("canvas");
  const W = 1080;
  const H = 1920;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // 1. Background gradient + glow
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#0c0c0a");
  bg.addColorStop(0.5, "#0f0e0a");
  bg.addColorStop(1, "#080807");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(540, 960, 0, 540, 960, 600);
  glow.addColorStop(0, "rgba(212,175,55,0.06)");
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // 2. "JUST CERTIFIED" header with flanking lines
  ctx.font = "700 52px sans-serif";
  ctx.fillStyle = "#D4AF37";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("JUST CERTIFIED", 540, 180);
  ctx.strokeStyle = "rgba(212,175,55,0.4)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(54, 180);
  ctx.lineTo(310, 180);
  ctx.moveTo(770, 180);
  ctx.lineTo(1026, 180);
  ctx.stroke();
  ctx.textBaseline = "alphabetic";

  // 3. Card image
  const card = await drawCardWithFrame(ctx, loadImage, scanBuffer, { x: 140, y: 240, w: 800, h: 1080 });

  // 4. Grade badge — larger
  drawGradeBadge(ctx, cert, card.x + card.w - 24, card.y + card.h - 24, 90, 1.25);

  // 5. Card identity — centred
  ctx.textAlign = "center";
  ctx.font = "700 52px sans-serif";
  ctx.fillStyle = "#ffffff";
  ctx.fillText(cert.cardName, 540, card.y + card.h + 80, 920);
  if (cert.setName) {
    ctx.font = "400 36px sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.fillText(cert.setName, 540, card.y + card.h + 140, 920);
  }

  // 6. Footer
  ctx.font = "500 28px sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.fillText("Graded by MINTVAULT UK", 540, 1820);
  ctx.font = "400 24px sans-serif";
  ctx.fillStyle = "rgba(212,175,55,0.5)";
  ctx.fillText("mintvaultuk.com", 540, 1858);

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
