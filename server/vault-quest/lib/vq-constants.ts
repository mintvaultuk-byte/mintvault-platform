/**
 * Server-side render constants — the v1.2.1 template lock geometry and the
 * element palettes, embedded so the server render path has no dependency on the
 * CLI's data files. Values mirror scripts/vault-quest-builder/template_lock_v1.2.1.json
 * and data/elements.json. Later phases can override elements from the vq_elements table.
 */
import type { ElementStyle, TemplateLock } from "./types";

export const VQ_LOCK: TemplateLock = {
  template: "VQ_STANDARD_CREATURE_CARD_TEMPLATE_v1.2.1_STAGE_LOCK",
  canvas_mm: [69, 94],
  trim_mm: [63, 88],
  bleed_mm: 3,
  set_code: "GNV",
  year: 2026,
  front_qr_nfc_allowed: false,
  grid_rule: "Coordinates immutable; only data and artwork change.",
  stage_templates: { "1": "A", "2": "B", "3": "C" },
};

export const VQ_ELEMENTS: Record<string, ElementStyle> = {
  // --- approved active elements (real palettes + crests) ---
  Flame: { border: "#C93316", accent: "#F97316", dark: "#2A0B05", crest: "🔥" },
  Water: { border: "#0284C7", accent: "#38BDF8", dark: "#082F49", crest: "💧" },
  Nature: { border: "#2F9E44", accent: "#69DB7C", dark: "#0B2E13", crest: "🌿" },
  Storm: { border: "#E8A100", accent: "#FFD43B", dark: "#3A2A00", crest: "⚡" },
  Stone: { border: "#7A6A55", accent: "#B8A88F", dark: "#2A231A", crest: "⬢" },
  Shadow: { border: "#6741D9", accent: "#9775FA", dark: "#160B2E", crest: "☾" },
  Neutral: { border: "#64748B", accent: "#CBD5E1", dark: "#0F172A", crest: "◆" },
  // --- 150-master taxonomy: PLACEHOLDER palettes, NEEDS_APPROVAL (OPEN-21) ---
  // Values mirror the legacy elements.json where one exists; Brand/Crystal are
  // generic placeholders (no prior palette). All render with a vector-diamond
  // placeholder crest. None is final until founder-approved.
  Blaze: { border: "#C93316", accent: "#F97316", dark: "#2A0B05", crest: "◆" },
  Tide: { border: "#0EA5E9", accent: "#38BDF8", dark: "#042F4B", crest: "◆" },
  Blossom: { border: "#65A30D", accent: "#A3E635", dark: "#1F3B0A", crest: "◆" },
  Spark: { border: "#EAB308", accent: "#FACC15", dark: "#3B2F05", crest: "◆" },
  Earth: { border: "#78716C", accent: "#A8A29E", dark: "#292524", crest: "◆" },
  Cosmos: { border: "#7C3AED", accent: "#C084FC", dark: "#1E103A", crest: "◆" },
  Wind: { border: "#14B8A6", accent: "#99F6E4", dark: "#042F2E", crest: "◆" },
  Electric: { border: "#EAB308", accent: "#FDE047", dark: "#1E1B00", crest: "◆" },
  Ice: { border: "#0284C7", accent: "#BAE6FD", dark: "#082F49", crest: "◆" },
  Dark: { border: "#6D28D9", accent: "#A855F7", dark: "#12051F", crest: "◆" },
  Light: { border: "#D97706", accent: "#FDE68A", dark: "#2A1600", crest: "◆" },
  Brand: { border: "#9A6A3A", accent: "#C89B6A", dark: "#2A1A0A", crest: "◆" },
  Crystal: { border: "#3AA6A6", accent: "#7FD8D8", dark: "#06322F", crest: "◆" },
  Terra: { border: "#5F7F3A", accent: "#A7C957", dark: "#20310F", crest: "◆" },
  Volt: { border: "#D7A900", accent: "#FDE047", dark: "#2F2700", crest: "◆" },
  Gale: { border: "#0F9A9A", accent: "#99F6E4", dark: "#063A3A", crest: "◆" },
};

/**
 * Elements NOT yet founder-approved for launch (OPEN-21). They render with
 * PLACEHOLDER palettes + a generic placeholder crest and are flagged
 * NEEDS_APPROVAL so nothing draft-unsafe ships as final. The 7 approved active
 * elements above are intentionally omitted.
 */
export const VQ_ELEMENTS_NEEDS_APPROVAL: ReadonlySet<string> = new Set([
  "Blaze",
  "Blossom",
  "Spark",
  "Earth",
  "Cosmos",
  "Wind",
  "Electric",
  "Ice",
  "Dark",
  "Light",
  "Brand",
]);

export const VQ_LOCKED_CONSTANTS = { set_code: "GNV", year: 2026, edition: "FIRST EDITION", language: "EN" } as const;
