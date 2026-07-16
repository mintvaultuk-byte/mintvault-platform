/**
 * MintVault Pokémon Identification Handbook + desk-sheet PDF generators.
 *
 * Reads the ONE shared catalogue (shared/pokemon-rarity-catalogue.ts) + the
 * knowledge layer (shared/pokemon-knowledge.ts); sets are injected by the
 * caller from the DB set directory. Follows the house PDF recipe
 * (certificate-document.ts pattern): A4, Helvetica built-ins, buffer-collect.
 *
 * Symbols (★●◆…) are NOT in Helvetica's WinAnsi set, so every rarity symbol is
 * DRAWN with vector primitives — same geometry/colours as the client
 * RaritySymbol component, so screen and paper match. All flowing text is
 * WinAnsi-safe (é is fine; glyph characters are never written as text).
 *
 * No customer data, no cert data, no secrets — catalogue + set-directory only.
 */
import PDFDocument from "pdfkit";
import path from "path";
import {
  POKEMON_RARITIES,
  POKEMON_FINISHES,
  POKEMON_PROMOS,
  describeSymbol,
  type PokemonRarity,
  type RaritySymbol,
  type SymbolColour,
} from "@shared/pokemon-rarity-catalogue";
import {
  KNOWLEDGE_CATALOGUE_VERSION,
  catalogueChecksum,
  provenanceFor,
  knowledgeNoteFor,
  ERA_TIMELINE,
  LANGUAGE_GUIDE,
  COMPARISON_PAIRS,
} from "@shared/pokemon-knowledge";
import { COMPANY } from "@shared/company";

// ── Geometry + palette (house recipe) ─────────────────────────────────────────
const PAGE_W = 595.28; // A4 portrait
const PAGE_H = 841.89;
const MARGIN = 40;
const CONTENT_W = PAGE_W - MARGIN * 2;

const GOLD = "#D4AF37";
const GOLD_DARK = "#B8960C";
const NAVY = "#0f1e33";
const GRAY_DARK = "#1a1a1a";
const GRAY_MID = "#555555";
const GRAY_LIGHT = "#888888";
const CREAM = "#f5f0e8";

const LOGO_PATH = path.join(process.cwd(), "public", "brand", "logo.png");

const DISCLAIMER =
  "MintVault internal identification reference. Pokémon and related marks belong to their respective owners.";

// Symbol fills — identical to client RaritySymbol.tsx so paper matches screen.
const SYM_FILL: Record<SymbolColour, string> = {
  gold: "#C8A227",
  silver: "#AEB4BC",
  black: "#1b1b1f",
  bronze: "#A9713B",
  white: "#f5f5f5",
  rainbow: "#b14dff", // flat fallback (pdfkit has no easy multi-stop diagonal here)
  none: "#ffffff",
};
const SYM_STROKE: Record<SymbolColour, string> = {
  gold: "#8a6d12",
  silver: "#7d828a",
  black: "#000000",
  bronze: "#6f4a24",
  white: "#c9c9c9",
  rainbow: "#7a3ea8",
  none: "#9aa0a8",
};

type Doc = InstanceType<typeof PDFDocument>;

// ── Vector symbol drawing (same shapes as the client component) ───────────────
function starPoints(cx: number, cy: number, r: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < 10; i++) {
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = i % 2 === 0 ? r : r * 0.45;
    pts.push([cx + rad * Math.cos(angle), cy + rad * Math.sin(angle)]);
  }
  return pts;
}

function drawPolygon(doc: Doc, pts: [number, number][], fill: string, stroke: string): void {
  doc.save().moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) doc.lineTo(pts[i][0], pts[i][1]);
  doc.closePath().fillAndStroke(fill, stroke).restore();
}

