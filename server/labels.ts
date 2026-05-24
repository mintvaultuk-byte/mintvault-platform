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
  // v424 — flat GOLD_LIGHT fill (was 5-stop diagonal gradient). Brand-
  // unification pass folded the separate slightly-darker outer-frame
  // shade into GOLD_LIGHT so every gold surface uses one brand value.
  ctx.fillStyle = GOLD_LIGHT;
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
  // Black Label foreground: GOLD_LIGHT for premium gold-on-black look.
  // Affects three text elements inside drawFront(): card title block (L742),
  // rarity strip (L629), and cert ID in grade-panel column (L606). White
  // Label is unaffected (black on white).
  const labelFg = isBlack ? GOLD_LIGHT : "#000000";

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
  const STRIP_H = 44;                         // v432: 28→44 — taller strip hosts rarity (left) + cert ID (right) at matched main-line size.
  const panelX  = I_RIGHT - PANEL_W;          // 651
  const stripY  = I_BOTTOM - STRIP_H;         // 179

  // Left text insets
  const TXT_PAD  = 28;
  const textLeft = I_LEFT + TXT_PAD;          // 47
  const textMaxW = panelX - textLeft - 6;     // 495

  // Vertical content zone — full inner height (no top banner on the front).
  const contentT = I_TOP;
  const contentB = stripY;

  // ── 1. CARD ARTWORK BACKGROUND ────────────────────────────────────────────
  // If artwork is available, draw it then add a white wash overlay so dark
  // text remains legible on any card image. Full inner-area extent.
  const artworkUrl = (cert as any).frontImageUrl;
  const artH = I_H;
  if (artworkUrl) {
    try {
      const artImg = await loadImage(artworkUrl);
      ctx.save();
      ctx.beginPath();
      ctx.rect(I_LEFT, contentT, I_W, artH);
      ctx.clip();
      const sc = Math.max(I_W / artImg.width, artH / artImg.height);
      const dw = artImg.width * sc, dh = artImg.height * sc;
      ctx.drawImage(artImg, I_LEFT + (I_W - dw) / 2, contentT + (artH - dh) / 2, dw, dh);
      ctx.restore();
      // Wash overlay — lightens (white label) or darkens (black label) artwork so text is legible
      ctx.fillStyle = labelBg === WHITE ? "rgba(255,255,255,0.62)" : "rgba(0,0,0,0.60)";
      ctx.fillRect(I_LEFT, contentT, I_W, artH);
    } catch {}
  }

  // ── 2. GRADE PANEL (right, above bottom strip) ────────────────────────────
  const panelY  = contentT;
  const panelH  = stripY - panelY;            // full inner height above strip
  const panelCX = panelX + PANEL_W / 2;
  const DARK    = "#1A1000";

  if (!isNonNum) {
    // v424 — flat GOLD_LIGHT fill (was 5-stop metallic gradient + shine
    // overlay). Solid gold prints reliably and the grade digit sits on a
    // uniform background instead of competing with a fade.
    ctx.fillStyle = GOLD_LIGHT;
    ctx.fillRect(panelX, panelY, PANEL_W, panelH);

    // Subtle vertical separator on the left edge of the panel
    ctx.strokeStyle = "rgba(212,175,55,0.25)";
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(panelX, panelY);
    ctx.lineTo(panelX, stripY);
    ctx.stroke();

    const gradeStr  = String(grade);
    const gradeAbbr = gradeLabel(grade);

    // ── Three equal 52-px zones inside the panel ─────────────────────
    // Panel y=18 → y=174 (panelH=156); each zone centre is the middle
    // of its third. New layout (rearranged): card number TOP, digit
    // MIDDLE, abbreviation BOTTOM. Hard-coded so a future panel resize
    // doesn't silently shift the rows.
    const cardNumCY = 29;    // zone 1 centre — top third
    const digitCY   = 99;    // zone 2 centre — middle third
    const abbrCY    = 158;   // zone 3 centre — bottom third

    // Element 1 — card number (#4) in zone 1
    const cardNumPanelText = cert.cardNumber ? `#${cert.cardNumber}` : "";
    const cardNumFontSize = 30;
    if (cardNumPanelText) {
      ctx.font         = `bold ${cardNumFontSize}px Arial, Helvetica, sans-serif`;
      ctx.fillStyle    = "#1A1A1A";
      ctx.textAlign    = "center";
      ctx.textBaseline = "middle";
      try { (ctx as any).letterSpacing = "0.5px"; } catch {}
      ctx.fillText(cardNumPanelText, panelCX, cardNumCY);
      try { (ctx as any).letterSpacing = "0px"; } catch {}
    }

    // Element 2 — grade digit in zone 2 (middle)
    // Hard 80-px cap; fitFontSize shrinks only when width can't accommodate.
    const gradeFontSize = fitFontSize(ctx, gradeStr, PANEL_W - 8, 120, 36);
    // Optical-centre adjustment: textBaseline="middle" places the em-box
    // middle at Y, but a numeral's visual centre sits slightly above the
    // em-box middle (digits are top-heavy). 0.04*em shift pushes the
    // digit down so it reads visually centred on digitCY.
    const digitY = digitCY - gradeFontSize * 0.04;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;
    ctx.shadowBlur    = 1;
    ctx.shadowColor   = "rgba(0,0,0,0.25)";
    ctx.font         = `bold ${gradeFontSize}px Arial, Helvetica, sans-serif`;
    ctx.fillStyle    = "#1A1A1A";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(gradeStr, panelCX, digitY);
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.shadowBlur    = 0;
    ctx.shadowColor   = "transparent";

    // Element 3 — grade abbreviation (GEM MT) in zone 3 (bottom)
    const abbrFontSize = 30;
    try { (ctx as any).letterSpacing = "5px"; } catch {}
    ctx.font         = `bold ${abbrFontSize}px Arial, Helvetica, sans-serif`;
    ctx.fillStyle    = "#1A1A1A";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(gradeAbbr, panelCX, abbrCY);
    try { (ctx as any).letterSpacing = "0px"; } catch {}

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
  // Strip background fill removed — the strip now inherits whatever was
  // drawn below it (artwork + wash, or the canvas base). Cert ID + rarity
  // text continue to render directly on top.

  // ── GRADE PANEL cert ID — right-anchored 8px from inner gold border ────────
  {
    const certStripSz  = 24;   // match back-label cert ID size (L815 certFontH)
    const certStripFit = fitFontSize(ctx, cert.certId, PANEL_W - 14, certStripSz, 16);
    ctx.font         = `bold ${certStripFit}px Arial, Helvetica, sans-serif`;
    ctx.fillStyle    = labelFg;
    ctx.textAlign    = "right";
    ctx.textBaseline = "middle";
    ctx.shadowBlur    = 0;
    ctx.shadowColor   = "transparent";
    // +3 optical down-shift: top-heavy mass distribution (digits/caps) reads
    // high when em-box-middle centred. Pattern matches grade-digit optical
    // adjustment (PR #26).
    ctx.fillText(cert.certId.replace(/^MV/, ""), I_RIGHT - 8, stripY + Math.round(STRIP_H / 2) + 3);
  }

  // v433 — rarity left-aligned at the same X as the main text block above
  // (textLeft), and sized smaller than the main lines so the visual
  // hierarchy reads NAME / SET (large) → RARITY (smaller) → CERT ID (small)
  // left-to-right and top-to-bottom.
  {
    const rarityVariantStrip = [buildVariantLine(cert), cert.rarity ? buildRarityText(cert) : ""]
      .filter(Boolean).map(s => s.toUpperCase()).join(" · ");
    if (rarityVariantStrip.trim().length > 0) {
      const rarityMaxW   = panelX - textLeft - 8;   // right edge stops 8px short of the grade panel column
      const rarityFamily = '"Arial Black", Arial, Helvetica, sans-serif';
      const rarityFit    = fitFontSize(ctx, rarityVariantStrip, rarityMaxW, 28, 16, "700", rarityFamily);
      ctx.font           = `700 ${rarityFit}px ${rarityFamily}`;
      ctx.fillStyle      = labelFg;
      ctx.textAlign      = "left";
      ctx.textBaseline   = "middle";
      ctx.fillText(rarityVariantStrip, textLeft, stripY + Math.round(STRIP_H / 2) + 3);
    }
  }

  // ── 3b. MINTVAULT wordmark lockup — Bodoni Moda 900, gold border box ────────
  // Perfectly centred in the left text panel (I_LEFT → panelX).
  //
  // node-canvas does NOT include CSS letterSpacing in measureText(), so we:
  //   1. Measure at letterSpacing=0 to get the baseline advance width
  //   2. Add the letter-spacing contribution manually (n-1 gaps × LS px)
  //   3. Use textAlign="left" with an explicit x so the text lands exactly
  //      in the centre of the correctly-sized border box.
  const MV_HDR_SZ    = 44;                           // sized to fill the 56-px black top banner; glyph centre lands on banner midY=46.
  const MV_HDR_PAD   = 6;                            // tuned so MV_HDR_Y − BOX_PY lands on I_TOP=18 → BOX_Y aligns with banner top.
  const MV_HDR_Y     = contentT + MV_HDR_PAD;        // text baseline anchor (top mode)
  const MV_HDR_BOT   = MV_HDR_Y + MV_HDR_SZ;         // bottom of text zone
  const MV_BELOW_GAP = 2;                            // v429: 4→2 — every pixel matters for the expanded text zone.
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
  const BOX_PY   = 6;    // vertical padding (banner = 44 + 6*2 = 56 → matches the black banner height exactly)
  const BOX_LW   = 3;    // border line width (unused now — box border removed; kept for symmetry)
  const BOX_W    = mvTextW + BOX_PX * 2;
  const BOX_H    = MV_HDR_SZ + BOX_PY * 2;
  const leftPanelCX = (I_LEFT + panelX) / 2;                // exact centre of left panel
  const BOX_X    = Math.round(leftPanelCX - BOX_W / 2);
  const BOX_Y    = MV_HDR_Y - BOX_PY;
  const BOX_CY   = BOX_Y + BOX_H / 2;                       // vertical centre of box

  // Step 3 — black top banner. Spans the inner area from the left gold
  // frame to the grade panel's left edge, vertically from the inner top
  // down to the bottom of the wordmark box so the gold MINTVAULT glyphs
  // sit on a pure black plate. Drawn before the wordmark text so the
  // fillText below renders on top of the banner.
  ctx.fillStyle = "#000000";
  ctx.fillRect(I_LEFT, I_TOP, panelX - I_LEFT, BOX_Y + BOX_H - I_TOP);

  // Step 4 — v424 — solid GOLD_LIGHT fill replaces the 5-stop gradient and
  // glow shadow. The gradient was washing out the centre of each letter on
  // physical labels; flat gold reads cleanly at the new 70mm width.
  try { (ctx as any).letterSpacing = `${MV_LS}px`; } catch {}
  ctx.textAlign    = "left";
  ctx.textBaseline = "middle";
  const mvTextX    = BOX_X + Math.round((BOX_W - mvBaseW) / 2);

  // Always gold — the wordmark sits on the black top banner regardless
  // of label variant, so the previous white-vs-black conditional has been
  // removed.
  ctx.fillStyle   = GOLD_LIGHT;
  ctx.shadowBlur  = 0;
  ctx.shadowColor = "transparent";
  ctx.fillText(MV_TEXT, mvTextX, BOX_CY);
  try { (ctx as any).letterSpacing = "0px"; } catch {}

  // ── 4. LEFT PANEL TEXT — v427 uniform 3-line block ───────────────────────
  // Cornelius's review of v426 PSA-hierarchy: he prefers the opposite — all
  // three lines identical in size, weight, colour, spacing. Reference cert
  // is GEODUDE / 1999 FOSSIL / COMMON; "GEODUDE"-comfortable size is the
  // target. Longer-named carts shrink the whole 3-line block proportionally
  // so within a single label every line still matches.
  const textZoneT = MV_HDR_BOT + MV_BELOW_GAP;
  const textZoneH = contentB - textZoneT;

  // Title family drops "Arial Black" so weight 600 (semibold) actually renders
  // as semibold via Arial — "Arial Black" is a single-weight (900) face and
  // would override the requested weight.
  const TXT_FAMILY      = 'Arial, Helvetica, sans-serif';
  const TXT_WEIGHT      = "600";  // was "700" — lighter title per print pass
  const TARGET_SIZE     = 34;     // was 40 — ~15% reduction
  const MIN_SIZE        = 20;     // was 24 — ~15% reduction
  const MIN_GAP_FACTOR  = 0.1;

  // v432 — rarity moves OUT of the white panel and into the bottom strip,
  // so the main block uses the full textZoneH (no RARITY_ZONE_H reservation).
  const mainBlockZoneH = textZoneH;

  // v432 — main block has TWO lines (card name + year+set). Rarity moved
  // into the bottom strip alongside the cert ID (rendered earlier).
  const cardNameText = cert.cardName ? cert.cardName.toUpperCase() : "";
  const yearSetText  = [cert.year, cert.setName ? cert.setName.toUpperCase() : ""]
    .filter(Boolean).join(" ");

  const lines = [cardNameText, yearSetText]
    .filter(s => s.trim().length > 0);

  // Horizontal fit: pick the smallest size that satisfies the widest line.
  let fitSize = TARGET_SIZE;
  for (const line of lines) {
    const sz = fitFontSize(ctx, line, textMaxW, fitSize, MIN_SIZE, TXT_WEIGHT, TXT_FAMILY);
    if (sz < fitSize) fitSize = sz;
  }

  // Vertical fit operates on the rarity-reduced main-block zone so
  // descenders never extend into the rarity line below.
  const requiredHeight = (lines.length * fitSize) + ((lines.length + 1) * fitSize * MIN_GAP_FACTOR);
  if (requiredHeight > mainBlockZoneH) {
    const vScale = mainBlockZoneH / requiredHeight;
    fitSize = Math.max(MIN_SIZE, Math.floor(fitSize * vScale));
  }

  // Even distribution: gaps above first line, between lines, and below
  // last line are all equal — within the rarity-reduced zone.
  ctx.font          = `${TXT_WEIGHT} ${fitSize}px ${TXT_FAMILY}`;
  ctx.fillStyle     = labelFg;
  ctx.textAlign     = "left";
  ctx.textBaseline  = "alphabetic";

  const totalLineHeight = lines.length * fitSize;
  const totalGapSpace   = mainBlockZoneH - totalLineHeight;
  const gapSize         = totalGapSpace / (lines.length + 1);

  for (let i = 0; i < lines.length; i++) {
    const baseline = textZoneT + gapSize * (i + 1) + fitSize * (i + 1);
    ctx.fillText(lines[i], textLeft, baseline);
  }

  // v432 — rarity moved into the bottom strip (rendered earlier alongside
  // the cert ID). Nothing more to draw in the white panel.
}

