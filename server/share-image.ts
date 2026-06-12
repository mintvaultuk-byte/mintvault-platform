/**
 * Instagram share-image generator — Share Studio edition.
 *
 * 20 cinematic AI background variants (Segmind FLUX schnell, cached per
 * variant in R2 — shared across ALL certs; canvas-gradient fallback when
 * Segmind is unavailable) composited under the card with an 11-layer
 * premium frame (grade badge, MintVault header, card identity, cert/URL,
 * gold hairline, corner registration marks).
 *
 * Fonts (Bebas Neue, Barlow Condensed, Space Mono) are registered at module
 * load from public/brand — the same convention server/labels.ts uses, and the
 * only path that ships in the Docker image (COPY public).
 *
 * Backgrounds: public/share-bg/{variant}.jpg (1080² shared).
 * No PII: cert number, grade, card identity only.
 */
import path from "path";
import sharp from "sharp";
import pLimit from "p-limit";
import { uploadToR2, headR2 } from "./r2";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getR2Client } from "./r2";
import { textToImage } from "./lib/segmind-client";

// ── Font registration (node-canvas) ─────────────────────────────────────────
// Registered once at module load. public/brand ships via the Dockerfile's
// `COPY public` (server/fonts/ would not be copied). Failures are non-fatal —
// canvas falls back to a system sans if a face is missing.
const BRAND_DIR = path.join(process.cwd(), "public", "brand");
let fontsRegistered = false;
async function ensureFonts() {
  if (fontsRegistered) return;
  fontsRegistered = true;
  try {
    const { registerFont } = await import("canvas");
    const reg = (file: string, family: string, weight?: string) => {
      try {
        registerFont(path.join(BRAND_DIR, file), weight ? { family, weight } : { family });
      } catch (e: any) {
        console.warn(`[share-image] font register failed for ${file}: ${e?.message || e}`);
      }
    };
    reg("BebasNeue-Regular.ttf", "Bebas Neue");
    reg("BarlowCondensed-Regular.ttf", "Barlow Condensed", "400");
    reg("BarlowCondensed-Bold.ttf", "Barlow Condensed", "700");
    reg("BarlowCondensed-Black.ttf", "Barlow Condensed", "900");
    reg("SpaceMono-Regular.ttf", "Space Mono", "400");
    reg("SpaceMono-Bold.ttf", "Space Mono", "700");
  } catch (e: any) {
    console.warn(`[share-image] canvas font registration unavailable: ${e?.message || e}`);
  }
}

export interface ShareCertData {
  certNumber: string;
  grade: number;
  gradeLabel: string;
  gradeStrengthScore: number | null;
  cardName: string;
  setName: string | null;
  setNumber?: string | null;
}

export type ShareFormat = "feed" | "story";

