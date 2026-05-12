/**
 * Pure SVG builders for each Instagram post type.
 *
 * Kept separate from image-generator.ts so the SVG composition is
 * testable without sharp / node-canvas / any rendering. Each builder
 * returns a complete SVG document string sized 1080×1080. The caller
 * (image-generator.ts) composites the SVG onto a sharp-created
 * background buffer.
 *
 * BRAND tokens come from CLAUDE.md + the saved gold-palette memory:
 *   - Gold:   #D4AF37 (primary, matches client/src/styles/v2-tokens.css)
 *   - DkGold: #A07820 (deep gold, matches server/labels.ts)
 *   - Dark:   #1A1A1A (slab body ink, chosen by Cornelius)
 *
 * Bodoni Moda 900 is base64-embedded for the MintVault wordmark
 * specifically. Other text uses system serif/sans fallbacks — node-canvas
 * doesn't render here (sharp does), so font availability depends on the
 * runtime OS. Embedding only the wordmark font keeps SVG size bounded;
 * other text is set in Georgia/Helvetica which exist on every common
 * server OS.
 */
import { readFileSync } from "fs";
import path from "path";
import type { IgPostData } from "./types";

export const DIMS = { W: 1080, H: 1080 } as const;

export const BRAND = {
  gold:        "#D4AF37",
  goldDeep:    "#B8960C",
  goldDark:    "#A07820",
  dark:        "#1A1A1A",
  darkSoft:    "#2A2A2A",  // panel/card backgrounds on dark
  white:       "#FFFFFF",
  inkOnGold:   "#1A1400",
  mutedOnDark: "#A8A8A8",
} as const;

// One-line benefit copy per service tier — drives the body of the
// service_explainer post type. Keyed by service_tiers.tier_id (the raw
// canonical id, not the display name). Falls back to a generic line if a
// tier_id isn't in the map (e.g. reholder / crossover / authentication
// don't currently get IG explainer posts but the cron rotation only picks
// from standard/priority/express/gold, see selectPostType()).
export const TIER_BENEFIT: Record<string, string> = {
  standard: "Affordable grading for high-volume submissions.",
  priority: "Our default service — reliable and consistent.",
  express:  "Skip the queue when you need it fast.",
  gold:     "Premium handling for your highest-value cards.",
};

// Lazy-load Bodoni Moda 900 as base64, cached at module scope. The font file
// lives at public/brand/BodoniModa-Black.ttf (~120KB). Inlining it into every
// SVG is wasteful per render but the buffer is held once in memory.
let cachedBodoniDataUrl: string | null = null;
function bodoniDataUrl(): string {
  if (cachedBodoniDataUrl !== null) return cachedBodoniDataUrl;
  try {
    const fontPath = path.join(process.cwd(), "public", "brand", "BodoniModa-Black.ttf");
    const ttf = readFileSync(fontPath);
    cachedBodoniDataUrl = `data:font/ttf;base64,${ttf.toString("base64")}`;
  } catch {
    cachedBodoniDataUrl = "";  // graceful fallback to system serif
  }
  return cachedBodoniDataUrl;
}

// XML-escape a user-controlled string before injecting into SVG.
export function esc(s: string | undefined | null): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Very rough monospace approximation for wrapping; this is good enough for
// caps display text where each char is ~0.6em wide. Returns lines (already
// XML-escaped).
export function wrapText(text: string, maxCharsPerLine: number, maxLines = 4): string[] {
  if (!text) return [];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? line + " " + w : w;
    if (next.length <= maxCharsPerLine) {
      line = next;
    } else {
      if (line) lines.push(line);
      line = w;
    }
    if (lines.length >= maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  // Truncate the last line with ellipsis if we ran out of room.
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    lines[maxLines - 1] = lines[maxLines - 1].replace(/\s+\S+$/, "") + "…";
  }
  return lines.map(esc);
}

