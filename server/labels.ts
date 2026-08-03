import QRCode from "qrcode";
import PDFDocument from "pdfkit";
import type { CertificateRecord, LabelOverride } from "@shared/schema";
import { gradeLabelFull, isNonNumericGrade } from "@shared/schema";
import { computeMvgsScore, mvgsTierName } from "@shared/mvgs-scoring";
import { isPristine } from "@shared/pristine";
import { assertPrintableGrade, parseStoredGrade, UnprintableGradeError } from "@shared/printable-grade";
import { formatVariantLine, CONSOLIDATED_VARIANT_SCHEME } from "@shared/variant-line";
import path from "path";
import { readFileSync, statSync, type Stats } from "fs";
import { createHash } from "crypto";
import { APP_BASE_URL } from "./app-url";

/**
 * Merge label_overrides into a certificate record before rendering.
 * Only display fields are overridden — grade, certId, and QR are untouched.
 */
export function applyLabelOverrides(cert: CertificateRecord, override: LabelOverride | null): CertificateRecord {
  if (!override) return cert;
  return {
    ...cert,
    ...(override.cardNameOverride != null ? { cardName: override.cardNameOverride } : {}),
    ...(override.setOverride != null ? { setName: override.setOverride } : {}),
    // The variant override is an EXPLICIT operator instruction for this label, so
    // it must win even on a consolidated (v2) certificate — where the structured
    // line would otherwise ignore the legacy `variant` column this override writes
    // through. The marker lets consolidatedVariantForLabel tell "operator typed
    // this for the label" apart from "an incidental legacy column".
    ...(override.variantOverride != null ? { variant: override.variantOverride, __variantOverridden: true } : {}),
    ...(override.languageOverride != null ? { language: override.languageOverride } : {}),
    ...(override.yearOverride != null ? { year: override.yearOverride } : {}),
  };
}

// v424 — slab cutout is 70×20mm (was 72×22mm). Canvas pixel dims recomputed
// from new physical size at 300 DPI. Most internal layout constants are
// derived from PX_W/PX_H (I_RIGHT, I_BOTTOM, panelX, stripY etc.) and so
// re-flow automatically; absolute font sizes stay put — they occupy a
// slightly larger fraction of the smaller canvas which compensates for
// the loss of physical real estate.
const PX_W = 826; // 70mm × 300 DPI / 25.4
const PX_H = 236; // 20mm × 300 DPI / 25.4
const MM_TO_PT = 2.83465;
const PDF_W = 70 * MM_TO_PT;
const PDF_H = 20 * MM_TO_PT;

// ── Border geometry ────────────────────────────────────────────────────────
// Gold frame fills from canvas edge inward FRAME_W pixels — no white gap.
const FRAME_W = 18; // px — gold border fill width (outer edge = canvas edge)

// ── Colour palette ──────────────────────────────────────────────────────────
const GOLD_DARK = "#A07820";
const GOLD_LIGHT = "#D4AF37";
const BLACK = "#000000";
const WHITE = "#FFFFFF";

// ── Holographic-paper mode (founder-approved design) ──────────────────────
// Slab inserts print on holographic (silver/rainbow) stock. The office printer
// has NO white ink, so anywhere the artwork is WHITE (#FFFFFF) it lays no ink
// and the holographic paper shows through — that IS the shimmer. The design
// leans into that: the BORDER and ALL lettering/numbers are drawn WHITE, so
// they print as nothing and shimmer on the paper; the label backgrounds are
// printed ink (warm gold #c18e22 on the standard label, jet black on the
// Pristine label); the QR is printed black on a solid printable light colour
// (silver #CFCFCF on black, gold on the gold label) so it stays scannable with
// no shimmer behind it. No black banners; no faint separator lines.
//
// On an on-screen preview (admin) the holographic areas will look WHITE, not
// rainbow — the shimmer only appears on the physical holographic paper.
//
// Toggle with the LABEL_HOLOGRAPHIC env/secret: "1" = holographic design,
// unset/"0" = the original white-paper rendering (byte-for-byte unchanged).
// Fully reversible with one secret flip + redeploy.
const HOLOGRAPHIC_PAPER = process.env.LABEL_HOLOGRAPHIC === "1";
// Warm gold printed on the standard (non-Pristine) label in holographic mode.
const HOLO_GOLD = "#c18e22";
// Printable light background behind the QR on the BLACK/Pristine label (no
// white ink available). Silver reads clean against black + hologram and keeps
// QR contrast. Nudge darker (e.g. "#C2C2C2") if a test scan is marginal.
const HOLO_QR_SILVER = "#CFCFCF";

// v424 — frame gradient removed in favour of a flat GOLD fill. The diagonal
// 5-stop gradient looked rich on screen but printed muddy on label stock and
// fought with the wordmark/grade panel readability.

// Inner safe edge coordinates (inside gold frame)
const I_LEFT = FRAME_W; // 18
const I_RIGHT = PX_W - FRAME_W; // 832
const I_TOP = FRAME_W; // 18
const I_BOTTOM = PX_H - FRAME_W; // 242
const I_W = I_RIGHT - I_LEFT; // 814
const I_H = I_BOTTOM - I_TOP; // 224

const LOGO_PATH = path.join(process.cwd(), "public", "brand", "logo.png");
const NFC_ICON_PATH = path.join(process.cwd(), "public", "brand", "nfc-tap-icon.png");
const BRAND_DIR = path.join(process.cwd(), "public", "brand");
const BODONI_PATH = path.join(BRAND_DIR, "BodoniModa-Black.ttf");
const FONT_DIR = path.join(BRAND_DIR, "fonts");

/**
 * DETERMINISTIC FONT RESOLUTION — the label is a physical product, so its glyphs must not
 * depend on which fonts happen to be installed on the host.
 *
 * THE DEFECT (found 2026-07-29): the font stacks below name `Arial`, `Helvetica`, `Georgia`
 * and `Times New Roman`, but only "Bodoni Moda" was ever registered. Everything else was
 * resolved by the host's fontconfig, so the SAME certificate rendered differently per machine:
 *
 *   macOS dev      Arial -> /System/.../Arial.ttf      (Monotype, licensed to Apple)
 *   Fly production Arial -> DejaVuSans.ttf             (the ONLY 6 font files in the image,
 *                                                       pulled in transitively by libpango)
 *
 * The slabs customers actually hold are therefore rendered in DejaVu, NOT Arial — and the
 * production image installs no font package explicitly, so a future base-image rebuild could
 * silently change the typeface on a physical product.
 *
 * THE FIX: bundle the exact faces production already resolves to and register them under the
 * family names the renderer asks for. Arial and Georgia cannot be bundled (proprietary
 * Monotype faces, not redistributable), so the deterministic target is the one that is BOTH
 * freely licensed AND already the live production rendering: DejaVu. Every environment now
 * renders exactly what production renders today — the physical product is unchanged, and it
 * can no longer drift.
 *
 * Nothing about layout, metrics, sizes, spacing, centring, QR/NFC placement or grade text is
 * touched: only WHERE the glyphs come from.
 */
/**
 * PRIVATE family names, deliberately not the names of any real installed font.
 *
 * A registered face CANNOT shadow a host font of the same name — measured on macOS, where
 * registering a bundled file as "Arial" left rendering byte-identical to the system Arial
 * (hash 745250a02438 before AND after), while the same file under a novel family took effect
 * immediately (1433512364f0). Aliasing therefore cannot deliver determinism; only a family
 * name no host can supply can. These three names are what the stacks below now request, so
 * the bundled file is the ONLY possible resolution on every platform.
 */
/**
 * CJK fallback family (hostile-review N3).
 *
 * The Latin faces below cover no Japanese, so a Japanese card name previously fell through to
 * whatever the HOST had — it rendered differently once the bundled Latin faces were introduced,
 * and still changed when the image's fonts were removed. MintVault grades Japanese cards, so
 * that is a real determinism hole on a physical product.
 *
 * The bundled face is the EXACT one production resolves today (`fc-match :lang=ja` in a replica
 * of the Dockerfile's production stage → DroidSansFallbackFull.ttf), so bundling it preserves
 * the current Japanese appearance rather than restyling it.
 *
 * It is appended AFTER the Latin family in every stack, so Latin glyphs still come from
 * Nimbus/DejaVu byte-for-byte and only uncovered code points reach it.
 */
export const MV_CJK = '"MV Slab CJK"';

export const MV_SANS = `"MV Slab Sans", ${MV_CJK}`;
export const MV_SERIF = `"MV Slab Serif", ${MV_CJK}`;
export const MV_MONO = `"MV Slab Mono", ${MV_CJK}`;
/** `"Arial Black", Arial, sans-serif` resolves to a DIFFERENT face in production than plain
 *  `Arial` does (DejaVu Sans Bold, not Nimbus Sans Bold), so it gets its own family rather
 *  than being folded into MV_SANS — folding them would silently restyle the claim insert. */
