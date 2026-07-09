/**
 * Vault Quest render service — the bridge between a DB/editor card and the shared
 * render engine (server/vault-quest/lib). Maps the camelCase card shape to the
 * engine's VqCard, resolves crests (embedded) + artwork (R2/uploaded buffers),
 * renders SVG/PNG/PDF, and runs the same QA gates the CLI uses.
 *
 * No database and no R2 access happen here — callers pass artwork buffers in, so
 * this is pure and unit-testable. Routes fetch R2 and call in.
 */
import sharp from "sharp";
import type { ArtResolver } from "./lib/template";
import type { CardQa, ElementStyle, QaIssue, VqCard } from "./lib/types";
import { cardSVG_v121, ZoneOverflowError } from "./lib/template-v12";
import { cardSVG_support, SupportOverflowError } from "./lib/template-support";
import { qaCard, qaSupportCard, qaRenderedSvg } from "./lib/qa";
import { cardPdf, svgToPng } from "./lib/export";
import { VQ_ELEMENTS, VQ_ELEMENTS_NEEDS_APPROVAL, VQ_LOCK, VQ_LOCKED_CONSTANTS } from "./lib/vq-constants";
import { CREST_SVGS } from "./lib/crest-data";

// Collector/Place are stat-less cards (150-master) — rendered via the support
// template (type-as-hero), never the creature grid.
const SUPPORT_TYPES = ["Tactic", "Relic", "Vault", "Collector", "Place"];
const PREVIEW_DPI = 300;
const MASTER_DPI = 600;
const MAIN_KEY = "__main_art__";
const PREV_KEY = "__prev_art__";

/** camelCase card the editor sends and a DB row maps onto. */
export interface RenderCardInput {
  cardId: string;
  collectorNumber: string;
  name: string;
  displayName?: string | null;
  cardType: string;
  element: string;
  rarity?: string | null;
  familyId?: string | null;
  familyName?: string | null;
  stageNumber?: number | null;
  lifeStage?: string | null;
  previousStage?: string | null;
  health?: number | null;
  guard?: number | null;
  shift?: number | null;
  attack1Name?: string | null;
  attack1Cost?: number | null;
  attack1Damage?: number | null;
  attack1Effect?: string | null;
  attack2Name?: string | null;
  attack2Cost?: number | null;
  attack2Damage?: number | null;
  attack2Effect?: string | null;
  vulnerability?: string | null;
  keywords?: string[] | null;
  setCode?: string | null;
  language?: string | null;
  year?: number | null;
  edition?: string | null;
}

const n = (v: number | null | undefined): number => (v === null || v === undefined ? NaN : v);
const s = (v: string | null | undefined): string => v ?? "";

/** Map the editor/DB card onto the engine's VqCard, applying locked constants. */
export function mapInputToVqCard(input: RenderCardInput): VqCard {
  const c = VQ_LOCKED_CONSTANTS;
  const stage = n(input.stageNumber);
  // artwork_file is always a slot key (a name, like the CLI) so the required-field
  // check passes; a missing buffer resolves to "" → placeholder + warn. The prev
  // portrait exists only for stages 2/3 (stage 1 must carry none).
  const artworkFile = MAIN_KEY;
  const prevArtworkFile = stage >= 2 ? PREV_KEY : "";
  return {
    collector_number: input.collectorNumber,
    card_id: input.cardId,
    card_name: input.name,
    display_name: input.displayName || input.name,
    card_type: input.cardType,
    element: input.element,
    family_id: s(input.familyId),
    family: input.familyName || input.name,
    stage_number: n(input.stageNumber),
    life_stage: s(input.lifeStage),
    previous_stage: s(input.previousStage),
    health: n(input.health),
    guard: n(input.guard),
    shift: n(input.shift),
    vulnerable_to: s(input.vulnerability),
    attack_1_cost: input.attack1Cost ?? 0,
    attack_1_name: s(input.attack1Name),
    attack_1_damage: n(input.attack1Damage),
    attack_1_effect: s(input.attack1Effect),
    attack_2_cost: input.attack2Cost ?? 0,
    attack_2_name: s(input.attack2Name),
    attack_2_damage: n(input.attack2Damage),
    attack_2_effect: s(input.attack2Effect),
    rarity: s(input.rarity),
    keywords: input.keywords ?? [],
    set_code: input.setCode || c.set_code,
    language: input.language || c.language,
    year: input.year || c.year,
    edition: input.edition || c.edition,
    artwork_file: artworkFile,
    prev_artwork_file: prevArtworkFile,
  } as VqCard;
}

