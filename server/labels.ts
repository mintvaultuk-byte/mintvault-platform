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
const GOLD       = "#C9A227";   // separators, accents
const GOLD_DARK  = "#A07820";
const GOLD_LIGHT = "#D4AF37";
const BLACK      = "#000000";
const WHITE      = "#FFFFFF";

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
 * Front label — ACE-style premium layout.
 *
 * Left 68%: artwork background + dark overlay + card text hierarchy
 *   Line 1  Year + Set   18px normal white
 *   Line 2  Card Name    38→28px bold white (hero)
 *   Line 3  Variant      22px normal white 85%  (if present)
 *   Line 4  #Num LANG    22px normal white 85%
 * Right 32%: gold grade panel (grade abbr + number, vertically centred)
 * Bottom strip ~38px: barcode | MintVault logo | cert number
 */
async function drawFront(ctx: any, cert: CertificateRecord, logo: any, loadImage: any, labelBg = WHITE, labelFg = "#000000") {
  const gradeType = cert.gradeType || "numeric";
  const isNonNum  = isNonNumericGrade(gradeType);
  const grade     = isNonNum ? 0 : Math.round(parseFloat(cert.gradeOverall || "0"));

  // ── LAYOUT CONSTANTS ──────────────────────────────────────────────────────
  const PANEL_W = 148;                        // right grade panel (≈ 18%, -5.7%)
  const STRIP_H = 38;                         // bottom strip height
  const panelX  = I_RIGHT - PANEL_W;          // 651
  const stripY  = I_BOTTOM - STRIP_H;         // 179

  // Left text insets
  const TXT_PAD  = 28;
  const textLeft = I_LEFT + TXT_PAD;          // 47
  const textMaxW = panelX - textLeft - 6;     // 495

  // Vertical content zone (inner area above bottom strip)
  const contentT = I_TOP;
  const contentB = stripY;

  // ── 1. CARD ARTWORK BACKGROUND ────────────────────────────────────────────
  // If artwork is available, draw it then add a white wash overlay so dark
  // text remains legible on any card image. No dark overlays — white bg design.
  const artworkUrl = (cert as any).frontImageUrl;
  if (artworkUrl) {
    try {
      const artImg = await loadImage(artworkUrl);
      ctx.save();
      ctx.beginPath();
      ctx.rect(I_LEFT, I_TOP, I_W, I_H);
      ctx.clip();
      const sc = Math.max(I_W / artImg.width, I_H / artImg.height);
      const dw = artImg.width * sc, dh = artImg.height * sc;
      ctx.drawImage(artImg, I_LEFT + (I_W - dw) / 2, I_TOP + (I_H - dh) / 2, dw, dh);
      ctx.restore();
      // Wash overlay — lightens (white label) or darkens (black label) artwork so text is legible
      ctx.fillStyle = labelBg === WHITE ? "rgba(255,255,255,0.62)" : "rgba(0,0,0,0.60)";
      ctx.fillRect(I_LEFT, I_TOP, I_W, I_H);
    } catch {}
  }

  // ── 2. GRADE PANEL (right, above bottom strip) ────────────────────────────
  const panelY  = I_TOP;
  const panelH  = stripY - panelY;            // 160px
  const panelCX = panelX + PANEL_W / 2;
  const DARK    = "#1A1000";

  if (!isNonNum) {
    // v424 — flat GOLD_LIGHT fill (was 5-stop metallic gradient + shine
    // overlay). Solid gold prints reliably and the grade digit sits on a
    // uniform background instead of competing with a fade.
    ctx.fillStyle = GOLD_LIGHT;
    ctx.fillRect(panelX, panelY, PANEL_W, panelH);

    // Bottom edge — crisp 3px darker line for depth (kept; not a gradient).
    ctx.fillStyle = "#9A7F1F";
    ctx.fillRect(panelX, panelY + panelH - 3, PANEL_W, 3);

    // Subtle vertical separator on the left edge of the panel
    ctx.strokeStyle = "rgba(255,215,0,0.25)";
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(panelX, panelY);
    ctx.lineTo(panelX, stripY);
    ctx.stroke();

    const gradeStr  = String(grade);
    const gradeAbbr = gradeLabel(grade);

    // ── Row 1: Card number (#112) ─────────────────────────────────────
    const cardNumPanelText = cert.cardNumber ? `#${cert.cardNumber}` : "";
    const CN_TOP_PAD  = 4;
    const cnFontSize  = 29;   // +16% — bold, prominent top-right anchor
    let   cardNumBot  = panelY + CN_TOP_PAD;
    if (cardNumPanelText) {
      ctx.font         = `bold ${cnFontSize}px Arial, Helvetica, sans-serif`;
      ctx.fillStyle    = "#1A1A1A";
      ctx.textAlign    = "center";
      ctx.textBaseline = "top";
      try { (ctx as any).letterSpacing = "0.5px"; } catch {}
      ctx.fillText(cardNumPanelText, panelCX, panelY + CN_TOP_PAD);
      try { (ctx as any).letterSpacing = "0px"; } catch {}
      cardNumBot = panelY + CN_TOP_PAD + cnFontSize;
    }

    // ── Row 2: Grade abbreviation (GEM MT) ───────────────────────────
    const ABBR_TOP_PAD = cardNumPanelText ? 7 : 4;   // breathing room below card#
    const abbrFontSize = fitFontSize(ctx, gradeAbbr, PANEL_W - 10, 35, 12);
    try { (ctx as any).letterSpacing = "5px"; } catch {}
    ctx.font         = `bold ${abbrFontSize}px Arial, Helvetica, sans-serif`;
    ctx.fillStyle    = "#1A1A1A";
    ctx.textAlign    = "center";
    ctx.textBaseline = "top";
    ctx.fillText(gradeAbbr, panelCX, cardNumBot + ABBR_TOP_PAD);
    try { (ctx as any).letterSpacing = "0px"; } catch {}

    // Grade number — dark, large, subtle drop shadow.
    // Sizing zone keeps small safety margins so the digit doesn't kiss the
    // abbr line above or the panel bottom edge during fitFontSize. Centring
    // however ignores those margins and uses descBot ↔ stripY directly so
    // the digit sits visually centred in the full lower panel zone.
    const descBot      = cardNumBot + ABBR_TOP_PAD + abbrFontSize;
    const ABBR_NUM_GAP = 6;
    const NUM_BOT_PAD  = 10;
    const numZoneTop   = descBot + ABBR_NUM_GAP;
    const numZoneBot   = stripY - NUM_BOT_PAD;
    const numZoneH     = numZoneBot - numZoneTop;
    const maxByH       = Math.floor(numZoneH / 0.754);
    const gradeFontSize = fitFontSize(ctx, gradeStr, PANEL_W - 8, Math.min(133, maxByH), 48);
    // Optical-centre adjustment: textBaseline="middle" places the em-box
    // middle at Y, but a numeral's visual centre sits ~15% of em ABOVE the
    // em-box middle (digits have no descender; visual mass is top-heavy).
    // 0.08*em pushes the digit down so it reads visually centred rather
    // than mathematically centred.
    const gradeNumCY   = (descBot + stripY) / 2 + gradeFontSize * 0.08;

    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;
    ctx.shadowBlur    = 1;
    ctx.shadowColor   = "rgba(0,0,0,0.25)";
    ctx.font         = `bold ${gradeFontSize}px Arial, Helvetica, sans-serif`;
    ctx.fillStyle    = "#1A1A1A";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(gradeStr, panelCX, gradeNumCY);
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.shadowBlur    = 0;
    ctx.shadowColor   = "transparent";

  } else {
    // Non-numeric (AUTHENTIC / AUTHENTIC ALTERED)
    ctx.textAlign = "center";
    if (gradeType === "AA") {
      ctx.textBaseline = "middle";
      ctx.font      = `bold 28px Arial, Helvetica, sans-serif`;
      ctx.fillStyle = "#1A1A1A";
      ctx.fillText("AUTHENTIC", panelCX, panelY + panelH / 2 - 20);
      ctx.font      = `bold 22px Arial, Helvetica, sans-serif`;
      ctx.fillStyle = GOLD_DARK;
      ctx.fillText("ALTERED", panelCX, panelY + panelH / 2 + 14);
    } else {
      const authSize = fitFontSize(ctx, "AUTHENTIC", PANEL_W - 8, 30, 18);
      ctx.textBaseline = "middle";
      ctx.font      = `bold ${authSize}px Arial, Helvetica, sans-serif`;
      ctx.fillStyle = "#1A1A1A";
      ctx.fillText("AUTHENTIC", panelCX, panelY + panelH / 2);
    }
  }

  // ── 3. BOTTOM STRIP ───────────────────────────────────────────────────────
  ctx.fillStyle = labelBg;
  ctx.fillRect(I_LEFT, stripY, I_W, STRIP_H);

  // ── GRADE PANEL cert ID — centred in the grade panel's strip zone ──────────
  {
    const certStripSz  = 28;
    const certStripFit = fitFontSize(ctx, cert.certId, PANEL_W - 14, certStripSz, 14);
    ctx.font         = `bold ${certStripFit}px Arial, Helvetica, sans-serif`;
    ctx.fillStyle    = labelFg;
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.shadowBlur    = 0;
    ctx.shadowColor   = "transparent";
    // +3 optical down-shift: caps-only text (MV2) has visual mass in upper
    // half, so em-box-middle centring reads high. Pattern matches grade-digit
    // optical adjustment (PR #26).
    ctx.fillText(cert.certId, panelCX, stripY + Math.round(STRIP_H / 2) + 3);
  }

  // ── 3b. MINTVAULT wordmark lockup — Bodoni Moda 900, gold border box ────────
  // Perfectly centred in the left text panel (I_LEFT → panelX).
  //
  // node-canvas does NOT include CSS letterSpacing in measureText(), so we:
  //   1. Measure at letterSpacing=0 to get the baseline advance width
  //   2. Add the letter-spacing contribution manually (n-1 gaps × LS px)
  //   3. Use textAlign="left" with an explicit x so the text lands exactly
  //      in the centre of the correctly-sized border box.
  const MV_HDR_SZ    = 42;                           // font size
  const MV_HDR_PAD   = 21;                           // top padding from content area (was 8 — +13 for breathing room from gold border)
  const MV_HDR_Y     = contentT + MV_HDR_PAD;        // text baseline anchor (top mode)
  const MV_HDR_BOT   = MV_HDR_Y + MV_HDR_SZ;         // bottom of text zone
  const MV_BELOW_GAP = 10;                           // gap below lockup before card text
  const MV_LS        = 2;                            // letter-spacing px
  const MV_TEXT      = "MINTVAULT";

  const mvFont = `900 ${MV_HDR_SZ}px "Bodoni Moda", "Times New Roman", serif`;

  // Step 1 — measure without letter-spacing so measureText is accurate
  try { (ctx as any).letterSpacing = "0px"; } catch {}
  ctx.font         = mvFont;
  ctx.textBaseline = "middle";                               // measure in same mode as draw
  const mvBaseW  = ctx.measureText(MV_TEXT).width;
  // Add letter-spacing contribution: (numChars - 1) gaps × MV_LS px
  const mvTextW  = mvBaseW + MV_LS * (MV_TEXT.length - 1);  // 9 chars → 8 gaps × 2px = +16px

  // Step 2 — derive box geometry centred in left panel
  const BOX_PX   = 12;   // horizontal padding inside box (each side)
  const BOX_PY   = 5;    // vertical padding inside box (each side)
  const BOX_LW   = 3;    // border line width
  const BOX_W    = mvTextW + BOX_PX * 2;
  const BOX_H    = MV_HDR_SZ + BOX_PY * 2;
  const leftPanelCX = (I_LEFT + panelX) / 2;                // exact centre of left panel
  const BOX_X    = Math.round(leftPanelCX - BOX_W / 2);
  const BOX_Y    = MV_HDR_Y - BOX_PY;
  const BOX_CY   = BOX_Y + BOX_H / 2;                       // vertical centre of box

  // Step 3 — draw gold border box
  ctx.strokeStyle = GOLD_LIGHT;
  ctx.lineWidth   = BOX_LW;
  ctx.shadowBlur  = 0;
  ctx.shadowColor = "transparent";
  ctx.strokeRect(BOX_X, BOX_Y, BOX_W, BOX_H);

  // Step 4 — v424 — solid GOLD_LIGHT fill replaces the 5-stop gradient and
  // glow shadow. The gradient was washing out the centre of each letter on
  // physical labels; flat gold reads cleanly at the new 70mm width.
  try { (ctx as any).letterSpacing = `${MV_LS}px`; } catch {}
  ctx.textAlign    = "left";
  ctx.textBaseline = "middle";
  const mvTextX    = BOX_X + BOX_PX;

  ctx.fillStyle   = GOLD_LIGHT;
  ctx.shadowBlur  = 0;
  ctx.shadowColor = "transparent";
  ctx.fillText(MV_TEXT, mvTextX, BOX_CY);
  try { (ctx as any).letterSpacing = "0px"; } catch {}

  // ── 4. LEFT PANEL TEXT ────────────────────────────────────────────────────
  // Card text vertically centred in zone below MINTVAULT header.
  const textZoneT = MV_HDR_BOT + MV_BELOW_GAP;
  const textZoneH = contentB - textZoneT;

  // Top padding — push first line down from the MintVault header band.
  // Mild (12%) so the SZ_NM bump survives auto-shrink on 3-line cards.
  const TOP_PAD       = Math.round(textZoneH * 0.12);
  const adjTextZoneT  = textZoneT + TOP_PAD;
  const adjTextZoneH  = textZoneH - TOP_PAD;

  // ── Base font sizes ───────────────────────────────────────────────────────
  const SZ_NM  = 48;   // Line 1: Card Name — hero, 900 weight
  const SZ_YS  = 34;   // Line 2: Year + Set
  const SZ_VAR = 34;   // Line 3: Variant (and Line 4: Rarity reuse this size)
  const LG     = 2;    // intra-block line gap

  // Inter-block gaps — computed dynamically below to distribute lines
  // across the zone instead of clustering.
  const MIN_GAP = 6;   // floor: keeps adjacent lines from touching
  const MAX_GAP = 22;  // ceiling: prevents gappy look on 2-line cards

  // Line 1 — Card Name (shrinks 48→24px before wrapping to fit max width)
  // Uses 900 weight + Arial Black family for the heaviest available system
  // weight; falls back to Arial bold if Arial Black isn't installed.
  const NM_FAMILY = '"Arial Black", Arial, Helvetica, sans-serif';
  const cardNameText = cert.cardName ? cert.cardName.toUpperCase() : "";
  ctx.font = `900 ${SZ_NM}px ${NM_FAMILY}`;
  let nameSz = SZ_NM;
  if (cardNameText && ctx.measureText(cardNameText).width > textMaxW) {
    nameSz = fitFontSize(ctx, cardNameText, textMaxW, SZ_NM, 24, "900", NM_FAMILY);
  }
  ctx.font = `900 ${nameSz}px ${NM_FAMILY}`;
  const nmLines = cardNameText ? wrapText(ctx, cardNameText, textMaxW, 2) : [];

  // Line 2 — Year + Set Name
  const yearSetText = [cert.year, cert.setName ? cert.setName.toUpperCase() : ""]
    .filter(Boolean).join("  ");
  ctx.font = `bold ${SZ_YS}px Arial, Helvetica, sans-serif`;
  const ysLines = balancedWrap(ctx, yearSetText, textMaxW);

  // Line 3 — Variant (only if present)
  const variantText = buildVariantLine(cert);
  ctx.font = `bold ${SZ_VAR}px Arial, Helvetica, sans-serif`;
  const varLines = variantText ? wrapText(ctx, variantText.toUpperCase(), textMaxW, 1) : [];

  // Line 4 — Rarity (only if present)
  const rarityText = cert.rarity ? buildRarityText(cert).toUpperCase() : "";
  ctx.font = `bold ${SZ_VAR}px Arial, Helvetica, sans-serif`;
  const rarLines = rarityText ? wrapText(ctx, rarityText, textMaxW, 1) : [];

  // ── VERTICAL DISTRIBUTION ─────────────────────────────────────────────────
  // Distribute lines across the zone rather than clustering with fixed gaps:
  // first line near top, last line near bottom, remainder split evenly across
  // active inter-line gaps (clamped to MIN_GAP..MAX_GAP).
  function lh(sz: number, n: number): number { return n > 0 ? n * sz + (n - 1) * LG : 0; }

  let nmSzR = nameSz, ysSzR = SZ_YS, varSzR = SZ_VAR, rarSzR = SZ_VAR;

  const totalLineHeights = () =>
      lh(nmSzR,  nmLines.length)
    + lh(ysSzR,  ysLines.length)
    + lh(varSzR, varLines.length)
    + lh(rarSzR, rarLines.length);

  // Active inter-line gap = a non-empty block followed by another non-empty
  // block (skipping any empty blocks in between).
  const activeGapCount = () => {
    let n = 0;
    if (nmLines.length  > 0 && (ysLines.length > 0 || varLines.length > 0 || rarLines.length > 0)) n++;
    if (ysLines.length  > 0 && (varLines.length > 0 || rarLines.length > 0)) n++;
    if (varLines.length > 0 && rarLines.length > 0) n++;
    return n;
  };

  // Overflow guard: if even the tightest possible stack (lines + minGap*count)
  // exceeds zone, shrink fonts proportionally. Floor is 16px so headlines
  // remain legible even with all 4 lines + a 2-line wrapped name.
  const maxStack = adjTextZoneH * 0.94;
  const tightestStack = () => totalLineHeights() + MIN_GAP * activeGapCount();
  if (tightestStack() > maxStack) {
    const s = maxStack / tightestStack();
    nmSzR  = Math.max(16, Math.round(nmSzR  * s));
    ysSzR  = Math.max(16, Math.round(ysSzR  * s));
    varSzR = Math.max(16, Math.round(varSzR * s));
    rarSzR = Math.max(16, Math.round(rarSzR * s));
  }

  // Distribute remaining vertical space evenly across active gaps.
  const gapCount = activeGapCount();
  const availableForGaps = adjTextZoneH - totalLineHeights();
  const gapSize = gapCount > 0
    ? Math.max(MIN_GAP, Math.min(MAX_GAP, availableForGaps / gapCount))
    : 0;

  // Start at top of (padded) text zone — first block sits near the top,
  // last near the bottom, gaps spread between.
  let curY = adjTextZoneT;

  // ── RENDER ────────────────────────────────────────────────────────────────
  ctx.textAlign    = "left";
  ctx.textBaseline = "top";

  const renderBlock = (lines: string[], sz: number, weight: string, color: string, family: string = "Arial, Helvetica, sans-serif") => {
    if (!lines.length) return;
    ctx.font      = `${weight} ${sz}px ${family}`;
    ctx.fillStyle = color;
    for (const line of lines) {
      ctx.fillText(line, textLeft, curY);
      curY += sz + LG;
    }
    curY -= LG;
  };

  const secondaryFg = labelFg === WHITE ? "rgba(255,255,255,0.95)" : "#000000";
  renderBlock(nmLines, nmSzR, "900", labelFg, NM_FAMILY);
  if (nmLines.length > 0 && (ysLines.length > 0 || varLines.length > 0 || rarLines.length > 0)) curY += gapSize;
  try { (ctx as any).letterSpacing = "0.5px"; } catch {}
  renderBlock(ysLines, ysSzR, "bold", secondaryFg);
  try { (ctx as any).letterSpacing = "0px"; } catch {}
  if (ysLines.length > 0 && (varLines.length > 0 || rarLines.length > 0)) curY += gapSize;
  try { (ctx as any).letterSpacing = "0.5px"; } catch {}
  renderBlock(varLines, varSzR, "bold", secondaryFg);
  try { (ctx as any).letterSpacing = "0px"; } catch {}
  if (varLines.length > 0 && rarLines.length > 0) curY += gapSize;
  try { (ctx as any).letterSpacing = "0.5px"; } catch {}
  renderBlock(rarLines, rarSzR, "bold", secondaryFg);
  try { (ctx as any).letterSpacing = "0px"; } catch {}

  ctx.textAlign    = "left";
  ctx.textBaseline = "alphabetic";
}

