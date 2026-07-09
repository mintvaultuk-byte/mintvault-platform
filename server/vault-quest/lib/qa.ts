import type { ElementStyle, QaIssue, TemplateLock, VqCard } from "./types";
import type { ArtResolver } from "./template";

/** Hard bans from the Fable handoff. Rejected in card data AND in rendered output. */
const BANNED_WORD = ["Pokémon", "Pokemon", "Weakness", "Resistance", "Retreat"];
const BANNED_EXACT = ["HP", "GV1", "2025"]; // exact whole tokens — "Health" is the word; GV1/2025 are the wrong set code/year (template doc reject list)
const FRONT_BANNED = ["QR", "NFC", "scan to", "Scan to", "scan me", "Scan me"]; // no QR/NFC/scan prompt on Standard fronts

const REQUIRED_FIELDS: (keyof VqCard)[] = [
  "collector_number", "card_id", "card_name", "card_type", "element",
  "stage_number", "health", "attack_1_name", "attack_1_damage",
  "rarity", "set_code", "language", "year", "edition", "artwork_file",
];

function findBanned(text: string): string[] {
  const hits: string[] = [];
  for (const term of BANNED_WORD) {
    const re = new RegExp(`(^|[^\\p{L}])${term}($|[^\\p{L}])`, "iu");
    if (re.test(text)) hits.push(term);
  }
  for (const term of BANNED_EXACT) {
    const re = new RegExp(`(^|[^A-Za-z])${term}($|[^A-Za-z])`, "u");
    if (re.test(text)) hits.push(term);
  }
  return hits;
}

/** Gate 1 — card data. */
export function qaCard(card: VqCard, lock: TemplateLock, elements: Record<string, ElementStyle>, art: ArtResolver): QaIssue[] {
  const issues: QaIssue[] = [];
  const reject = (field: string, message: string) => issues.push({ level: "reject", field, message });
  const warn = (field: string, message: string) => issues.push({ level: "warn", field, message });

  // missing fields
  for (const f of REQUIRED_FIELDS) {
    const v = card[f];
    if (v === undefined || v === "" || (typeof v === "number" && Number.isNaN(v))) reject(String(f), "required field is missing/empty");
  }

  // fixed values from the template lock
  if (card.set_code && card.set_code !== lock.set_code) reject("set_code", `"${card.set_code}" ≠ required "${lock.set_code}"`);
  if (!Number.isNaN(card.year) && card.year !== lock.year) reject("year", `${card.year} ≠ required ${lock.year}`);
  if (card.collector_number && !/^\d{3}\/\d{3}$/.test(card.collector_number)) warn("collector_number", `"${card.collector_number}" not in NNN/NNN form`);
  if (card.card_id && !card.card_id.startsWith(`${lock.set_code}-`)) reject("card_id", `"${card.card_id}" does not start with "${lock.set_code}-"`);

  // element registry
  if (card.element && !elements[card.element]) reject("element", `"${card.element}" is not in elements.json`);

  // stage lock rules (Template A/B/C)
  const stage = card.stage_number;
  if (![1, 2, 3].includes(stage)) reject("stage_number", `stage ${stage} invalid (1–3)`);
  if (stage === 1) {
    if (card.previous_stage) reject("previous_stage", "Template A (Stage 1): no Evolves From allowed");
    if (card.prev_artwork_file) reject("prev_artwork_file", "Template A (Stage 1): no previous portrait allowed");
  }
  if (stage === 2 || stage === 3) {
    if (!card.previous_stage) reject("previous_stage", `Template ${stage === 2 ? "B" : "C"} (Stage ${stage}): Evolves From name required`);
    if (!card.prev_artwork_file) warn("prev_artwork_file", `Stage ${stage} should carry the previous-stage portrait — placeholder box will render`);
  }
  const expectedLife = stage === 1 ? "BABY" : stage === 2 ? "TEEN" : "FINAL";
  if (card.life_stage && card.life_stage !== expectedLife) warn("life_stage", `"${card.life_stage}" ≠ expected "${expectedLife}" for stage ${stage}`);

  // banned words across every text field
  for (const [field, value] of Object.entries(card)) {
    if (typeof value !== "string" || !value) continue;
    const hits = findBanned(value);
    if (hits.length) reject(field, `banned term(s) [${hits.join(", ")}] in "${value}"`);
  }

  // artwork presence (fixed windows render placeholders when missing — warn, not reject)
  if (card.artwork_file && art.missing(card.artwork_file)) warn("artwork_file", `art/${card.artwork_file} not found — placeholder will render in the fixed window`);
  if (card.prev_artwork_file && art.missing(card.prev_artwork_file)) warn("prev_artwork_file", `art/${card.prev_artwork_file} not found — PREV placeholder will render`);

  return issues;
}

