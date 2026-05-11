import QRCode from "qrcode";
import PDFDocument from "pdfkit";
import type { CertificateRecord, LabelOverride } from "@shared/schema";
import { gradeLabel, gradeLabelFull, isNonNumericGrade } from "@shared/schema";
import path from "path";
import { APP_BASE_URL } from "./app-url";

/**
 * Merge label_overrides into a certificate record before rendering.
 * Only display fields are overridden — grade, certId, and QR are untouched.
 */
export function applyLabelOverrides(
  cert: CertificateRecord,
  override: LabelOverride | null
): CertificateRecord {
  if (!override) return cert;
  return {
    ...cert,
    ...(override.cardNameOverride != null ? { cardName: override.cardNameOverride } : {}),
    ...(override.setOverride      != null ? { setName: override.setOverride }      : {}),
    ...(override.variantOverride  != null ? { variant: override.variantOverride }  : {}),
    ...(override.languageOverride != null ? { language: override.languageOverride }: {}),
    ...(override.yearOverride     != null ? { year: override.yearOverride }         : {}),
  };
}

// v424 — slab cutout is 70×20mm (was 72×22mm). Canvas pixel dims recomputed
// from new physical size at 300 DPI. Most internal layout constants are
// derived from PX_W/PX_H (I_RIGHT, I_BOTTOM, panelX, stripY etc.) and so
// re-flow automatically; absolute font sizes stay put — they occupy a
// slightly larger fraction of the smaller canvas which compensates for
// the loss of physical real estate.
const PX_W = 826;   // 70mm × 300 DPI / 25.4
const PX_H = 236;   // 20mm × 300 DPI / 25.4
const MM_TO_PT = 2.83465;
const PDF_W = 70 * MM_TO_PT;
const PDF_H = 20 * MM_TO_PT;

// ── Border geometry ────────────────────────────────────────────────────────
// Gold frame fills from canvas edge inward FRAME_W pixels — no white gap.
const FRAME_W = 18;   // px — gold border fill width (outer edge = canvas edge)

// ── Colour palette ──────────────────────────────────────────────────────────
// PR #91 — print-specific yellow palette. The website stays at #FFCB05
// (Pikachu Yellow, PR #87). Physical labels use a slightly darker shade
// (#E6B505) for legibility on white paper after a physical print review.
// These constants are PRINT-ONLY — never reference --v2-gold or the site
// brand yellow from this file.
const PRINT_YELLOW      = "#E6B505";   // primary print yellow (borders, panels)
const PRINT_YELLOW_DARK = "#B8900A";   // inner accents, depth hairlines
const PRINT_BLACK       = "#111111";   // body text, grade number
const PRINT_WHITE       = "#FFFFFF";   // white label background

// Legacy aliases — kept so untouched helper code that still references
// `GOLD` / `GOLD_DARK` / `GOLD_LIGHT` / `BLACK` / `WHITE` continues to
// compile. New code should use the PRINT_* constants above.
const GOLD       = PRINT_YELLOW;
const GOLD_DARK  = PRINT_YELLOW_DARK;
const GOLD_LIGHT = PRINT_YELLOW;
const BLACK      = "#000000";
const WHITE      = PRINT_WHITE;

// v424 — frame gradient removed in favour of a flat GOLD fill. The diagonal
// 5-stop gradient looked rich on screen but printed muddy on label stock and
// fought with the wordmark/grade panel readability.

// Inner safe edge coordinates (inside gold frame)
const I_LEFT   = FRAME_W;           // 18
const I_RIGHT  = PX_W - FRAME_W;    // 832
const I_TOP    = FRAME_W;           // 18
const I_BOTTOM = PX_H - FRAME_W;    // 242
const I_W      = I_RIGHT - I_LEFT;  // 814
const I_H      = I_BOTTOM - I_TOP;  // 224

const LOGO_PATH      = path.join(process.cwd(), "public", "brand", "logo.png");
const NFC_ICON_PATH  = path.join(process.cwd(), "public", "brand", "nfc-tap-icon.png");
const BODONI_PATH    = path.join(process.cwd(), "public", "brand", "BodoniModa-Black.ttf");

// Register Bodoni Moda for canvas — runs once at module load.
// Safe to call multiple times; canvas deduplicates by family+weight.
try {
  const { registerFont } = require("canvas");
  registerFont(BODONI_PATH, { family: "Bodoni Moda", weight: "900" });
} catch {
  // canvas not available at import time in some build contexts — ignore
}

function getCertUrl(certId: string): string {
  return `${APP_BASE_URL}/vault/${certId}`;
}