/** Draw a rarity symbol centred at (cx, cy); `size` = symbol height in points. */
export function drawRaritySymbol(doc: Doc, symbol: RaritySymbol, cx: number, cy: number, size: number): void {
  const fill = SYM_FILL[symbol.colour];
  const stroke = SYM_STROKE[symbol.colour];
  const count = symbol.count ?? 1;
  const r = size / 2;
  switch (symbol.shape) {
    case "circle":
      doc.save().circle(cx, cy, r * 0.85).fillAndStroke(fill, stroke).restore();
      return;
    case "diamond":
      drawPolygon(doc, [[cx, cy - r], [cx + r, cy], [cx, cy + r], [cx - r, cy]], fill, stroke);
      return;
    case "star":
      drawPolygon(doc, starPoints(cx, cy, r), fill, stroke);
      return;
    case "stars": {
      const gap = size * 1.05;
      const startX = cx - ((count - 1) * gap) / 2;
      for (let i = 0; i < count; i++) drawPolygon(doc, starPoints(startX + i * gap, cy, r * 0.8), fill, stroke);
      return;
    }
    case "shiny": {
      // Four-point sparkle(s).
      const n = symbol.count ?? 1;
      const gap = size * 0.95;
      const startX = cx - ((n - 1) * gap) / 2;
      for (let i = 0; i < n; i++) {
        const x = startX + i * gap;
        drawPolygon(
          doc,
          [[x, cy - r], [x + r * 0.28, cy - r * 0.28], [x + r, cy], [x + r * 0.28, cy + r * 0.28], [x, cy + r], [x - r * 0.28, cy + r * 0.28], [x - r, cy], [x - r * 0.28, cy - r * 0.28]],
          fill,
          stroke,
        );
      }
      return;
    }
    case "text": {
      // Rounded badge with the code text (ASCII codes like SAR/RR are WinAnsi-safe).
      const label = symbol.glyph.replace(/[^\x20-\xFF]/g, "?");
      const w = Math.max(size * 1.4, label.length * size * 0.42);
      doc.save().roundedRect(cx - w / 2, cy - r * 0.72, w, r * 1.44, 3).fillAndStroke(fill, stroke);
      doc
        .font("Helvetica-Bold")
        .fontSize(size * 0.5)
        .fillColor(symbol.colour === "black" || symbol.colour === "none" ? "#ffffff" : "#1a1a1a")
        .text(label, cx - w / 2, cy - size * 0.27, { width: w, align: "center" });
      doc.restore();
      return;
    }
    case "none":
    default:
      doc.save().font("Helvetica").fontSize(size * 0.8).fillColor(GRAY_LIGHT).text("-", cx - 3, cy - size * 0.4).restore();
  }
}

// ── Small layout helpers ──────────────────────────────────────────────────────
function sectionHeading(doc: Doc, y: number, title: string): number {
  doc.font("Helvetica-Bold").fontSize(16).fillColor(NAVY).text(title, MARGIN, y);
  doc.rect(MARGIN, y + 21, CONTENT_W, 1.2).fill(GOLD);
  return y + 32;
}

function statusTag(status: string): string {
  return status === "verified" ? "" : ` (${status.replace(/_/g, " ")})`;
}

function newPage(doc: Doc): number {
  doc.addPage();
  return MARGIN;
}

function ensureSpace(doc: Doc, y: number, needed: number): number {
  return y + needed > PAGE_H - 60 ? newPage(doc) : y;
}

function drawLogoOrWordmark(doc: Doc, y: number, width = 90): number {
  const x = (PAGE_W - width) / 2;
  try {
    const img = (doc as unknown as { openImage: (p: string) => { width: number; height: number } }).openImage(LOGO_PATH);
    const h = Math.round(width * (img.height / img.width));
    doc.image(LOGO_PATH, x, y, { width });
    return y + h;
  } catch {
    doc.font("Helvetica-Bold").fontSize(20).fillColor(GOLD).text("MINTVAULT UK", MARGIN, y + 6, { width: CONTENT_W, align: "center" });
    return y + 30;
  }
}

function collect(doc: Doc): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}

/** Footer painted on every page after content (bufferPages). Writing text near
 *  the bottom margin would make pdfkit auto-append a blank page, so we zero the
 *  page's bottom margin for the duration of each footer write. */