export const MV_BLACK = `"MV Slab Black", ${MV_CJK}`;

/**
 * The bundled faces are EXACTLY the ones the production image resolves today, so bundling
 * them changes no pixel of the physical product — it only stops the resolution being an
 * accident of whatever the base image happens to ship. Measured with `fc-match` inside a
 * faithful replica of the Dockerfile's production stage (45 font files, from libvips/librsvg
 * pulling in fonts-urw-base35 + fonts-droid-fallback + fonts-noto-mono):
 *
 *   Arial / Helvetica            -> NimbusSans-Regular.otf      (URW Helvetica clone)
 *   Arial:bold                   -> NimbusSans-Bold.otf
 *   "Arial Black"                -> DejaVuSans-Bold.ttf         (a DIFFERENT face — see MV_BLACK)
 *   Georgia                      -> DejaVuSerif.ttf / -Bold.ttf
 *   'Courier New' / Courier      -> NimbusMonoPS-Regular.otf / -Bold.otf
 *   :lang=ja (CJK fallback)      -> DroidSansFallbackFull.ttf   (see MV_CJK)
 *
 * All are freely redistributable (DejaVu: Bitstream Vera/public-domain terms; URW base35:
 * AFPL/GPL with font exception, as shipped by Debian's fonts-urw-base35; Droid Sans Fallback:
 * Apache-2.0, licence text committed alongside it as DroidSansFallback-LICENSE.txt).
 *
 * WEIGHTS: registering `normal` + `bold` is sufficient and correct. node-canvas resolves every
 * numeric weight >= 600 to the registered bold face — measured on this exact pair:
 *   normal/400 -> 603.1611   600/700/bold/800/900 -> 610.2832
 * which is the same normal-vs-bold split production's fontconfig produces. No call site's
 * weight literal changes, so `600` on the rarity strip and `900` on the band still draw bold
 * exactly as they always have.
 */
const BUNDLED_FACES: ReadonlyArray<{ file: string; family: string; weight: string }> = [
  { file: "NimbusSans-Regular.otf", family: "MV Slab Sans", weight: "normal" },
  { file: "NimbusSans-Bold.otf", family: "MV Slab Sans", weight: "bold" },
  { file: "DejaVuSerif.ttf", family: "MV Slab Serif", weight: "normal" },
  { file: "DejaVuSerif-Bold.ttf", family: "MV Slab Serif", weight: "bold" },
  // `"Arial Black"` resolves to DejaVu Sans Bold in production, NOT to the Nimbus sans above.
  { file: "DejaVuSans.ttf", family: "MV Slab Black", weight: "normal" },
  { file: "DejaVuSans-Bold.ttf", family: "MV Slab Black", weight: "bold" },
  // The claim insert (server/claim-insert.ts) prints on the SAME physical sheet and had the
  // same defect, so its mono face is registered here too — one registration point for
  // everything that reaches paper.
  { file: "NimbusMonoPS-Regular.otf", family: "MV Slab Mono", weight: "normal" },
  { file: "NimbusMonoPS-Bold.otf", family: "MV Slab Mono", weight: "bold" },
  // CJK fallback — last, so it is only consulted for code points the Latin faces lack.
  { file: "DroidSansFallbackFull.ttf", family: "MV Slab CJK", weight: "normal" },
  { file: "DroidSansFallbackFull.ttf", family: "MV Slab CJK", weight: "bold" },
];

/**
 * CRYPTOGRAPHIC INTEGRITY MANIFEST for every bundled face (hostile-review N2).
 *
 * An existence check is not enough. A CORRUPT, ZERO-BYTE or UNREADABLE file passes
 * `existsSync`, `registerFont` then fails, and the render silently falls back to host fonts —
 * measured: a valid label hashed 9efe0f6669d3a022, the same label with one corrupted face
 * hashed 87b58cc65f474b2f, with no error raised. A different typeface on a physical product,
 * silently. Substituting a DIFFERENT valid font under an expected filename is the same class
 * and would also have passed.
 *
 * Size and SHA-256 are therefore verified before any registration. These values are a
 * reviewed, immutable constant: they are never computed from the files at runtime, so the
 * table cannot "self-heal" around a tampered asset. `tests/label-font-integrity.test.ts`
 * asserts that property directly.
 */
export const BUNDLED_FONT_MANIFEST: ReadonlyArray<{ file: string; bytes: number; sha256: string; dir?: string }> = [
  {
    file: "DejaVuSans-Bold.ttf",
    bytes: 708920,
    sha256: "0d977336a6d5fba34eab8e3199eb218327161b5143749f802982c2bc34df0c96",
  },
  { file: "DejaVuSans.ttf", bytes: 759720, sha256: "abdc775b21b1bc470d50c97e790d276f2054b7504e56e5bd3e64f48d68582322" },
  {
    file: "DejaVuSerif-Bold.ttf",
    bytes: 356668,
    sha256: "e2fd85eba2de65ac270d1cdb1685e252eb827f600850cf62af2d20c41b22e945",
  },
  {
    file: "DejaVuSerif.ttf",
    bytes: 380660,
    sha256: "13e61509f5c81d7c3132810f4f903e3523df89c802bf6e0674621e8f659cdfe1",
  },
  {
    file: "DroidSansFallbackFull.ttf",
    bytes: 4033420,
    sha256: "acb6440a713d880a13a21b468ba7cd43f5a2b2934972e51be791c880730777b8",
  },
  {
    file: "NimbusMonoPS-Bold.otf",
    bytes: 87520,
    sha256: "f036d05d2168c7f71cb11d31e81d11133f3d09711e24ebde19d08a24842384d5",
  },
  {
    file: "NimbusMonoPS-Regular.otf",
    bytes: 77936,
    sha256: "4f225ca8e13acb16f733ce741693105e527d5f7a5443901b9ecc190fca4e149b",
  },
  {
    file: "NimbusSans-Bold.otf",
    bytes: 83264,
    sha256: "7f33328e6b4d4cd21b45fa625791928c9407dc702db6780e56b09ca9a3ecaa67",
  },
  {
    file: "NimbusSans-Regular.otf",
    bytes: 82264,
    sha256: "7c25be4d78155523080ab85b10277150657ff7dabbcad7037bdd536c9b6d0d08",
  },
  /**
   * The MintVault WORDMARK face, registered by the same block as the faces above and therefore
   * needing the same protection (gap found in the final landing review, 2026-07-29).
   *
   * It was registered but never verified, so a corrupt or missing file registered SILENTLY —
   * measured — and the "MINTVAULT" lockup on the front label fell back to MV_SERIF (DejaVu
   * Serif). That is the exact N2 failure mode this manifest exists to stop: a different
   * typeface on a physical product, with no error raised.
   *
   * It lives alongside the other brand assets rather than in the fonts/ directory, so it
   * carries an explicit `dir`. Nothing about registration or rendering changes.
   */
  {
    file: "BodoniModa-Black.ttf",
    dir: BRAND_DIR,
    bytes: 44832,
    sha256: "2047983e15e97af62ab1907c714a5a6292ea599319f109d1aabd8a9878470ef8",
  },
];

/** Thrown when a bundled font is absent, the wrong size, or does not match its manifest hash. */
export class BundledFontIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundledFontIntegrityError";
  }
}

/**
 * Verify every bundled face against the manifest. Throws before a single glyph is drawn.
 * Deliberately does NOT depend on `registerFont` raising — node-canvas does not reliably do so.
 */
function verifyBundledFonts(): void {
  for (const entry of BUNDLED_FONT_MANIFEST) {
    // Most faces live in fonts/; the wordmark sits one level up with the other brand assets.
    const file = path.join(entry.dir ?? FONT_DIR, entry.file);
    let stat: Stats;
    try {
      stat = statSync(file);
    } catch {
      throw new BundledFontIntegrityError(
        `Bundled label font missing: ${entry.file}. Label rendering would fall back to host fonts ` +
          `and print a different typeface — refusing. Check public/brand/fonts/ is deployed.`
      );
    }
    if (!stat.isFile() || stat.size !== entry.bytes) {
      throw new BundledFontIntegrityError(
        `Bundled label font ${entry.file} is ${stat.isFile() ? `${stat.size} bytes, expected ${entry.bytes}` : "not a regular file"} — refusing to render.`
      );
    }
    let digest: string;
    try {
      digest = createHash("sha256").update(readFileSync(file)).digest("hex");
    } catch (err) {
      throw new BundledFontIntegrityError(
        `Bundled label font ${entry.file} could not be read (${(err as Error).message}) — refusing to render.`
      );
    }
    if (digest !== entry.sha256) {
      throw new BundledFontIntegrityError(
        `Bundled label font ${entry.file} failed its integrity check (sha256 ${digest.slice(0, 16)}…, ` +
          `expected ${entry.sha256.slice(0, 16)}…). The typeface on a printed slab would change — refusing to render.`
      );
    }
  }
}

