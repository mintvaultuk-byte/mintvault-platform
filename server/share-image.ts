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
export interface ShareRenderOptions {
  allowProviderGeneration?: boolean;
}

// ── Background variants ──────────────────────────────────────────────────────
// `accent` drives the keyless gradient fallback so variants stay visually
// distinct even when Segmind is unavailable.

// ── Background variants (Nano Banana Pro, 56) ──────────────────────────────
export const SHARE_VARIANTS = [
  // VAULT (10)
  {
    id: "vault-gold",
    category: "Vault",
    name: "Vault · Gold",
    prompt: "warm golden atmospheric light rays in darkness, deep amber and gold colour field",
  },
  {
    id: "vault-emerald",
    category: "Vault",
    name: "Vault · Emerald",
    prompt: "deep emerald green atmospheric glow, dark space, rich green light diffusion",
  },
  {
    id: "vault-steel",
    category: "Vault",
    name: "Vault · Steel",
    prompt: "cool steel blue light atmosphere, dark cold colour field, industrial blue tones",
  },
  {
    id: "vault-crimson",
    category: "Vault",
    name: "Vault · Crimson",
    prompt: "deep crimson red atmospheric light, dark dramatic red colour field",
  },
  {
    id: "vault-midnight",
    category: "Vault",
    name: "Vault · Midnight",
    prompt: "dark midnight blue atmosphere, deep navy colour field, subtle light diffusion",
  },
  {
    id: "vault-obsidian",
    category: "Vault",
    name: "Vault · Obsidian",
    prompt: "near-black dark atmosphere with subtle purple tones, dark luxury colour field",
  },
  {
    id: "vault-copper",
    category: "Vault",
    name: "Vault · Copper",
    prompt: "warm copper and bronze atmospheric tones, dark amber light field",
  },
  {
    id: "vault-platinum",
    category: "Vault",
    name: "Vault · Platinum",
    prompt: "cool silver platinum light atmosphere, pale metallic colour diffusion on dark background",
  },
  {
    id: "vault-onyx",
    category: "Vault",
    name: "Vault · Onyx",
    prompt: "pure deep black atmospheric field, very subtle dark texture, luxury darkness",
  },
  {
    id: "vault-rose",
    category: "Vault",
    name: "Vault · Rose",
    prompt: "deep rose gold atmospheric light, warm pink-gold colour field in darkness",
  },

  // COSMIC (10)
  {
    id: "cosmic-nebula",
    category: "Cosmic",
    name: "Cosmic · Nebula",
    prompt: "deep space nebula colour field, purple and blue atmospheric gas clouds",
  },
  {
    id: "cosmic-aurora",
    category: "Cosmic",
    name: "Cosmic · Aurora",
    prompt: "aurora borealis colour field, green and teal light waves in darkness",
  },
  {
    id: "cosmic-supernova",
    category: "Cosmic",
    name: "Cosmic · Supernova",
    prompt: "gold and orange cosmic explosion colour field, warm energy atmosphere",
  },
  {
    id: "cosmic-void",
    category: "Cosmic",
    name: "Cosmic · Void",
    prompt: "deep space void, dark blue-black colour field with subtle star atmosphere",
  },
  {
    id: "cosmic-pulsar",
    category: "Cosmic",
    name: "Cosmic · Pulsar",
    prompt: "electric blue cosmic energy field, pulsing blue atmosphere",
  },
  {
    id: "cosmic-galaxy",
    category: "Cosmic",
    name: "Cosmic · Galaxy",
    prompt: "spiral colour field of blues and purples, galactic atmosphere",
  },
  {
    id: "cosmic-stardust",
    category: "Cosmic",
    name: "Cosmic · Stardust",
    prompt: "golden stardust colour field, warm sparkle atmosphere in darkness",
  },
  {
    id: "cosmic-magnetar",
    category: "Cosmic",
    name: "Cosmic · Magnetar",
    prompt: "intense blue-white energy atmosphere, magnetic field colour diffusion",
  },
  {
    id: "cosmic-infrared",
    category: "Cosmic",
    name: "Cosmic · Infrared",
    prompt: "deep red infrared cosmic atmosphere, warm dark red colour field",
  },
  {
    id: "cosmic-plasma",
    category: "Cosmic",
    name: "Cosmic · Plasma",
    prompt: "electric green plasma energy field, vibrant green atmosphere in darkness",
  },

  // POKÉMON TYPES (18)
  {
    id: "poke-fire",
    category: "Elements",
    name: "Elements · Fire",
    prompt: "intense orange and red fire energy colour field, warm flame atmosphere",
  },
  {
    id: "poke-water",
    category: "Elements",
    name: "Elements · Water",
    prompt: "deep ocean blue colour field, cool aqua light diffusion atmosphere",
  },
  {
    id: "poke-grass",
    category: "Elements",
    name: "Elements · Grass",
    prompt: "rich forest green colour field, natural green light atmosphere",
  },
  {
    id: "poke-electric",
    category: "Elements",
    name: "Elements · Electric",
    prompt: "bright yellow electric energy colour field, lightning atmosphere",
  },
  {
    id: "poke-psychic",
    category: "Elements",
    name: "Elements · Psychic",
    prompt: "deep pink and purple psychic energy colour field, mystical atmosphere",
  },
  {
    id: "poke-ice",
    category: "Elements",
    name: "Elements · Ice",
    prompt: "pale blue and white ice energy colour field, cold crystal light atmosphere",
  },
  {
    id: "poke-dragon",
    category: "Elements",
    name: "Elements · Dragon",
    prompt: "deep purple and blue dragon energy colour field, powerful dark atmosphere",
  },
  {
    id: "poke-dark",
    category: "Elements",
    name: "Elements · Dark",
    prompt: "near-black dark energy colour field, shadowy purple atmosphere",
  },
  {
    id: "poke-steel",
    category: "Elements",
    name: "Elements · Steel",
    prompt: "metallic silver colour field, cool steel light diffusion",
  },
  {
    id: "poke-fairy",
    category: "Elements",
    name: "Elements · Fairy",
    prompt: "soft pink and white fairy energy colour field, delicate light atmosphere",
  },
  {
    id: "poke-fighting",
    category: "Elements",
    name: "Elements · Fighting",
    prompt: "deep red and orange fighting energy colour field, intense warm atmosphere",
  },
  {
    id: "poke-poison",
    category: "Elements",
    name: "Elements · Poison",
    prompt: "deep purple toxic colour field, dark violet atmosphere",
  },
  {
    id: "poke-ground",
    category: "Elements",
    name: "Elements · Ground",
    prompt: "warm earth tones colour field, ochre and brown atmosphere",
  },
  {
    id: "poke-flying",
    category: "Elements",
    name: "Elements · Flying",
    prompt: "light blue sky colour field, airy pale blue atmosphere",
  },
  {
    id: "poke-rock",
    category: "Elements",
    name: "Elements · Rock",
    prompt: "dark grey stone colour field, deep granite atmosphere",
  },
  {
    id: "poke-ghost",
    category: "Elements",
    name: "Elements · Ghost",
    prompt: "dark teal ghost energy colour field, ethereal misty atmosphere",
  },
  {
    id: "poke-bug",
    category: "Elements",
    name: "Elements · Bug",
    prompt: "deep green and yellow bug energy colour field, natural vivid atmosphere",
  },
  {
    id: "poke-normal",
    category: "Elements",
    name: "Elements · Normal",
    prompt: "warm cream and beige colour field, soft neutral light atmosphere",
  },

  // WEATHER (10)
  {
    id: "weather-storm",
    category: "Weather",
    name: "Weather · Storm",
    prompt: "dramatic dark storm atmosphere, deep grey energy colour field",
  },
  {
    id: "weather-lightning",
    category: "Weather",
    name: "Weather · Lightning",
    prompt: "electric white and blue lightning energy atmosphere",
  },
  {
    id: "weather-fog",
    category: "Weather",
    name: "Weather · Fog",
    prompt: "soft grey fog colour field, misty light diffusion atmosphere",
  },
  {
    id: "weather-aurora",
    category: "Weather",
    name: "Weather · Aurora",
    prompt: "green and pink aurora colour field, northern lights atmosphere",
  },
  {
    id: "weather-sunset",
    category: "Weather",
    name: "Weather · Sunset",
    prompt: "deep orange and red sunset colour field atmosphere",
  },
  {
    id: "weather-midnight",
    category: "Weather",
    name: "Weather · Midnight",
    prompt: "deep blue midnight sky atmosphere, dark navy colour field",
  },
  {
    id: "weather-rain",
    category: "Weather",
    name: "Weather · Rain",
    prompt: "dark blue-grey rain atmosphere, cool wet colour field",
  },
  {
    id: "weather-snow",
    category: "Weather",
    name: "Weather · Snow",
    prompt: "pale white and blue snow atmosphere, cold light colour field",
  },
  {
    id: "weather-heat",
    category: "Weather",
    name: "Weather · Heat",
    prompt: "shimmering gold heat haze atmosphere, warm distortion colour field",
  },
  {
    id: "weather-wind",
    category: "Weather",
    name: "Weather · Wind",
    prompt: "soft moving blue and white wind energy colour field",
  },

  // NATURE (8)
  {
    id: "nature-deep-ocean",
    category: "Nature",
    name: "Nature · Deep Ocean",
    prompt: "deep ocean blue-black atmosphere, bioluminescent teal glow colour field",
  },
  {
    id: "nature-forest",
    category: "Nature",
    name: "Nature · Forest",
    prompt: "deep rich forest green colour field, dark natural atmosphere",
  },
  {
    id: "nature-volcano",
    category: "Nature",
    name: "Nature · Volcano",
    prompt: "deep red and black volcanic atmosphere, magma glow colour field",
  },
  {
    id: "nature-arctic",
    category: "Nature",
    name: "Nature · Arctic",
    prompt: "pale blue and white arctic atmosphere, ice light colour field",
  },
  {
    id: "nature-desert",
    category: "Nature",
    name: "Nature · Desert",
    prompt: "warm ochre and gold desert atmosphere, heat colour field",
  },
  {
    id: "nature-jungle",
    category: "Nature",
    name: "Nature · Jungle",
    prompt: "vibrant deep green and teal jungle atmosphere, lush colour field",
  },
  {
    id: "nature-cave",
    category: "Nature",
    name: "Nature · Cave",
    prompt: "dark stone grey atmosphere, deep cave colour field",
  },
  {
    id: "nature-sky",
    category: "Nature",
    name: "Nature · Sky",
    prompt: "bright blue sky colour field, open atmosphere",
  },
] as const;