const SUPPORT_TYPES = ["Tactic", "Relic", "Vault", "Collector", "Place"];
const SUPPORT_REQUIRED: (keyof VqCard)[] = ["collector_number", "card_id", "card_name", "card_type", "element", "rarity", "set_code", "language", "year", "edition"];

/** Gate 1 for support cards (Tactic/Relic/Vault) — no creature fields required. */
export function qaSupportCard(card: VqCard, lock: TemplateLock, elements: Record<string, ElementStyle>): QaIssue[] {
  const issues: QaIssue[] = [];
  const reject = (field: string, message: string) => issues.push({ level: "reject", field, message });
  const warn = (field: string, message: string) => issues.push({ level: "warn", field, message });

  for (const f of SUPPORT_REQUIRED) {
    const v = card[f];
    if (v === undefined || v === "" || (typeof v === "number" && Number.isNaN(v))) reject(String(f), "required field is missing/empty");
  }
  if (card.card_type && !SUPPORT_TYPES.includes(card.card_type)) reject("card_type", `"${card.card_type}" is not a support type (${SUPPORT_TYPES.join("/")})`);
  if (card.set_code && card.set_code !== lock.set_code) reject("set_code", `"${card.set_code}" ≠ required "${lock.set_code}"`);
  if (!Number.isNaN(card.year) && card.year !== lock.year) reject("year", `${card.year} ≠ required ${lock.year}`);
  if (card.card_id && !card.card_id.startsWith(`${lock.set_code}-`)) reject("card_id", `"${card.card_id}" does not start with "${lock.set_code}-"`);
  if (card.element && !elements[card.element]) reject("element", `"${card.element}" is not in elements.json`);
  // support cards must NOT carry creature data (guards against a mis-typed row)
  if (card.stage_number && !Number.isNaN(card.stage_number)) warn("stage_number", "support card has a stage value — ignored by the support template");

  for (const [field, value] of Object.entries(card)) {
    if (typeof value !== "string" || !value) continue;
    const hits = findBanned(value);
    if (hits.length) reject(field, `banned term(s) [${hits.join(", ")}] in "${value}"`);
  }
  return issues;
}

/** Gate 2 — rendered output. Scans the final SVG text content (belt and braces). */
export function qaRenderedSvg(svg: string, lock: TemplateLock): QaIssue[] {
  const issues: QaIssue[] = [];
  const textOnly = svg
    .replace(/<image[^>]*>/g, " ") // base64 art payloads are not text content
    .replace(/<[^>]+>/g, " ");
  const hits = findBanned(textOnly);
  if (hits.length) issues.push({ level: "reject", field: "rendered_output", message: `banned term(s) [${hits.join(", ")}] present in rendered card` });
  if (!lock.front_qr_nfc_allowed) {
    for (const term of FRONT_BANNED) {
      const re = new RegExp(`(^|[^A-Za-z])${term}`, "u");
      if (re.test(textOnly)) {
        issues.push({ level: "reject", field: "rendered_output", message: `"${term}" on a Standard card front — QR/NFC/scan prompts are back-only` });
        break;
      }
    }
  }
  if (!textOnly.includes(lock.set_code)) issues.push({ level: "reject", field: "rendered_output", message: "set code missing from rendered card" });
  if (!textOnly.includes(String(lock.year))) issues.push({ level: "reject", field: "rendered_output", message: "year missing from rendered card" });
  return issues;
}