function paintFooters(doc: Doc, titleForFooter: string): void {
  const range = doc.bufferedPageRange();
  const generated = new Date().toISOString().slice(0, 10);
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = PAGE_H - 34;
    doc.rect(MARGIN, y - 6, CONTENT_W, 0.6).fill(GOLD);
    doc
      .font("Helvetica")
      .fontSize(6.5)
      .fillColor(GRAY_LIGHT)
      .text(
        `${titleForFooter}  |  v${KNOWLEDGE_CATALOGUE_VERSION} (${catalogueChecksum()})  |  Generated ${generated}  |  ${DISCLAIMER}`,
        MARGIN,
        y,
        { width: CONTENT_W - 90, align: "left", lineBreak: false },
      );
    doc.font("Helvetica").fontSize(7).fillColor(GRAY_MID).text(`Page ${i - range.start + 1} of ${range.count}`, PAGE_W - MARGIN - 60, y, { width: 60, align: "right", lineBreak: false });
    doc.page.margins.bottom = savedBottom;
  }
}

// ── Set rows injected by the route (from the DB set directory) ────────────────
export interface HandbookSetRow {
  setCode: string | null;
  name: string;
  year: string | null;
  region: string | null;
  language: string | null;
  era: string | null;
  status: string;
}

export interface HandbookOptions {
  sets: HandbookSetRow[];
  /** Tests pass false so text assertions can read the raw streams. Default true. */
  compress?: boolean;
}