/** ArtResolver backed by embedded crests + passed-in artwork buffers (no filesystem). */
function makeServerArtResolver(mainArt?: Buffer, prevArt?: Buffer): ArtResolver {
  const cache = new Map<string, string>();
  const resolve = async (filename: string): Promise<string> => {
    if (!filename || cache.has(filename)) return cache.get(filename) ?? "";
    let uri = "";
    const crestMatch = /^symbols\/crest_(.+)\.svg$/.exec(filename);
    if (crestMatch) {
      const svg = CREST_SVGS[crestMatch[1]];
      if (svg) {
        const png = await sharp(Buffer.from(svg), { density: 300 }).resize({ width: 512 }).png().toBuffer();
        uri = `data:image/png;base64,${png.toString("base64")}`;
      }
    } else if (filename === MAIN_KEY && mainArt) {
      const png = await sharp(mainArt).png().toBuffer();
      uri = `data:image/png;base64,${png.toString("base64")}`;
    } else if (filename === PREV_KEY && prevArt) {
      const png = await sharp(prevArt).png().toBuffer();
      uri = `data:image/png;base64,${png.toString("base64")}`;
    }
    cache.set(filename, uri);
    return uri;
  };
  return {
    href: (f) => cache.get(f) ?? "",
    missing: (f) => !!f && (cache.get(f) ?? "") === "",
    warm: async (filenames) => {
      for (const f of filenames) if (f) await resolve(f);
    },
  };
}

export interface RenderResult {
  qa: CardQa;
  svg?: string;
  previewPng?: Buffer;
  masterPng?: Buffer;
  pdf?: Buffer;
}

export type RenderFormat = "preview" | "all";

/**
 * Render a card and run QA. `format: "preview"` returns just the 300-DPI PNG (fast,
 * for the editor's live preview); `format: "all"` also returns SVG + master PNG + PDF.
 * If QA rejects, no images are produced and the reasons are in `qa.issues`.
 */
export async function renderCard(
  input: RenderCardInput,
  art: { mainArt?: Buffer; prevArt?: Buffer } = {},
  format: RenderFormat = "all",
): Promise<RenderResult> {
  const isSupport = SUPPORT_TYPES.includes(input.cardType);
  const card = mapInputToVqCard(input);
  const elements: Record<string, ElementStyle> = VQ_ELEMENTS;
  const resolver = makeServerArtResolver(art.mainArt, art.prevArt);
  const qa: CardQa = { card_id: input.cardId, card_name: input.name, status: "pass", issues: [], outputs: [] };

  await resolver.warm([card.artwork_file, card.prev_artwork_file, `symbols/crest_${card.element.toLowerCase()}.svg`]);

  // Gate 1: data QA
  qa.issues.push(...(isSupport ? qaSupportCard(card, VQ_LOCK, elements) : qaCard(card, VQ_LOCK, elements, resolver)));
  // Draft-safe label: an unapproved element renders with a placeholder — warn, never block.
  if (VQ_ELEMENTS_NEEDS_APPROVAL.has(input.element)) {
    qa.issues.push({ level: "warn", field: "element", message: `element "${input.element}" is NEEDS_APPROVAL — placeholder palette + crest, not final` });
  }
  if (qa.issues.some((i) => i.level === "reject")) {
    qa.status = "reject";
    return { qa };
  }

  // Render (overflow = reject, never a moved zone)
  let svg: string;
  try {
    svg = isSupport ? cardSVG_support(card, elements, resolver) : cardSVG_v121(card, elements, resolver);
  } catch (err) {
    const zone = err instanceof ZoneOverflowError || err instanceof SupportOverflowError ? err.zone : "render";
    qa.status = "reject";
    qa.issues.push({ level: "reject", field: zone, message: err instanceof Error ? err.message : String(err) } as QaIssue);
    return { qa };
  }

  // Gate 2: rendered-output QA
  const outputIssues = qaRenderedSvg(svg, VQ_LOCK);
  qa.issues.push(...outputIssues);
  if (outputIssues.some((i) => i.level === "reject")) {
    qa.status = "reject";
    return { qa };
  }

  const previewPng = await svgToPng(svg, VQ_LOCK, PREVIEW_DPI);
  if (format === "preview") return { qa, previewPng };

  const masterPng = await svgToPng(svg, VQ_LOCK, MASTER_DPI);
  const pdf = await cardPdf(masterPng, VQ_LOCK);
  return { qa, svg, previewPng, masterPng, pdf };
}