async function generateQRBuffer(url: string, size: number): Promise<Buffer> {
  return await QRCode.toBuffer(url, {
    type: "png",
    width: size,
    margin: 1,
    errorCorrectionLevel: "M",
    color: { dark: BLACK, light: WHITE },
  });
}

function fitFontSize(
  ctx: any,
  text: string,
  maxWidth: number,
  maxSize: number,
  minSize: number,
  weight: string = "bold",
  family: string = "Arial, Helvetica, sans-serif"
): number {
  for (let s = maxSize; s >= minSize; s--) {
    ctx.font = `${weight} ${s}px ${family}`;
    if (ctx.measureText(text).width <= maxWidth) return s;
  }
  return minSize;
}

function truncateText(ctx: any, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 0 && ctx.measureText(t + "…").width > maxWidth) {
    t = t.slice(0, -1);
  }
  return t + "…";
}

/**
 * Word-wrap `text` at `maxWidth` pixels using the current ctx.font.
 * Returns an array of line strings. Never shrinks the font.
 * If a single word exceeds maxWidth it is hard-truncated with ellipsis.
 * maxLines=0 means unlimited. When the cap is reached the last line is
 * truncated with ellipsis to fit any remaining words.
 */
function wrapText(ctx: any, text: string, maxWidth: number, maxLines = 0): string[] {
  if (!text) return [];
  const words = text.split(" ");
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(test).width <= maxWidth) {
      cur = test;
    } else {
      if (cur) out.push(cur);
      cur = ctx.measureText(w).width > maxWidth ? truncateText(ctx, w, maxWidth) : w;
    }
  }
  if (cur) out.push(cur);
  // Apply hard line cap — join any overflow back onto the last allowed line and truncate
  if (maxLines > 0 && out.length > maxLines) {
    const overflow = out.splice(maxLines - 1).join(" ");
    out.push(truncateText(ctx, overflow, maxWidth));
  }
  return out;
}

/**
 * PSA-style wrap: greedy first line, natural word boundaries, max 2 lines.
 * Orphan guard: if line 2 would be a single short word, pull one word down
 * from line 1 so line 2 has company — without over-optimising for equal lengths.
 */
function psaWrap(ctx: any, text: string, maxWidth: number): string[] {
  if (!text) return [];
  if (ctx.measureText(text).width <= maxWidth) return [text];

  const words = text.split(" ");
  if (words.length <= 1) return [truncateText(ctx, text, maxWidth)];

  // Greedy: fill line 1 as much as possible
  let splitAt = 0;
  for (let i = 1; i <= words.length; i++) {
    if (ctx.measureText(words.slice(0, i).join(" ")).width <= maxWidth) {
      splitAt = i;
    } else {
      break;
    }
  }

  if (splitAt === 0)            return [truncateText(ctx, text, maxWidth)];
  if (splitAt === words.length) return [text];

  // Orphan guard: single short word on line 2 → pull one word down from line 1
  const line2Words = words.slice(splitAt);
  if (line2Words.length === 1 && line2Words[0].length <= 5 && splitAt > 1) {
    splitAt -= 1;
  }

  const l1 = words.slice(0, splitAt).join(" ");
  const l2 = words.slice(splitAt).join(" ");
  return [
    ctx.measureText(l1).width > maxWidth ? truncateText(ctx, l1, maxWidth) : l1,
    ctx.measureText(l2).width > maxWidth ? truncateText(ctx, l2, maxWidth) : l2,
  ];
}

// Balanced wrap: split nearest the visual midpoint so both lines are similar width.
// Avoids one very long + one very short line.  Max 2 lines, then truncates.
function balancedWrap(ctx: any, text: string, maxWidth: number): string[] {
  if (!text) return [];
  if (ctx.measureText(text).width <= maxWidth) return [text];

  const words = text.split(" ");
  if (words.length <= 1) return [truncateText(ctx, text, maxWidth)];

  let bestSplit = 1;
  let bestDiff  = Infinity;
  for (let i = 1; i < words.length; i++) {
    const w1   = ctx.measureText(words.slice(0, i).join(" ")).width;
    const w2   = ctx.measureText(words.slice(i).join(" ")).width;
    const diff = Math.abs(w1 - w2);
    if (diff < bestDiff && w1 <= maxWidth && w2 <= maxWidth) {
      bestDiff  = diff;
      bestSplit = i;
    }
  }

  const l1 = words.slice(0, bestSplit).join(" ");
  const l2 = words.slice(bestSplit).join(" ");
  return [
    ctx.measureText(l1).width > maxWidth ? truncateText(ctx, l1, maxWidth) : l1,
    ctx.measureText(l2).width > maxWidth ? truncateText(ctx, l2, maxWidth) : l2,
  ];
}

