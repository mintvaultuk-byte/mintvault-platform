/**
 * VQ_STANDARD_CREATURE_CARD_TEMPLATE_v1.1_STAGE_LOCK — faithful port of the
 * cardSVG() engine from the pack's src/index.html (the authoritative grid).
 *
 * THE GRID NEVER MOVES. Every coordinate below is the v1.1 Stage Lock.
 * Only data and artwork change. Any coordinate edit is a template version
 * bump, never a casual change. Artwork is inserted into the two fixed
 * windows only: main art 6,17 57×35 — previous-stage portrait 6,17 9×9.
 */
import fs from "fs";
import path from "path";
import type { ElementStyle, VqCard } from "./types";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[m] as string));

export interface ArtResolver {
  /** returns a data: URI for an artwork filename, or "" when missing (call warm() first) */
  href(filename: string): string;
  missing(filename: string): boolean;
  /** loads + (for SVG art) rasterises the given filenames into the cache */
  warm(filenames: string[]): Promise<void>;
}

/**
 * Loads artwork files (png/jpg/svg) from the art/ folder as data URIs.
 * SVG artwork is pre-rasterised to PNG at print resolution first — nested SVG
 * images otherwise rasterise at their intrinsic pixel size and blur at 600 DPI.
 * The main art window is 57mm wide; 57mm at 600 DPI ≈ 1347px, so 2000px wide
 * covers both windows with margin.
 */
export async function makeArtResolver(artDir: string): Promise<ArtResolver> {
  const sharp = (await import("sharp")).default;
  const cache = new Map<string, string>();
  const resolve = async (filename: string): Promise<string> => {
    if (!filename) return "";
    if (cache.has(filename)) return cache.get(filename)!;
    const base = filename.replace(/\.[^.]+$/, "");
    const candidates = [filename, `${base}.png`, `${base}.jpg`, `${base}.jpeg`, `${base}.svg`];
    for (const cand of candidates) {
      const p = path.join(artDir, cand);
      if (!fs.existsSync(p)) continue;
      let uri: string;
      if (cand.endsWith(".svg")) {
        const png = await sharp(p, { density: 300 }).resize({ width: 2000 }).png().toBuffer();
        uri = `data:image/png;base64,${png.toString("base64")}`;
      } else {
        const mime = cand.endsWith(".png") ? "image/png" : "image/jpeg";
        uri = `data:${mime};base64,${fs.readFileSync(p).toString("base64")}`;
      }
      cache.set(filename, uri);
      return uri;
    }
    cache.set(filename, "");
    return "";
  };
  return {
    href: (f) => cache.get(f) ?? "",
    missing: (f) => !!f && (cache.get(f) ?? "") === "",
    warm: async (filenames) => {
      for (const f of filenames) if (f) await resolve(f);
    },
  };
}

/**
 * Element crest in the fixed 58,6 5×5 slot. Prefers a real SVG symbol from the
 * symbols folder (handoff input: art/symbols/crest_<element>.svg, e.g.
 * crest_blaze.svg) — falls back to the elements.json emoji character, which
 * renders in browsers but NOT in the PNG/PDF raster path (no colour-emoji
 * support in librsvg). Final crests must ship as SVG symbols.
 */
function crestMark(elementName: string, el: ElementStyle, art: ArtResolver): string {
  const symbol = art.href(`symbols/crest_${elementName.toLowerCase()}.svg`);
  if (symbol) return `<image href="${symbol}" x="58.5" y="6.5" width="4" height="4" preserveAspectRatio="xMidYMid meet"/>`;
  return `<text x="60.5" y="9.7" text-anchor="middle" font-size="2.7" font-family="Arial" fill="#fff">${esc(el.crest)}</text>`;
}

function coreCost(n: number, x: number, y: number, accent: string): string {
  let s = "";
  for (let i = 0; i < 3; i++) {
    const fill = i < (Number(n) || 0) ? accent : "#F8FAFC";
    s += `<circle cx="${x + i * 3.2}" cy="${y}" r="1.25" fill="${fill}" stroke="#111827" stroke-width="0.18"/>`;
  }
  return s;
}

