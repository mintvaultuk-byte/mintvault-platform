/**
 * VQ_STANDARD_CREATURE_CARD_TEMPLATE_v1.2_STAGE_LOCK — style refinement.
 *
 * COORDINATES ARE IMMUTABLE. Every zone below is byte-identical to the official
 * v1.1 coordinate map (Z00–Z28, data/VQ_TEMPLATE_v1.1_COORDINATE_MAP.csv).
 * v1.2 changes style only: boxes/heavy outlines removed, typography and spacing
 * refined, Vulnerability label/value measured to fit INSIDE Z24, attack effect
 * text wrapped to the map's mandated max-two-lines inside Z18/Z23.
 * Only CSV/JSON data and artwork change between cards.
 */
import { createCanvas } from "canvas";
import type { ElementStyle, VqCard } from "./types";
import type { ArtResolver } from "./template";

/** Official zone rects (mm) — Z-numbers from VQ_TEMPLATE_v1.1_COORDINATE_MAP.csv. DO NOT EDIT. */
export const ZONES = {
  Z00_canvas: { x: 0, y: 0, w: 69, h: 94 },
  Z02_border: { x: 3, y: 3, w: 63, h: 88 },
  Z03_safe: { x: 6, y: 6, w: 57, h: 82 },
  Z04_stage: { x: 6, y: 6, w: 10, h: 10 },
  Z05_prevPortrait: { x: 6, y: 17, w: 9, h: 9 },
  Z06_name: { x: 17, y: 6, w: 29, h: 6 },
  Z07_crest: { x: 58, y: 6, w: 5, h: 5 },
  Z08_health: { x: 47, y: 6, w: 10, h: 5 },
  Z09_guard: { x: 47, y: 12, w: 8, h: 4 },
  Z10_shift: { x: 56, y: 12, w: 7, h: 4 },
  Z11_evolves: { x: 17, y: 12, w: 29, h: 4 },
  Z12_art: { x: 6, y: 17, w: 57, h: 35 },
  Z13_meta: { x: 6, y: 53, w: 57, h: 5 },
  Z14_attack1: { x: 6, y: 59, w: 57, h: 11 },
  Z15_cost1: { x: 7, y: 60, w: 9, h: 5 },
  Z16_name1: { x: 17, y: 60, w: 27, h: 4 },
  Z17_dmg1: { x: 54, y: 60, w: 8, h: 5 },
  Z18_effect1: { x: 17, y: 64, w: 38, h: 5 },
  Z19_attack2: { x: 6, y: 71, w: 57, h: 11 },
  Z20_cost2: { x: 7, y: 72, w: 9, h: 5 },
  Z21_name2: { x: 17, y: 72, w: 27, h: 4 },
  Z22_dmg2: { x: 54, y: 72, w: 8, h: 5 },
  Z23_effect2: { x: 17, y: 76, w: 38, h: 5 },
  Z24_vuln: { x: 6, y: 83, w: 14, h: 4 },
  Z25_rarity: { x: 21, y: 83, w: 5, h: 4 },
  Z26_collector: { x: 27, y: 83, w: 20, h: 4 },
  Z27_edition: { x: 48, y: 83, w: 15, h: 4 },
  Z28_copyright: { x: 6, y: 88, w: 57, h: 3 },
} as const;

const INK = "#1C1917"; // primary text
const MUTED = "#6E655B"; // secondary text
const FACE = "#FFFDF6"; // face panel

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[m] as string));

/* -------- text measurement (system Arial family; mm units) -------- */
const mctx = createCanvas(8, 8).getContext("2d");
const K = 20; // measure at 20px per mm for precision
export function textWidthMm(text: string, sizeMm: number, family: "Arial" | "Arial Black"): number {
  mctx.font = `${sizeMm * K}px "${family}"`;
  return mctx.measureText(text).width / K;
}

/** Size ladder inside a fixed width. Returns the size that fits, or null. */
function fitSize(text: string, maxWmm: number, family: "Arial" | "Arial Black", base: number, min: number): number | null {
  for (let s = base; s >= min - 1e-9; s -= 0.05) {
    if (textWidthMm(text, s, family) <= maxWmm) return s;
  }
  return null;
}