const COLLECTION_DISPLAY: Record<string, string> = {
  CLASSIC_COLLECTION: "CLASSIC COLLECTION", COLLECTION_GENERIC: "COLLECTION",
  BLACK_STAR_PROMO: "BLACK STAR PROMO", PROMO_GENERIC: "PROMO",
  FIRST_EDITION: "1ST EDITION", UNLIMITED: "UNLIMITED", SHADOWLESS: "SHADOWLESS",
  FOURTH_PRINT: "4TH PRINT", NO_RARITY_SYMBOL: "NO RARITY SYMBOL",
  ERROR_MISPRINT: "ERROR / MISPRINT", TROPHY_PRIZE: "TROPHY / PRIZE",
  TRAINER_GALLERY: "TRAINER GALLERY", GALARIAN_GALLERY: "GALARIAN GALLERY",
  RADIANT_COLLECTION: "RADIANT COLLECTION", SHINY_VAULT: "SHINY VAULT",
  ILLUSTRATION_RARE: "ILLUSTRATION RARE", SPECIAL_ILLUSTRATION_RARE: "SPECIAL ILLUSTRATION RARE",
  CHARACTER_RARE: "CHARACTER RARE", CHARACTER_SUPER_RARE: "CHARACTER SUPER RARE",
  PRISM_STAR: "PRISM STAR", AMAZING_RARE: "AMAZING RARE", SECRET_RARE: "SECRET RARE",
  OTHER: "OTHER",
};

function buildCollectionLine(cert: CertificateRecord): string {
  const code = (cert as any).collectionCode;
  if (!code) {
    const legacy = (cert as any).collection;
    return legacy ? legacy.trim().toUpperCase() : "";
  }
  if (code === "OTHER") {
    const other = (cert as any).collectionOther;
    return other ? other.trim().toUpperCase() : "";
  }
  return COLLECTION_DISPLAY[code] || code.replace(/_/g, " ");
}

function buildLine1(cert: CertificateRecord): string {
  const parts: string[] = [];
  if (cert.year) parts.push(cert.year);
  if (cert.setName) parts.push(cert.setName.toUpperCase());
  return parts.join(" ") || "";
}

function buildLine2(cert: CertificateRecord): string {
  return cert.cardName ? cert.cardName.toUpperCase() : "";
}

const VARIANT_DISPLAY: Record<string, string> = {
  NONE: "", HOLO: "HOLO", REVERSE_HOLO: "REVERSE HOLO",
  COSMOS_HOLO: "COSMOS HOLO", CRACKED_ICE_HOLO: "CRACKED ICE HOLO",
  MIRROR_HOLO: "MIRROR HOLO", GLITTER_HOLO: "GLITTER HOLO", PATTERN_HOLO: "PATTERN HOLO",
  TEXTURED: "TEXTURED", FULL_ART: "FULL ART", ALT_ART: "ALT ART", SPECIAL_ART: "SPECIAL ART",
  RAINBOW: "RAINBOW", GOLD: "GOLD", SHINY: "SHINY", RADIANT: "RADIANT",
  TRAINER_GALLERY: "TRAINER GALLERY", GALARIAN_GALLERY: "GALARIAN GALLERY",
  CHARACTER_RARE: "CHARACTER RARE", CHARACTER_SUPER_RARE: "CHARACTER SUPER RARE",
  SECRET_RARE: "SECRET RARE", ILLUSTRATION_RARE: "ILLUSTRATION RARE",
  SPECIAL_ILLUSTRATION_RARE: "SPECIAL ILLUSTRATION RARE", PROMO: "PROMO",
  FIRST_EDITION: "1ST EDITION", SHADOWLESS: "SHADOWLESS", UNLIMITED: "UNLIMITED",
  OTHER: "OTHER",
};

function buildVariantLine(cert: CertificateRecord): string {
  const v = cert.variant;
  if (!v || v === "NONE") return "";
  if (v === "OTHER") {
    const other = (cert as any).variantOther;
    return other ? other.toUpperCase() : "OTHER";
  }
  if (VARIANT_DISPLAY[v]) return VARIANT_DISPLAY[v];
  return v.toUpperCase();
}