/**
 * Draws the standard contactless/NFC symbol — three arcs opening rightward
 * plus a center dot. cx/cy is the geometric centre of the bounding box.
 * size is the half-width of the bounding box (= largest arc radius).
 */
function drawContactlessIcon(
  ctx: any,
  cx: number,
  cy: number,
  size: number,
  color: string,
) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth   = Math.max(2.5, size * 0.13);
  ctx.lineCap     = "round";
  // Three arcs, 30 % / 60 % / 90 % of size, opening rightward (−60° → +60°)
  for (const r of [size * 0.30, size * 0.60, size * 0.90]) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 3, Math.PI / 3);
    ctx.stroke();
  }
  // Centre dot
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(2, size * 0.13), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

async function drawBack(ctx: any, cert: CertificateRecord, logo: any, loadImage: any, _labelBg = WHITE, labelFg = "#1A1A1A") {
  // ── QR CODE — top-right corner, flush to inner gold borders ──────────────
  // Clean white background, no border, no framing — high contrast for scanning.
  const qrSize = 187;                        // +25% from original 150 (170→187 with cert ID shrunk to fit)
  const qrPad  = 0;                          // QR's internal margin:1 (~6px) provides quiet zone — no external pad needed
  const qrY    = I_TOP;                      // flush to top inner border
  const qrX    = I_RIGHT - qrSize;           // 645 — flush to right inner border
  const qrCenterX = qrX + qrSize / 2;       // 738.5

  // White box matches QR dimensions exactly (no external pad).
  const wbLeft   = qrX - qrPad;             // 645
  const wbTop    = I_TOP;                   // 18
  const wbW      = qrSize + qrPad;          // 187
  const wbH      = qrSize + qrPad;          // 187
  const wbBottom = wbTop + wbH;             // 205

  // Cert ID: visually centred between the QR image bottom and the inner
  // gold border. With qrPad=0, wbBottom == qrY+qrSize == 205, so both
  // references converge — no white-on-white invisibility caveat needed.
  const certFontH  = 28;
  const certMidY   = Math.round((qrY + qrSize + I_BOTTOM) / 2);      // (18 + 187 + 242) / 2 = 223.5 → 224

  // Left edge of the QR zone (used for NFC_ICON_CX midpoint calculation below)
  const gfLeft = wbLeft;                    // 645 — alias kept for layout calc

  const certUrl = getCertUrl(cert.certId);
  const qrBuf   = await generateQRBuffer(certUrl, qrSize);
  const qrImg   = await loadImage(qrBuf);

  // White box
  ctx.fillStyle = WHITE;
  ctx.fillRect(wbLeft, wbTop, wbW, wbH);

  // QR image on white background
  ctx.drawImage(qrImg, qrX, qrY, qrSize, qrSize);

  // Cert ID — readable below the QR box, centred under it.
  ctx.textAlign    = "center";
  ctx.textBaseline = "middle";
  const certBackFit = fitFontSize(ctx, cert.certId, wbW - 8, certFontH, 14);
  ctx.font          = `bold ${certBackFit}px Arial, Helvetica, sans-serif`;
  ctx.fillStyle     = labelFg;
  ctx.shadowBlur    = 0;
  ctx.shadowColor   = "transparent";
  ctx.fillText(cert.certId, qrCenterX, certMidY);

  // ── THREE-ZONE LAYOUT ────────────────────────────────────────────
  //
  //   LEFT   — Logo        : fits within inner content area (~24% of label width)
  //   CENTRE — NFC + txt   : NFC_ICON_CX = midpoint of (logo-right … qr-left)
  //   RIGHT  — QR code     : unchanged (150px, flush top-right)
  //
  // Logo must fit within PX_H=260 canvas. Using I_H-10=214px keeps it inside
  // the inner content area (I_TOP=15 to I_BOTTOM=221) with 5px margin each side.
  const LOGO_DRAW    = I_H - 10;                  // 196px — fits within inner area
  const LOGO_LX      = I_LEFT + 4;                // 19px — tight to left gold border
  const NFC_ICON_CX  = Math.round((LOGO_LX + LOGO_DRAW + gfLeft) / 2); // midpoint of (logo-right … gold-frame-left)

  // ── LEFT: MintVault logo — primary visual anchor ──────────────────────────
  if (logo) {
    const aspect = logo.width / logo.height;
    const drawH = LOGO_DRAW;
    const drawW = Math.round(drawH * aspect);
    const lx = LOGO_LX;
    const ly = I_TOP + Math.round((I_H - drawH) / 2); // vertically centred within inner area

    ctx.drawImage(logo, lx, ly, drawW, drawH);

    // Redraw gold frame on top so logo never bleeds into the border.
    drawGoldFrame(ctx);
  }

  // ── CENTRE TOP: website URL — v424 flat GOLD_DARK (was 5-stop gradient + glow) ──
  {
    const urlY    = I_TOP + 24;
    const urlSz   = 38;
    (ctx as any).letterSpacing = "1.5px";
    ctx.font             = `bold ${urlSz}px Arial, Helvetica, sans-serif`;
    ctx.fillStyle        = GOLD_DARK;
    ctx.textAlign        = "center";
    ctx.textBaseline     = "middle";
    ctx.shadowBlur       = 0;
    ctx.shadowColor      = "transparent";
    ctx.fillText("mintvaultuk.com", NFC_ICON_CX, urlY);
  }

  // ── CENTRE BOTTOM: tap instruction — v424 flat GOLD_DARK (was 5-stop gradient + glow) ──
  {
    const nfcY    = I_BOTTOM - 31;
    const nfcSz   = 34;
    (ctx as any).letterSpacing = "1.5px";
    ctx.font             = `bold ${nfcSz}px Arial, Helvetica, sans-serif`;
    ctx.fillStyle        = GOLD_DARK;
    ctx.textAlign        = "center";
    ctx.textBaseline     = "middle";
    ctx.shadowBlur       = 0;
    ctx.shadowColor      = "transparent";
    ctx.fillText("Tap NFC to verify", NFC_ICON_CX - 12, nfcY);
  }

  // ── CENTRE MIDDLE: NFC hand-tap icon — tinted gold ─────────────────────────
  try {
    const { createCanvas } = await import("canvas");
    const nfcImg  = await loadImage(NFC_ICON_PATH);
    const iconSz  = 165;                                  // rendered square size (px)
    const iconX   = Math.round(NFC_ICON_CX - iconSz / 2);
    const iconY   = Math.round(PX_H / 2 - iconSz / 2);
    console.log(`[label-back-debug] cert=${cert.certId} NFC_ICON_PATH=${NFC_ICON_PATH} CX=${NFC_ICON_CX} iconSz=${iconSz} iconX=${iconX} iconY=${iconY} img=${nfcImg.width}x${nfcImg.height}`);

    // PNG is opaque RGB (black icon on white background), no alpha channel —
    // confirmed via `sips`: samplesPerPixel: 3, hasAlpha: no. The previous
    // destination-out/destination-in compositing assumed alpha and produced
    // invisible output. Extract alpha via inverse luminance instead: dark
    // pixels become opaque gold, light pixels become transparent. Continuous
    // luminance values handle antialiased edges cleanly.
    const off    = createCanvas(iconSz, iconSz);
    const offCtx = off.getContext("2d");
    offCtx.drawImage(nfcImg, 0, 0, iconSz, iconSz);
    const imgData = offCtx.getImageData(0, 0, iconSz, iconSz);
    const d = imgData.data;
    const goldHex = GOLD_DARK.replace("#", "");
    const gR = parseInt(goldHex.substring(0, 2), 16);
    const gG = parseInt(goldHex.substring(2, 4), 16);
    const gB = parseInt(goldHex.substring(4, 6), 16);
    for (let i = 0; i < d.length; i += 4) {
      const lum = (d[i] + d[i+1] + d[i+2]) / 3;
      d[i]   = gR;
      d[i+1] = gG;
      d[i+2] = gB;
      d[i+3] = 255 - lum;  // alpha: black input → 255 (opaque), white → 0 (clear)
    }
    offCtx.putImageData(imgData, 0, 0);
    ctx.drawImage(off, iconX, iconY);
  } catch (err) {
    // Fallback: draw programmatic signal arcs if icon fails to load
    console.error(`[label-back-debug] cert=${cert.certId} NFC icon failed, falling back to arcs:`, err);
    const iconSz = 100;
    drawContactlessIcon(ctx, NFC_ICON_CX, Math.round(PX_H / 2), iconSz / 2.5, GOLD_DARK);
  }

  ctx.textAlign    = "left";
  ctx.textBaseline = "alphabetic";
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