/** Wrap into a fixed width; used for attack effects (map mandate: max two lines). */
function wrapLines(text: string, sizeMm: number, family: "Arial" | "Arial Black", maxWmm: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const cand = line ? `${line} ${w}` : w;
    if (textWidthMm(cand, sizeMm, family) <= maxWmm || !line) line = cand;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines;
}

export class ZoneOverflowError extends Error {
  constructor(public zone: string, message: string) {
    super(message);
  }
}

function tintChip(z: { x: number; y: number; w: number; h: number }, el: ElementStyle): string {
  return `<rect x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" rx="1" fill="${el.accent}" fill-opacity="0.16"/>`;
}

function crestMark(elementName: string, el: ElementStyle, art: ArtResolver): string {
  const z = ZONES.Z07_crest;
  const symbol = art.href(`symbols/crest_${elementName.toLowerCase()}.svg`);
  const plate = `<rect x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" rx="1.1" fill="${el.dark}"/>`;
  if (symbol) return plate + `<image href="${symbol}" x="${z.x + 0.5}" y="${z.y + 0.5}" width="${z.w - 1}" height="${z.h - 1}" preserveAspectRatio="xMidYMid meet"/>`;
  // no crest SVG for this element — vector-diamond placeholder (never an emoji,
  // which does not rasterise in the PNG/PDF path).
  const cx = z.x + z.w / 2, cy = z.y + z.h / 2, r = z.w * 0.32;
  return plate + `<path d="M${cx} ${cy - r} L${cx + r} ${cy} L${cx} ${cy + r} L${cx - r} ${cy} Z" fill="${el.accent}" stroke="#fff" stroke-width="0.25"/>`;
}

function corePips(n: number, z: { x: number; y: number; w: number; h: number }, el: ElementStyle): string {
  // label + 3 pips, all inside the official 9×5 cost zone
  let s = `<text x="${z.x}" y="${z.y + 1.4}" font-size="1.05" font-family="Arial Black" letter-spacing="0.12" fill="${MUTED}">CORE</text>`;
  for (let i = 0; i < 3; i++) {
    const filled = i < (Number(n) || 0);
    s += `<circle cx="${z.x + 1.3 + i * 3.1}" cy="${z.y + 3.4}" r="1.15" fill="${filled ? el.border : "#EBE4D6"}"/>`;
  }
  return s;
}

interface AttackZones {
  cost: { x: number; y: number; w: number; h: number };
  name: { x: number; y: number; w: number; h: number };
  dmg: { x: number; y: number; w: number; h: number };
  effect: { x: number; y: number; w: number; h: number };
}

function attack(
  idx: 1 | 2,
  zs: AttackZones,
  name: string,
  cost: number,
  damage: number,
  effect: string,
  el: ElementStyle
): string {
  if (!name) return "";
  const parts: string[] = [];
  parts.push(corePips(cost, zs.cost, el));

  const nameSize = fitSize(name, zs.name.w, "Arial Black", 2.6, 2.0);
  if (nameSize === null) throw new ZoneOverflowError(`Z${idx === 1 ? 16 : 21}`, `attack ${idx} name "${name}" does not fit its zone at 2.0mm`);
  parts.push(`<text x="${zs.name.x}" y="${zs.name.y + 3.1}" font-size="${nameSize.toFixed(2)}" font-family="Arial Black" fill="${INK}">${esc(name)}</text>`);

  parts.push(`<text x="${zs.dmg.x + zs.dmg.w}" y="${zs.dmg.y + 3.9}" text-anchor="end" font-size="3.6" font-family="Arial Black" fill="${el.border}">${esc(damage)}</text>`);

  if (effect) {
    // Z18/Z23 mandate: max two lines. Ladder 1.35 -> 1.1mm, then reject.
    let placed: { size: number; lines: string[] } | null = null;
    for (let s = 1.35; s >= 1.1 - 1e-9; s -= 0.05) {
      const lines = wrapLines(effect, s, "Arial", zs.effect.w);
      if (lines.length <= 2) { placed = { size: s, lines }; break; }
    }
    if (!placed) throw new ZoneOverflowError(`Z${idx === 1 ? 18 : 23}`, `attack ${idx} effect exceeds two lines at 1.1mm — shorten: "${effect}"`);
    const lineH = placed.size * 1.5;
    placed.lines.forEach((l, i) => {
      parts.push(`<text x="${zs.effect.x}" y="${(zs.effect.y + 1.6 + i * lineH).toFixed(2)}" font-size="${placed!.size.toFixed(2)}" font-family="Arial" fill="${INK}">${esc(l)}</text>`);
    });
  }
  return parts.join("\n  ");
}

