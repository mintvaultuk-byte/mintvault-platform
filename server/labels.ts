import QRCode from "qrcode";
import PDFDocument from "pdfkit";
import type { CertificateRecord, LabelOverride } from "@shared/schema";
import { gradeLabel, gradeLabelFull, isNonNumericGrade } from "@shared/schema";
import path from "path";

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

const PX_W = 827;
const PX_H = 236;
const MM_TO_PT = 2.83465;
const PDF_W = 70 * MM_TO_PT;
const PDF_H = 20 * MM_TO_PT;

const BORDER = 3;
const CUT_STROKE    = 0;   // px — no black cut outline; cut paths provided via SVG cut guide instead
const WHITE_GAP     = 3;   // px — white margin from canvas edge to gold (covers 0→3, meeting gold outer edge)
const BORDER_STROKE = 12;  // px — gold border stroke width
const GOLD_CENTER   = 9;   // px — gold stroke centre from edge; outer edge = 9-6 = 3 (= WHITE_GAP)

// ── Colour palette ──────────────────────────────────────────────────────────
const GOLD       = "#C9A227";   // outer border, separators
const GOLD_DARK  = "#A07820";
const GOLD_LIGHT = "#D4AF37";
const INNER_HL   = "#F3D67A";   // unused — merged into single outer border
const BLACK      = "#000000";
const WHITE      = "#FFFFFF";

// Inner safe edge coordinates (inside gold border)
// gold inner edge = GOLD_CENTER + BORDER_STROKE/2 = 9 + 6 = 15
const I_LEFT   = GOLD_CENTER + BORDER_STROKE / 2;   // 15
const I_RIGHT  = PX_W - I_LEFT;                     // 812
const I_TOP    = I_LEFT;                             // 15
const I_BOTTOM = PX_H - I_LEFT;                     // 221
const I_W      = I_RIGHT - I_LEFT;                   // 797
const I_H      = I_BOTTOM - I_TOP;                   // 198

const LOGO_PATH     = path.join(process.cwd(), "public", "brand", "logo.png");
// White-on-transparent version pre-generated via scripts/process-nfc-icon.js
const NFC_ICON_PATH = path.join(process.cwd(), "public", "brand", "nfc-tap-icon-white.png");