// ── Background variants ──────────────────────────────────────────────────────
// `accent` drives the keyless gradient fallback so variants stay visually
// distinct even when Segmind is unavailable.
export const SHARE_VARIANTS = [
  // VAULT
  {
    id: "vault-gold",
    category: "Vault",
    name: "Vault · Gold",
    accent: "#D4AF37",
    prompt:
      "dark luxury vault interior, dramatic warm golden light rays, treasure room, deep shadows, gold atmospheric glow, cinematic, 8k, hyperrealistic, no text, no people, no cards",
  },
  {
    id: "vault-emerald",
    category: "Vault",
    name: "Vault · Emerald",
    accent: "#10b981",
    prompt:
      "dark vault interior, deep emerald green atmospheric lighting, dramatic shadows, premium dark aesthetic, green luminescence, cinematic 8k, no text, no people, no cards",
  },
  {
    id: "vault-steel",
    category: "Vault",
    name: "Vault · Steel",
    accent: "#64748b",
    prompt:
      "cool steel blue vault interior, secure storage facility, dramatic cold lighting, dark blue atmosphere, cinematic, premium industrial, 8k, no text, no people, no cards",
  },
  {
    id: "vault-crimson",
    category: "Vault",
    name: "Vault · Crimson",
    accent: "#dc2626",
    prompt:
      "dark vault interior, deep crimson red dramatic lighting, shadows, dark red atmosphere, cinematic luxury, 8k, no text, no people, no cards",
  },
  // COSMIC
  {
    id: "cosmic-gold",
    category: "Cosmic",
    name: "Cosmic · Gold",
    accent: "#f0c020",
    prompt:
      "deep space gold starfield, warm gold and amber nebula, cosmic dust, dramatic space photography, dark background, no text, no people, no cards, 8k cinematic",
  },
  {
    id: "cosmic-green",
    category: "Cosmic",
    name: "Cosmic · Green",
    accent: "#22c55e",
    prompt:
      "deep space emerald nebula, green cosmic gas clouds, dark background, dramatic space photography, bioluminescent green glow, 8k cinematic, no text, no people, no cards",
  },
  {
    id: "cosmic-blue",
    category: "Cosmic",
    name: "Cosmic · Blue",
    accent: "#3b82f6",
    prompt:
      "deep space blue galaxy, cool blue star clusters, cosmic, dark background, dramatic space photography, 8k cinematic, no text, no people, no cards",
  },
  {
    id: "cosmic-purple",
    category: "Cosmic",
    name: "Cosmic · Purple",
    accent: "#a855f7",
    prompt:
      "deep space purple void, aurora-like purple and violet light, dark cosmic background, nebula, 8k cinematic, no text, no people, no cards",
  },
  // STUDIO
  {
    id: "studio-warm",
    category: "Studio",
    name: "Studio · Warm",
    accent: "#e8a838",
    prompt:
      "dark photography studio, single warm spotlight from above, bokeh background, dramatic chiaroscuro lighting, luxury product photography setup, 8k, no text, no people, no cards",
  },
  {
    id: "studio-cool",
    category: "Studio",
    name: "Studio · Cool",
    accent: "#38bdf8",
    prompt:
      "dark photography studio, cool blue backlight, atmospheric haze, cinematic lighting, luxury product photography, 8k, no text, no people, no cards",
  },
  {
    id: "studio-neon",
    category: "Studio",
    name: "Studio · Neon",
    accent: "#84cc16",
    prompt:
      "dark studio, neon light leaks, green and gold neon glow, atmospheric dark background, cinematic, 8k, no text, no people, no cards",
  },
  {
    id: "studio-smoke",
    category: "Studio",
    name: "Studio · Smoke",
    accent: "#9ca3af",
    prompt:
      "dark studio, dramatic smoke and atmospheric haze, single key light, cinematic dramatic lighting, luxury aesthetic, 8k, no text, no people, no cards",
  },
  // ABSTRACT
  {
    id: "abstract-marble",
    category: "Abstract",
    name: "Abstract · Marble",
    accent: "#cbb26a",
    prompt:
      "dark black marble texture with gold veining, luxury surface, macro photography, premium material, cinematic lighting, 8k, no text, no people, no cards",
  },
  {
    id: "abstract-carbon",
    category: "Abstract",
    name: "Abstract · Carbon",
    accent: "#475569",
    prompt:
      "dark carbon fibre texture, premium tech material, macro photography, dark industrial luxury, cinematic, 8k, no text, no people, no cards",
  },
  {
    id: "abstract-metal",
    category: "Abstract",
    name: "Abstract · Metal",
    accent: "#94a3b8",
    prompt:
      "brushed dark metal surface, industrial luxury, dramatic lighting, premium material macro photography, 8k, no text, no people, no cards",
  },
  {
    id: "abstract-obsidian",
    category: "Abstract",
    name: "Abstract · Obsidian",
    accent: "#6d28d9",
    prompt:
      "volcanic black obsidian glass texture, dark luxury mineral, macro photography, premium natural material, 8k, no text, no people, no cards",
  },
  // NATURE
  {
    id: "nature-forest",
    category: "Nature",
    name: "Nature · Forest",
    accent: "#16a34a",
    prompt:
      "dark ancient forest canopy, shafts of light through trees, atmospheric fog, cinematic nature photography, dark moody, 8k, no text, no people, no cards",
  },
  {
    id: "nature-ocean",
    category: "Nature",
    name: "Nature · Ocean",
    accent: "#06b6d4",
    prompt:
      "deep ocean bioluminescent glow, dark underwater, blue and green light, cinematic underwater photography, 8k, no text, no people, no cards",
  },
  {
    id: "nature-dusk",
    category: "Nature",
    name: "Nature · Dusk",
    accent: "#f97316",
    prompt:
      "dark desert dusk, deep orange horizon glow, dramatic sky, cinematic landscape, moody atmosphere, 8k, no text, no people, no cards",
  },
  {
    id: "nature-arctic",
    category: "Nature",
    name: "Nature · Arctic",
    accent: "#5eead4",
    prompt:
      "dark arctic night, aurora borealis, green and blue northern lights, dramatic sky, cinematic, 8k, no text, no people, no cards",
  },
] as const;