/**
 * Registration must COMPLETE before the first glyph is drawn. The previous code fired a
 * floating `import("canvas").then(registerFont)` at module load and awaited nothing, so a
 * render starting in the same tick could draw with the font not yet registered — a real
 * nondeterminism source independent of the host-font one. This is awaited by every renderer
 * and memoised, so it runs exactly once per process and is a no-op thereafter.
 */
let fontRegistration: Promise<void> | null = null;
export function ensureFontsRegistered(): Promise<void> {
  fontRegistration ??= import("canvas")
    .then(({ registerFont }) => {
      // INTEGRITY FIRST — before any registration, so a corrupt, truncated, unreadable or
      // substituted face can never reach the renderer (N2).
      verifyBundledFonts();
      // Bodoni Moda — unchanged from before, still the MintVault wordmark face.
      registerFont(BODONI_PATH, { family: "Bodoni Moda", weight: "900" });
      for (const f of BUNDLED_FACES) {
        registerFont(path.join(FONT_DIR, f.file), { family: f.family, weight: f.weight });
      }
    })
    .catch((err) => {
      // A FONT INTEGRITY FAILURE must never be swallowed — that is the silent fallback this
      // whole mechanism exists to prevent, so it is re-thrown and stops the render.
      if (err instanceof BundledFontIntegrityError) {
        fontRegistration = null; // let a later call retry rather than cache the failure
        throw err;
      }
      // Anything else means the canvas module itself is unavailable in this build context
      // (it is imported dynamically). Rendering cannot proceed either way and fails loudly
      // at its own `await import("canvas")`, so nothing is hidden by returning here.
    });
  return fontRegistration;
}

function getCertUrl(certId: string): string {
  return `${APP_BASE_URL}/vault/${certId}`;
}

async function generateQRBuffer(url: string, size: number, light: string = WHITE): Promise<Buffer> {
  return await QRCode.toBuffer(url, {
    type: "png",
    width: size,
    margin: 1,
    errorCorrectionLevel: "M",
    // Dark modules always black; light modules default WHITE (unchanged), or a
    // printable light colour in holographic mode so the QR stays scannable.
    color: { dark: BLACK, light },
  });
}