async function drawBack(ctx: any, cert: CertificateRecord, _logo: any, loadImage: any, _labelBg = WHITE, _labelFg = "#1A1A1A") {
  // ── Layout constants ─────────────────────────────────────────────────────
  const PANEL_X      = I_LEFT;                  // 18
  const PANEL_W      = 58;
  const PANEL_RIGHT  = PANEL_X + PANEL_W;       // 76
  const BANNER_H     = 60;
  const BANNER_BG    = "#1A1A1A";
  const BANNER_MUTED = "#666666";
  const GOLD_MARK    = GOLD_LIGHT;              // #D4AF37
  const INK          = "#1A1A1A";
  const bannerY      = I_TOP;
  const bannerMidY   = I_TOP + BANNER_H / 2;
  const qrSize       = 160;
  const qrX          = I_RIGHT - qrSize;
  const qrY          = I_TOP;
  const centreX      = (PANEL_RIGHT + qrX) / 2;

  // ── 1. WHITE BACKGROUND FILL ─────────────────────────────────────────────
  // Overpaints the inner area white regardless of label variant. The back
  // is uniformly white-bg with dark text + gold accents for both Black
  // Label and Standard variants.
  ctx.fillStyle = WHITE;
  ctx.fillRect(I_LEFT, I_TOP, I_W, I_H);

  // ── 2. BANNER fillRect ───────────────────────────────────────────────────
  // Banner spans from the panel's right edge to I_RIGHT (NOT full inner
  // width) so the gold panel (drawn later, step 4) sits on top of nothing
  // dark and bleeds cleanly into the inner frame.
  ctx.fillStyle = BANNER_BG;
  ctx.fillRect(PANEL_RIGHT, I_TOP, I_RIGHT - PANEL_RIGHT, BANNER_H);

  // ── 3. BANNER TEXT ───────────────────────────────────────────────────────
  // Pre-compute the MVGS mark geometry so the two side texts can centre
  // themselves against the mark's left and right edges (PANEL_RIGHT ↔
  // markRectX for "GRADED UNDER", markRight ↔ qrX for "GRADING STANDARD").
  const markFontSize = 22;
  const markPadX     = 20;
  const markPadY     = 8;
  ctx.save();
  ctx.font = `bold ${markFontSize}px Georgia, "Times New Roman", serif`;
  (ctx as any).letterSpacing = "2px";
  const markTextW = ctx.measureText("MVGS").width;
  ctx.restore();
  const markRectW = Math.round(markTextW + markPadX * 2);
  const markRectH = Math.round(markFontSize + markPadY * 2);
  let markRectX   = Math.round(centreX - markRectW / 2);
  const minMarkX  = Math.round(PANEL_RIGHT + 10);
  if (markRectX < minMarkX) markRectX = minMarkX;
  const markRectY = Math.round(bannerMidY - markRectH / 2);
  const markRight = markRectX + markRectW;
  const markTextX = Math.round(markRectX + markRectW / 2);
  const markTextY = Math.round(markRectY + markPadY + markFontSize * 0.85);

  // Left — "GRADED UNDER" centred between the gold left panel and the
  // MVGS box.
  ctx.save();
  ctx.font = "900 12px Arial, Helvetica, sans-serif";
  (ctx as any).letterSpacing = "1.5px";
  ctx.fillStyle    = "#FFFFFF";
  ctx.textAlign    = "center";
  ctx.textBaseline = "middle";
  // Defensive min clamp: if the MVGS box ever sits flush against the
  // gold panel (markRectX hits the PANEL_RIGHT+10 floor), the corridor
  // midpoint would slide left of the band itself. Force minimum
  // PANEL_RIGHT + 40 so the text always reads inside the band.
  const gradedUnderX = Math.max(
    PANEL_RIGHT + 40,
    Math.round((PANEL_RIGHT + markRectX) / 2),
  );
  ctx.fillText("GRADED UNDER", gradedUnderX, bannerMidY);
  ctx.restore();

  // Centre — MVGS gold-bordered mark. Coordinates are integer-rounded and
  // imageSmoothingEnabled is off so the rect edges and glyph baselines
  // hit whole pixels (no AA fuzz).
  ctx.save();
  (ctx as any).imageSmoothingEnabled = false;
  ctx.font = `bold ${markFontSize}px Georgia, "Times New Roman", serif`;
  (ctx as any).letterSpacing = "2px";
  ctx.strokeStyle = GOLD_MARK;
  ctx.lineWidth   = 3;
  ctx.strokeRect(markRectX, markRectY, markRectW, markRectH);
  ctx.fillStyle   = GOLD_MARK;
  ctx.textAlign   = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("MVGS", markTextX, markTextY);
  ctx.restore();

  // Right — "GRADING STANDARD" centred between the MVGS box right edge
  // and the QR's left edge.
  ctx.save();
  ctx.font = "900 12px Arial, Helvetica, sans-serif";
  (ctx as any).letterSpacing = "1.5px";
  ctx.fillStyle    = "#FFFFFF";
  ctx.textAlign    = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("GRADING STANDARD", Math.round((markRight + qrX) / 2), bannerMidY);
  ctx.restore();

  // ── 4. GOLD PANEL fillRect ───────────────────────────────────────────────
  // Drawn AFTER the banner so the panel cleanly covers the banner's left
  // edge if any rendering drifted. Full inner height — not just below the
  // banner — so the wordmark has the full vertical canvas to centre in.
  ctx.fillStyle = GOLD_LIGHT;
  ctx.fillRect(PANEL_X, I_TOP, PANEL_W, I_BOTTOM - I_TOP);

  // ── 5. MINTVAULT ROTATED TEXT ────────────────────────────────────────────
  ctx.save();
  ctx.translate(PANEL_X + PANEL_W / 2, (I_TOP + I_BOTTOM) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.font = "bold 24px Georgia, 'Times New Roman', serif";
  (ctx as any).letterSpacing = "4px";
  ctx.fillStyle    = INK;
  ctx.textAlign    = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("MINTVAULT", 0, 0);
  ctx.restore();

  // ── 6. URL ───────────────────────────────────────────────────────────────
  ctx.save();
  ctx.font = "bold 26px 'Cinzel', Georgia, 'Times New Roman', serif";
  (ctx as any).letterSpacing = "1.5px";
  ctx.fillStyle    = INK;
  ctx.textAlign    = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("mintvaultuk.com", centreX, I_TOP + BANNER_H + 38);
  ctx.restore();

  // ── 7. TAP NFC TEXT ──────────────────────────────────────────────────────
  ctx.save();
  ctx.font = "bold 20px Georgia, 'Times New Roman', serif";
  (ctx as any).letterSpacing = "1.5px";
  ctx.fillStyle    = INK;
  ctx.textAlign    = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("Tap NFC to verify", centreX, I_BOTTOM - 28);
  ctx.restore();

  // ── 8. QR CODE ───────────────────────────────────────────────────────────
  const certUrl = getCertUrl(cert.certId);
  const qrBuf   = await generateQRBuffer(certUrl, qrSize);
  const qrImg   = await loadImage(qrBuf);
  // White box behind QR — covers the banner in the top-right corner.
  ctx.fillStyle = WHITE;
  ctx.fillRect(qrX, qrY, qrSize, qrSize);
  ctx.drawImage(qrImg, qrX, qrY, qrSize, qrSize);

  // ── 9. CERT NUMBER ───────────────────────────────────────────────────────
  // Right-anchored below the QR, between QR bottom and inner-frame bottom.
  ctx.save();
  const certFontH = 24;
  const certMidY  = Math.round((qrY + qrSize + I_BOTTOM) / 2);
  ctx.textAlign    = "right";
  ctx.textBaseline = "middle";
  const certBackFit = fitFontSize(ctx, cert.certId.replace(/^MV/, ""), qrSize - 8, certFontH, 14);
  ctx.font      = `bold ${certBackFit}px Arial, Helvetica, sans-serif`;
  ctx.fillStyle = INK;
  ctx.fillText(cert.certId.replace(/^MV/, ""), qrX + qrSize - 8, certMidY);
  ctx.restore();

  // ── 10. GOLD FRAME (last) ────────────────────────────────────────────────
  // Painted last so nothing can bleed into the border.
  drawGoldFrame(ctx);

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
