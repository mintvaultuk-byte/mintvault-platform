/**
 * Support-card template (Tactic / Relic / Vault) — simple + consistent, v1.2.1 style.
 *
 * This is a SEPARATE renderer. It does NOT import or touch the creature template's
 * coordinate grid (template-v12.ts ZONES) — "do not move creature template
 * coordinates" is honoured by never referencing them. Support cards share only the
 * outer card geometry (69×94 canvas, 63×88 trim, 3mm border, square corners) and the
 * footer treatment, for brand consistency.
 *
 * The master set has no effect text for support cards (Art Status TEMPLATE_NEEDED), so
 * the effect panel is an intentionally clean ruled area ready for playtest text. The
 * card TYPE is the hero. Neutral (no existing crest SVG) uses an inline vector diamond.
 */
import { createCanvas } from "canvas";
import type { ElementStyle, VqCard } from "./types";
import type { ArtResolver } from "./template";

const INK = "#1C1917";
const MUTED = "#6E655B";
const FACE = "#FFFDF6";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[m] as string));

const mctx = createCanvas(8, 8).getContext("2d");
const K = 20;
function widthMm(text: string, sizeMm: number, family: "Arial" | "Arial Black"): number {
  mctx.font = `${sizeMm * K}px "${family}"`;
  return mctx.measureText(text).width / K;
}
function fitSize(text: string, maxWmm: number, family: "Arial" | "Arial Black", base: number, min: number): number | null {
  for (let s = base; s >= min - 1e-9; s -= 0.05) if (widthMm(text, s, family) <= maxWmm) return s;
  return null;
}

export class SupportOverflowError extends Error {
  constructor(public zone: string, message: string) {
    super(message);
  }
}

/** Pick black or white text for legibility on a coloured banner (Storm/Volt are light). */
function inkOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#FFFFFF";
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? "#141200" : "#FFFFFF";
}

/** Fixed support-card zones (mm). Independent of the creature grid; consistent footer y-line with it. */
const S = {
  border: { x: 3, y: 3, w: 63, h: 88 },
  crest: { x: 55.5, y: 6, w: 7, h: 7 },
  name: { x: 6, y: 6, w: 47, h: 7 },
  typeBanner: { x: 6, y: 14.5, w: 57, h: 6 },
  art: { x: 6, y: 22, w: 57, h: 38 },
  effectPanel: { x: 6, y: 62, w: 57, h: 19 },
  rarity: { x: 21, y: 83, w: 5, h: 4 },
  collector: { x: 27, y: 83, w: 20, h: 4 },
  edition: { x: 48, y: 83, w: 15, h: 4 },
  copyright: { x: 6, y: 88, w: 57, h: 3 },
} as const;

function crestMark(card: VqCard, el: ElementStyle, art: ArtResolver): string {
  const z = S.crest;
  const plate = `<rect x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" rx="1.2" fill="${el.dark}"/>`;
  if (card.element.toLowerCase() === "neutral") {
    // Neutral has no crest SVG (use-existing rule) — inline vector diamond, never emoji.
    const cx = z.x + z.w / 2, cy = z.y + z.h / 2, r = z.w * 0.3;
    return plate + `<path d="M${cx} ${cy - r} L${cx + r} ${cy} L${cx} ${cy + r} L${cx - r} ${cy} Z" fill="${el.accent}"/>`;
  }
  const symbol = art.href(`symbols/crest_${card.element.toLowerCase()}.svg`);
  if (symbol) return plate + `<image href="${symbol}" x="${z.x + 0.7}" y="${z.y + 0.7}" width="${z.w - 1.4}" height="${z.h - 1.4}" preserveAspectRatio="xMidYMid meet"/>`;
  // no crest SVG — vector-diamond placeholder (never emoji tofu)
  const cx = z.x + z.w / 2, cy = z.y + z.h / 2, r = z.w * 0.3;
  return plate + `<path d="M${cx} ${cy - r} L${cx + r} ${cy} L${cx} ${cy + r} L${cx - r} ${cy} Z" fill="${el.accent}"/>`;
}