const RARITY_DISPLAY: Record<string, string> = {
  COMMON: "COMMON", UNCOMMON: "UNCOMMON", RARE: "RARE", HOLO: "HOLO",
  RARE_HOLO: "HOLO RARE", REVERSE_HOLO: "REVERSE HOLO",
  DOUBLE_RARE: "DOUBLE RARE", ULTRA_RARE: "ULTRA RARE",
  ILLUSTRATION_RARE: "ILLUSTRATION RARE", SPECIAL_ILLUSTRATION_RARE: "SPECIAL ILLUSTRATION RARE",
  HYPER_RARE: "HYPER RARE", SECRET_RARE: "SECRET RARE",
  SHINY_RARE: "SHINY RARE", SHINY_ULTRA_RARE: "SHINY ULTRA RARE",
  RADIANT: "RADIANT", AMAZING_RARE: "AMAZING RARE", ACE_SPEC: "ACE SPEC",
  TRAINER_GALLERY: "TRAINER GALLERY", GALAR_GALLERY: "GALARIAN GALLERY",
  GOLD_STAR: "★ GOLD STAR", DOUBLE_GOLD_STAR: "★★ DOUBLE GOLD STAR",
  PROMO_RARITY: "PROMO", OTHER: "OTHER",
};

function buildRarityText(cert: CertificateRecord): string {
  const code = cert.rarity;
  if (!code) return "";
  if (code === "OTHER") {
    const other = (cert as any).rarityOther;
    return other ? other.toUpperCase() : "OTHER";
  }
  // Form may write "Uncommon", AI may write "uncommon", manual import may write
  // "RARE_HOLO" — uppercase the lookup key so display map hits regardless.
  return RARITY_DISPLAY[String(code).toUpperCase()] || String(code).replace(/_/g, " ");
}

function buildLine3(cert: CertificateRecord): string {
  const parts: string[] = [];
  const rText = buildRarityText(cert);
  if (rText) parts.push(rText);
  if (cert.labelType && cert.labelType !== "Standard" && cert.labelType !== "black") parts.push(cert.labelType.toUpperCase());
  return parts.join(" · ") || "";
}

function buildLine4(cert: CertificateRecord): string {
  return cert.cardNumber ? `#${cert.cardNumber}` : "";
}

/**
 * Draws the gold outer frame onto ctx. Called once during setup and again
 * after the logo is painted on the back label to prevent bleed-over.
 */
function drawGoldFrame(ctx: any) {
  ctx.shadowBlur  = 0;
  ctx.shadowColor = "transparent";
  // v424 — flat GOLD fill (was 5-stop diagonal gradient).
  ctx.fillStyle = GOLD;
  // Four strips — top, bottom, left, right
  ctx.fillRect(0,               0,               PX_W,   FRAME_W);
  ctx.fillRect(0,               PX_H - FRAME_W,  PX_W,   FRAME_W);
  ctx.fillRect(0,               FRAME_W,         FRAME_W, PX_H - FRAME_W * 2);
  ctx.fillRect(PX_W - FRAME_W,  FRAME_W,         FRAME_W, PX_H - FRAME_W * 2);
}

export async function generateLabelPNG(
  cert: CertificateRecord,
  side: "front" | "back"
): Promise<Buffer> {
  const { createCanvas, loadImage } = await import("canvas");

  // Black Label: ONLY quad-10s (all four subgrades exactly 10) get the dark label.
  // A standard GEM MT 10 with any subgrade below 10 renders on the white label.
  const gradeNum = parseFloat(cert.gradeOverall || "0");
  const isBlack = !isNonNumericGrade(cert.gradeType || "numeric")
    && gradeNum === 10
    && parseFloat(cert.gradeCentering || "0") === 10
    && parseFloat(cert.gradeCorners   || "0") === 10
    && parseFloat(cert.gradeEdges     || "0") === 10
    && parseFloat(cert.gradeSurface   || "0") === 10;
  const labelBg = isBlack ? BLACK : WHITE;
  const labelFg = isBlack ? WHITE : "#000000";

  const canvas = createCanvas(PX_W, PX_H);
  const ctx = canvas.getContext("2d");

  // ── 1. CANVAS BASE ────────────────────────────────────────────────────────
  ctx.shadowBlur  = 0;
  ctx.shadowColor = "transparent";
  ctx.fillStyle   = labelBg;
  ctx.fillRect(0, 0, PX_W, PX_H);

  // ── 2. GOLD OUTER FRAME — fills from canvas edge to FRAME_W inward ───────
  drawGoldFrame(ctx);

  // ── 3. INNER BACKGROUND — content zone inside gold frame ─────────────────
  ctx.fillStyle = labelBg;
  ctx.fillRect(I_LEFT, I_TOP, I_W, I_H);


  let logo: any = null;
  try {
    logo = await loadImage(LOGO_PATH);
  } catch {}

  if (side === "front") {
    await drawFront(ctx, cert, logo, loadImage, labelBg, labelFg);
  } else {
    await drawBack(ctx, cert, logo, loadImage, labelBg, labelFg);
  }

  return canvas.toBuffer("image/png");
}