// ── Rarity tile (shared by handbook + desk sheet) ─────────────────────────────
function rarityTile(doc: Doc, r: PokemonRarity, x: number, y: number, w: number, h: number, symbolSize: number): void {
  doc.save().roundedRect(x, y, w, h, 5).fillAndStroke("#ffffff", "#d8d2c4").restore();
  drawRaritySymbol(doc, r.symbol, x + w / 2, y + symbolSize / 2 + 10, symbolSize);
  const prov = provenanceFor("rarity", r.value);
  const codes = r.codes.length ? ` [${r.codes.join("/")}]` : "";
  let label = `${r.label}${codes}`;
  // Keep the label to ONE line so it can never overlap the description row.
  doc.font("Helvetica-Bold").fontSize(8.5);
  while (label.length > 8 && doc.widthOfString(label) > w - 10) label = label.slice(0, -1);
  if (label !== `${r.label}${codes}`) label = label.replace(/\s*\[?[^[]*$/, "").trim() || r.label.slice(0, 18);
  doc.fillColor(GRAY_DARK).text(label, x + 4, y + symbolSize + 16, { width: w - 8, align: "center", lineBreak: false });
  doc
    .font("Helvetica")
    .fontSize(6.5)
    .fillColor(GRAY_MID)
    .text(describeSymbol(r.symbol) + statusTag(prov.status), x + 4, y + symbolSize + 28, { width: w - 8, align: "center", height: 16, ellipsis: true });
}

// ═══════════════════════════════ HANDBOOK ═════════════════════════════════════
export async function generateHandbookPdf(opts: HandbookOptions): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    bufferPages: true,
    compress: opts.compress !== false,
    info: { Title: "MintVault Pokemon Card Identification Guide", Author: COMPANY.legalName },
  });
  const done = collect(doc);

  // ── Page 1 · Cover (premium dark) ──
  doc.rect(0, 0, PAGE_W, PAGE_H).fill(NAVY);
  doc.rect(0, 0, PAGE_W, 6).fill(GOLD);
  doc.rect(0, PAGE_H - 6, PAGE_W, 6).fill(GOLD);
  let y = 170;
  y = drawLogoOrWordmark(doc, y, 120) + 40;
  doc.font("Helvetica-Bold").fontSize(28).fillColor("#ffffff").text("MintVault Pokemon Card", MARGIN, y, { width: CONTENT_W, align: "center" });
  doc.text("Identification Guide", MARGIN, y + 34, { width: CONTENT_W, align: "center" });
  doc.font("Helvetica").fontSize(13).fillColor(GOLD).text("Official Internal Grading Reference", MARGIN, y + 82, { width: CONTENT_W, align: "center" });
  // Sample symbol strip on the cover — each symbol sits on a light chip so the
  // black-star symbols stay visible against the navy background.
  const strip = ["rare", "double_rare", "illustration_rare", "ultra_rare", "special_illustration_rare", "hyper_rare"];
  let sx = PAGE_W / 2 - (strip.length - 1) * 35;
  for (const v of strip) {
    const rr = POKEMON_RARITIES.find((x) => x.value === v);
    if (rr) {
      const chipW = rr.symbol.shape === "stars" ? 58 : 40;
      doc.save().roundedRect(sx - chipW / 2, y + 134, chipW, 32, 6).fillAndStroke("#f6f2e8", GOLD_DARK).restore();
      drawRaritySymbol(doc, rr.symbol, sx, y + 150, 20);
    }
    sx += 70;
  }
  doc.font("Helvetica").fontSize(9).fillColor("#9fb0c8").text(
    `Catalogue v${KNOWLEDGE_CATALOGUE_VERSION}  ·  ${catalogueChecksum()}  ·  Generated ${new Date().toISOString().slice(0, 10)}`,
    MARGIN, PAGE_H - 120, { width: CONTENT_W, align: "center" });
  doc.fontSize(7.5).fillColor("#7a8aa0").text(DISCLAIMER, MARGIN, PAGE_H - 100, { width: CONTENT_W, align: "center" });

  // ── Printed rarities ──
  y = newPage(doc);
  y = sectionHeading(doc, y, "Printed Rarities");
  doc.font("Helvetica").fontSize(8.5).fillColor(GRAY_MID).text(
    "The rarity symbol or letter code printed on the card. Colour + star count matter: gold vs silver and one vs two stars are DIFFERENT tiers. Provisional records are labelled.",
    MARGIN, y, { width: CONTENT_W });
  y += 26;
  const tileW = (CONTENT_W - 3 * 8) / 4;
  const tileH = 74;
  let col = 0;
  for (const r of POKEMON_RARITIES) {
    y = ensureSpace(doc, y, tileH + 8);
    if (y === MARGIN) { y = sectionHeading(doc, y, "Printed Rarities (continued)"); col = 0; }
    rarityTile(doc, r, MARGIN + col * (tileW + 8), y, tileW, tileH, 22);
    col++;
    if (col === 4) { col = 0; y += tileH + 8; }
  }
  if (col !== 0) y += tileH + 8;

  // ── Finishes ──
  y = newPage(doc);
  y = sectionHeading(doc, y, "Finish / Variant Types");
  doc.font("Helvetica").fontSize(8.5).fillColor(GRAY_MID).text(
    "The card's surface treatment or print run. A finish is NOT a rarity - a card has both.",
    MARGIN, y, { width: CONTENT_W });
  y += 22;
  for (const f of POKEMON_FINISHES) {
    y = ensureSpace(doc, y, 34);
    if (y === MARGIN) y = sectionHeading(doc, y, "Finish / Variant Types (continued)");
    const note = knowledgeNoteFor("finish", f.value);
    const prov = provenanceFor("finish", f.value);
    doc.save().roundedRect(MARGIN, y, CONTENT_W, 30, 4).fillAndStroke(y % 68 < 34 ? "#ffffff" : CREAM, "#e2dccd").restore();
    doc.font("Helvetica-Bold").fontSize(9).fillColor(GRAY_DARK).text(f.label + statusTag(prov.status), MARGIN + 8, y + 5, { width: 150 });
    doc.font("Helvetica").fontSize(7.5).fillColor(GRAY_MID).text(
      note ? `${f.description} ${note.identification}` : f.description,
      MARGIN + 165, y + 5, { width: CONTENT_W - 175, height: 22 });
    y += 34;
  }

  // ── Promos / subsets / stamps ──
  y = newPage(doc);
  y = sectionHeading(doc, y, "Promo Programmes, Subsets & Stamps");
  doc.font("Helvetica").fontSize(8.5).fillColor(GRAY_MID).text(
    "Promos and subsets are SEPARATE from printed rarity. Stamps (Staff, Prerelease, Pokemon Center, League, Championship) are recorded as finishes.",
    MARGIN, y, { width: CONTENT_W });
  y += 26;
  for (const kind of ["promo", "subset"] as const) {
    doc.font("Helvetica-Bold").fontSize(11).fillColor(GOLD_DARK).text(kind === "promo" ? "Promo programmes" : "Subsets", MARGIN, y);
    y += 16;
    for (const p of POKEMON_PROMOS.filter((x) => x.kind === kind)) {
      y = ensureSpace(doc, y, 26);
      const prov = provenanceFor("promo", p.value);
      const note = knowledgeNoteFor("promo", p.value);
      doc.font("Helvetica-Bold").fontSize(8.5).fillColor(GRAY_DARK).text(`• ${p.label}${statusTag(prov.status)}`, MARGIN + 6, y, { width: 170 });
      doc.font("Helvetica").fontSize(7.5).fillColor(GRAY_MID).text(note ? `${p.description} ${note.identification}` : p.description, MARGIN + 180, y, { width: CONTENT_W - 190 });
      y += 24;
    }
    y += 8;
  }

  // ── Set code directory ──
  y = newPage(doc);
  y = sectionHeading(doc, y, "Set Code Quick Directory");
  if (opts.sets.length === 0) {
    doc.font("Helvetica").fontSize(9).fillColor(GRAY_MID).text(
      "No sets in the knowledge directory yet - add sets in Admin > Pokemon Knowledge, then regenerate this handbook.",
      MARGIN, y, { width: CONTENT_W });
    y += 20;
  } else {
    const cols = [70, 210, 45, 90, 105]; // code, set, year, region/lang, era
    const header = ["Code", "Set", "Year", "Region / Language", "Era"];
    const drawHeader = (yy: number): number => {
      doc.save().rect(MARGIN, yy, CONTENT_W, 16).fill(NAVY).restore();
      let xx = MARGIN + 6;
      header.forEach((h, i) => { doc.font("Helvetica-Bold").fontSize(8).fillColor("#ffffff").text(h, xx, yy + 4, { width: cols[i] }); xx += cols[i]; });
      return yy + 18;
    };
    y = drawHeader(y);
    let row = 0;
    for (const s of opts.sets) {
      y = ensureSpace(doc, y, 15);
      if (y === MARGIN) { y = sectionHeading(doc, y, "Set Code Quick Directory (continued)"); y = drawHeader(y); row = 0; }
      if (row % 2 === 1) doc.save().rect(MARGIN, y - 2, CONTENT_W, 14).fill(CREAM).restore();
      const vals = [
        s.setCode ?? "-",
        s.name + (s.status !== "verified" ? ` (${s.status.replace(/_/g, " ")})` : ""),
        s.year ?? "-",
        [s.region, s.language].filter(Boolean).join(" / ") || "-",
        s.era ?? "-",
      ];
      let xx = MARGIN + 6;
      vals.forEach((v, i) => { doc.font(i === 0 ? "Helvetica-Bold" : "Helvetica").fontSize(7.5).fillColor(GRAY_DARK).text(String(v).slice(0, 60), xx, y, { width: cols[i] - 6, height: 12 }); xx += cols[i]; });
      y += 14;
      row++;
    }
  }

  // ── Languages ──
  y = newPage(doc);
  y = sectionHeading(doc, y, "Languages & Regional Identification");
  for (const l of LANGUAGE_GUIDE) {
    if (l.key === "other") continue;
    y = ensureSpace(doc, y, 44);
    if (y === MARGIN) y = sectionHeading(doc, y, "Languages (continued)");
    doc.font("Helvetica-Bold").fontSize(9.5).fillColor(GRAY_DARK).text(`${l.label}  (${l.region})`, MARGIN, y);
    // Non-Latin sample scripts can't render in Helvetica — describe instead.
    doc.font("Helvetica").fontSize(7.5).fillColor(GRAY_MID).text(
      `Set codes: ${l.setCodeFormat}. Rarity: ${l.rarityFormat}. ${l.tips[0] ?? ""}`,
      MARGIN + 6, y + 12, { width: CONTENT_W - 12 });
    if (l.commonMistakes[0]) {
      doc.font("Helvetica-Oblique").fontSize(7).fillColor(GOLD_DARK).text(`Watch out: ${l.commonMistakes[0]}`, MARGIN + 6, y + 30, { width: CONTENT_W - 12 });
    }
    y += 44;
  }

  // ── Era timeline ──
  y = newPage(doc);
  y = sectionHeading(doc, y, "Era Timeline");
  for (const e of ERA_TIMELINE) {
    if (e.key === "future") continue;
    y = ensureSpace(doc, y, 52);
    if (y === MARGIN) y = sectionHeading(doc, y, "Era Timeline (continued)");
    doc.save().circle(MARGIN + 5, y + 6, 3.2).fillAndStroke(GOLD, GOLD_DARK).restore();
    doc.font("Helvetica-Bold").fontSize(9.5).fillColor(GRAY_DARK).text(`${e.label}  ·  ${e.yearsApprox}`, MARGIN + 16, y);
    doc.font("Helvetica").fontSize(7.5).fillColor(GRAY_MID).text(
      `Rarities: ${e.raritySystemNotes}  Codes: ${e.codeFormatNotes}`,
      MARGIN + 16, y + 12, { width: CONTENT_W - 20 });
    doc.rect(MARGIN + 4.5, y + 12, 1, 36).fill("#e2dccd");
    y += 52;
  }

  // ── Common-confusion comparisons ──
  y = newPage(doc);
  y = sectionHeading(doc, y, "Common Confusions - Side by Side");
  for (const c of COMPARISON_PAIRS) {
    y = ensureSpace(doc, y, 64);
    if (y === MARGIN) y = sectionHeading(doc, y, "Common Confusions (continued)");
    doc.save().roundedRect(MARGIN, y, CONTENT_W, 58, 5).fillAndStroke("#ffffff", "#d8d2c4").restore();
    doc.font("Helvetica-Bold").fontSize(9).fillColor(NAVY).text(c.title, MARGIN + 8, y + 6, { width: CONTENT_W - 16 });
    const leftR = POKEMON_RARITIES.find((r) => r.value === c.left.value);
    const rightR = POKEMON_RARITIES.find((r) => r.value === c.right.value);
    if (leftR) drawRaritySymbol(doc, leftR.symbol, MARGIN + 60, y + 36, 18);
    doc.font("Helvetica-Bold").fontSize(7).fillColor(GRAY_MID).text("VS", MARGIN + 105, y + 32, { width: 20, align: "center" });
    if (rightR) drawRaritySymbol(doc, rightR.symbol, MARGIN + 170, y + 36, 18);
    doc.font("Helvetica").fontSize(7.5).fillColor(GRAY_MID).text(c.howToTell, MARGIN + 230, y + 22, { width: CONTENT_W - 240, height: 34 });
    y += 64;
  }

  // ── Final page · quick-reference grid ──
  y = newPage(doc);
  y = sectionHeading(doc, y, "MintVault Quick Reference");
  const quick = ["common", "uncommon", "rare", "double_rare", "illustration_rare", "ultra_rare", "special_illustration_rare", "hyper_rare", "shiny_rare", "ace_spec", "jp_art_rare", "jp_special_art_rare"];
  col = 0;
  for (const v of quick) {
    const r = POKEMON_RARITIES.find((x) => x.value === v);
    if (!r) continue;
    rarityTile(doc, r, MARGIN + col * (tileW + 8), y, tileW, 80, 26);
    col++;
    if (col === 4) { col = 0; y += 88; }
  }
  y += col !== 0 ? 88 : 0;
  doc.font("Helvetica").fontSize(8).fillColor(GRAY_MID).text(
    "Rule of thumb: identify the LANGUAGE first, then the PRINTED SYMBOL OR CODE, then the FINISH, then any PROMO/SUBSET marking. Record each separately in the grading picker.",
    MARGIN, y + 6, { width: CONTENT_W });

  paintFooters(doc, "MintVault Pokemon Card Identification Guide");
  doc.end();
  return done;
}