// ── Shared SVG fragments ──────────────────────────────────────────────────

function defsBlock(): string {
  const dataUrl = bodoniDataUrl();
  const fontFaceCss = dataUrl
    ? `@font-face { font-family: "BodoniMV"; src: url("${dataUrl}") format("truetype"); font-weight: 900; }`
    : "";
  return `<defs><style type="text/css"><![CDATA[
    ${fontFaceCss}
    .wordmark { font-family: "BodoniMV", "Bodoni Moda", "Didot", "Georgia", serif; font-weight: 900; fill: ${BRAND.gold}; }
    .display  { font-family: "Helvetica Neue", "Arial", sans-serif; font-weight: 900; }
    .body     { font-family: "Helvetica Neue", "Arial", sans-serif; font-weight: 600; }
    .label    { font-family: "Helvetica Neue", "Arial", sans-serif; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; }
  ]]></style></defs>`;
}

function wordmark(cx: number, y: number, fontSize: number): string {
  // Letter-spaced "MINTVAULT" in gold Bodoni. Single line, centred at cx.
  return `<text x="${cx}" y="${y}" class="wordmark" font-size="${fontSize}" text-anchor="middle" letter-spacing="${Math.round(fontSize * 0.06)}">MINTVAULT</text>`;
}

function tagline(cx: number, y: number, fontSize: number): string {
  return `<text x="${cx}" y="${y}" class="label" font-size="${fontSize}" fill="${BRAND.mutedOnDark}" text-anchor="middle">UK CARD AUTHENTICATION REGISTRY</text>`;
}

function url(cx: number, y: number, fontSize: number): string {
  return `<text x="${cx}" y="${y}" class="body" font-size="${fontSize}" fill="${BRAND.gold}" text-anchor="middle">mintvaultuk.com</text>`;
}

// Thin gold horizontal divider line, full-width less a small inset.
function divider(y: number, width: number = DIMS.W, inset: number = 80, opacity: number = 0.4): string {
  return `<line x1="${inset}" y1="${y}" x2="${width - inset}" y2="${y}" stroke="${BRAND.gold}" stroke-width="1" stroke-opacity="${opacity}"/>`;
}

// ── 1. card_reveal ─────────────────────────────────────────────────────────