// ── Language code → 3-letter abbreviation ────────────────────────────────
function langAbbr(lang: string | null | undefined): string {
  if (!lang) return "";
  const l = lang.trim().toLowerCase();
  if (l.startsWith("jap") || l === "jp") return "JPN";
  if (l.startsWith("kor") || l === "kr") return "KOR";
  if (l.startsWith("chi") || l === "cn" || l === "zh") return "CHN";
  if (l.startsWith("ger") || l === "de") return "GER";
  if (l.startsWith("fre") || l === "fr") return "FRE";
  if (l.startsWith("ita") || l === "it") return "ITA";
  if (l.startsWith("spa") || l === "es") return "ESP";
  if (l.startsWith("por") || l === "pt") return "POR";
  if (l.startsWith("pol") || l === "pl") return "POL";
  if (l.startsWith("dut") || l === "nl") return "DUT";
  return "ENG";
}

/**
 * Draws a visual barcode (white bars on dark background) derived from the
 * cert ID. Aesthetic only — not technically scannable by a scanner.
 */
function drawSimpleBarcode(
  ctx: any, data: string,
  x: number, y: number, w: number, h: number
) {
  const src = (data.replace(/[^A-Z0-9]/gi, "").toUpperCase() || "MVUK").repeat(4);
  const THIN = 1.5, WIDE = 3.0, GAP = 1.0;
  ctx.save();
  let bx = x;
  // Guard bars
  for (let i = 0; i < 3 && bx + WIDE <= x + w; i++) {
    ctx.fillStyle = WHITE;
    ctx.fillRect(bx, y, THIN, h);
    bx += THIN + GAP;
  }
  bx += GAP;
  // Data bars derived from cert ID characters
  for (let ci = 0; ci < src.length && bx + WIDE * 5 + GAP * 5 <= x + w - 6; ci++) {
    const code = src.charCodeAt(ci);
    for (let bit = 7; bit >= 0; bit--) {
      const bw = ((code >> bit) & 1) ? WIDE : THIN;
      if (bit % 2 !== 0) {
        ctx.fillStyle = WHITE;
        ctx.fillRect(bx, y, bw, h);
      }
      bx += bw + GAP;
    }
    bx += 1;
  }
  // Stop bars
  for (let i = 0; i < 4 && bx + WIDE <= x + w; i++) {
    ctx.fillStyle = WHITE;
    ctx.fillRect(bx, y, i === 3 ? WIDE : THIN, h);
    bx += (i === 3 ? WIDE : THIN) + GAP;
  }
  ctx.restore();
}

/**
 * PR #91 — print-yellow redesign: PSA-style boxed wordmark + framed grade
 * panel + flat-yellow shield on back. Replaces the v416 artwork-background
 * layout entirely. White label uses PRINT_WHITE inner bg + PRINT_BLACK
 * text; Black Label uses PRINT_BLACK inner bg + PRINT_YELLOW text. The
 * grade panel is always PRINT_YELLOW filled with PRINT_BLACK contents
 * (black-on-yellow is the rule, regardless of label variant).
 *
 * Dimensions (70 × 20 mm slab @ 300 DPI = 826 × 236 px):
 *   2mm yellow border on all four sides
 *   Inner content: 66 × 16 mm (= 779 × 189 px)
 *   Wordmark box: 22 × 4 mm, top-centre, 0.5mm below top border
 *   Grade panel: 14mm wide × full inner height − 0.5mm bottom margin
 *   Card-detail text column: left of the grade panel, 2mm left margin
 */

// ── px helpers (300 DPI canvas, top-left origin) ─────────────────────────
const PX_PER_MM = PX_W / 70;   // 826 / 70 = 11.8 (matches global MM scale)
const mmPx      = (mm: number) => mm * PX_PER_MM;
const ptPx      = (pt: number) => pt * (300 / 72);   // 4.167 px per pt

const BORDER_MM = 2;

function drawSlabBorder(ctx: any, innerBg: string): { x: number; y: number; w: number; h: number } {
  ctx.fillStyle = PRINT_YELLOW;
  ctx.fillRect(0, 0, PX_W, PX_H);
  const ix = mmPx(BORDER_MM);
  const iy = mmPx(BORDER_MM);
  const iw = PX_W - 2 * mmPx(BORDER_MM);
  const ih = PX_H - 2 * mmPx(BORDER_MM);
  ctx.fillStyle = innerBg;
  ctx.fillRect(ix, iy, iw, ih);
  return { x: ix, y: iy, w: iw, h: ih };
}