export function cardSVG_support(card: VqCard, elements: Record<string, ElementStyle>, art: ArtResolver): string {
  const el = elements[card.element] || elements.Neutral;
  const artHref = art.href(card.artwork_file);
  const displayName = card.display_name || card.card_name;
  const typeLabel = (card.card_type || "").toUpperCase();
  const bannerInk = inkOn(el.border);

  const nameSize = fitSize(displayName, S.name.w, "Arial Black", 4.0, 2.6);
  if (nameSize === null) throw new SupportOverflowError("name", `support name "${displayName}" does not fit at 2.6mm`);

  const mainArt = artHref
    ? `<image href="${artHref}" x="${S.art.x}" y="${S.art.y}" width="${S.art.w}" height="${S.art.h}" preserveAspectRatio="xMidYMid slice"/>`
    : `<rect x="${S.art.x}" y="${S.art.y}" width="${S.art.w}" height="${S.art.h}" fill="#F1E9DB"/><text x="${S.art.x + S.art.w / 2}" y="${S.art.y + S.art.h / 2}" text-anchor="middle" font-size="3" font-family="Arial Black" fill="${MUTED}">ARTWORK</text>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="69mm" height="94mm" viewBox="0 0 69 94">
  <!-- VQ SUPPORT card (${typeLabel}) v1.2.1 · creature grid untouched · square corners -->
  <defs>
    <clipPath id="sArt"><rect x="${S.art.x}" y="${S.art.y}" width="${S.art.w}" height="${S.art.h}" rx="1.2"/></clipPath>
    <linearGradient id="sBorder" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${el.border}"/><stop offset="1" stop-color="${el.dark}"/></linearGradient>
  </defs>

  <rect x="0" y="0" width="69" height="94" fill="url(#sBorder)"/>
  <rect x="${S.border.x}" y="${S.border.y}" width="${S.border.w}" height="${S.border.h}" rx="0" fill="${FACE}"/>

  <!-- name + crest -->
  <text x="${S.name.x}" y="${S.name.y + 4.7}" font-size="${nameSize.toFixed(2)}" font-family="Arial Black" fill="${INK}">${esc(displayName)}</text>
  ${crestMark(card, el, art)}

  <!-- type banner (the hero of a support card) -->
  <rect x="${S.typeBanner.x}" y="${S.typeBanner.y}" width="${S.typeBanner.w}" height="${S.typeBanner.h}" rx="1" fill="${el.border}"/>
  <text x="${S.typeBanner.x + 2}" y="${S.typeBanner.y + 4.1}" font-size="2.6" font-family="Arial Black" letter-spacing="0.3" fill="${bannerInk}">${esc(typeLabel)}</text>
  <text x="${S.typeBanner.x + S.typeBanner.w - 2}" y="${S.typeBanner.y + 3.9}" text-anchor="end" font-size="1.6" font-family="Arial Black" letter-spacing="0.14" fill="${bannerInk}" fill-opacity="0.85">${esc(card.element.toUpperCase())}</text>

  <!-- art window -->
  <g clip-path="url(#sArt)">${mainArt}</g>
  <rect x="${S.art.x}" y="${S.art.y}" width="${S.art.w}" height="${S.art.h}" rx="1.2" fill="none" stroke="${el.dark}" stroke-opacity="0.5" stroke-width="0.25"/>

  <!-- effect panel (clean; master has no effect text yet — TEMPLATE_NEEDED) -->
  <rect x="${S.effectPanel.x}" y="${S.effectPanel.y}" width="${S.effectPanel.w}" height="${S.effectPanel.h}" rx="1.2" fill="${el.accent}" fill-opacity="0.12"/>
  <text x="${S.effectPanel.x + 2}" y="${S.effectPanel.y + 3.2}" font-size="1.4" font-family="Arial Black" letter-spacing="0.14" fill="${MUTED}">EFFECT</text>
  <text x="${S.effectPanel.x + S.effectPanel.w / 2}" y="${S.effectPanel.y + S.effectPanel.h / 2 + 1}" text-anchor="middle" font-size="1.5" font-family="Arial" fill="${MUTED}" fill-opacity="0.8">effect text pending playtest</text>

  <!-- footer (same y-line as creature cards for consistency) -->
  <rect x="${S.rarity.x}" y="${S.rarity.y}" width="${S.rarity.w}" height="${S.rarity.h}" rx="1" fill="${el.accent}" fill-opacity="0.16"/>
  <text x="${S.rarity.x + S.rarity.w / 2}" y="${S.rarity.y + 2.8}" text-anchor="middle" font-size="1.5" font-family="Arial Black" fill="${INK}">${esc(card.rarity)}</text>
  <text x="${S.collector.x + S.collector.w / 2}" y="${S.collector.y + 2.75}" text-anchor="middle" font-size="1.25" font-family="Arial Black" fill="${MUTED}">${esc(card.collector_number)} • ${esc(card.set_code)} • ${esc(card.language)}</text>
  <text x="${S.edition.x + S.edition.w}" y="${S.edition.y + 2.75}" text-anchor="end" font-size="1.15" font-family="Arial Black" fill="${MUTED}">${esc(card.edition)} • ${esc(card.year)}</text>
  <text x="${S.copyright.x}" y="${S.copyright.y + 2}" font-size="0.95" font-family="Arial" fill="${MUTED}">© ${esc(card.year)} Vault Quest Studios</text>
</svg>`;
}