export function svgCardReveal(d: IgPostData): string {
  const isBlackLabel = d.labelType === "black";
  const bgFill = isBlackLabel ? "#000000" : BRAND.dark;
  const gradeText = d.gradeOverall ?? "—";
  const gradeIsLong = gradeText.length >= 3;

  // Subgrade row only when all 4 are present (numeric grades).
  const hasSubgrades = !!(d.gradeCentering && d.gradeCorners && d.gradeEdges && d.gradeSurface);

  const cardName = (d.cardName ?? "Unknown").toUpperCase();
  const cardNameLines = wrapText(cardName, 18, 2);
  // Top-anchored: first line baseline at y=844. With 56px font (alphabetic
  // baseline), glyph cap-line lands ~y=800. Disc bottom is at y=740, so the
  // gap between disc and card-name top is ≥60px. Additional lines stack
  // downward at +60px each; the layout shifts DOWN for multi-line names but
  // never crashes into the disc.
  const cardNameStartY = 844;

  const setLine = [d.year, d.setName].filter(Boolean).join(" • ").toUpperCase();

  // The grade-disc badge — gold-filled circle, dark numeral inside.
  const discCx = DIMS.W / 2;
  const discCy = 540;
  const discR = 200;
  const gradeFontSize = gradeIsLong ? 200 : 240;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${DIMS.W}" height="${DIMS.H}" viewBox="0 0 ${DIMS.W} ${DIMS.H}">
${defsBlock()}
<rect width="100%" height="100%" fill="${bgFill}"/>

<!-- Header: MintVault wordmark + tagline -->
${wordmark(DIMS.W / 2, 130, 56)}
${tagline(DIMS.W / 2, 175, 18)}
${divider(220)}

<!-- Grade disc -->
<circle cx="${discCx}" cy="${discCy}" r="${discR}" fill="${BRAND.gold}"/>
<circle cx="${discCx}" cy="${discCy}" r="${discR - 8}" fill="none" stroke="${BRAND.goldDark}" stroke-width="2" stroke-opacity="0.6"/>
<text x="${discCx}" y="${discCy + gradeFontSize * 0.35}" class="display" font-size="${gradeFontSize}" fill="${BRAND.inkOnGold}" text-anchor="middle">${esc(gradeText)}</text>

<!-- Card name -->
${cardNameLines.map((line, i) =>
    `<text x="${DIMS.W / 2}" y="${cardNameStartY + i * 60}" class="display" font-size="56" fill="${BRAND.gold}" text-anchor="middle">${line}</text>`
  ).join("\n")}

<!-- Set / year line — 30px below the LAST card-name baseline (top-anchored) -->
<text x="${DIMS.W / 2}" y="${cardNameStartY + (cardNameLines.length - 1) * 60 + 30}" class="label" font-size="22" fill="${BRAND.mutedOnDark}" text-anchor="middle">${esc(setLine)}</text>

<!-- Bottom strip: subgrades + cert ID -->
${divider(960)}
${hasSubgrades ?
  `<text x="${DIMS.W / 2}" y="1000" class="body" font-size="22" fill="${BRAND.gold}" text-anchor="middle" letter-spacing="3">CTR ${esc(d.gradeCentering)} • CRN ${esc(d.gradeCorners)} • EDG ${esc(d.gradeEdges)} • SRF ${esc(d.gradeSurface)}</text>`
  : ""}
<text x="${DIMS.W / 2}" y="${hasSubgrades ? 1040 : 1010}" class="label" font-size="18" fill="${BRAND.mutedOnDark}" text-anchor="middle">CERT ${esc(d.certId ?? "—")}${d.serviceTierLabel ? ` • ${esc(d.serviceTierLabel.toUpperCase())}` : ""}</text>
</svg>`;
}

// ── 2. grade_breakdown ─────────────────────────────────────────────────────

export function svgGradeBreakdown(d: IgPostData): string {
  const overall = d.gradeOverall ?? "—";
  const insight = d.insight ?? "";
  const insightLines = wrapText(insight, 36, 4);

  // 4 subgrade bars, each shows a numeric value 0–10 as a filled rectangle.
  const subgrades = [
    { label: "CENTERING", value: parseFloat(d.gradeCentering ?? "0") },
    { label: "CORNERS",   value: parseFloat(d.gradeCorners   ?? "0") },
    { label: "EDGES",     value: parseFloat(d.gradeEdges     ?? "0") },
    { label: "SURFACE",   value: parseFloat(d.gradeSurface   ?? "0") },
  ];
  const barX = 140;
  const barW = DIMS.W - barX * 2;
  const barH = 22;
  const barRowY0 = 460;
  const barRowGap = 90;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${DIMS.W}" height="${DIMS.H}" viewBox="0 0 ${DIMS.W} ${DIMS.H}">
${defsBlock()}
<rect width="100%" height="100%" fill="${BRAND.dark}"/>

${wordmark(DIMS.W / 2, 130, 50)}
${divider(180)}

<!-- Headline -->
<text x="${DIMS.W / 2}" y="290" class="label" font-size="22" fill="${BRAND.mutedOnDark}" text-anchor="middle">WHY THIS CARD GOT A</text>
<text x="${DIMS.W / 2}" y="400" class="display" font-size="140" fill="${BRAND.gold}" text-anchor="middle">${esc(overall)}</text>

<!-- Subgrade bars -->
${subgrades.map((sg, i) => {
    const y = barRowY0 + i * barRowGap;
    const fillPct = Math.max(0, Math.min(10, sg.value)) / 10;
    return `
<text x="${barX}" y="${y - 12}" class="label" font-size="18" fill="${BRAND.white}">${esc(sg.label)}</text>
<text x="${barX + barW}" y="${y - 12}" class="body" font-size="18" fill="${BRAND.gold}" text-anchor="end">${sg.value.toFixed(1)} / 10</text>
<rect x="${barX}" y="${y}" width="${barW}" height="${barH}" rx="4" ry="4" fill="${BRAND.darkSoft}"/>
<rect x="${barX}" y="${y}" width="${Math.round(barW * fillPct)}" height="${barH}" rx="4" ry="4" fill="${BRAND.gold}"/>`;
  }).join("")}

<!-- Insight quote -->
${insightLines.length ? `
<text x="${DIMS.W / 2}" y="930" class="body" font-size="24" fill="${BRAND.white}" text-anchor="middle" font-style="italic">
  ${insightLines.map((line, i) => `<tspan x="${DIMS.W / 2}" dy="${i === 0 ? 0 : 32}">${line}</tspan>`).join("")}
</text>` : ""}

${url(DIMS.W / 2, 1030, 22)}
</svg>`;
}