function fitFontSize(
  ctx: any,
  text: string,
  maxWidth: number,
  maxSize: number,
  minSize: number,
  weight: string = "bold",
  family: string = MV_SANS
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

  if (splitAt === 0) return [truncateText(ctx, text, maxWidth)];
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
  let bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const w1 = ctx.measureText(words.slice(0, i).join(" ")).width;
    const w2 = ctx.measureText(words.slice(i).join(" ")).width;
    const diff = Math.abs(w1 - w2);
    if (diff < bestDiff && w1 <= maxWidth && w2 <= maxWidth) {
      bestDiff = diff;
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
  CLASSIC_COLLECTION: "CLASSIC COLLECTION",
  COLLECTION_GENERIC: "COLLECTION",
  BLACK_STAR_PROMO: "BLACK STAR PROMO",
  PROMO_GENERIC: "PROMO",
  FIRST_EDITION: "1ST EDITION",
  UNLIMITED: "UNLIMITED",
  SHADOWLESS: "SHADOWLESS",
  FOURTH_PRINT: "4TH PRINT",
  NO_RARITY_SYMBOL: "NO RARITY SYMBOL",
  ERROR_MISPRINT: "ERROR / MISPRINT",
  TROPHY_PRIZE: "TROPHY / PRIZE",
  TRAINER_GALLERY: "TRAINER GALLERY",
  GALARIAN_GALLERY: "GALARIAN GALLERY",
  RADIANT_COLLECTION: "RADIANT COLLECTION",
  SHINY_VAULT: "SHINY VAULT",
  ILLUSTRATION_RARE: "ILLUSTRATION RARE",
  SPECIAL_ILLUSTRATION_RARE: "SPECIAL ILLUSTRATION RARE",
  CHARACTER_RARE: "CHARACTER RARE",
  CHARACTER_SUPER_RARE: "CHARACTER SUPER RARE",
  PRISM_STAR: "PRISM STAR",
  AMAZING_RARE: "AMAZING RARE",
  SECRET_RARE: "SECRET RARE",
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
  NONE: "",
  HOLO: "HOLO",
  REVERSE_HOLO: "REVERSE HOLO",
  COSMOS_HOLO: "COSMOS HOLO",
  CRACKED_ICE_HOLO: "CRACKED ICE HOLO",
  MIRROR_HOLO: "MIRROR HOLO",
  GLITTER_HOLO: "GLITTER HOLO",
  PATTERN_HOLO: "PATTERN HOLO",
  TEXTURED: "TEXTURED",
  FULL_ART: "FULL ART",
  ALT_ART: "ALT ART",
  SPECIAL_ART: "SPECIAL ART",
  RAINBOW: "RAINBOW",
  GOLD: "GOLD",
  SHINY: "SHINY",
  RADIANT: "RADIANT",
  TRAINER_GALLERY: "TRAINER GALLERY",
  GALARIAN_GALLERY: "GALARIAN GALLERY",
  CHARACTER_RARE: "CHARACTER RARE",
  CHARACTER_SUPER_RARE: "CHARACTER SUPER RARE",
  SECRET_RARE: "SECRET RARE",
  ILLUSTRATION_RARE: "ILLUSTRATION RARE",
  SPECIAL_ILLUSTRATION_RARE: "SPECIAL ILLUSTRATION RARE",
  DOUBLE_RARE: "DOUBLE RARE",
  ULTRA_RARE: "ULTRA RARE",
  HYPER_RARE: "HYPER RARE",
  AMAZING_RARE: "AMAZING RARE",
  ACE_SPEC_RARE: "ACE SPEC RARE",
  EX: "EX",
  PROMO: "PROMO",
  FIRST_EDITION: "1ST EDITION",
  SHADOWLESS: "SHADOWLESS",
  UNLIMITED: "UNLIMITED",
  OTHER: "OTHER",
};

function buildVariantLine(cert: CertificateRecord): string {
  const v = cert.variant;
  if (!v || v === "NONE") return "";
  if (v === "OTHER") {
    const other = (cert as any).variantOther;
    return other ? other.toUpperCase() : "OTHER";
  }
  // Same defence as buildRarityText: uppercase the lookup key (form/AI/import
  // casing varies) and never let a raw CODE reach the physical label — an
  // unmapped code prints with its underscores stripped, not "ULTRA_RARE".
  const key = String(v).toUpperCase();
  if (VARIANT_DISPLAY[key]) return VARIANT_DISPLAY[key];
  return key.replace(/_/g, " ");
}

const RARITY_DISPLAY: Record<string, string> = {
  COMMON: "COMMON",
  UNCOMMON: "UNCOMMON",
  RARE: "RARE",
  HOLO: "HOLO",
  RARE_HOLO: "HOLO RARE",
  REVERSE_HOLO: "REVERSE HOLO",
  DOUBLE_RARE: "DOUBLE RARE",
  ULTRA_RARE: "ULTRA RARE",
  ILLUSTRATION_RARE: "ILLUSTRATION RARE",
  SPECIAL_ILLUSTRATION_RARE: "SPECIAL ILLUSTRATION RARE",
  HYPER_RARE: "HYPER RARE",
  SECRET_RARE: "SECRET RARE",
  SHINY_RARE: "SHINY RARE",
  SHINY_ULTRA_RARE: "SHINY ULTRA RARE",
  RADIANT: "RADIANT",
  AMAZING_RARE: "AMAZING RARE",
  ACE_SPEC: "ACE SPEC",
  TRAINER_GALLERY: "TRAINER GALLERY",
  GALAR_GALLERY: "GALARIAN GALLERY",
  GOLD_STAR: "★ GOLD STAR",
  DOUBLE_GOLD_STAR: "★★ DOUBLE GOLD STAR",
  PROMO_RARITY: "PROMO",
  OTHER: "OTHER",
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

/**
 * The single public-facing variant/rarity line printed on the front label.
 *
 * Certs saved under the CONSOLIDATED variant scheme (structuredVariantVersion ≥
 * CONSOLIDATED_VARIANT_SCHEME) print the ONE canonical consolidated line built
 * by the shared formatVariantLine() — the exact same wording the Review preview
 * and summary show, so preview and print always match. Every OLDER cert keeps
 * its previous, byte-identical wording (variant OR rarity via the legacy maps),
 * so no existing certificate's label changes until it is edited and re-saved.
 *
 * This affects ONLY the variant/rarity text line — no grade, subgrade, centering,
 * Pristine/black-label, dimension, or MVGS logic is touched.
 *
 * Exported for regression tests (preview↔print parity, version gate, legacy
 * fallback) — it is a pure string function, safe to call without canvas.
 */
export function consolidatedVariantForLabel(cert: CertificateRecord): string {
  const version = Number((cert as unknown as { structuredVariantVersion?: number }).structuredVariantVersion ?? 0);
  // The boundary is the SCHEME VERSION ALONE — deliberately NOT "does it currently
  // hold a structured value". A consolidated certificate prints exactly its
  // explicit structured selections, so clearing every field yields NO variant
  // line rather than resurrecting the legacy wording (previously, a full clear
  // fell through to the legacy branch and "HOLO" reappeared). The legacy columns
  // are still stored and untouched — they simply stop being printed once the
  // operator has converted the certificate to the consolidated scheme.
  if (version >= CONSOLIDATED_VARIANT_SCHEME) {
    // An explicit label variant OVERRIDE is an operator instruction for this
    // label and outranks the structured line — otherwise the override (and the
    // Manual Identity Override, which writes through the same legacy column)
    // became a silent no-op on every converted certificate, removing the very
    // escape hatch used to correct a wrong printed line.
    const overridden = (cert as unknown as { __variantOverridden?: boolean }).__variantOverridden === true;
    if (overridden)
      return String(cert.variant ?? "")
        .trim()
        .toUpperCase();
    return formatVariantLine(cert as unknown as Parameters<typeof formatVariantLine>[0]).toUpperCase();
  }
  return buildVariantLine(cert) || (cert.rarity ? buildRarityText(cert).toUpperCase() : "");
}

// ─────────────────────────────────────────────────────────────────────────────
// GRADING ORIGIN — rendering side of the immutable snapshot (migration 0035).
//
// ONE formatter, exported, so every surface that says who graded a card says the
// same thing. Pure string function: no canvas, no database, no partner lookup.
//
// It reads ONLY the snapshot columns on the certificate row. It must never
// re-resolve the partner through partner_organisations / partner_profiles —
// that is precisely what would let a later rename, relocation, suspension or
// revocation rewrite what an already-issued certificate says.
//
// ⚠️ NOT PAINTED ON THE PHYSICAL SLAB. The 827×236 label is fully committed:
// the back carries GRADED UNDER / MVGS / GRADING STANDARD, the rotated
// MINTVAULT wordmark, the verification URL, the NFC line, the QR and the cert
// number, with no free zone. Adding an origin line there means moving printed
// elements, which is a protected geometry change and a separate founder-approved
// decision. This helper therefore feeds the CERTIFICATE DOCUMENT (and any future
// digital surface); server/labels.ts owns the formatter but draws nothing new.
// ─────────────────────────────────────────────────────────────────────────────

/** What an in-house-graded certificate is called. */
export const HQ_ORIGIN_NAME = "MintVault Headquarters";

/**
 * Used only if a row claims PARTNER origin but carries neither a trading name nor a legal
 * name — a shape the 0035 CHECK constraint and storage both reject, so it should be
 * unreachable. Falling back to HQ there would print a FALSE statement (MintVault did not
 * grade that card), so the fallback is deliberately honest-but-unnamed instead.
 */
export const UNNAMED_PARTNER_ORIGIN_NAME = "an Accredited MintVault Partner";

export interface CertificateOriginView {
  /** True only for a certificate carrying a PARTNER origin snapshot. */
  isPartner: boolean;
  /** Name that follows "Graded by". */
  name: string;
  /** The full rendered line, e.g. "Graded by MintVault Headquarters". */
  line: string;
  /**
   * Approved intake/grading location snapshot ("<Site name> — <address>"), or null.
   * Null for HQ and legacy certificates, and for partner certificates recorded without a
   * location. Never synthesised from the partner's CURRENT address.
   */
  location: string | null;
}

/**
 * Resolve the grading origin of a certificate for display.
 *
 * HQ, and LEGACY (origin_type NULL — the row predates origin capture), both render as
 * "Graded by MintVault Headquarters". They are the same statement because they describe the
 * same fact: no partner was involved. The NULL is kept in the database purely so an auditor
 * can tell a recorded assertion from an absent one.
 */
export function certificateOrigin(cert: CertificateRecord): CertificateOriginView {
  const originType = (cert as unknown as { originType?: string | null }).originType ?? null;

  if (originType !== "PARTNER") {
    return { isPartner: false, name: HQ_ORIGIN_NAME, line: `Graded by ${HQ_ORIGIN_NAME}`, location: null };
  }

  const row = cert as unknown as {
    originPartnerTradingName?: string | null;
    originPartnerLegalName?: string | null;
    originLocationName?: string | null;
    originLocationAddress?: string | null;
  };

  // Trading name is the customer-facing shop name and wins. Legal name is the fallback because
  // partner_profiles.trading_name is nullable (0015) and a partner may never have set one.
  const name =
    (row.originPartnerTradingName ?? "").trim() ||
    (row.originPartnerLegalName ?? "").trim() ||
    UNNAMED_PARTNER_ORIGIN_NAME;

  const siteName = (row.originLocationName ?? "").trim();
  const siteAddress = (row.originLocationAddress ?? "").trim();
  const location = [siteName, siteAddress].filter(Boolean).join(" — ") || null;

  return { isPartner: true, name, line: `Graded by ${name}`, location };
}

// Real-world TCG sets in this recurring "<Era> Black Star Promos" family (e.g.
// "Sword & Shield Black Star Promos", "XY Black Star Promos") name the whole
// promo sub-line as part of the set name. Split that trailing qualifier off
// so it can print on its own line instead of crushing onto the year line —
// sets with no such suffix are returned untouched (base = full name).
// Bounded whitespace quantifier ({1,64} rather than +) so the match cost stays
// linear — an unbounded \s+ before a literal is the polynomial-ReDoS shape CodeQL
// flags (js/polynomial-redos), since a long run of whitespace makes the engine
// retry from every start position. The VISIBLE OUTPUT is unchanged for every
// possible input: splitPromoSuffix() .trim()s both the base and the suffix, so a
// whitespace run longer than 64 yields byte-identical base/suffix either way —
// only the internal match offset differs. Real set names have exactly one space.
const PROMO_SUFFIX_RE = /\s{1,64}black star promos?$/i;

function splitPromoSuffix(setName: string): { base: string; suffix: string } {
  const m = setName.match(PROMO_SUFFIX_RE);
  if (!m) return { base: setName, suffix: "" };
  return { base: setName.slice(0, m.index).trim(), suffix: m[0].trim() };
}

function buildLine3(cert: CertificateRecord): string {
  const parts: string[] = [];
  const rText = buildRarityText(cert);
  if (rText) parts.push(rText);
  if (cert.labelType && cert.labelType !== "Standard" && cert.labelType !== "black")
    parts.push(cert.labelType.toUpperCase());
  return parts.join(" · ") || "";
}

function buildLine4(cert: CertificateRecord): string {
  return cert.cardNumber ? `#${cert.cardNumber}` : "";
}

/**
 * Draws the gold outer frame onto ctx. Called once during setup and again
 * after the logo is painted on the back label to prevent bleed-over.
 */
function drawGoldFrame(ctx: any, frameColor: string = GOLD_LIGHT) {
  ctx.shadowBlur = 0;
  ctx.shadowColor = "transparent";
  // Flat frame fill. GOLD_LIGHT normally; WHITE in holographic mode so the
  // border prints as nothing and the holographic paper shows through it.
  ctx.fillStyle = frameColor;
  // Four strips — top, bottom, left, right
  ctx.fillRect(0, 0, PX_W, FRAME_W);
  ctx.fillRect(0, PX_H - FRAME_W, PX_W, FRAME_W);
  ctx.fillRect(0, FRAME_W, FRAME_W, PX_H - FRAME_W * 2);
  ctx.fillRect(PX_W - FRAME_W, FRAME_W, FRAME_W, PX_H - FRAME_W * 2);
}

export async function generateLabelPNG(cert: CertificateRecord, side: "front" | "back"): Promise<Buffer> {
  // FAIL CLOSED before a single pixel is produced. Every label path funnels through this
  // function — single label, print batch, print-workflow batch, reprint, slab showcase and
  // the live workstation preview — so this one assertion makes "a numeric certificate can
  // never produce a printable label without a valid MVGS ladder grade" true for present and
  // future callers alike. See shared/printable-grade.ts for the 2026-07-25 incident
  // (22 certificates rendered as 0 / POOR). Authentication-only certificates are
  // unaffected: carrying no grade is their correct state.
  assertPrintableGrade(cert as { gradeType?: string | null; gradeOverall?: string | number | null; certId?: string });
  // Bundled faces must be registered BEFORE the first glyph, or the host's fonts decide what
  // a physical slab looks like. Memoised — one registration per process.
  await ensureFontsRegistered();
  const { createCanvas, loadImage } = await import("canvas");

  // Black Label / PRISTINE gate — uses the canonical isPristine() from
  // shared/pristine.ts, the SAME gate the cert/approve system uses. Quad-10
  // subgrades are necessary but NOT sufficient: isPristine additionally
  // requires ZERO raw defect deduction (centering_front/back, corners, edges,
  // surface). So a card with all-10 subgrades but residual deduction renders
  // on the WHITE label, not the black PRISTINE one. Deductions are
  // reconstructed here exactly as the approve route does — from the same cert
  // columns fed to computeMvgsScore — changing nothing about how they're
  // computed.
  // No "|| 0" coercion: a missing grade must never become the digit 0, which
  // mvgsTierName then labels "Poor". assertPrintableGrade above has already refused any
  // numeric certificate without a valid grade.
  const gradeNum = parseStoredGrade(cert.gradeOverall) ?? 0;
  const isNumericGrade = !isNonNumericGrade(cert.gradeType || "numeric");
  let mvgsDeductions: Record<string, number> | undefined;
  if (isNumericGrade) {
    const rawDefects = cert.defects;
    const savedDefects: Array<Record<string, unknown>> = Array.isArray(rawDefects)
      ? (rawDefects as unknown as Array<Record<string, unknown>>)
      : [];
    const mvgsPins = savedDefects
      .filter((d) => d.mvgsCode && d.tier && d.zone)
      .map((d) => ({ mvgsCode: String(d.mvgsCode), tier: String(d.tier), zone: String(d.zone) }));
    // MVGS v2 — load calibration + thread persisted measurement inputs
    // through the precedence-aware builder (shared/mvgs-input-builder.ts).
    // The slab gate reads `deductions` from the engine result, so v2
    // ceiling-triggered scores still surface the right deduction shape for
    // the isPristine check below.
    const { scoreMvgsV2 } = await import("@shared/mvgs-input-builder");
    const { loadMvgsCalibration } = await import("./lib/mvgs-calibration");
    const certAny = cert as any;
    const surfaceFlags = (certAny.surfaceValues as any) ?? {};
    const calibration = await loadMvgsCalibration();
    mvgsDeductions = scoreMvgsV2(
      {
        centeringFrontLr: cert.centeringFrontLr,
        centeringFrontTb: cert.centeringFrontTb,
        centeringBackLr: cert.centeringBackLr,
        centeringBackTb: cert.centeringBackTb,
        defects: mvgsPins,
        darkBorderFront: cert.darkBorderFront,
        darkBorderBack: cert.darkBorderBack,
        eyeAppealModifier: cert.eyeAppealModifier,
        whiteningLines: Array.isArray(certAny.whiteningLines) ? certAny.whiteningLines : null,
        // v2.1 — multi-crease list. Engine input is max(spanPct) at the builder.
        creaseLines: Array.isArray(certAny.creaseLines) ? certAny.creaseLines : null,
        creaseSpanPct: certAny.creaseSpanPct != null ? Number(certAny.creaseSpanPct) : null,
        wrinkleSeverity: certAny.wrinkleSeverity ?? null,
        tearSeverity: certAny.tearSeverity ?? null,
        hasCrease: !!surfaceFlags.hasCrease,
        hasTear: !!surfaceFlags.hasTear,
      },
      calibration
    ).deductions;
  }
  const isBlack =
    isNumericGrade &&
    isPristine(
      {
        centering: parseFloat(cert.gradeCentering || "0"),
        corners: parseFloat(cert.gradeCorners || "0"),
        edges: parseFloat(cert.gradeEdges || "0"),
        surface: parseFloat(cert.gradeSurface || "0"),
      },
      gradeNum,
      mvgsDeductions
    );
  // Backgrounds: holographic mode prints the standard label warm gold #c18e22
  // (was white) and keeps the Pristine label black; white-paper mode unchanged.
  const labelBg = isBlack ? BLACK : HOLOGRAPHIC_PAPER ? HOLO_GOLD : WHITE;
  // Foreground: holographic mode draws ALL lettering WHITE (prints as nothing →
  // holographic paper shimmers through it). White-paper mode unchanged
  // (GOLD_LIGHT on the black label, black on the white label).
  const labelFg = HOLOGRAPHIC_PAPER ? WHITE : isBlack ? GOLD_LIGHT : "#000000";
  // Frame: WHITE (holographic border) in holo mode, else the gold frame.
  const frameColor = HOLOGRAPHIC_PAPER ? WHITE : GOLD_LIGHT;

  const SCALE = 2.4; // 300 base × 2.4 = 720 DPI effective. Uniform ctx.scale —
  // PX_W/PX_H and all derived layout constants stay identical; only the physical
  // pixel count grows. Both createCanvas and ctx.scale use this same constant.
  const canvas = createCanvas(PX_W * SCALE, PX_H * SCALE);
  const ctx = canvas.getContext("2d");
  ctx.scale(SCALE, SCALE);

  // ── 1. CANVAS BASE ────────────────────────────────────────────────────────
  ctx.shadowBlur = 0;
  ctx.shadowColor = "transparent";
  ctx.fillStyle = labelBg;
  ctx.fillRect(0, 0, PX_W, PX_H);

  // ── 2. GOLD OUTER FRAME — fills from canvas edge to FRAME_W inward ───────
  drawGoldFrame(ctx, frameColor);

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
function drawSimpleBarcode(ctx: any, data: string, x: number, y: number, w: number, h: number) {
  const src = (data.replace(/[^A-Z0-9]/gi, "").toUpperCase() || "MVUK").repeat(4);
  const THIN = 1.5,
    WIDE = 3.0,
    GAP = 1.0;
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
      const bw = (code >> bit) & 1 ? WIDE : THIN;
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
async function drawFront(
  ctx: any,
  cert: CertificateRecord,
  logo: any,
  loadImage: any,
  labelBg = WHITE,
  labelFg = "#000000"
) {
  const gradeType = cert.gradeType || "numeric";
  const isNonNum = isNonNumericGrade(gradeType);
  // v-halfgrade: render the TRUE grade (no Math.round). A half-grade like 8.5
  // must print "8.5" on the slab, matching the online cert — rounding to "9"
  // overstated the grade by half a tier. String(8.5)="8.5", String(9)="9",
  // String(10)="10" (no trailing .0).
  // Non-numeric certificates never reach the grade panel (guarded by `if (!isNonNum)`),
  // and a numeric certificate without a valid grade was refused at the entry point — so
  // this can no longer invent a 0 / POOR grade.
  // For a numeric certificate the grade is guaranteed parseable by assertPrintableGrade at
  // the entry point; if that ever ceases to hold, refuse rather than invent 0 (which
  // mvgsTierName labels "Poor"). Non-numeric certificates never reach the grade panel.
  const parsedGrade = parseStoredGrade(cert.gradeOverall);
  if (!isNonNum && parsedGrade === null) {
    throw new UnprintableGradeError(String((cert as { certId?: string }).certId ?? "certificate"), {
      printable: false,
      reason: "missing_numeric_grade",
      message: "This certificate has no readable numeric grade, so no label can be produced for it.",
    });
  }
  const grade = isNonNum ? 0 : (parsedGrade as number);

  // ── LAYOUT CONSTANTS ──────────────────────────────────────────────────────
  const PANEL_W = 148; // right grade panel (≈ 18%, -5.7%)
  const STRIP_H = 44; // v432: 28→44 — taller strip hosts rarity (left) + cert ID (right) at matched main-line size.
  const panelX = I_RIGHT - PANEL_W; // 651
  const stripY = I_BOTTOM - STRIP_H; // 179

  // Left text insets
  const TXT_PAD = 16;
  const textLeft = I_LEFT + TXT_PAD; // 47
  const textMaxW = panelX - textLeft - 6; // 495

  // Vertical content zone — full inner height (no top banner on the front).
  const contentT = I_TOP;
  const contentB = stripY;

  // ── 1. CARD ARTWORK BACKGROUND ────────────────────────────────────────────
  // If artwork is available, draw it then add a white wash overlay so dark
  // text remains legible on any card image. Full inner-area extent.
  // Holographic mode uses a solid gold/black background (no washed artwork),
  // matching the approved design; white-paper mode keeps the artwork wash.
  const artworkUrl = HOLOGRAPHIC_PAPER ? null : (cert as any).frontImageUrl;
  const artH = I_H;
  if (artworkUrl) {
    try {
      const artImg = await loadImage(artworkUrl);
      ctx.save();
      ctx.beginPath();
      ctx.rect(I_LEFT, contentT, I_W, artH);
      ctx.clip();
      const sc = Math.max(I_W / artImg.width, artH / artImg.height);
      const dw = artImg.width * sc,
        dh = artImg.height * sc;
      ctx.drawImage(artImg, I_LEFT + (I_W - dw) / 2, contentT + (artH - dh) / 2, dw, dh);
      ctx.restore();
      // Wash overlay — lightens (white label) or darkens (black label) artwork so text is legible
      ctx.fillStyle = labelBg === WHITE ? "rgba(255,255,255,0.62)" : "rgba(0,0,0,0.60)";
      ctx.fillRect(I_LEFT, contentT, I_W, artH);
    } catch {}
  }

  // ── 2. GRADE PANEL (right, above bottom strip) ────────────────────────────
  const panelY = contentT;
  const panelH = stripY - panelY; // full inner height above strip
  const panelCX = panelX + PANEL_W / 2;
  const DARK = "#1A1000";

  if (!isNonNum) {
    // Grade panel background. White-paper: solid gold panel. Holographic: fill
    // the panel with the label background (gold/black) so the holographic grade
    // digit sits on a seamless field — no separate panel, no faint lines.
    ctx.fillStyle = HOLOGRAPHIC_PAPER ? labelBg : GOLD_LIGHT;
    ctx.fillRect(panelX, panelY, PANEL_W, panelH);

    // Subtle vertical separator on the left edge of the panel (white-paper
    // only — removed in holographic mode per "no faint lines").
    if (!HOLOGRAPHIC_PAPER) {
      ctx.strokeStyle = "rgba(212,175,55,0.25)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(panelX, panelY);
      ctx.lineTo(panelX, stripY);
      ctx.stroke();
    }

    const gradeStr = String(grade);
    // Tier NAME from the MVGS table keyed by the grade itself, so the slab and
    // the online cert page (which also uses the MVGS vocabulary) can never
    // disagree. Half-grades get their TRUE tier: 8.5 → "NM-MINT+", 7.5 → "NM+".
    const gradeAbbr = labelBg === "#000000" ? "PRISTINE" : mvgsTierName(grade).toUpperCase();

    // ── Three equal 52-px zones inside the panel ─────────────────────
    // Panel y=18 → y=174 (panelH=156); each zone centre is the middle
    // of its third. New layout (rearranged): card number TOP, digit
    // MIDDLE, abbreviation BOTTOM. Hard-coded so a future panel resize
    // doesn't silently shift the rows.
    const cardNumCY = 34; // zone 1 centre — top third
    const digitCY = 111; // zone 2 centre — middle third
    const abbrCY = 158; // zone 3 centre — bottom third

    // Element 1 — card number (#4) in zone 1
    const cardNumPanelText = cert.cardNumber ? `#${cert.cardNumber}` : "";
    const cardNumFontSize = 30;
    if (cardNumPanelText) {
      ctx.font = `bold ${cardNumFontSize}px ${MV_SANS}`;
      ctx.fillStyle = HOLOGRAPHIC_PAPER ? WHITE : "#1A1A1A";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      try {
        (ctx as any).letterSpacing = "0.5px";
      } catch {}
      ctx.fillText(cardNumPanelText, panelCX, cardNumCY);
      try {
        (ctx as any).letterSpacing = "0px";
      } catch {}
    }

    // Element 2 — grade digit in zone 2 (middle)
    // Hard 80-px cap; fitFontSize shrinks only when width can't accommodate.
    const gradeFontSize = fitFontSize(ctx, gradeStr, PANEL_W - 8, 116, 36);
    // Optical-centre adjustment: textBaseline="middle" places the em-box
    // middle at Y, but a numeral's visual centre sits slightly above the
    // em-box middle (digits are top-heavy). 0.04*em shift pushes the
    // digit down so it reads visually centred on digitCY.
    const digitY = digitCY - gradeFontSize * 0.04;
    // Drop shadow on white-paper only — on a holographic (white) digit a grey
    // shadow reads as a faint smudge, so it's dropped in holo mode.
    if (!HOLOGRAPHIC_PAPER) {
      ctx.shadowOffsetX = 1;
      ctx.shadowOffsetY = 1;
      ctx.shadowBlur = 1;
      ctx.shadowColor = "rgba(0,0,0,0.25)";
    }
    ctx.font = `bold ${gradeFontSize}px ${MV_SANS}`;
    ctx.fillStyle = HOLOGRAPHIC_PAPER ? WHITE : "#1A1A1A";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(gradeStr, panelCX, digitY);
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";

    // Element 3 — grade tier name in zone 3 (bottom). MVGS names vary in
    // length ("NM+" → "NM-MINT+" → "EXCELLENT-MINT"), so spacing tightens and
    // the font shrinks-to-fit the 140-px panel. Short names keep the original
    // 30 px / 5 px-tracked look; longer ones step down so nothing clips.
    const abbrLen = gradeAbbr.length;
    const abbrLetterSpacing = abbrLen <= 6 ? 5 : abbrLen <= 9 ? 2 : 0;
    // fitFontSize measures glyphs only, so reserve the inter-letter spacing up
    // front by shrinking the width budget by (len-1)*spacing.
    const abbrAvailW = PANEL_W - 8 - Math.max(0, abbrLen - 1) * abbrLetterSpacing;
    const abbrFontSize = fitFontSize(ctx, gradeAbbr, abbrAvailW, 30, 12);
    try {
      (ctx as any).letterSpacing = `${abbrLetterSpacing}px`;
    } catch {}
    ctx.font = `bold ${abbrFontSize}px ${MV_SANS}`;
    ctx.fillStyle = HOLOGRAPHIC_PAPER ? WHITE : "#1A1A1A";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(gradeAbbr, panelCX, abbrCY);
    try {
      (ctx as any).letterSpacing = "0px";
    } catch {}
  } else {
    // Non-numeric (AUTHENTIC / AUTHENTIC ALTERED)
    ctx.textAlign = "center";
    if (gradeType === "AA" || gradeType === "authentic_altered") {
      ctx.textBaseline = "middle";
      ctx.font = `bold 28px ${MV_SANS}`;
      ctx.fillStyle = HOLOGRAPHIC_PAPER ? WHITE : "#1A1A1A";
      ctx.fillText("AUTHENTIC", panelCX, panelY + panelH / 2 - 20);
      ctx.font = `bold 22px ${MV_SANS}`;
      ctx.fillStyle = HOLOGRAPHIC_PAPER ? WHITE : GOLD_DARK;
      ctx.fillText("ALTERED", panelCX, panelY + panelH / 2 + 14);
    } else {
      const authSize = fitFontSize(ctx, "AUTHENTIC", PANEL_W - 8, 30, 18);
      ctx.textBaseline = "middle";
      ctx.font = `bold ${authSize}px ${MV_SANS}`;
      ctx.fillStyle = HOLOGRAPHIC_PAPER ? WHITE : "#1A1A1A";
      ctx.fillText("AUTHENTIC", panelCX, panelY + panelH / 2);
    }
  }

  // ── 3. BOTTOM STRIP ───────────────────────────────────────────────────────
  // Strip background fill removed — the strip now inherits whatever was
  // drawn below it (artwork + wash, or the canvas base). Cert ID + rarity
  // text continue to render directly on top.

  // ── GRADE PANEL cert ID — right-anchored 8px from inner gold border ────────
  {
    const certStripSz = 24; // match back-label cert ID size (L815 certFontH)
    const certStripFit = fitFontSize(ctx, cert.certId, PANEL_W - 14, certStripSz, 16);
    ctx.font = `bold ${certStripFit}px ${MV_SANS}`;
    ctx.fillStyle = labelFg;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
    // +3 optical down-shift: top-heavy mass distribution (digits/caps) reads
    // high when em-box-middle centred. Pattern matches grade-digit optical
    // adjustment (PR #26).
    ctx.fillText(cert.certId.replace(/^MV/, ""), I_RIGHT - 8, Math.round(stripY + STRIP_H / 2) + 4);
  }

  // v433 — rarity left-aligned at the same X as the main text block above
  // (textLeft), and sized smaller than the main lines so the visual
  // hierarchy reads NAME / SET (large) → RARITY (smaller) → CERT ID (small)
  // left-to-right and top-to-bottom.
  {
    const rarityVariantStrip = [""]
      .filter(Boolean)
      .map((s) => s.toUpperCase())
      .join(" · ");
    if (rarityVariantStrip.trim().length > 0) {
      const rarityMaxW = panelX - textLeft - 8; // right edge stops 8px short of the grade panel column
      const rarityFamily = MV_SANS;
      const rarityFit = fitFontSize(ctx, rarityVariantStrip, rarityMaxW, 28, 16, "700", rarityFamily);
      ctx.font = `600 ${rarityFit}px ${rarityFamily}`;
      ctx.fillStyle = labelFg;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
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
  const MV_HDR_SZ = 50; // sized to fill the 56-px black top banner; glyph centre lands on banner midY=46.
  const MV_HDR_PAD = 6; // tuned so MV_HDR_Y − BOX_PY lands on I_TOP=18 → BOX_Y aligns with banner top.
  const MV_HDR_Y = contentT + MV_HDR_PAD; // text baseline anchor (top mode)
  const MV_HDR_BOT = MV_HDR_Y + MV_HDR_SZ; // bottom of text zone
  const MV_BELOW_GAP = 8; // v429: 4→2 — every pixel matters for the expanded text zone.
  const MV_LS = 2; // letter-spacing px
  const MV_TEXT = "MINTVAULT";

  const mvFont = `900 ${MV_HDR_SZ}px "Bodoni Moda", ${MV_SERIF}`;

  // Step 1 — measure without letter-spacing so measureText is accurate
  try {
    (ctx as any).letterSpacing = "0px";
  } catch {}
  ctx.font = mvFont;
  ctx.textBaseline = "middle"; // measure in same mode as draw
  const mvBaseW = ctx.measureText(MV_TEXT).width;
  // Add letter-spacing contribution: (numChars - 1) gaps × MV_LS px
  const mvTextW = mvBaseW + MV_LS * (MV_TEXT.length - 1); // 9 chars → 8 gaps × 2px = +16px

  // Step 2 — derive box geometry centred in left panel
  const BOX_PX = 12; // horizontal padding inside box (each side)
  const BOX_PY = 6; // vertical padding (banner = 44 + 6*2 = 56 → matches the black banner height exactly)
  const BOX_LW = 3; // border line width (unused now — box border removed; kept for symmetry)
  const BOX_W = mvTextW + BOX_PX * 2;
  const BOX_H = MV_HDR_SZ + BOX_PY * 2;
  const leftPanelCX = (I_LEFT + panelX) / 2; // exact centre of left panel
  const BOX_X = Math.round(leftPanelCX - BOX_W / 2);
  const BOX_Y = MV_HDR_Y - BOX_PY;
  const BOX_CY = BOX_Y + BOX_H / 2; // vertical centre of box

  // Step 3 — top banner. White-paper: a black plate behind the gold MINTVAULT
  // wordmark. Holographic: filled with the label background (gold/black) so
  // there is NO black bar — the holographic wordmark sits directly on the
  // label colour. Same rect/position either way.
  ctx.fillStyle = HOLOGRAPHIC_PAPER ? labelBg : "#000000";
  ctx.fillRect(I_LEFT, I_TOP, panelX - I_LEFT, BOX_Y + BOX_H - I_TOP);

  // Step 4 — v424 — solid GOLD_LIGHT fill replaces the 5-stop gradient and
  // glow shadow. The gradient was washing out the centre of each letter on
  // physical labels; flat gold reads cleanly at the new 70mm width.
  try {
    (ctx as any).letterSpacing = `${MV_LS}px`;
  } catch {}
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const mvTextX = BOX_X + Math.round((BOX_W - mvBaseW) / 2);

  // Wordmark: gold on the black banner (white-paper), or holographic WHITE in
  // holo mode (prints as nothing → holographic paper shows through the glyphs).
  ctx.fillStyle = HOLOGRAPHIC_PAPER ? WHITE : GOLD_LIGHT;
  ctx.shadowBlur = 0;
  ctx.shadowColor = "transparent";
  ctx.fillText(MV_TEXT, mvTextX, BOX_CY);
  try {
    (ctx as any).letterSpacing = "0px";
  } catch {}

  // ── 4. LEFT PANEL TEXT — v427 uniform 3-line block ───────────────────────
  // Cornelius's review of v426 PSA-hierarchy: he prefers the opposite — all
  // three lines identical in size, weight, colour, spacing. Reference cert
  // is GEODUDE / 1999 FOSSIL / COMMON; "GEODUDE"-comfortable size is the
  // target. Longer-named carts shrink the whole 3-line block proportionally
  // so within a single label every line still matches.
  const textZoneT = MV_HDR_BOT + MV_BELOW_GAP;
  // Text block fills DOWN to the inner bottom border (I_BOTTOM), not contentB
  // (= stripY), so the 3 lines distribute across the full height and the last
  // line (rarity) lands level with the cert ID. Safe to occupy the strip zone:
  // the strip has no background fill and its left side is empty (only the
  // right-anchored cert ID renders there, different column). contentB / stripY
  // / panelH are untouched, so the grade panel + cert ID are unaffected.
  const textBlockB = I_BOTTOM; // 242
  const textZoneH = textBlockB - textZoneT;

  // Title family drops "Arial Black" so weight 600 (semibold) actually renders
  // as semibold via Arial — "Arial Black" is a single-weight (900) face and
  // would override the requested weight.
  const TXT_FAMILY = MV_SANS;
  const TXT_WEIGHT = "600"; // was "700" — lighter title per print pass
  const TARGET_SIZE = 48; // was 34 — raised so short-name lines grow to fill the 116px text zone
  const MIN_SIZE = 20; // was 24 — ~15% reduction
  const MIN_GAP_FACTOR = 0.1;

  // v432 — rarity moves OUT of the white panel and into the bottom strip,
  // so the main block uses the full textZoneH (no RARITY_ZONE_H reservation).
  const mainBlockZoneH = textZoneH;

  // v432 — main block has TWO lines (card name + year+set). Rarity moved
  // into the bottom strip alongside the cert ID (rendered earlier).
  const cardNameText = cert.cardName ? cert.cardName.toUpperCase() : "";
  const yearText = cert.year || "";
  const { base: setBase, suffix: setSuffix } = splitPromoSuffix(cert.setName || "");
  const setBaseText = setBase.toUpperCase();
  const setSuffixText = setSuffix.toUpperCase();

  // Owner ruling (2026-07-12): year + set name share a line as before, EXCEPT
  // a recurring "<Era> Black Star Promos" suffix (e.g. "Sword & Shield Black
  // Star Promos") splits onto its own line below — that family of real-world
  // set names is long enough to crush onto the year line otherwise. Bottom
  // line still shows the variant if set, else the rarity — never both. Font
  // auto-shrinks (below) to fit whatever line count a given cert ends up with.
  const lines = [
    cardNameText,
    yearText && setBaseText ? yearText + " " + setBaseText : yearText || setBaseText,
    setSuffixText,
    consolidatedVariantForLabel(cert),
  ].filter((s) => s.trim().length > 0);

  // Horizontal fit: pick the smallest size that satisfies the widest line.
  let fitSize = TARGET_SIZE;
  for (const line of lines) {
    const sz = fitFontSize(ctx, line, textMaxW, fitSize, MIN_SIZE, TXT_WEIGHT, TXT_FAMILY);
    if (sz < fitSize) fitSize = sz;
  }

  // Vertical fit operates on the rarity-reduced main-block zone so
  // descenders never extend into the rarity line below.
  const requiredHeight = lines.length * fitSize + (lines.length + 1) * fitSize * MIN_GAP_FACTOR;
  if (requiredHeight > mainBlockZoneH) {
    const vScale = mainBlockZoneH / requiredHeight;
    fitSize = Math.max(MIN_SIZE, Math.floor(fitSize * vScale));
  }

  // Even distribution: gaps above first line, between lines, and below
  // last line are all equal — within the rarity-reduced zone.
  ctx.font = `${TXT_WEIGHT} ${fitSize}px ${TXT_FAMILY}`;
  ctx.fillStyle = labelFg;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  const totalLineHeight = lines.length * fitSize;
  const totalGapSpace = mainBlockZoneH - totalLineHeight;
  const gapSize = totalGapSpace / (lines.length + 1);

  for (let i = 0; i < lines.length; i++) {
    const baseline = textZoneT + gapSize * (i + 1) + fitSize * i + fitSize * 0.5;
    ctx.fillText(lines[i], textLeft, baseline);
  }

  // v432 — rarity moved into the bottom strip (rendered earlier alongside
  // the cert ID). Nothing more to draw in the white panel.
}

async function drawBack(
  ctx: any,
  cert: CertificateRecord,
  _logo: any,
  loadImage: any,
  labelBg = WHITE,
  _labelFg = "#1A1A1A"
) {
  // Holographic mode: the back prints on the label colour (gold/black) with
  // holographic (WHITE) lettering, matching the front. isBlack is derived from
  // the passed background. The QR sits on a printed light colour so it scans:
  // silver on the black label, gold on the gold label.
  const isBlackHolo = labelBg === BLACK;
  const holoFg = WHITE; // holographic lettering
  const qrBg = HOLOGRAPHIC_PAPER ? (isBlackHolo ? HOLO_QR_SILVER : HOLO_GOLD) : WHITE;
  // ── Layout constants ─────────────────────────────────────────────────────
  const PANEL_X = I_LEFT; // 18
  const PANEL_W = 58;
  const PANEL_RIGHT = PANEL_X + PANEL_W; // 76
  const BANNER_H = 60;
  const BANNER_BG = "#1A1A1A";
  const BANNER_MUTED = "#666666";
  const GOLD_MARK = GOLD_LIGHT; // #D4AF37
  const INK = "#1A1A1A";
  const bannerY = I_TOP;
  const bannerMidY = I_TOP + BANNER_H / 2;
  const qrSize = 160;
  const qrX = I_RIGHT - qrSize;
  const qrY = I_TOP;
  const centreX = (PANEL_RIGHT + qrX) / 2;

  // ── 1. BACKGROUND FILL ───────────────────────────────────────────────────
  // White-paper: uniform white. Holographic: the label colour (gold/black) so
  // the back matches the front and the holographic lettering shows through.
  const backBg = HOLOGRAPHIC_PAPER ? labelBg : WHITE;
  ctx.fillStyle = backBg;
  ctx.fillRect(I_LEFT, I_TOP, I_W, I_H);

  // ── 2. BANNER fillRect ───────────────────────────────────────────────────
  // White-paper: dark banner strip behind GRADED UNDER / MVGS / GRADING
  // STANDARD. Holographic: filled with the label colour so there is no black
  // strip — the holographic text sits directly on the label. Same rect.
  ctx.fillStyle = HOLOGRAPHIC_PAPER ? labelBg : BANNER_BG;
  ctx.fillRect(PANEL_RIGHT, I_TOP, I_RIGHT - PANEL_RIGHT, BANNER_H);

  // ── 3. BANNER TEXT ───────────────────────────────────────────────────────
  // Pre-compute the MVGS mark geometry so the two side texts can centre
  // themselves against the mark's left and right edges (PANEL_RIGHT ↔
  // markRectX for "GRADED UNDER", markRight ↔ qrX for "GRADING STANDARD").
  // Founder review of the printed holographic sample: MVGS mark ~25% larger,
  // GRADED UNDER / GRADING STANDARD bigger, holographic mode only — the
  // white-paper back label (already approved, unchanged) keeps its sizes.
  const markFontSize = HOLOGRAPHIC_PAPER ? 28 : 22; // was 22; holo: +~25%
  const markPadX = HOLOGRAPHIC_PAPER ? 25 : 20;
  const markPadY = HOLOGRAPHIC_PAPER ? 10 : 8;
  const bandFontSize = HOLOGRAPHIC_PAPER ? 18 : 14; // GRADED UNDER / GRADING STANDARD, was 14
  ctx.save();
  ctx.font = `bold ${markFontSize}px ${MV_SERIF}`;
  (ctx as any).letterSpacing = "2px";
  const markTextW = ctx.measureText("MVGS").width;
  ctx.restore();
  const markRectW = Math.round(markTextW + markPadX * 2);
  const markRectH = Math.round(markFontSize + markPadY * 2);
  let markRectX = Math.round(centreX - markRectW / 2);
  const minMarkX = Math.round(PANEL_RIGHT + 10);
  if (markRectX < minMarkX) markRectX = minMarkX;
  const markRectY = Math.round(bannerMidY - markRectH / 2);
  const markRight = markRectX + markRectW;
  const markTextX = Math.round(markRectX + markRectW / 2);
  const markTextY = Math.round(markRectY + markPadY + markFontSize * 0.85);

  // Left — "GRADED UNDER" centred between the gold left panel and the
  // MVGS box.
  ctx.save();
  ctx.font = `900 ${bandFontSize}px ${MV_SANS}`;
  (ctx as any).letterSpacing = "1.5px";
  ctx.fillStyle = "#FFFFFF";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // Defensive min clamp: if the MVGS box ever sits flush against the
  // gold panel (markRectX hits the PANEL_RIGHT+10 floor), the corridor
  // midpoint would slide left of the band itself. Force minimum
  // PANEL_RIGHT + 40 so the text always reads inside the band.
  const gradedUnderX = Math.max(PANEL_RIGHT + 40, Math.round((PANEL_RIGHT + markRectX) / 2));
  ctx.fillText("GRADED UNDER", gradedUnderX, bannerMidY);
  ctx.restore();

  // Centre — MVGS gold-bordered mark. Coordinates are integer-rounded and
  // imageSmoothingEnabled is off so the rect edges and glyph baselines
  // hit whole pixels (no AA fuzz).
  ctx.save();
  (ctx as any).imageSmoothingEnabled = false;
  ctx.font = `bold ${markFontSize}px ${MV_SERIF}`;
  (ctx as any).letterSpacing = "2px";
  ctx.strokeStyle = HOLOGRAPHIC_PAPER ? holoFg : GOLD_MARK;
  ctx.lineWidth = 3;
  ctx.strokeRect(markRectX, markRectY, markRectW, markRectH);
  ctx.fillStyle = HOLOGRAPHIC_PAPER ? holoFg : GOLD_MARK;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("MVGS", markTextX, markTextY);
  ctx.restore();

  // Right — "GRADING STANDARD" centred between the MVGS box right edge
  // and the QR's left edge.
  ctx.save();
  ctx.font = `900 ${bandFontSize}px ${MV_SANS}`;
  (ctx as any).letterSpacing = "1.5px";
  ctx.fillStyle = "#FFFFFF";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("GRADING STANDARD", Math.round((markRight + qrX) / 2), bannerMidY);
  ctx.restore();

  // ── 4. LEFT PANEL fillRect ───────────────────────────────────────────────
  // White-paper: gold strip for the rotated MINTVAULT wordmark. Holographic:
  // filled with the label colour so it is a seamless field with the holographic
  // wordmark on top. Same rect/position.
  ctx.fillStyle = HOLOGRAPHIC_PAPER ? labelBg : GOLD_LIGHT;
  ctx.fillRect(PANEL_X, I_TOP, PANEL_W, I_BOTTOM - I_TOP);

  // ── 5. MINTVAULT ROTATED TEXT ────────────────────────────────────────────
  ctx.save();
  ctx.translate(39, 118);
  ctx.rotate(-Math.PI / 2);
  ctx.font = `bold 28px ${MV_SERIF}`;
  (ctx as any).letterSpacing = "3px";
  ctx.fillStyle = HOLOGRAPHIC_PAPER ? holoFg : INK;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("MINTVAULT", 0, 0);
  ctx.restore();

  // ── 6. URL ───────────────────────────────────────────────────────────────
  // Founder review: double size in holographic mode (white-paper unchanged).
  // Baseline pushed down from +38 to +50 so the taller glyphs clear the
  // banner above (verified by rendering — see commit note).
  ctx.save();
  const urlFontSize = HOLOGRAPHIC_PAPER ? 52 : 26;
  ctx.font = `bold ${urlFontSize}px ${MV_SERIF}`;
  (ctx as any).letterSpacing = "1.5px";
  ctx.fillStyle = HOLOGRAPHIC_PAPER ? holoFg : INK;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("mintvaultuk.com", centreX, I_TOP + BANNER_H + (HOLOGRAPHIC_PAPER ? 50 : 38));
  ctx.restore();

  // ── 7. TAP NFC TEXT ──────────────────────────────────────────────────────
  // Founder review: double size in holographic mode. Baseline pulled up from
  // -28 to -40 so the taller glyphs clear the inner frame below.
  ctx.save();
  const nfcFontSize = HOLOGRAPHIC_PAPER ? 40 : 20;
  ctx.font = `bold ${nfcFontSize}px ${MV_SERIF}`;
  (ctx as any).letterSpacing = "1.5px";
  ctx.fillStyle = HOLOGRAPHIC_PAPER ? holoFg : INK;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("Tap NFC to verify", centreX, I_BOTTOM - (HOLOGRAPHIC_PAPER ? 40 : 28));
  ctx.restore();

  // ── 8. QR CODE ───────────────────────────────────────────────────────────
  const certUrl = getCertUrl(cert.certId);
  // White-paper: black-on-white QR on a white box. Holographic: black-on-qrBg
  // (silver on black label, gold on gold label) — a PRINTED light background so
  // the QR is high-contrast and scannable with no holographic shimmer behind it.
  const qrBuf = await generateQRBuffer(certUrl, qrSize, qrBg);
  const qrImg = await loadImage(qrBuf);
  ctx.fillStyle = qrBg;
  ctx.fillRect(qrX, qrY, qrSize, qrSize);
  ctx.drawImage(qrImg, qrX, qrY, qrSize, qrSize);

  // ── 9. CERT NUMBER ───────────────────────────────────────────────────────
  // Right-anchored below the QR, between QR bottom and inner-frame bottom.
  ctx.save();
  const certFontH = 24;
  const certMidY = Math.round((qrY + qrSize + I_BOTTOM) / 2);
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const certBackFit = fitFontSize(ctx, cert.certId.replace(/^MV/, ""), qrSize - 8, certFontH, 14);
  ctx.font = `bold ${certBackFit}px ${MV_SANS}`;
  ctx.fillStyle = HOLOGRAPHIC_PAPER ? holoFg : INK;
  ctx.fillText(cert.certId.replace(/^MV/, ""), qrX + qrSize - 8, certMidY);
  ctx.restore();

  // ── 10. FRAME (last) ─────────────────────────────────────────────────────
  // Painted last so nothing can bleed into the border. WHITE (holographic
  // border) in holo mode, else gold.
  drawGoldFrame(ctx, HOLOGRAPHIC_PAPER ? WHITE : GOLD_LIGHT);

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

export async function generateLabelPDF(cert: CertificateRecord, side: "front" | "back" | "both"): Promise<Buffer> {
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
          Title: `MintVault Label - ${cert.certId}`,
          Author: "MintVault Trading Card Grading",
        },
      });

      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
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