export type VariantId = (typeof SHARE_VARIANTS)[number]["id"];
export const DEFAULT_VARIANT: VariantId = "vault-gold";
const VARIANT_IDS = new Set<string>(SHARE_VARIANTS.map((v) => v.id));
export function isValidVariant(id: string): id is VariantId {
  return VARIANT_IDS.has(id);
}

// ── Grade colour + tier ──────────────────────────────────────────────────────
const GRADE_COLOURS: Record<string, string> = {
  "10": "#D4AF37",
  "9.5": "#c8a020",
  "9": "#22c55e",
  "8": "#16a34a",
  "7": "#3b82f6",
  "6": "#f59e0b",
  "5": "#ea580c",
  "4": "#ef4444",
};

function gradeColour(grade: number): string {
  const key = grade % 1 === 0.5 ? grade.toFixed(1) : String(Math.round(grade));
  return GRADE_COLOURS[key] ?? "#9ca3af";
}

function tierLabel(grade: number): string {
  if (grade === 10) return "PRISTINE";
  if (grade >= 9) return "MINT";
  if (grade >= 7) return "NEAR MINT";
  if (grade >= 5) return "GOOD";
  if (grade >= 3) return "POOR";
  return "AUTHENTIC";
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}
function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}
function toHex({ r, g, b }: { r: number; g: number; b: number }): string {
  return `#${clamp255(r).toString(16).padStart(2, "0")}${clamp255(g).toString(16).padStart(2, "0")}${clamp255(b).toString(16).padStart(2, "0")}`;
}
function lighten(hex: string, pct: number): string {
  const { r, g, b } = hexToRgb(hex);
  return toHex({ r: r + (255 - r) * pct, g: g + (255 - g) * pct, b: b + (255 - b) * pct });
}
function darken(hex: string, pct: number): string {
  const { r, g, b } = hexToRgb(hex);
  return toHex({ r: r * (1 - pct), g: g * (1 - pct), b: b * (1 - pct) });
}
function rgba(hex: string, a: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
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

// ── Background generation (Segmind FLUX schnell, R2-cached per variant) ──────

/** Per-variant near-black gradient — keyless / Segmind-down fallback. Kept
 *  visually distinct per variant (accent colour) and NOT cached, so it
 *  auto-upgrades to the AI background once the key/key-cache lands. */
async function variantFallback(variant: VariantId): Promise<Buffer> {
  const { createCanvas } = await import("canvas");
  const W = 1080;
  const canvas = createCanvas(W, W);
  const ctx = canvas.getContext("2d");
  const accent = SHARE_VARIANTS.find((v) => v.id === variant)?.accent ?? "#D4AF37";
  ctx.fillStyle = "#050504";
  ctx.fillRect(0, 0, W, W);
  const g = ctx.createRadialGradient(W / 2, W * 0.42, 0, W / 2, W * 0.42, W * 0.62);
  g.addColorStop(0, rgba(accent, 0.32));
  g.addColorStop(0.5, rgba(accent, 0.1));
  g.addColorStop(1, rgba(accent, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, W);
  return sharp(canvas.toBuffer("image/png")).jpeg({ quality: 85 }).toBuffer();
}

/**
 * 1080² background for a variant — R2 cache hit, else Segmind FLUX schnell
 * resized to exactly 1080² and cached at q0.85. Any failure (no key, non-2xx,
 * decode) falls back to the variant gradient so a share image always returns.
 */
async function generateBackground(variant: VariantId): Promise<Buffer> {
  const r2Key = `public/share-bg/${variant}.jpg`;

  const cached = await headR2(r2Key).catch(() => null);
  if (cached) return fetchR2Buffer(r2Key);

  if (!process.env.SEGMIND_API_KEY) {
    console.warn(`[share-bg] SEGMIND_API_KEY unset — gradient fallback for ${variant}`);
    return variantFallback(variant);
  }

  const v = SHARE_VARIANTS.find((x) => x.id === variant)!;
  try {
    const raw = await textToImage(v.prompt, { width: 1080, height: 1080, steps: 4 });
    const jpeg = await sharp(raw)
      .resize(1080, 1080, { fit: "cover", position: "centre" })
      .jpeg({ quality: 85 })
      .toBuffer();
    await uploadToR2(r2Key, jpeg, "image/jpeg");
    console.log(`[share-bg] generated ${variant} (${(jpeg.length / 1024).toFixed(0)}KB → ${r2Key})`);
    return jpeg;
  } catch (err: any) {
    console.error(`[share-bg] generation failed for ${variant}: ${err?.message || err} — gradient fallback`);
    return variantFallback(variant);
  }
}

/** Public accessor for a variant background (R2-cached or freshly generated). */
export async function getShareBackground(variant: VariantId): Promise<Buffer> {
  return generateBackground(variant);
}

/** Pre-warm all 20 backgrounds. p-limit concurrency 3 (NOT Promise.all). */
export async function preGenerateAllBackgrounds(): Promise<{ generated: number; cached: number }> {
  const limit = pLimit(3);
  let generated = 0;
  let cached = 0;
  await Promise.all(
    SHARE_VARIANTS.map((v) =>
      limit(async () => {
        const r2Key = `public/share-bg/${v.id}.jpg`;
        const exists = await headR2(r2Key).catch(() => null);
        if (exists) {
          cached++;
          return;
        }
        await generateBackground(v.id);
        generated++;
      })
    )
  );
  return { generated, cached };
}

// ── Shared layer helpers ─────────────────────────────────────────────────────

/** Layer 1+2 — AI background (cover-fill) + dark overlay. */
async function drawBackground(ctx: any, loadImage: any, variant: VariantId, W: number, H: number) {
  const bgBuf = await generateBackground(variant);
  const bgImg = await loadImage(await sharp(bgBuf).resize(W, H, { fit: "cover", position: "centre" }).png().toBuffer());
  ctx.drawImage(bgImg, 0, 0, W, H);
  ctx.fillStyle = "rgba(0,0,0,0.30)";
  ctx.fillRect(0, 0, W, H);
}

/** Card scan + edge glow + border rings (Layers 3 & 4). */
function drawCard(ctx: any, cardImg: any, grade: number, x: number, y: number, w: number, h: number) {
  const colour = gradeColour(grade);

  // Layer 4 — edge glow (two passes), projected via shadow on an alpha-0 stroke
  for (const [blur, alpha] of [
    [55, 0.18],
    [110, 0.09],
  ] as const) {
    ctx.save();
    ctx.shadowColor = rgba(colour, alpha);
    ctx.shadowBlur = blur;
    ctx.strokeStyle = rgba(colour, alpha);
    ctx.lineWidth = 2;
    roundRectPath(ctx, x, y, w, h, 14);
    ctx.stroke();
    ctx.restore();
  }

  // Layer 3 — card scan, scaled to fill, clipped to rounded rect (white mat kept)
  ctx.save();
  roundRectPath(ctx, x, y, w, h, 14);
  ctx.clip();
  const scale = Math.max(w / cardImg.width, h / cardImg.height);
  const dw = cardImg.width * scale;
  const dh = cardImg.height * scale;
  ctx.drawImage(cardImg, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  ctx.restore();

  // Border rings — drawn after the card
  ctx.strokeStyle = "rgba(212,175,55,0.55)";
  ctx.lineWidth = 2;
  roundRectPath(ctx, x, y, w, h, 14);
  ctx.stroke();
  ctx.strokeStyle = "rgba(0,0,0,0.72)";
  ctx.lineWidth = 1;
  roundRectPath(ctx, x - 9, y - 9, w + 18, h + 18, 18);
  ctx.stroke();
}

/** Grade badge (Layer 5). */
function drawBadge(ctx: any, grade: number, gradeLabelStr: string, cx: number, cy: number, diameter: number) {
  const r = diameter / 2;
  const colour = gradeColour(grade);

  // Shadow + glow
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.72)";
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 10;
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Radial fill — highlight at 32%/28%
  const grad = ctx.createRadialGradient(cx - r * 0.18, cy - r * 0.22, r * 0.1, cx, cy, r);
  grad.addColorStop(0, lighten(colour, 0.3));
  grad.addColorStop(0.55, colour);
  grad.addColorStop(1, darken(colour, 0.2));
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  // Rings
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = rgba(colour, 0.28);
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(cx, cy, r + 9, 0, Math.PI * 2);
  ctx.stroke();

  // Grade number — Bebas Neue
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#ffffff";
  ctx.font = `60px "Bebas Neue"`;
  ctx.fillText(String(grade), cx, cy - 6);

  // Tier label — Barlow Condensed 700, tracked
  ctx.fillStyle = "rgba(255,255,255,0.90)";
  ctx.font = `700 14px "Barlow Condensed"`;
  drawTracked(ctx, gradeLabelStr, cx, cy + 28, 4, "center");
}

/** Draw letter-spaced text (node-canvas has no letterSpacing). */
function drawTracked(
  ctx: any,
  text: string,
  x: number,
  y: number,
  spacing: number,
  align: "left" | "center" | "right"
) {
  const chars = [...text];
  const widths = chars.map((c) => ctx.measureText(c).width);
  const total = widths.reduce((s, w) => s + w, 0) + spacing * Math.max(0, chars.length - 1);
  let cursor = align === "center" ? x - total / 2 : align === "right" ? x - total : x;
  const prevAlign = ctx.textAlign;
  ctx.textAlign = "left";
  chars.forEach((c, i) => {
    ctx.fillText(c, cursor, y);
    cursor += widths[i] + spacing;
  });
  ctx.textAlign = prevAlign;
  return total;
}

function measureTracked(ctx: any, text: string, spacing: number): number {
  const chars = [...text];
  return chars.reduce((s, c) => s + ctx.measureText(c).width, 0) + spacing * Math.max(0, chars.length - 1);
}

/** MintVault header (Layer 6). */
function drawHeader(ctx: any, x: number, baselineY: number) {
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#D4AF37";
  ctx.font = `900 38px "Barlow Condensed"`;
  const logoW = drawTracked(ctx, "MINTVAULT", x, baselineY, 5, "left");
  const dividerX = x + logoW + 15;
  ctx.strokeStyle = "rgba(212,175,55,0.30)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(dividerX, baselineY - 20);
  ctx.lineTo(dividerX, baselineY + 6);
  ctx.stroke();
  ctx.fillStyle = "rgba(212,175,55,0.42)";
  ctx.font = `400 13px "Barlow Condensed"`;
  drawTracked(ctx, "CERTIFIED GRADING", dividerX + 15, baselineY - 2, 5, "left");
}

/** Truncate text to a max pixel width, appending an ellipsis. */
function truncateToWidth(ctx: any, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > maxWidth) t = t.slice(0, -1);
  return t + "…";
}

/** Cert + URL block, bottom-right (Layer 9). */
function drawCertUrl(ctx: any, certNumber: string, W: number, certY: number, urlY: number) {
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "rgba(212,175,55,0.62)";
  ctx.font = `700 14px "Space Mono"`;
  const certW = measureTracked(ctx, certNumber, 2);
  drawTracked(ctx, certNumber, W - 52 - certW, certY, 2, "left");
  ctx.fillStyle = "rgba(212,175,55,0.28)";
  ctx.font = `400 11px "Space Mono"`;
  const urlW = measureTracked(ctx, "mintvaultuk.com", 1);
  drawTracked(ctx, "mintvaultuk.com", W - 52 - urlW, urlY, 1, "left");
}

/** Gold hairline (Layer 10). */
function drawHairline(ctx: any, W: number, y: number) {
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, "rgba(212,175,55,0)");
  g.addColorStop(0.06, "rgba(212,175,55,0.48)");
  g.addColorStop(0.28, "#D4AF37");
  g.addColorStop(0.72, "#D4AF37");
  g.addColorStop(0.94, "rgba(212,175,55,0.48)");
  g.addColorStop(1, "rgba(212,175,55,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, y, W, 3);
}

/** Four corner registration brackets (Layer 11). */
function drawCornerMarks(ctx: any, W: number, H: number) {
  const s = 26;
  const m = 22;
  ctx.strokeStyle = "rgba(212,175,55,0.20)";
  ctx.lineWidth = 2;
  const bracket = (x: number, y: number, hDir: 1 | -1, vDir: 1 | -1) => {
    ctx.beginPath();
    ctx.moveTo(x + (hDir === 1 ? 0 : s), y);
    ctx.lineTo(x + (hDir === 1 ? s : 0), y); // horizontal arm
    ctx.moveTo(x + (hDir === 1 ? 0 : s), y);
    ctx.lineTo(x + (hDir === 1 ? 0 : s), y + vDir * s); // vertical arm
    ctx.stroke();
  };
  bracket(m, m, 1, 1); // TL: right + down
  bracket(W - m - s, m, -1, 1); // TR: left + down
  bracket(m, H - m, 1, -1); // BL: right + up
  bracket(W - m - s, H - m, -1, -1); // BR: left + up
}

// ── Format A: 1080×1080 feed ─────────────────────────────────────────────────

async function renderFeed(cert: ShareCertData, scanBuffer: Buffer, variant: VariantId): Promise<Buffer> {
  await ensureFonts();
  const { createCanvas, loadImage } = await import("canvas");
  const W = 1080;
  const H = 1080;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // Layers 1 + 2
  await drawBackground(ctx, loadImage, variant, W, H);

  // Layers 3 + 4 — card
  const cardImg = await loadImage(await sharp(scanBuffer).png().toBuffer());
  const CARD_X = 240,
    CARD_Y = 72,
    CARD_W = 600,
    CARD_H = 840;
  drawCard(ctx, cardImg, cert.grade, CARD_X, CARD_Y, CARD_W, CARD_H);

  // Layer 5 — badge fully OUTSIDE the card's bottom-right corner.
  // Centre X = CARD_X+CARD_W+R+18 = 912; left edge 858 > card right 840 (clear);
  // right edge 966 < 1080 (safe).
  const BADGE_DIAM = 108;
  const BADGE_R2 = BADGE_DIAM / 2;
  drawBadge(
    ctx,
    cert.grade,
    tierLabel(cert.grade),
    CARD_X + CARD_W + BADGE_R2 + 18,
    CARD_Y + CARD_H - BADGE_R2 - 18,
    BADGE_DIAM
  );

  // Layer 6 — header
  drawHeader(ctx, 52, 50);

  // Layer 7 — card name (Bebas Neue 80px). Y tracks the taller card.
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.95)";
  ctx.shadowBlur = 30;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = "#ffffff";
  ctx.font = `80px "Bebas Neue"`;
  drawTracked(ctx, truncateToWidth(ctx, cert.cardName.toUpperCase(), 900), 52, 964, 3, "left");
  ctx.restore();

  // Layer 8 — set line
  if (cert.setName) {
    const setText = cert.setNumber ? `${cert.setName} · ${cert.setNumber}` : cert.setName;
    ctx.fillStyle = "rgba(255,255,255,0.30)";
    ctx.font = `400 20px "Barlow Condensed"`;
    drawTracked(ctx, truncateToWidth(ctx, setText, 800), 52, 992, 4, "left");
  }

  // Layer 9 — cert + url
  drawCertUrl(ctx, cert.certNumber, W, 1025, 1045);

  // Layer 10 — gold hairline
  drawHairline(ctx, W, 1077);

  // Layer 11 — corner marks
  drawCornerMarks(ctx, W, H);

  return sharp(canvas.toBuffer("image/png")).jpeg({ quality: 92, progressive: true, mozjpeg: true }).toBuffer();
}