export function cardSVG(card: VqCard, elements: Record<string, ElementStyle>, art: ArtResolver): string {
  const el = elements[card.element] || elements.Neutral;
  const stage = Number(card.stage_number || 1);
  const isStage1 = stage === 1;
  const life = card.life_stage || (stage === 1 ? "BABY" : stage === 2 ? "TEEN" : "FINAL");
  const artHref = art.href(card.artwork_file);
  const prevArt = art.href(card.prev_artwork_file);

  const previousZone = isStage1 ? "" : `
    <rect x="6" y="17" width="9" height="9" rx="1" fill="#fff" stroke="${el.border}" stroke-width=".35"/>
    ${prevArt ? `<image href="${prevArt}" x="6.3" y="17.3" width="8.4" height="8.4" preserveAspectRatio="xMidYMid slice"/>` : `<text x="10.5" y="22.2" text-anchor="middle" font-size="1.2" fill="#111827">PREV</text>`}
  `;

  const evolves = isStage1 ? "" : `<text x="17" y="15" font-size="1.1" font-family="Arial" fill="#111827">Evolves From ${esc(card.previous_stage)}</text>`;

  const mainArt = artHref
    ? `<image href="${artHref}" x="6" y="17" width="57" height="35" preserveAspectRatio="xMidYMid slice"/>`
    : `<rect x="6" y="17" width="57" height="35" fill="#fed7aa"/><text x="34.5" y="35" text-anchor="middle" font-size="3" font-family="Arial Black" fill="#111827">ARTWORK</text>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="69mm" height="94mm" viewBox="0 0 69 94">
  <defs>
    <clipPath id="artClip"><rect x="6" y="17" width="57" height="35" rx="1.2"/></clipPath>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${el.border}"/><stop offset="1" stop-color="${el.dark}"/></linearGradient>
  </defs>

  <rect x="0" y="0" width="69" height="94" fill="${el.border}"/>
  <rect x="3" y="3" width="63" height="88" rx="2.2" fill="#fff7ed" stroke="#111827" stroke-width=".35"/>
  <rect x="4.2" y="4.2" width="60.6" height="85.6" rx="1.8" fill="none" stroke="${el.dark}" stroke-width=".6"/>

  <!-- Top locked zones -->
  <rect x="6" y="6" width="10" height="10" rx="1.2" fill="${el.dark}"/>
  <text x="11" y="9.2" text-anchor="middle" font-size="1.4" font-family="Arial Black" fill="#fff">STAGE</text>
  <text x="11" y="13.5" text-anchor="middle" font-size="4.2" font-family="Arial Black" fill="#fff">${stage}</text>
  <text x="11" y="15.5" text-anchor="middle" font-size="1.2" font-family="Arial Black" fill="#fff">${esc(life)}</text>

  <rect x="17" y="6" width="29" height="6" rx="1" fill="#fffaf0"/>
  <text x="18" y="10.6" font-size="4.2" font-family="Arial Black, Arial" fill="#111827">${esc(card.display_name || card.card_name)}</text>
  ${evolves}

  <rect x="47" y="6" width="10" height="5" rx=".8" fill="#fffaf0"/>
  <text x="48" y="8.1" font-size="1.1" font-family="Arial Black" fill="#111827">Health</text>
  <text x="55.8" y="10.2" text-anchor="end" font-size="2.8" font-family="Arial Black" fill="#111827">${esc(card.health)}</text>

  <rect x="47" y="12" width="8" height="4" rx=".7" fill="#fffaf0"/>
  <text x="48" y="14.7" font-size="1.1" font-family="Arial Black" fill="#111827">Guard ${esc(card.guard)}</text>

  <rect x="56" y="12" width="7" height="4" rx=".7" fill="#fffaf0"/>
  <text x="57" y="14.7" font-size="1.1" font-family="Arial Black" fill="#111827">Shift ${esc(card.shift)}</text>

  <rect x="58" y="6" width="5" height="5" rx=".8" fill="${el.dark}" stroke="${el.accent}" stroke-width=".3"/>
  ${crestMark(card.element, el, art)}

  <!-- Artwork -->
  <g clip-path="url(#artClip)">${mainArt}</g>
  <rect x="6" y="17" width="57" height="35" rx="1.2" fill="none" stroke="${el.dark}" stroke-width=".45"/>
  ${previousZone}

  <!-- Metadata -->
  <rect x="6" y="53" width="57" height="5" rx=".5" fill="${el.dark}"/>
  <text x="8" y="56.2" font-size="1.5" font-family="Arial Black" fill="#fff">NO. ${esc((card.collector_number || "").split("/")[0])}</text>
  <text x="23" y="56.2" font-size="1.5" font-family="Arial Black" fill="#fff">${esc(card.family || "")} CREATURE</text>

  <!-- Attack 1 -->
  <rect x="6" y="59" width="57" height="11" rx=".8" fill="#fffaf0" stroke="${el.border}" stroke-width=".3"/>
  <text x="7" y="62.3" font-size="1.1" font-family="Arial Black" fill="${el.border}">CORE</text>
  ${coreCost(card.attack_1_cost, 8, 65.5, el.accent)}
  <text x="17" y="63" font-size="2.1" font-family="Arial Black" fill="#111827">${esc(card.attack_1_name)}</text>
  <text x="61.5" y="63.6" text-anchor="end" font-size="3.2" font-family="Arial Black" fill="${el.border}">${esc(card.attack_1_damage)}</text>
  <text x="17" y="66.4" font-size="1.3" font-family="Arial" fill="#111827">${esc(card.attack_1_effect || "This attack deals damage.")}</text>

  <!-- Attack 2 -->
  <rect x="6" y="71" width="57" height="11" rx=".8" fill="#fffaf0" stroke="${el.border}" stroke-width=".3"/>
  <text x="7" y="74.3" font-size="1.1" font-family="Arial Black" fill="${el.border}">CORE</text>
  ${coreCost(card.attack_2_cost, 8, 77.5, el.accent)}
  <text x="17" y="75" font-size="2.1" font-family="Arial Black" fill="#111827">${esc(card.attack_2_name)}</text>
  <text x="61.5" y="75.6" text-anchor="end" font-size="3.2" font-family="Arial Black" fill="${el.border}">${esc(card.attack_2_damage)}</text>
  <text x="17" y="78.4" font-size="1.3" font-family="Arial" fill="#111827">${esc(card.attack_2_effect || "This attack deals damage.")}</text>

  <!-- Bottom -->
  <rect x="6" y="83" width="14" height="4" rx=".5" fill="${el.dark}"/>
  <text x="7" y="85.6" font-size="1" font-family="Arial Black" fill="#fff">Vulnerability</text>
  <text x="15.5" y="85.6" text-anchor="end" font-size="1" font-family="Arial Black" fill="#fff">${esc(card.vulnerable_to)}</text>

  <rect x="21" y="83" width="5" height="4" rx=".5" fill="#fffaf0" stroke="${el.dark}" stroke-width=".2"/>
  <text x="23.5" y="85.8" text-anchor="middle" font-size="1.4" font-family="Arial Black" fill="#111827">${esc(card.rarity)}</text>

  <rect x="27" y="83" width="20" height="4" rx=".5" fill="#fffaf0" stroke="${el.dark}" stroke-width=".2"/>
  <text x="37" y="85.7" text-anchor="middle" font-size="1.2" font-family="Arial Black" fill="#111827">${esc(card.collector_number)} • ${esc(card.set_code)} • ${esc(card.language)}</text>

  <rect x="48" y="83" width="15" height="4" rx=".5" fill="#fffaf0" stroke="${el.dark}" stroke-width=".2"/>
  <text x="55.5" y="85.7" text-anchor="middle" font-size="1.1" font-family="Arial Black" fill="#111827">${esc(card.edition)} • ${esc(card.year)}</text>

  <text x="6" y="90.2" font-size=".95" font-family="Arial" fill="#111827">© ${esc(card.year)} Vault Quest Studios</text>
</svg>`;
}