/**
 * Draws a flat-yellow shield silhouette (rounded top, pointed bottom) with
 * "MINTVAULT" + "TRADING CARD GRADING" centred inside. PR #88 replaced the
 * legacy raster mintvault-logo.png; PR #91 keeps the text-only approach
 * but draws an enclosing shield outline so the back label reads as a
 * premium grading mark rather than free-floating text.
 */
function drawShield(ctx: any, x: number, y: number, w: number, h: number): void {
  const r = w * 0.18;
  const pointDepth = h * 0.18;
  const sideCurveAmount = w * 0.05;
  const cx = x + w / 2;
  const topY = y;
  const bottomY = y + h;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x + r, topY);
  ctx.lineTo(x + w - r, topY);
  ctx.quadraticCurveTo(x + w, topY, x + w, topY + r);
  ctx.quadraticCurveTo(x + w + sideCurveAmount, y + h * 0.55, cx, bottomY + pointDepth * 0.1);
  ctx.quadraticCurveTo(x - sideCurveAmount, y + h * 0.55, x, topY + r);
  ctx.quadraticCurveTo(x, topY, x + r, topY);
  ctx.closePath();
  ctx.fillStyle   = PRINT_YELLOW;
  ctx.fill();
  ctx.strokeStyle = PRINT_YELLOW_DARK;
  ctx.lineWidth   = mmPx(0.14);
  ctx.stroke();

  const inset = mmPx(0.42);
  ctx.beginPath();
  ctx.moveTo(x + r + inset, topY + inset);
  ctx.lineTo(x + w - r - inset, topY + inset);
  ctx.quadraticCurveTo(x + w - inset, topY + inset, x + w - inset, topY + r + inset);
  ctx.quadraticCurveTo(x + w + sideCurveAmount - inset, y + h * 0.55, cx, bottomY + pointDepth * 0.1 - inset);
  ctx.quadraticCurveTo(x - sideCurveAmount + inset, y + h * 0.55, x + inset, topY + r + inset);
  ctx.quadraticCurveTo(x + inset, topY + inset, x + r + inset, topY + inset);
  ctx.closePath();
  ctx.strokeStyle = PRINT_YELLOW_DARK;
  ctx.lineWidth   = mmPx(0.11);
  ctx.stroke();

  ctx.fillStyle    = PRINT_BLACK;
  ctx.textAlign    = "center";
  ctx.textBaseline = "alphabetic";

  const mainSize     = ptPx(5.5);
  const subtitleSize = ptPx(2.6);
  const stackGap     = mmPx(0.6);
  const visualCY     = y + h * 0.48;

  ctx.font = `bold ${mainSize}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.fillText("MINTVAULT", cx, visualCY);
  ctx.font = `bold ${subtitleSize}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.fillText("TRADING CARD GRADING", cx, visualCY + stackGap + subtitleSize);

  ctx.textAlign    = "left";
  ctx.restore();
}

/**
 * Three concentric arcs (radii 25/40/55% of size) opening rightward, plus
 * a small filled finger oval below. PRINT_YELLOW @ 0.8pt stroke.
 */