// ── Format B: 1080×1920 story ────────────────────────────────────────────────

async function renderStory(cert: ShareCertData, scanBuffer: Buffer, variant: VariantId): Promise<Buffer> {
  await ensureFonts();
  const { createCanvas, loadImage } = await import("canvas");
  const W = 1080;
  const H = 1920;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  await drawBackground(ctx, loadImage, variant, W, H);

  const cardImg = await loadImage(await sharp(scanBuffer).png().toBuffer());
  const CARD_X = 325,
    CARD_Y = 280,
    CARD_W = 430,
    CARD_H = 600;
  drawCard(ctx, cardImg, cert.grade, CARD_X, CARD_Y, CARD_W, CARD_H);

  // Badge fully OUTSIDE the card's bottom-right corner (story card values).
  const BADGE_DIAM = 108;
  const BADGE_R2 = BADGE_DIAM / 2;
  drawBadge(
    ctx,
    cert.grade,
    tierLabel(cert.grade),
    CARD_X + CARD_W + BADGE_R2 + 18,
    CARD_Y + CARD_H - BADGE_R2 - 18,
    BADGE_DIAM
  );

  drawHeader(ctx, 52, 50);

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.95)";
  ctx.shadowBlur = 30;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = "#ffffff";
  ctx.font = `80px "Bebas Neue"`;
  drawTracked(ctx, truncateToWidth(ctx, cert.cardName.toUpperCase(), 900), 52, 1040, 3, "left");
  ctx.restore();

  if (cert.setName) {
    const setText = cert.setNumber ? `${cert.setName} · ${cert.setNumber}` : cert.setName;
    ctx.fillStyle = "rgba(255,255,255,0.30)";
    ctx.font = `400 20px "Barlow Condensed"`;
    drawTracked(ctx, truncateToWidth(ctx, setText, 800), 52, 1134, 4, "left");
  }

  drawCertUrl(ctx, cert.certNumber, W, 1840, 1860);
  drawHairline(ctx, W, 1917);
  drawCornerMarks(ctx, W, H);

  return sharp(canvas.toBuffer("image/png")).jpeg({ quality: 92, progressive: true, mozjpeg: true }).toBuffer();
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Render a share image for a cert/format/variant. Composites are NOT R2-cached
 * per (cert × variant × format) — the expensive part (the background) is cached
 * per variant; compositing is fast canvas work, and skipping the composite cache
 * keeps fallback backgrounds from freezing into the cert's image. The HTTP layer
 * sets Cache-Control for browser/CDN caching.
 */
export async function getOrCreateShareImage(
  cert: ShareCertData,
  scanKey: string,
  format: ShareFormat,
  variant: VariantId = DEFAULT_VARIANT
): Promise<Buffer> {
  const scanBuffer = await fetchR2Buffer(scanKey);
  return format === "feed" ? renderFeed(cert, scanBuffer, variant) : renderStory(cert, scanBuffer, variant);
}