// ── 3. service_explainer ───────────────────────────────────────────────────

export function svgServiceExplainer(d: IgPostData): string {
  const tierName = (d.tierName ?? "Standard").toUpperCase();
  // One-line benefit drives the body. Falls back to a generic catch-all when
  // the tier_id isn't in the map (defensive — selectPostType() only rotates
  // through standard/priority/express/gold, all of which are mapped).
  const benefit = (d.tierId && TIER_BENEFIT[d.tierId]) ?? "Choose the right tier for your collection.";
  const benefitLines = wrapText(benefit, 36, 3);
  const price = d.tierPricePence != null ? `£${(d.tierPricePence / 100).toFixed(2)}` : "—";
  const turnaround = d.tierTurnaroundLabel ?? (d.tierTurnaroundDays ? `${d.tierTurnaroundDays} days` : "—");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${DIMS.W}" height="${DIMS.H}" viewBox="0 0 ${DIMS.W} ${DIMS.H}">
${defsBlock()}
<rect width="100%" height="100%" fill="${BRAND.dark}"/>

${wordmark(DIMS.W / 2, 130, 50)}
${divider(180)}

<text x="${DIMS.W / 2}" y="320" class="label" font-size="22" fill="${BRAND.mutedOnDark}" text-anchor="middle">SERVICE TIER</text>
<text x="${DIMS.W / 2}" y="430" class="display" font-size="92" fill="${BRAND.gold}" text-anchor="middle">${esc(tierName)}</text>

<!-- One-line benefit (no duplication with the bottom turnaround/price row) -->
${benefitLines.length ? `
<text x="${DIMS.W / 2}" y="540" class="body" font-size="28" fill="${BRAND.white}" text-anchor="middle">
  ${benefitLines.map((line, i) => `<tspan x="${DIMS.W / 2}" dy="${i === 0 ? 0 : 38}">${line}</tspan>`).join("")}
</text>` : ""}

<!-- Two-column stat row: turnaround / price -->
${divider(750)}
<text x="${DIMS.W * 0.3}" y="830" class="label" font-size="20" fill="${BRAND.mutedOnDark}" text-anchor="middle">TURNAROUND</text>
<text x="${DIMS.W * 0.3}" y="890" class="display" font-size="56" fill="${BRAND.gold}" text-anchor="middle">${esc(turnaround)}</text>

<text x="${DIMS.W * 0.7}" y="830" class="label" font-size="20" fill="${BRAND.mutedOnDark}" text-anchor="middle">FROM</text>
<text x="${DIMS.W * 0.7}" y="890" class="display" font-size="56" fill="${BRAND.gold}" text-anchor="middle">${esc(price)}</text>

${url(DIMS.W / 2, 1020, 26)}
</svg>`;
}

// ── 4. vault_club ──────────────────────────────────────────────────────────

export function svgVaultClub(d: IgPostData): string {
  const monthly = d.vaultClubMonthly ?? "£9.99/mo";
  const annual = d.vaultClubAnnual ?? "£99/yr";
  const benefits = (d.vaultClubBenefits ?? [
    "Priority grading queue",
    "Discounted submissions",
    "Exclusive collector reports",
  ]).slice(0, 3);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${DIMS.W}" height="${DIMS.H}" viewBox="0 0 ${DIMS.W} ${DIMS.H}">
${defsBlock()}
<rect width="100%" height="100%" fill="${BRAND.dark}"/>

<!-- Gold-tinted top band -->
<rect x="0" y="0" width="${DIMS.W}" height="180" fill="${BRAND.gold}" fill-opacity="0.08"/>

${wordmark(DIMS.W / 2, 130, 50)}
${divider(180)}

<text x="${DIMS.W / 2}" y="310" class="label" font-size="22" fill="${BRAND.mutedOnDark}" text-anchor="middle">MEMBERSHIP</text>
<text x="${DIMS.W / 2}" y="420" class="display" font-size="104" fill="${BRAND.gold}" text-anchor="middle">VAULT CLUB</text>

<!-- Pricing row -->
<text x="${DIMS.W * 0.3}" y="540" class="display" font-size="56" fill="${BRAND.white}" text-anchor="middle">${esc(monthly)}</text>
<text x="${DIMS.W * 0.7}" y="540" class="display" font-size="56" fill="${BRAND.white}" text-anchor="middle">${esc(annual)}</text>

${divider(610)}

<!-- Benefits list -->
${benefits.map((b, i) => `
<text x="${DIMS.W / 2}" y="${710 + i * 70}" class="body" font-size="32" fill="${BRAND.white}" text-anchor="middle">
  <tspan fill="${BRAND.gold}">•</tspan>  ${esc(b)}
</text>`).join("")}

${url(DIMS.W / 2, 1020, 28)}
</svg>`;
}