function drawNfcSwoosh(ctx: any, cx: number, cy: number, sizePx: number): void {
  ctx.save();
  ctx.strokeStyle = PRINT_YELLOW;
  ctx.lineWidth   = ptPx(0.8);
  ctx.lineCap     = "round";
  for (const r of [sizePx * 0.25, sizePx * 0.40, sizePx * 0.55]) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 3, Math.PI / 3);
    ctx.stroke();
  }
  ctx.fillStyle = PRINT_YELLOW;
  ctx.beginPath();
  ctx.ellipse(cx, cy + sizePx * 0.72, sizePx * 0.16, sizePx * 0.10, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ── FRONT LABEL ─────────────────────────────────────────────────────────────
async function drawFront(
  ctx: any,
  cert: CertificateRecord,
  _logo: any,
  _loadImage: any,
  labelBg: string = WHITE,
  _labelFg: string = "#000000",
): Promise<void> {
  const isBlack = labelBg !== WHITE;
  const innerBg = isBlack ? PRINT_BLACK : PRINT_WHITE;
  const textFg  = isBlack ? PRINT_YELLOW : PRINT_BLACK;
  const subdued = isBlack ? PRINT_YELLOW_DARK : "#333333";

  drawSlabBorder(ctx, innerBg);

  // BOXED MINTVAULT WORDMARK — top-centre, 22×4mm, 0.5mm below top border
  const wmBoxW = mmPx(22);
  const wmBoxH = mmPx(4);
  const wmBoxX = (PX_W - wmBoxW) / 2;
  const wmBoxY = mmPx(BORDER_MM + 0.5);
  ctx.fillStyle = innerBg;
  ctx.fillRect(wmBoxX, wmBoxY, wmBoxW, wmBoxH);
  ctx.strokeStyle = PRINT_YELLOW;
  ctx.lineWidth   = mmPx(0.4);
  ctx.strokeRect(wmBoxX, wmBoxY, wmBoxW, wmBoxH);
  ctx.fillStyle    = textFg;
  ctx.font         = `bold ${ptPx(8)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.textAlign    = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("MINTVAULT", PX_W / 2, wmBoxY + wmBoxH / 2);

  // GRADE PANEL — right column, 14mm wide
  const panelW = mmPx(14);
  const panelX = PX_W - mmPx(BORDER_MM) - panelW;
  const panelY = mmPx(BORDER_MM);
  const panelH = PX_H - 2 * mmPx(BORDER_MM) - mmPx(0.5);

  ctx.fillStyle = PRINT_YELLOW;
  ctx.fillRect(panelX, panelY, panelW, panelH);
  const piInset = mmPx(0.3);
  ctx.strokeStyle = PRINT_YELLOW_DARK;
  ctx.lineWidth   = mmPx(0.11);
  ctx.strokeRect(panelX + piInset, panelY + piInset, panelW - 2 * piInset, panelH - 2 * piInset);

  const panelCX    = panelX + panelW / 2;
  const gradeType  = cert.gradeType || "numeric";
  const isNonNum   = isNonNumericGrade(gradeType);
  const grade      = isNonNum ? 0 : Math.round(parseFloat(cert.gradeOverall || "0"));
  const gradeStr   = isNonNum ? "" : String(grade);
  const gradeAbbr  = isNonNum ? (gradeType === "AA" ? "AUTH ALT" : "AUTH") : gradeLabel(grade);
  const certNumTxt = cert.cardNumber ? `#${cert.cardNumber}` : "";
  const certIdTxt  = cert.certId || "";

  ctx.fillStyle    = PRINT_BLACK;
  ctx.textAlign    = "center";
  ctx.textBaseline = "alphabetic";

  if (certNumTxt) {
    ctx.font = `bold ${ptPx(5.5)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
    ctx.fillText(certNumTxt, panelCX, panelY + mmPx(2.5));
  }
  ctx.font = `bold ${ptPx(4.5)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  const abbrFit = fitFontSize(ctx, gradeAbbr, panelW - mmPx(1), ptPx(4.5), ptPx(3));
  ctx.font = `bold ${abbrFit}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.fillText(gradeAbbr, panelCX, panelY + mmPx(4.5));

  if (!isNonNum) {
    ctx.font = `bold ${ptPx(18)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
    ctx.fillText(gradeStr, panelCX, panelY + panelH * 0.62);
  }

  ctx.font = `bold ${ptPx(4.5)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.fillText(certIdTxt, panelCX, panelY + panelH - mmPx(0.8));

  // CARD DETAILS LEFT COLUMN
  const textLeftX = mmPx(BORDER_MM + 2);
  const textRight = panelX - mmPx(1);
  const textMaxW  = textRight - textLeftX;
  ctx.fillStyle    = textFg;
  ctx.textAlign    = "left";
  ctx.textBaseline = "alphabetic";

  const cardName = (cert.cardName || "").toUpperCase();
  const setName  = [cert.year, (cert.setName || "").toUpperCase()].filter(Boolean).join(" ");
  const rarity   = (cert.rarity || cert.variant || "").toString().toUpperCase();

  ctx.font = `bold ${ptPx(7)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  const nameFit = fitFontSize(ctx, cardName, textMaxW, ptPx(7), ptPx(4.5));
  ctx.font = `bold ${nameFit}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.fillText(truncateText(ctx, cardName, textMaxW), textLeftX, mmPx(9));

  ctx.font = `bold ${ptPx(6.5)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  const setFit = fitFontSize(ctx, setName, textMaxW, ptPx(6.5), ptPx(4.5));
  ctx.font = `bold ${setFit}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.fillText(truncateText(ctx, setName, textMaxW), textLeftX, mmPx(12));

  if (rarity) {
    ctx.fillStyle = subdued;
    ctx.font = `bold ${ptPx(5.5)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
    const rFit = fitFontSize(ctx, rarity, textMaxW, ptPx(5.5), ptPx(4));
    ctx.font = `bold ${rFit}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
    ctx.fillText(truncateText(ctx, rarity, textMaxW), textLeftX, mmPx(15));
  }

  ctx.textAlign    = "left";
  ctx.textBaseline = "alphabetic";
}

// ── BACK LABEL ──────────────────────────────────────────────────────────────
async function drawBack(
  ctx: any,
  cert: CertificateRecord,
  _logo: any,
  loadImage: any,
  labelBg: string = WHITE,
  _labelFg: string = "#1A1A1A",
): Promise<void> {
  const isBlack = labelBg !== WHITE;
  const innerBg = isBlack ? PRINT_BLACK : PRINT_WHITE;
  const textFg  = isBlack ? PRINT_YELLOW : PRINT_BLACK;

  drawSlabBorder(ctx, innerBg);

  // LEFT: shield (16×11mm @ 4mm canvas-x, vertically centred-ish)
  const shieldW = mmPx(16);
  const shieldH = mmPx(11);
  const shieldX = mmPx(4);
  const shieldY = mmPx(BORDER_MM + 1);
  drawShield(ctx, shieldX, shieldY, shieldW, shieldH);

  // CENTRE: URL + NFC swoosh + caption
  const centreCX = mmPx(36);
  ctx.fillStyle    = textFg;
  ctx.font         = `bold ${ptPx(6.5)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.textAlign    = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("mintvaultuk.com", centreCX, mmPx(5));

  drawNfcSwoosh(ctx, centreCX, mmPx(11), mmPx(3.5));

  ctx.fillStyle = PRINT_YELLOW;
  ctx.font      = `bold ${ptPx(4.5)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.fillText("Tap NFC to verify", centreCX, mmPx(17));

  // RIGHT: QR + cert ID
  const qrSizePx = mmPx(13);
  const qrX      = PX_W - mmPx(BORDER_MM) - qrSizePx - mmPx(1);
  const qrY      = mmPx(BORDER_MM) + mmPx(0.5);

  const certUrl = getCertUrl(cert.certId);
  const qrBuf   = await generateQRBuffer(certUrl, Math.round(qrSizePx));
  const qrImg   = await loadImage(qrBuf);
  ctx.fillStyle = PRINT_WHITE;
  ctx.fillRect(qrX, qrY, qrSizePx, qrSizePx);
  ctx.drawImage(qrImg, qrX, qrY, qrSizePx, qrSizePx);

  ctx.fillStyle = textFg;
  ctx.font      = `bold ${ptPx(4.5)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText(cert.certId || "", qrX + qrSizePx / 2, qrY + qrSizePx + mmPx(2));

  ctx.textAlign    = "left";
  ctx.textBaseline = "alphabetic";

  // Compatibility — drawContactlessIcon kept for legacy callers; not used here.
  void drawContactlessIcon;
}

/** Three-arcs-plus-dot NFC mark kept for any callers outside the back label. */
function drawContactlessIcon(ctx: any, cx: number, cy: number, size: number, color: string): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth   = Math.max(2.5, size * 0.13);
  ctx.lineCap     = "round";
  for (const r of [size * 0.30, size * 0.60, size * 0.90]) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 3, Math.PI / 3);
    ctx.stroke();
  }
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(2, size * 0.13), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export async function generateLabelPDF(
  cert: CertificateRecord,
  side: "front" | "back" | "both"
): Promise<Buffer> {
  const pngBuffers: Buffer[] = [];

  if (side === "front" || side === "both") {
    pngBuffers.push(await generateLabelPNG(cert, "front"));
  }
  if (side === "back" || side === "both") {
    pngBuffers.push(await generateLabelPNG(cert, "back"));
  }

  return new Promise((resolve, reject) => {
    try {
      const pageH = side === "both" ? PDF_H * 2 : PDF_H;
      const doc = new PDFDocument({
        size: [PDF_W, pageH],
        margin: 0,
        info: {
          Title:  `MintVault Label - ${cert.certId}`,
          Author: "MintVault Trading Card Grading",
        },
      });

      const chunks: Buffer[] = [];
      doc.on("data",  (chunk: Buffer) => chunks.push(chunk));
      doc.on("end",   () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      let yOffset = 0;
      for (const pngBuf of pngBuffers) {
        doc.image(pngBuf, 0, yOffset, { width: PDF_W, height: PDF_H });
        yOffset += PDF_H;
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
