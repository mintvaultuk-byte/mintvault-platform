/**
 * Vault Quest AI guardrails — legal/brand safety for every AI suggestion.
 *
 * Applied to BOTH the request (reject prompts that reference other IP or ask for
 * copied layouts) and the output (drop suggestions that slip through). Pure,
 * dependency-free string checks so they can run on input before we spend a token
 * and on output before anything is shown. Nothing here auto-applies or saves.
 */

// Other games / characters that must never appear.
const BANNED_IP = [
  "pokemon", "pokémon", "poke ball", "pokeball", "pikachu", "charizard", "bulbasaur", "squirtle",
  "eevee", "mewtwo", "mew ", "gengar", "snorlax", "gyarados", "jigglypuff", "gotta catch",
  "yu-gi-oh", "yugioh", "yu gi oh", "exodia", "blue-eyes", "dark magician", "kuriboh",
  "magic the gathering", "planeswalker", "mana tap",
  "lorcana", "disney lorcana",
  "digimon", "digivolve", "digivolution",
  "one piece", "monkey d", "luffy", "zoro ", "nami ",
  "gundam", "bakugan", "beyblade", "yokai watch",
];

// Pokémon-TCG mechanics vocabulary (the VQ lexicon is Health/Guard/Shift/Core/…).
const BANNED_CARD_TERMS = ["hp", "weakness", "resistance", "retreat cost", "retreat", "energy card", "trainer card"];

// Requests / outputs that would produce a full card layout or copied marks.
const LAYOUT_TERMS = [
  "full card", "card layout", "card frame", "card border", "card template", "trading card",
  "text box", "stat box", "hp bar", "add text", "add a logo", "add logo", "watermark",
  "name plate", "energy symbol", "type symbol", "rarity symbol", "set symbol", "card back",
];

// Name anti-patterns.
const MEDIEVAL_WORDS = [
  "guardian", "sentinel", "warden", "knight", "vault", "paladin", "squire", "castle", "kingdom",
  "lord", "lady", "sir ", "dame", "templar", "crusader", "dragoon", "citadel", "keep", "realm",
  "throne", "royal", "medieval", "sword", "shield", "armor", "armour", "blade", "valor", "valour",
];

export interface OutputGuard {
  hard: string[]; // must-drop reasons (IP, banned terms, layout) — never shown
  soft: string[]; // warnings shown alongside a suggestion (style rules)
}

function hits(text: string, terms: string[]): string[] {
  const t = ` ${text.toLowerCase()} `;
  return terms.filter((w) => t.includes(w.toLowerCase())).map((w) => w.trim());
}

function isNegatedUse(text: string, at: number): boolean {
  const prefix = text.slice(Math.max(0, at - 28), at);
  return /\b(no|not|never|without|avoid|forbid|forbids|forbidden)\s+(?:a\s+|an\s+|the\s+)?$/i.test(prefix);
}

function hardHits(text: string, terms: string[]): string[] {
  const lower = text.toLowerCase();
  const found: string[] = [];
  for (const term of terms) {
    const needle = term.toLowerCase();
    let at = lower.indexOf(needle);
    while (at >= 0) {
      if (!isNegatedUse(lower, at)) {
        found.push(term.trim());
        break;
      }
      at = lower.indexOf(needle, at + needle.length);
    }
  }
  return found;
}

/** Reject a REQUEST before spending a token if it references other IP or asks for a layout. */
export function guardInput(text: string): { ok: boolean; violations: string[] } {
  const v = [
    ...hardHits(text, BANNED_IP).map((h) => `references "${h}" (other IP)`),
    ...hardHits(text, LAYOUT_TERMS).map((h) => `asks for card layout ("${h}") — artwork only`),
  ];
  return { ok: v.length === 0, violations: [...new Set(v)] };
}

/** Screen a single piece of AI output. `hard` reasons mean drop it; `soft` are warnings. */
export function guardOutput(kind: string, text: string): OutputGuard {
  const hard = hardHits(text, BANNED_IP).map((h) => `contains "${h}" (other IP)`);
  if (kind === "gameplay" || kind === "flavour") {
    hard.push(...hardHits(text, BANNED_CARD_TERMS).map((h) => `uses banned term "${h}"`));
  }
  if (kind === "artwork-prompt") {
    hard.push(...hardHits(text, LAYOUT_TERMS).map((h) => `describes card layout ("${h}") — artwork only`));
  }
  const soft: string[] = [];
  if (kind === "name") {
    const words = text.trim().split(/\s+/);
    if (words.length > 2) soft.push("more than two words — prefer one");
    if (text.replace(/[^a-z]/gi, "").length > 12) soft.push("long name — prefer short");
    const med = hits(text, MEDIEVAL_WORDS);
    if (med.length) soft.push(`medieval/overused word: ${med.join(", ")}`);
  }
  return { hard: [...new Set(hard)], soft: [...new Set(soft)] };
}

/** The standard disclaimer shown on every AI panel. */
export const AI_DISCLAIMER = "AI suggestions are draft only. Founder approval required.";