function getCertUrl(certId: string): string {
  return `https://mintvaultuk.co.uk/cert/${certId}`;
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
  weight: string = "bold"
): number {
  for (let s = maxSize; s >= minSize; s--) {
    ctx.font = `${weight} ${s}px Arial, Helvetica, sans-serif`;
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
  return RARITY_DISPLAY[code] || code.replace(/_/g, " ");
}

function buildLine3(cert: CertificateRecord): string {
  const parts: string[] = [];
  const rText = buildRarityText(cert);
  if (rText) parts.push(rText);
  if (cert.labelType && cert.labelType !== "Standard") parts.push(cert.labelType.toUpperCase());
  return parts.join(" · ") || "";
}

function buildLine4(cert: CertificateRecord): string {
  return cert.cardNumber ? `#${cert.cardNumber}` : "";
}

export async function generateLabelPNG(
  cert: CertificateRecord,
  side: "front" | "back"
): Promise<Buffer> {
  const { createCanvas, loadImage } = await import("canvas");

  const canvas = createCanvas(PX_W, PX_H);
  const ctx = canvas.getContext("2d");

  // ── 1. CANVAS BASE — pure #000000 interior fill ──────────────────────────
  // The entire canvas is first filled black. The outer white gap and gold border
  // are then drawn on top. No black detection edge — cuts are provided via the
  // separate SVG cut guide (direct cut mode on ScanNCut CM300).
  ctx.shadowBlur   = 0;
  ctx.shadowColor  = "transparent";
  ctx.fillStyle    = BLACK;
  ctx.fillRect(0, 0, PX_W, PX_H);

  // ── 2. WHITE OUTER MARGIN ──────────────────────────────────────────────────
  // Structure (outside-in): [3px white margin][gold border 12px][content]
  // White strips cover 0→WHITE_GAP from each edge, meeting the gold outer edge at
  // GOLD_CENTER - BORDER_STROKE/2 = 3px. No black detection element at canvas edge.
  const CG = CUT_STROKE;           // 0 — white gap starts flush at canvas edge
  ctx.fillStyle = WHITE;
  ctx.fillRect(CG,           CG,           PX_W - CG * 2, WHITE_GAP); // top gap
  ctx.fillRect(CG,           PX_H - CG - WHITE_GAP, PX_W - CG * 2, WHITE_GAP); // bottom gap
  ctx.fillRect(CG,           CG,           WHITE_GAP,     PX_H - CG * 2); // left gap
  ctx.fillRect(PX_W - CG - WHITE_GAP, CG, WHITE_GAP,     PX_H - CG * 2); // right gap

  // ── 3. INNER BACKGROUND GRADIENT — constrained inside gold border ────────
  // Gradient is drawn only within the content zone (I_LEFT … I_RIGHT ×
  // I_TOP … I_BOTTOM) so the cut-guide and gap zones stay pure #000000.
  const bgGrad = ctx.createLinearGradient(I_LEFT, I_TOP, I_LEFT, I_BOTTOM);
  bgGrad.addColorStop(0, "#0A0A0A"); // near-black top
  bgGrad.addColorStop(1, "#000000"); // pure black bottom
  ctx.fillStyle = bgGrad;
  ctx.fillRect(I_LEFT, I_TOP, I_W, I_H);

  // ── 4. GOLD BORDER — 0.51mm inside the cut guide ────────────────────────
  // strokeRect here is safe: GOLD_CENTER=15 is an integer → no sub-pixel AA.
  ctx.shadowBlur   = 0;
  ctx.shadowColor  = "transparent";
  ctx.strokeStyle  = GOLD_LIGHT;
  ctx.lineWidth    = BORDER_STROKE;
  ctx.strokeRect(GOLD_CENTER, GOLD_CENTER, PX_W - GOLD_CENTER * 2, PX_H - GOLD_CENTER * 2);

  let logo: any = null;
  try {
    logo = await loadImage(LOGO_PATH);
  } catch {}

  if (side === "front") {
    await drawFront(ctx, cert, logo, loadImage);
  } else {
    await drawBack(ctx, cert, logo, loadImage);
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
async function drawFront(ctx: any, cert: CertificateRecord, logo: any, loadImage: any) {
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
  const contentT = I_TOP;                     // 19
  const contentB = stripY;                    // 179
  const contentH = contentB - contentT;       // 160

  // ── 1. CARD ARTWORK BACKGROUND ────────────────────────────────────────────
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
    } catch {}
  }

  // Dark overlay across full inner area (42% opacity)
  ctx.fillStyle = "rgba(0,0,0,0.42)";
  ctx.fillRect(I_LEFT, I_TOP, I_W, I_H);

  // Extra gradient darkening behind left text area for readability
  const lDark = ctx.createLinearGradient(I_LEFT, 0, panelX, 0);
  lDark.addColorStop(0,    "rgba(0,0,0,0.38)");
  lDark.addColorStop(0.70, "rgba(0,0,0,0.18)");
  lDark.addColorStop(1,    "rgba(0,0,0,0.00)");
  ctx.fillStyle = lDark;
  ctx.fillRect(I_LEFT, I_TOP, panelX - I_LEFT, I_H);

  // ── 2. GRADE PANEL (right, above bottom strip) ────────────────────────────
  const panelY  = I_TOP;
  const panelH  = stripY - panelY;            // 160px
  const panelCX = panelX + PANEL_W / 2;
  const DARK    = "#1A1000";

  if (!isNonNum) {
    // Premium 5-stop metallic gold gradient
    const grad = ctx.createLinearGradient(panelX, panelY, panelX, panelY + panelH);
    grad.addColorStop(0,    "#FFF3B0");
    grad.addColorStop(0.25, "#F5D06F");
    grad.addColorStop(0.55, "#D4AF37");
    grad.addColorStop(0.75, "#B8962E");
    grad.addColorStop(1,    "#A67C00");
    ctx.fillStyle = grad;
    ctx.fillRect(panelX, panelY, PANEL_W, panelH);

    // Shine overlay — top 12% gloss
    const shineH = Math.round(panelH * 0.12);
    const shine  = ctx.createLinearGradient(panelX, panelY, panelX, panelY + shineH);
    shine.addColorStop(0,   "rgba(255,255,255,0.35)");
    shine.addColorStop(0.5, "rgba(255,255,255,0.05)");
    shine.addColorStop(1,   "rgba(255,255,255,0)");
    ctx.fillStyle = shine as any;
    ctx.fillRect(panelX, panelY, PANEL_W, shineH);

    // Bottom edge — crisp 3px darker line for depth
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

    // Grade number — dark, large, subtle drop shadow
    const descBot      = cardNumBot + ABBR_TOP_PAD + abbrFontSize;
    const ABBR_NUM_GAP = 6;
    const NUM_BOT_PAD  = 10;
    const numZoneTop   = descBot + ABBR_NUM_GAP;
    const numZoneBot   = stripY - NUM_BOT_PAD;
    const numZoneH     = numZoneBot - numZoneTop;
    const maxByH       = Math.floor(numZoneH / 0.754);
    const gradeFontSize = fitFontSize(ctx, gradeStr, PANEL_W - 8, Math.min(133, maxByH), 48);
    const gradeNumCY   = (numZoneTop + numZoneBot) / 2 + gradeFontSize * 0.024;

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
      ctx.fillStyle = WHITE;
      ctx.fillText("AUTHENTIC", panelCX, panelY + panelH / 2 - 20);
      ctx.font      = `bold 22px Arial, Helvetica, sans-serif`;
      ctx.fillStyle = GOLD;
      ctx.fillText("ALTERED", panelCX, panelY + panelH / 2 + 14);
    } else {
      const authSize = fitFontSize(ctx, "AUTHENTIC", PANEL_W - 8, 30, 18);
      ctx.textBaseline = "middle";
      ctx.font      = `bold ${authSize}px Arial, Helvetica, sans-serif`;
      ctx.fillStyle = WHITE;
      ctx.fillText("AUTHENTIC", panelCX, panelY + panelH / 2);
    }
  }

  // ── 3. BOTTOM STRIP ───────────────────────────────────────────────────────
  // Near-black background, full inner width
  ctx.fillStyle = "#0C0C0C";
  ctx.fillRect(I_LEFT, stripY, I_W, STRIP_H);

  // ── GRADE PANEL cert ID — centred in the grade panel's strip zone ──────────
  {
    const certStripSz  = 28;
    const certStripFit = fitFontSize(ctx, cert.certId, PANEL_W - 14, certStripSz, 14);
    ctx.font         = `bold ${certStripFit}px Arial, Helvetica, sans-serif`;
    ctx.fillStyle    = WHITE;
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor   = "rgba(0, 0, 0, 0.35)";
    ctx.shadowBlur    = 2;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 1;
    ctx.fillText(cert.certId, panelCX, stripY + Math.round(STRIP_H / 2));
    ctx.shadowBlur    = 0;
    ctx.shadowColor   = "transparent";
    ctx.shadowOffsetY = 0;
  }

  // ── 3b. MINTVAULT header — top of label, centred in left panel ─────────────
  // Centred between I_LEFT and panelX (left panel only).
  const MV_HDR_SZ    = 44;                           // bold dominant brand header
  const MV_HDR_PAD   = 8;                            // top padding — vertically centres text in header zone
  const MV_HDR_Y     = contentT + MV_HDR_PAD;        // 19 + 8 = 27  (text top)
  const MV_HDR_BOT   = MV_HDR_Y + MV_HDR_SZ;         // 27 + 44 = 71 (text bottom)
  const MV_BELOW_GAP = 5;                            // gap below MINTVAULT header → tighter top section
  try { (ctx as any).letterSpacing = "2px"; } catch {}
  ctx.font         = `bold ${MV_HDR_SZ}px Arial, Helvetica, sans-serif`;
  ctx.textAlign    = "center";
  ctx.textBaseline = "top";
  const mvCenterX = I_LEFT + Math.round((panelX - I_LEFT) / 2);

  // Gradient text fill — matches grade box gradient exactly
  const mvGrad = ctx.createLinearGradient(0, MV_HDR_Y, 0, MV_HDR_BOT);
  mvGrad.addColorStop(0,    "#FFF3B0");
  mvGrad.addColorStop(0.25, "#F5D06F");
  mvGrad.addColorStop(0.55, "#D4AF37");
  mvGrad.addColorStop(0.75, "#B8962E");
  mvGrad.addColorStop(1,    "#A67C00");
  ctx.fillStyle        = mvGrad;
  ctx.shadowColor      = "rgba(255, 215, 0, 0.25)";
  ctx.shadowBlur       = 6;
  ctx.shadowOffsetX    = 0;
  ctx.shadowOffsetY    = 0;
  ctx.fillText("MINTVAULT", mvCenterX, MV_HDR_Y);
  ctx.shadowBlur       = 0;
  ctx.shadowColor      = "transparent";
  try { (ctx as any).letterSpacing = "0px"; } catch {}

  // ── Gradient side lines flanking MINTVAULT ────────────────────────────────
  // Measure text width + manual letter-spacing contribution (8 gaps × 3px)
  const mvTextW    = ctx.measureText("MINTVAULT").width + 8 * 3;
  const mvHalf     = mvTextW / 2;
  const LINE_GAP   = 8;    // gap between text edge and solid-gold line end
  const LINE_PAD   = 28;   // inset from left/right panel edges — extended for print visibility
  const lineY      = MV_HDR_Y + MV_HDR_SZ / 2;  // vertical centre of header text

  // Left line — pill gradient: transparent → solid (20%) → bright centre → solid (80%) → transparent
  const llNearX = mvCenterX - mvHalf - LINE_GAP;
  const llFarX  = I_LEFT + LINE_PAD;
  if (llNearX > llFarX) {
    const llGrad = ctx.createLinearGradient(llNearX, lineY, llFarX, lineY);
    llGrad.addColorStop(0,    "rgba(212,175,55,0)");   // inner end — fade to transparent
    llGrad.addColorStop(0.20, "rgba(225,188,62,1)");   // solid gold starts
    llGrad.addColorStop(0.50, "rgba(255,235,110,1)");  // bright centre
    llGrad.addColorStop(0.80, "rgba(225,188,62,1)");   // solid gold ends
    llGrad.addColorStop(1,    "rgba(212,175,55,0)");   // outer end — fade to transparent
    ctx.strokeStyle = llGrad;
    ctx.lineWidth   = 7;
    ctx.beginPath();
    ctx.moveTo(llNearX, lineY);
    ctx.lineTo(llFarX, lineY);
    ctx.stroke();
  }

  // Right line — pill gradient: transparent → solid (20%) → bright centre → solid (80%) → transparent
  const rlNearX = mvCenterX + mvHalf + LINE_GAP;
  const rlFarX  = panelX - LINE_PAD;
  if (rlFarX > rlNearX) {
    const rlGrad = ctx.createLinearGradient(rlNearX, lineY, rlFarX, lineY);
    rlGrad.addColorStop(0,    "rgba(212,175,55,0)");   // inner end — fade to transparent
    rlGrad.addColorStop(0.20, "rgba(225,188,62,1)");   // solid gold starts
    rlGrad.addColorStop(0.50, "rgba(255,235,110,1)");  // bright centre
    rlGrad.addColorStop(0.80, "rgba(225,188,62,1)");   // solid gold ends
    rlGrad.addColorStop(1,    "rgba(212,175,55,0)");   // outer end — fade to transparent
    ctx.strokeStyle = rlGrad;
    ctx.lineWidth   = 7;
    ctx.beginPath();
    ctx.moveTo(rlNearX, lineY);
    ctx.lineTo(rlFarX, lineY);
    ctx.stroke();
  }

  // ── 4. LEFT PANEL TEXT ────────────────────────────────────────────────────
  // Card text centred in zone below MINTVAULT header.
  // Cert ID is drawn separately in the strip at the bottom.
  const textZoneT = MV_HDR_BOT + MV_BELOW_GAP;       // 71 + 6 = 77
  const textZoneH = contentB - textZoneT;             // 179 - 77 = 102

  // ── Font size constants (hierarchy: 43 / 29 / 25) ────────────────────────
  const SZ_NM  = 43;   // Line 1: Card Name  — hero, bold
  const SZ_YS  = 29;   // Line 2: Year + Set
  const SZ_VAR = 29;   // Line 3: Variant — same weight as set line
  const LG     = 2;    // inner line gap (−8% for tighter compact block)
  const DIM    = "rgba(255,255,255,0.85)";

  // Line 1 — Card Name (hero, scales 36→26px before wrapping)
  const cardNameText = cert.cardName ? cert.cardName.toUpperCase() : "";
  ctx.font = `bold ${SZ_NM}px Arial, Helvetica, sans-serif`;
  let nameSz = SZ_NM;
  if (cardNameText && ctx.measureText(cardNameText).width > textMaxW) {
    nameSz = fitFontSize(ctx, cardNameText, textMaxW, SZ_NM, 28, "bold");
  }
  ctx.font = `bold ${nameSz}px Arial, Helvetica, sans-serif`;
  const nmLines = cardNameText ? wrapText(ctx, cardNameText, textMaxW, 2) : [];

  // Line 2 — Year + Set Name (no language tag)
  const yearSetText = [cert.year, cert.setName ? cert.setName.toUpperCase() : ""]
    .filter(Boolean).join("  ");
  ctx.font = `bold ${SZ_YS}px Arial, Helvetica, sans-serif`;
  const ysLines = balancedWrap(ctx, yearSetText, textMaxW);

  // Line 3 — Variant (only if present)
  const variantText = buildVariantLine(cert);
  ctx.font = `bold ${SZ_VAR}px Arial, Helvetica, sans-serif`;
  const varLines = variantText ? wrapText(ctx, variantText.toUpperCase(), textMaxW, 1) : [];

  // ── VERTICAL CENTERING CALC ───────────────────────────────────────────────
  function lh(sz: number, n: number): number { return n > 0 ? n * sz + (n - 1) * LG : 0; }

  const G_NM_YS  = 3;   // Card Name → Year+Set gap
  const G_YS_VAR = 3;   // Year+Set → Variant gap

  const stackH =
      lh(nameSz, nmLines.length)
    + (nmLines.length > 0 && ysLines.length > 0 ? G_NM_YS  : 0)
    + lh(SZ_YS,  ysLines.length)
    + (ysLines.length > 0 && varLines.length > 0 ? G_YS_VAR : 0)
    + lh(SZ_VAR, varLines.length);

  // Centre the text stack with a slight upward bias — tighter header gap, more breathing room below
  const TOP_BIAS = 3;
  let curY = textZoneT + Math.max(0, Math.round((textZoneH - stackH) / 2) - TOP_BIAS);

  // ── RENDER ────────────────────────────────────────────────────────────────
  ctx.textAlign    = "left";
  ctx.textBaseline = "top";

  const renderBlock = (lines: string[], sz: number, weight: string, color: string) => {
    if (!lines.length) return;
    ctx.font      = `${weight} ${sz}px Arial, Helvetica, sans-serif`;
    ctx.fillStyle = color;
    for (const line of lines) {
      ctx.fillText(line, textLeft, curY);
      curY += sz + LG;
    }
    curY -= LG;
  };

  renderBlock(nmLines, nameSz, "bold",   WHITE);
  if (nmLines.length && ysLines.length) curY += G_NM_YS;
  try { (ctx as any).letterSpacing = "0.5px"; } catch {}
  renderBlock(ysLines, SZ_YS,  "bold",   WHITE);
  try { (ctx as any).letterSpacing = "0px"; } catch {}
  if (ysLines.length && varLines.length) curY += G_YS_VAR;
  try { (ctx as any).letterSpacing = "0.5px"; } catch {}
  renderBlock(varLines, SZ_VAR, "bold", WHITE);
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

async function drawBack(ctx: any, cert: CertificateRecord, logo: any, loadImage: any) {
  // ── QR CODE — top-right corner, flush to inner gold borders ──────────────
  // Clean white background, no border, no framing — high contrast for scanning.
  const qrSize = 150;
  const qrPad  = 5;                          // quiet-zone padding on left & bottom
  const qrY    = I_TOP;                      // flush to top inner border
  const qrX    = I_RIGHT - qrSize;           // flush to right inner border
  const qrCenterX = qrX + qrSize / 2;       // 737

  // White box: top & right flush to inner borders; 5px pad on left & bottom
  const wbLeft   = qrX - qrPad;             // 657
  const wbTop    = I_TOP;                   // 15
  const wbW      = qrSize + qrPad;          // 155
  const wbH      = qrSize + qrPad;          // 155
  const wbBottom = wbTop + wbH;             // 170

  // Cert ID: positioned below white box with deliberate top padding.
  // Font cap raised to 30px (+20% vs 25px) to match front label visual weight.
  // certTopGap ensures clear breathing room between QR base and text cap-height.
  const certFontH  = 30;
  const certTopGap = 14;                                              // px gap from wbBottom to text top
  const certMidY   = wbBottom + certTopGap + Math.round(certFontH / 2); // 170 + 14 + 15 = 199

  // Left edge of the QR zone (used for NFC_ICON_CX midpoint calculation below)
  const gfLeft = wbLeft;                    // 657 — alias kept for layout calc

  const certUrl = getCertUrl(cert.certId);
  const qrBuf   = await generateQRBuffer(certUrl, qrSize);
  const qrImg   = await loadImage(qrBuf);

  // White box
  ctx.fillStyle = WHITE;
  ctx.fillRect(wbLeft, wbTop, wbW, wbH);

  // QR image on white background
  ctx.drawImage(qrImg, qrX, qrY, qrSize, qrSize);

  // Cert ID — white, readable on dark background below the white box
  ctx.textAlign    = "center";
  ctx.textBaseline = "middle";
  const certBackFit = fitFontSize(ctx, cert.certId, wbW - 8, certFontH, 14);
  ctx.font          = `bold ${certBackFit}px Arial, Helvetica, sans-serif`;
  ctx.fillStyle     = WHITE;
  ctx.shadowColor   = "rgba(0, 0, 0, 0.35)";  // matches front label cert ID shadow exactly
  ctx.shadowBlur    = 2;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 1;
  ctx.fillText(cert.certId, qrCenterX, certMidY);
  ctx.shadowBlur    = 0;
  ctx.shadowColor   = "transparent";
  ctx.shadowOffsetY = 0;

  // ── THREE-ZONE LAYOUT ────────────────────────────────────────────
  //
  //   LEFT   — Logo        : 240×240px, centred vertically — ~29% of label width
  //   CENTRE — NFC + txt   : NFC_ICON_CX = midpoint of (logo-right … qr-left)
  //   RIGHT  — QR code     : unchanged (150px, flush top-right)
  //
  // Logo uses source-over blend (logo PNG has transparent background —
  // screen blend was incorrectly hiding most of the graphic).
  const LOGO_DRAW    = 240;                        // px — 29% of PX_W=827 ✓ (user target: 25–30%)
  const LOGO_LX      = I_LEFT + 4;                // 19px — tight to left gold border
  const NFC_ICON_CX  = Math.round((LOGO_LX + LOGO_DRAW + gfLeft) / 2); // midpoint of (logo-right … gold-frame-left)

  // ── LEFT: MintVault logo — primary visual anchor (transparent PNG, source-over) ──
  if (logo) {
    const aspect = logo.width / logo.height;
    let drawH = LOGO_DRAW;
    let drawW = Math.round(drawH * aspect);
    const lx = LOGO_LX;
    const ly = Math.round((PX_H - drawH) / 2);    // vertically centred in full canvas

    // source-over: logo PNG has a transparent background — renders cleanly against
    // the dark label. No screen blend needed (and screen was incorrectly fading the graphic).
    ctx.drawImage(logo, lx, ly, drawW, drawH);

    // Redraw gold border on top to ensure logo never bleeds into the frame.
    ctx.shadowBlur  = 0;
    ctx.shadowColor = "transparent";
    ctx.strokeStyle = GOLD_LIGHT;
    ctx.lineWidth   = BORDER_STROKE;
    ctx.strokeRect(GOLD_CENTER, GOLD_CENTER, PX_W - GOLD_CENTER * 2, PX_H - GOLD_CENTER * 2);
  }

  // ── CENTRE TOP: website URL — full gradient + glow matching front MINTVAULT ─────
  {
    const urlY    = I_TOP + 24;
    const urlSz   = 38;
    const urlGrad = ctx.createLinearGradient(0, urlY - urlSz / 2, 0, urlY + urlSz / 2);
    urlGrad.addColorStop(0,    "#FFF3B0");
    urlGrad.addColorStop(0.25, "#F5D06F");
    urlGrad.addColorStop(0.55, "#D4AF37");
    urlGrad.addColorStop(0.75, "#B8962E");
    urlGrad.addColorStop(1,    "#A67C00");
    (ctx as any).letterSpacing = "1.5px";
    ctx.font             = `bold ${urlSz}px Arial, Helvetica, sans-serif`;
    ctx.fillStyle        = urlGrad;
    ctx.textAlign        = "center";
    ctx.textBaseline     = "middle";
    ctx.shadowColor      = "rgba(255, 215, 0, 0.25)";
    ctx.shadowBlur       = 6;
    ctx.shadowOffsetX    = 0;
    ctx.shadowOffsetY    = 0;
    ctx.fillText("mintvaultuk.com", NFC_ICON_CX, urlY);
    ctx.shadowBlur       = 0;
    ctx.shadowColor      = "transparent";
  }

  // ── CENTRE BOTTOM: tap instruction — full gradient + glow matching front MINTVAULT ────
  {
    const nfcY    = I_BOTTOM - 31;
    const nfcSz   = 34;
    const nfcGrad = ctx.createLinearGradient(0, nfcY - nfcSz / 2, 0, nfcY + nfcSz / 2);
    nfcGrad.addColorStop(0,    "#FFF3B0");
    nfcGrad.addColorStop(0.25, "#F5D06F");
    nfcGrad.addColorStop(0.55, "#D4AF37");
    nfcGrad.addColorStop(0.75, "#B8962E");
    nfcGrad.addColorStop(1,    "#A67C00");
    (ctx as any).letterSpacing = "1.5px";
    ctx.font             = `bold ${nfcSz}px Arial, Helvetica, sans-serif`;
    ctx.fillStyle        = nfcGrad;
    ctx.textAlign        = "center";
    ctx.textBaseline     = "middle";
    ctx.shadowColor      = "rgba(255, 215, 0, 0.25)";
    ctx.shadowBlur       = 6;
    ctx.shadowOffsetX    = 0;
    ctx.shadowOffsetY    = 0;
    ctx.fillText("Tap NFC to verify", NFC_ICON_CX - 12, nfcY);
    ctx.shadowBlur       = 0;
    ctx.shadowColor      = "transparent";
  }

  // ── CENTRE MIDDLE: NFC icon — 100px (secondary element; −20% from 126px) ──
  const iconSz = 100;
  try {
    const nfcImg = await loadImage(NFC_ICON_PATH);
    ctx.drawImage(
      nfcImg,
      NFC_ICON_CX - Math.round(iconSz / 2),
      Math.round(PX_H / 2) - Math.round(iconSz / 2),
      iconSz,
      iconSz,
    );
  } catch {
    drawContactlessIcon(ctx, NFC_ICON_CX, Math.round(PX_H / 2), iconSz / 5, WHITE);
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