/** v1.2.1 final polish: identical to v1.2 except the outside card frame is square-cornered. */
export function cardSVG_v121(card: VqCard, elements: Record<string, ElementStyle>, art: ArtResolver): string {
  return cardSVG_v12(card, elements, art, { frameRx: 0 });
}

export function cardSVG_v12(card: VqCard, elements: Record<string, ElementStyle>, art: ArtResolver, opts?: { frameRx?: number }): string {
  const frameRx = opts?.frameRx ?? 2.2;
  const el = elements[card.element] || elements.Neutral;
  const stage = Number(card.stage_number || 1);
  const isStage1 = stage === 1;
  const life = card.life_stage || (stage === 1 ? "BABY" : stage === 2 ? "TEEN" : "FINAL");
  const artHref = art.href(card.artwork_file);
  const prevArt = art.href(card.prev_artwork_file);
  const Z = ZONES;
  const displayName = card.display_name || card.card_name;

  // Z06 name — measured fit ladder, zone immutable
  const nameSize = fitSize(displayName, Z.Z06_name.w, "Arial Black", 4.0, 2.8);
  if (nameSize === null) throw new ZoneOverflowError("Z06", `name "${displayName}" does not fit its zone at 2.8mm`);

  // Z24 vulnerability — measured label + value INSIDE the 14mm zone (overlap fix)
  const vuln = String(card.vulnerable_to || "");
  let vulnValueSize = 1.35;
  // Vulnerability is STACKED inside Z24 (label over value) — a 14mm box cannot hold
  // the full word "VULNERABILITY" beside a wide value like "Water" on one line. The
  // stack keeps the required word legible and fits every element name in the set.
  const vulnLabel = "VULNERABILITY";
  const fitted = fitSize(vuln, Z.Z24_vuln.w - 2.2, "Arial Black", 1.7, 1.0);
  if (fitted === null) throw new ZoneOverflowError("Z24", `vulnerability value "${vuln}" does not fit its zone at 1.0mm`);
  vulnValueSize = fitted;

  const previousZone = isStage1 ? "" : `
  <rect x="${Z.Z05_prevPortrait.x}" y="${Z.Z05_prevPortrait.y}" width="${Z.Z05_prevPortrait.w}" height="${Z.Z05_prevPortrait.h}" rx="1" fill="${FACE}"/>
  ${prevArt
    ? `<image href="${prevArt}" x="${Z.Z05_prevPortrait.x + 0.35}" y="${Z.Z05_prevPortrait.y + 0.35}" width="${Z.Z05_prevPortrait.w - 0.7}" height="${Z.Z05_prevPortrait.h - 0.7}" preserveAspectRatio="xMidYMid slice"/>`
    : `<text x="${Z.Z05_prevPortrait.x + Z.Z05_prevPortrait.w / 2}" y="${Z.Z05_prevPortrait.y + 5.2}" text-anchor="middle" font-size="1.2" font-family="Arial" fill="${MUTED}">PREV</text>`}
  <rect x="${Z.Z05_prevPortrait.x}" y="${Z.Z05_prevPortrait.y}" width="${Z.Z05_prevPortrait.w}" height="${Z.Z05_prevPortrait.h}" rx="1" fill="none" stroke="${el.border}" stroke-width="0.3"/>`;

  const evolves = isStage1 ? "" : `<text x="${Z.Z11_evolves.x}" y="${Z.Z11_evolves.y + 2.9}" font-size="1.35" font-family="Arial" fill="${MUTED}">Evolves From <tspan font-family="Arial Black" fill="${INK}">${esc(card.previous_stage)}</tspan></text>`;

  const mainArt = artHref
    ? `<image href="${artHref}" x="${Z.Z12_art.x}" y="${Z.Z12_art.y}" width="${Z.Z12_art.w}" height="${Z.Z12_art.h}" preserveAspectRatio="xMidYMid slice"/>`
    : `<rect x="${Z.Z12_art.x}" y="${Z.Z12_art.y}" width="${Z.Z12_art.w}" height="${Z.Z12_art.h}" fill="#F1E9DB"/><text x="${Z.Z12_art.x + Z.Z12_art.w / 2}" y="${Z.Z12_art.y + Z.Z12_art.h / 2}" text-anchor="middle" font-size="3" font-family="Arial Black" fill="${MUTED}">ARTWORK</text>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="69mm" height="94mm" viewBox="0 0 69 94">
  <!-- VQ_STANDARD_CREATURE_CARD_TEMPLATE_v1.2_STAGE_LOCK · zones Z00-Z28 immutable · style layer v1.2 -->
  <defs>
    <clipPath id="artClip"><rect x="${Z.Z12_art.x}" y="${Z.Z12_art.y}" width="${Z.Z12_art.w}" height="${Z.Z12_art.h}" rx="1.2"/></clipPath>
    <linearGradient id="borderGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${el.border}"/><stop offset="1" stop-color="${el.dark}"/>
    </linearGradient>
  </defs>

  <!-- Z00 full bleed + Z02 visible border (gradient is style; geometry unchanged) -->
  <rect x="0" y="0" width="69" height="94" fill="url(#borderGrad)"/>
  <rect x="${Z.Z02_border.x}" y="${Z.Z02_border.y}" width="${Z.Z02_border.w}" height="${Z.Z02_border.h}" rx="${frameRx}" fill="${FACE}"/>

  <!-- Z04 stage block -->
  <rect x="${Z.Z04_stage.x}" y="${Z.Z04_stage.y}" width="${Z.Z04_stage.w}" height="${Z.Z04_stage.h}" rx="1.4" fill="${el.dark}"/>
  <text x="11" y="9.1" text-anchor="middle" font-size="1.3" font-family="Arial Black" letter-spacing="0.24" fill="#FFFFFF" fill-opacity="0.75">STAGE</text>
  <text x="11" y="13.4" text-anchor="middle" font-size="4.4" font-family="Arial Black" fill="#fff">${stage}</text>
  <text x="11" y="15.4" text-anchor="middle" font-size="1.15" font-family="Arial Black" letter-spacing="0.18" fill="#FFFFFF" fill-opacity="0.75">${esc(life)}</text>

  <!-- Z06 name (open typography, no plate) -->
  <text x="${Z.Z06_name.x}" y="${Z.Z06_name.y + 4.7}" font-size="${nameSize.toFixed(2)}" font-family="Arial Black" fill="${INK}">${esc(displayName)}</text>
  ${evolves}

  <!-- Z08 health -->
  <text x="${Z.Z08_health.x + Z.Z08_health.w - 4.6}" y="${Z.Z08_health.y + 2.1}" text-anchor="end" font-size="1.15" font-family="Arial Black" letter-spacing="0.14" fill="${MUTED}">HEALTH</text>
  <text x="${Z.Z08_health.x + Z.Z08_health.w}" y="${Z.Z08_health.y + 4.6}" text-anchor="end" font-size="3.6" font-family="Arial Black" fill="${INK}">${esc(card.health)}</text>

  <!-- Z09/Z10 guard + shift chips -->
  ${tintChip(Z.Z09_guard, el)}
  <text x="${Z.Z09_guard.x + Z.Z09_guard.w / 2}" y="${Z.Z09_guard.y + 2.7}" text-anchor="middle" font-size="1.35" font-family="Arial Black" fill="${INK}">Guard ${esc(card.guard)}</text>
  ${tintChip(Z.Z10_shift, el)}
  <text x="${Z.Z10_shift.x + Z.Z10_shift.w / 2}" y="${Z.Z10_shift.y + 2.7}" text-anchor="middle" font-size="1.35" font-family="Arial Black" fill="${INK}">Shift ${esc(card.shift)}</text>

  ${crestMark(card.element, el, art)}

  <!-- Z12 artwork window (immutable; hairline keyline only) -->
  <g clip-path="url(#artClip)">${mainArt}</g>
  <rect x="${Z.Z12_art.x}" y="${Z.Z12_art.y}" width="${Z.Z12_art.w}" height="${Z.Z12_art.h}" rx="1.2" fill="none" stroke="${el.dark}" stroke-opacity="0.5" stroke-width="0.25"/>
  ${previousZone}

  <!-- Z13 metadata strip (soft tint, no solid bar) -->
  ${tintChip(Z.Z13_meta, el)}
  <text x="${Z.Z13_meta.x + 2}" y="${Z.Z13_meta.y + 3.4}" font-size="1.55" font-family="Arial Black" letter-spacing="0.1" fill="${INK}">NO. ${esc((card.collector_number || "").split("/")[0])}</text>
  <text x="${Z.Z13_meta.x + 17}" y="${Z.Z13_meta.y + 3.4}" font-size="1.55" font-family="Arial Black" letter-spacing="0.1" fill="${INK}">${esc((card.family || "").toUpperCase())} CREATURE</text>

  <!-- Z14-Z18 attack 1 (no box) -->
  ${attack(1, { cost: Z.Z15_cost1, name: Z.Z16_name1, dmg: Z.Z17_dmg1, effect: Z.Z18_effect1 }, card.attack_1_name, card.attack_1_cost, card.attack_1_damage, card.attack_1_effect, el)}

  <!-- separator between attacks (hairline, replaces boxes) -->
  ${card.attack_2_name ? `<line x1="${Z.Z19_attack2.x}" y1="${Z.Z19_attack2.y - 0.5}" x2="${Z.Z19_attack2.x + Z.Z19_attack2.w}" y2="${Z.Z19_attack2.y - 0.5}" stroke="${el.dark}" stroke-opacity="0.22" stroke-width="0.2"/>` : ""}

  <!-- Z19-Z23 attack 2 -->
  ${attack(2, { cost: Z.Z20_cost2, name: Z.Z21_name2, dmg: Z.Z22_dmg2, effect: Z.Z23_effect2 }, card.attack_2_name, card.attack_2_cost, card.attack_2_damage, card.attack_2_effect, el)}

  <!-- Z24 vulnerability (stacked label over value, inside the fixed 14x4mm zone) -->
  ${tintChip(Z.Z24_vuln, el)}
  <text x="${Z.Z24_vuln.x + Z.Z24_vuln.w / 2}" y="${Z.Z24_vuln.y + 1.55}" text-anchor="middle" font-size="0.8" font-family="Arial Black" letter-spacing="0.1" fill="${MUTED}">${vulnLabel}</text>
  <text x="${Z.Z24_vuln.x + Z.Z24_vuln.w / 2}" y="${Z.Z24_vuln.y + 3.5}" text-anchor="middle" font-size="${vulnValueSize.toFixed(2)}" font-family="Arial Black" fill="${INK}">${esc(vuln)}</text>

  <!-- Z25 rarity -->
  ${tintChip(Z.Z25_rarity, el)}
  <text x="${Z.Z25_rarity.x + Z.Z25_rarity.w / 2}" y="${Z.Z25_rarity.y + 2.8}" text-anchor="middle" font-size="1.5" font-family="Arial Black" fill="${INK}">${esc(card.rarity)}</text>

  <!-- Z26/Z27 footers (open text) -->
  <text x="${Z.Z26_collector.x + Z.Z26_collector.w / 2}" y="${Z.Z26_collector.y + 2.75}" text-anchor="middle" font-size="1.25" font-family="Arial Black" fill="${MUTED}">${esc(card.collector_number)} • ${esc(card.set_code)} • ${esc(card.language)}</text>
  <text x="${Z.Z27_edition.x + Z.Z27_edition.w}" y="${Z.Z27_edition.y + 2.75}" text-anchor="end" font-size="1.15" font-family="Arial Black" fill="${MUTED}">${esc(card.edition)} • ${esc(card.year)}</text>

  <!-- Z28 flavour/copyright (official zone; was drawn outside any zone in v1.1) -->
  <text x="${Z.Z28_copyright.x}" y="${Z.Z28_copyright.y + 2}" font-size="0.95" font-family="Arial" fill="${MUTED}">© ${esc(card.year)} Vault Quest Studios</text>
</svg>`;
}