// ── 5. market_insight ──────────────────────────────────────────────────────

export function svgMarketInsight(d: IgPostData): string {
  const stat = d.insightStat ?? "—";
  const context = d.insightContext ?? "";
  const contextLines = wrapText(context, 32, 4);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${DIMS.W}" height="${DIMS.H}" viewBox="0 0 ${DIMS.W} ${DIMS.H}">
${defsBlock()}
<rect width="100%" height="100%" fill="${BRAND.dark}"/>

${wordmark(DIMS.W / 2, 130, 50)}
${divider(180)}

<text x="${DIMS.W / 2}" y="320" class="label" font-size="22" fill="${BRAND.mutedOnDark}" text-anchor="middle">VAULT INSIGHT</text>

<!-- Big stat -->
<text x="${DIMS.W / 2}" y="540" class="display" font-size="110" fill="${BRAND.gold}" text-anchor="middle">${esc(stat)}</text>

${divider(620)}

${contextLines.length ? `
<text x="${DIMS.W / 2}" y="730" class="body" font-size="28" fill="${BRAND.white}" text-anchor="middle">
  ${contextLines.map((line, i) => `<tspan x="${DIMS.W / 2}" dy="${i === 0 ? 0 : 40}">${line}</tspan>`).join("")}
</text>` : ""}

${url(DIMS.W / 2, 1020, 26)}
</svg>`;
}

// ── Dispatch ────────────────────────────────────────────────────────────────

export function buildSvg(d: IgPostData): string {
  switch (d.postType) {
    case "card_reveal":        return svgCardReveal(d);
    case "grade_breakdown":    return svgGradeBreakdown(d);
    case "service_explainer":  return svgServiceExplainer(d);
    case "vault_club":         return svgVaultClub(d);
    case "market_insight":     return svgMarketInsight(d);
  }
}