// ═══════════════════════════════ DESK SHEETS ══════════════════════════════════
export type DeskSheetKind = "rarities" | "finishes" | "promos" | "setcodes" | "languages";

export const DESK_SHEET_FILENAMES: Record<DeskSheetKind, string> = {
  rarities: "MintVault_Rarity_Symbols_Desk_Sheet.pdf",
  finishes: "MintVault_Finish_Comparison_Desk_Sheet.pdf",
  promos: "MintVault_Promo_Subset_Quick_Guide.pdf",
  setcodes: "MintVault_Set_Code_Quick_Directory.pdf",
  languages: "MintVault_Language_Identification_Sheet.pdf",
};

/** A4 LANDSCAPE desk sheets with oversized symbols (>= ~57pt = 20mm). */
export async function generateDeskSheetPdf(kind: DeskSheetKind, opts: HandbookOptions): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    layout: "landscape",
    margins: { top: 30, bottom: 30, left: 34, right: 34 },
    bufferPages: true,
    compress: opts.compress !== false,
    info: { Title: `MintVault Desk Sheet - ${kind}`, Author: COMPANY.legalName },
  });
  const done = collect(doc);
  const LW = PAGE_H; // landscape width = portrait height
  const LH = PAGE_W;
  const LM = 34;
  const LCW = LW - LM * 2;

  const title: Record<DeskSheetKind, string> = {
    rarities: "Rarity Symbols - Large Reference",
    finishes: "Finish Comparison",
    promos: "Promo & Subset Quick Guide",
    setcodes: "Set Code Quick Directory",
    languages: "Language Identification",
  };
  doc.rect(0, 0, LW, 42).fill(NAVY);
  doc.rect(0, 42, LW, 3).fill(GOLD);
  doc.font("Helvetica-Bold").fontSize(17).fillColor("#ffffff").text(`MintVault  ·  ${title[kind]}`, LM, 12);
  let y = 58;

  if (kind === "rarities") {
    // Oversized tiles: symbol ~60pt (~21mm), 5 per row.
    const w = (LCW - 4 * 10) / 5;
    const h = 118;
    let colL = 0;
    for (const r of POKEMON_RARITIES) {
      if (y + h > LH - 46) { doc.addPage({ layout: "landscape" }); y = 58; colL = 0; }
      rarityTile(doc, r, LM + colL * (w + 10), y, w, h, 58);
      colL++;
      if (colL === 5) { colL = 0; y += h + 10; }
    }
  } else if (kind === "finishes") {
    for (const f of POKEMON_FINISHES) {
      if (y + 40 > LH - 46) { doc.addPage({ layout: "landscape" }); y = 58; }
      const note = knowledgeNoteFor("finish", f.value);
      doc.save().roundedRect(LM, y, LCW, 36, 5).fillAndStroke("#ffffff", "#d8d2c4").restore();
      doc.font("Helvetica-Bold").fontSize(12).fillColor(GRAY_DARK).text(f.label, LM + 10, y + 6, { width: 200 });
      doc.font("Helvetica").fontSize(9).fillColor(GRAY_MID).text(
        note ? `${f.description} ${note.identification}${note.commonMistakes[0] ? ` Watch: ${note.commonMistakes[0]}` : ""}` : f.description,
        LM + 220, y + 6, { width: LCW - 235, height: 26 });
      y += 40;
    }
  } else if (kind === "promos") {
    for (const p of POKEMON_PROMOS) {
      if (y + 34 > LH - 46) { doc.addPage({ layout: "landscape" }); y = 58; }
      doc.save().roundedRect(LM, y, LCW, 30, 5).fillAndStroke(p.kind === "subset" ? CREAM : "#ffffff", "#d8d2c4").restore();
      doc.font("Helvetica-Bold").fontSize(11).fillColor(GRAY_DARK).text(`${p.label}  [${p.kind.toUpperCase()}]`, LM + 10, y + 6, { width: 260 });
      doc.font("Helvetica").fontSize(9).fillColor(GRAY_MID).text(p.description, LM + 280, y + 7, { width: LCW - 295 });
      y += 34;
    }
  } else if (kind === "setcodes") {
    const cols = [90, 300, 60, 130, 150];
    const header = ["Code", "Set", "Year", "Region / Language", "Era"];
    const drawHeader = (yy: number): number => {
      doc.save().rect(LM, yy, LCW, 20).fill(NAVY).restore();
      let xx = LM + 8;
      header.forEach((hh, i) => { doc.font("Helvetica-Bold").fontSize(10).fillColor("#ffffff").text(hh, xx, yy + 5, { width: cols[i] }); xx += cols[i]; });
      return yy + 24;
    };
    y = drawHeader(y);
    let row = 0;
    for (const s of opts.sets) {
      if (y + 18 > LH - 46) { doc.addPage({ layout: "landscape" }); y = drawHeader(58); row = 0; }
      if (row % 2 === 1) doc.save().rect(LM, y - 2, LCW, 17).fill(CREAM).restore();
      const vals = [s.setCode ?? "-", s.name, s.year ?? "-", [s.region, s.language].filter(Boolean).join(" / ") || "-", s.era ?? "-"];
      let xx = LM + 8;
      vals.forEach((v, i) => { doc.font(i === 0 ? "Helvetica-Bold" : "Helvetica").fontSize(9.5).fillColor(GRAY_DARK).text(String(v).slice(0, 70), xx, y, { width: cols[i] - 8, height: 14 }); xx += cols[i]; });
      y += 17;
      row++;
    }
    if (opts.sets.length === 0) {
      doc.font("Helvetica").fontSize(11).fillColor(GRAY_MID).text("No sets in the knowledge directory yet.", LM, y + 6);
    }
  } else {
    for (const l of LANGUAGE_GUIDE) {
      if (l.key === "other") continue;
      if (y + 44 > LH - 46) { doc.addPage({ layout: "landscape" }); y = 58; }
      doc.save().roundedRect(LM, y, LCW, 40, 5).fillAndStroke("#ffffff", "#d8d2c4").restore();
      doc.font("Helvetica-Bold").fontSize(12).fillColor(GRAY_DARK).text(l.label, LM + 10, y + 6, { width: 140 });
      doc.font("Helvetica").fontSize(9).fillColor(GRAY_MID).text(
        `Codes: ${l.setCodeFormat}  ·  Rarity: ${l.rarityFormat}  ·  ${l.tips[0] ?? ""}`,
        LM + 160, y + 6, { width: LCW - 175, height: 30 });
      y += 44;
    }
  }

  // Landscape footer — zero the bottom margin so near-edge text doesn't append pages.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font("Helvetica").fontSize(6.5).fillColor(GRAY_LIGHT).text(
      `v${KNOWLEDGE_CATALOGUE_VERSION} (${catalogueChecksum()})  ·  Generated ${new Date().toISOString().slice(0, 10)}  ·  ${DISCLAIMER}`,
      LM, LH - 26, { width: LCW - 90, lineBreak: false });
    doc.fontSize(7).fillColor(GRAY_MID).text(`Page ${i - range.start + 1} of ${range.count}`, LW - LM - 60, LH - 26, { width: 60, align: "right", lineBreak: false });
    doc.page.margins.bottom = savedBottom;
  }
  doc.end();
  return done;
}