export type VariantId = (typeof SHARE_VARIANTS)[number]["id"];
export type VariantCategory = (typeof SHARE_VARIANTS)[number]["category"];
export const DEFAULT_VARIANT: VariantId = "vault-gold";
export const VARIANT_CATEGORIES = ["Vault", "Cosmic", "Elements", "Weather", "Nature"] as const;
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
  // New variants carry no accent field; gradient fallback is gold (only the
  // failed-generation variant, weather-midnight, ever reaches this path).
  void variant;
  const accent = "#D4AF37";
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
async function generateBackground(variant: VariantId, options: ShareRenderOptions = {}): Promise<Buffer> {
  const allowProviderGeneration = options.allowProviderGeneration !== false;
  const r2Key = `public/share-bg/${variant}.jpg`;

  const cached = await headR2(r2Key).catch(() => null);
  if (cached) return fetchR2Buffer(r2Key);

  if (!allowProviderGeneration) {
    console.warn(`[share-bg] static-only fallback for missing ${variant}`);
    return variantFallback(variant);
  }

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
export async function getShareBackground(variant: VariantId, options: ShareRenderOptions = {}): Promise<Buffer> {
  return generateBackground(variant, options);
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
async function drawBackground(
  ctx: any,
  loadImage: any,
  variant: VariantId,
  W: number,
  H: number,
  options: ShareRenderOptions = {}
) {
  const bgBuf = await generateBackground(variant, options);
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

async function renderFeed(
  cert: ShareCertData,
  scanBuffer: Buffer,
  variant: VariantId,
  options: ShareRenderOptions = {}
): Promise<Buffer> {
  await ensureFonts();
  const { createCanvas, loadImage } = await import("canvas");
  const W = 1080;
  const H = 1080;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // Layers 1 + 2
  await drawBackground(ctx, loadImage, variant, W, H, options);

  // Layers 3 + 4 — card
  const cardImg = await loadImage(await sharp(scanBuffer).png().toBuffer());
  const CARD_X = 240,
    CARD_Y = 72,
    CARD_W = 600,
    CARD_H = 840;
  drawCard(ctx, cardImg, cert.grade, CARD_X, CARD_Y, CARD_W, CARD_H);

  // Layer 5 — badge overlaps the card's top-right corner from outside,
  // like a price sticker on a product.
  const BADGE_DIAM = 100;
  const BADGE_R2 = BADGE_DIAM / 2;
  const BADGE_CX = CARD_X + CARD_W + BADGE_R2 - 10;
  const BADGE_CY = CARD_Y + BADGE_R2 - 10;
  drawBadge(ctx, cert.grade, tierLabel(cert.grade), BADGE_CX, BADGE_CY, BADGE_DIAM);

  // Layer 6 — header
  drawHeader(ctx, 52, 50);

  // Layer 7 — card name (Bebas Neue 80px). Badge vacated the footer, so
  // the name + set return to the left edge.
  const FOOTER_TEXT_X = 52;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.95)";
  ctx.shadowBlur = 30;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = "#ffffff";
  ctx.font = `80px "Bebas Neue"`;
  drawTracked(ctx, truncateToWidth(ctx, cert.cardName.toUpperCase(), 900), FOOTER_TEXT_X, 964, 3, "left");
  ctx.restore();

  // Layer 8 — set line
  if (cert.setName) {
    const setText = cert.setNumber ? `${cert.setName} · ${cert.setNumber}` : cert.setName;
    ctx.fillStyle = "rgba(255,255,255,0.30)";
    ctx.font = `400 20px "Barlow Condensed"`;
    drawTracked(ctx, truncateToWidth(ctx, setText, 800), FOOTER_TEXT_X, 992, 4, "left");
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

async function renderStory(
  cert: ShareCertData,
  scanBuffer: Buffer,
  variant: VariantId,
  options: ShareRenderOptions = {}
): Promise<Buffer> {
  await ensureFonts();
  const { createCanvas, loadImage } = await import("canvas");
  const W = 1080;
  const H = 1920;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  await drawBackground(ctx, loadImage, variant, W, H, options);

  const cardImg = await loadImage(await sharp(scanBuffer).png().toBuffer());
  const CARD_X = 325,
    CARD_Y = 280,
    CARD_W = 430,
    CARD_H = 600;
  drawCard(ctx, cardImg, cert.grade, CARD_X, CARD_Y, CARD_W, CARD_H);

  // Badge overlaps the card's top-right corner from outside (story values).
  const BADGE_DIAM = 100;
  const BADGE_R2 = BADGE_DIAM / 2;
  const BADGE_CX = CARD_X + CARD_W + BADGE_R2 - 10;
  const BADGE_CY = CARD_Y + BADGE_R2 - 10;
  drawBadge(ctx, cert.grade, tierLabel(cert.grade), BADGE_CX, BADGE_CY, BADGE_DIAM);

  drawHeader(ctx, 52, 50);

  // Name + set return to the left edge, below the card (badge vacated footer).
  const FOOTER_TEXT_X = 52;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.95)";
  ctx.shadowBlur = 30;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = "#ffffff";
  ctx.font = `80px "Bebas Neue"`;
  drawTracked(ctx, truncateToWidth(ctx, cert.cardName.toUpperCase(), 900), FOOTER_TEXT_X, 1040, 3, "left");
  ctx.restore();

  if (cert.setName) {
    const setText = cert.setNumber ? `${cert.setName} · ${cert.setNumber}` : cert.setName;
    ctx.fillStyle = "rgba(255,255,255,0.30)";
    ctx.font = `400 20px "Barlow Condensed"`;
    drawTracked(ctx, truncateToWidth(ctx, setText, 800), FOOTER_TEXT_X, 1134, 4, "left");
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
  variant: VariantId = DEFAULT_VARIANT,
  options: ShareRenderOptions = {}
): Promise<Buffer> {
  const scanBuffer = await fetchR2Buffer(scanKey);
  return format === "feed"
    ? renderFeed(cert, scanBuffer, variant, options)
    : renderStory(cert, scanBuffer, variant, options);
}
