/**
 * MintVault Pokémon AI Card Identification — shared contract + pure validation.
 *
 * The AI is UNTRUSTED: a provider returns a {@link RawAiCardObservation} (what it
 * thinks it saw), and the server assembles a {@link CardIdentificationSuggestionV1}
 * by resolving each observation against the ONE shared catalogue + the Knowledge
 * Engine set directory, tagging every field with a confidence band + short
 * evidence + a validation status. NOTHING here auto-applies — `needsHumanReview`
 * is always true; the grader accepts/changes/rejects.
 *
 * Pure + shared: types + deterministic helpers only (no DOM, no network, no DB).
 * Set-directory validation (set exists, code↔set, era/region compat) needs the DB
 * and lives server-side; the rarity/finish/promo/symbol validation is pure + here.
 */
import {
  searchCatalogue,
  rarityByValue,
  finishByValue,
  promoByValue,
  describeSymbol,
  languageByValueOrLabel,
  type PokemonRarity,
} from "./pokemon-rarity-catalogue";

export const SUGGESTION_CONTRACT_VERSION = "v1" as const;

// ── Confidence + evidence + validation vocab ─────────────────────────────────
export type ConfidenceBand = "high" | "medium" | "low" | "conflict" | "unknown";

export type EvidenceKind =
  | "deterministic_parse"
  | "ocr_text"
  | "visible_set_code"
  | "visible_collector_number"
  | "visible_star_symbol"
  | "visible_promo_stamp"
  | "knowledge_engine_match"
  | "ai_visual_inference";

/** Short evidence summary only — NEVER provider chain-of-thought. */
export interface Evidence {
  kind: EvidenceKind;
  summary: string; // capped; assembled server-side
}

export type FieldSource = "deterministic" | "ai" | "knowledge_engine" | "none";
export type ValidationStatus = "validated" | "conflict" | "unvalidated" | "invalid" | "unknown";
/** A flat scan can't prove reflective/textured finishes — track how sure we are. */
export type FinishConfirmation = "visually_confirmed" | "likely" | "requires_physical_inspection" | "unknown";

export interface SuggestedField<T> {
  value: T | null;
  confidence: ConfidenceBand;
  source: FieldSource;
  evidence: Evidence[];
  validationStatus: ValidationStatus;
  /** When validationStatus === "conflict": the canonical value the KE says instead. */
  canonicalAlternative?: T | null;
}

export interface CardCandidate {
  setId: string | null;
  setName: string | null;
  setCode: string | null;
  collectorNumber: string | null;
  language: string | null;
  era?: string | null;
  reason: string;
}

export interface KnowledgeValidationResult {
  setResolved: boolean;
  setCodeMatchesSet: boolean | null;
  languageRegionCompatible: boolean | null;
  eraCompatible: boolean | null;
  collectorNumberCompatible: boolean | null;
  rarityCompatible: boolean | null;
  finishCompatible: boolean | null;
  promoCompatible: boolean | null;
  symbolMatchesRarity: boolean | null;
  conflicts: string[];
}

export interface CardIdentificationSuggestionV1 {
  contractVersion: typeof SUGGESTION_CONTRACT_VERSION;
  requestId: string;
  provider: string; // "mock" | "anthropic" | "none"
  model: string; // e.g. "claude-haiku-4-5" | "none"
  createdAt: string;
  frontImageChecksum: string | null;
  backImageChecksum: string | null;

  game: SuggestedField<string>;
  cardName: SuggestedField<string>;
  year: SuggestedField<string>;
  setId: SuggestedField<string>;
  setName: SuggestedField<string>;
  setCode: SuggestedField<string>;
  collectorNumber: SuggestedField<string>;
  collectorNumberTotal: SuggestedField<string>;
  language: SuggestedField<string>;
  region: SuggestedField<string>;
  era: SuggestedField<string>;
  rarityCode: SuggestedField<string>;
  rarityLabel: SuggestedField<string>;
  printedSymbol: SuggestedField<string>;
  printedSymbolCount: SuggestedField<number>;
  printedSymbolColour: SuggestedField<string>;
  finishVariant: SuggestedField<string> & { finishConfirmation: FinishConfirmation };
  promoType: SuggestedField<string>;
  subsetName: SuggestedField<string>;
  legacyVariantSuggestion: SuggestedField<string>;

  overallConfidence: ConfidenceBand;
  /** ALWAYS true — the grader must accept; nothing auto-applies. */
  needsHumanReview: true;
  warnings: string[];
  evidence: Evidence[];
  alternatives: CardCandidate[];
  knowledgeValidation: KnowledgeValidationResult;
  providerCostEstimate: number | null;
  actualProviderCost: number | null;
}

/** The UNTRUSTED provider output — free-text observations, never persisted raw. */
export interface RawAiCardObservation {
  game?: string | null;
  cardName?: string | null;
  year?: string | null;
  setNameGuess?: string | null;
  setCodeGuess?: string | null;
  collectorNumberText?: string | null;
  languageGuess?: string | null;
  rarityGuess?: string | null;
  printedSymbolDescription?: string | null;
  printedSymbolColourGuess?: string | null;
  printedSymbolCountGuess?: number | null;
  finishGuess?: string | null;
  promoGuess?: string | null;
  visibleStampText?: string | null;
  regulationMark?: string | null;
  /** The model's own 0..1 confidence — advisory input to the band, never trusted alone. */
  modelConfidence?: number | null;
  /** Short evidence notes ONLY (the pipeline caps + sanitises these). */
  evidenceNotes?: string[];
}

// ── Confidence helpers ────────────────────────────────────────────────────────
export function bandFromScore(score: number): ConfidenceBand {
  if (score >= 0.8) return "high";
  if (score >= 0.5) return "medium";
  if (score > 0) return "low";
  return "unknown";
}

/** An empty (all-unknown) suggested field. */
export function emptyField<T>(): SuggestedField<T> {
  return { value: null, confidence: "unknown", source: "none", evidence: [], validationStatus: "unknown" };
}

/** Cap + sanitise an evidence summary (no chain-of-thought, bounded length). */
export function evidenceSummary(kind: EvidenceKind, text: string): Evidence {
  return { kind, summary: String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 140) };
}

// ── Pure catalogue resolution (AI guess → canonical value) ───────────────────
// `searchCatalogue` is a loose substring search — good for a UI search box, but
// for resolving an AI guess to ONE canonical value we must prefer an EXACT
// normalised match on a code/label/alias, and only fall back to the sole fuzzy
// hit. This prevents "SIR" resolving to Illustration Rare (shares the "ir"
// substring) or "reverse holo" resolving to plain Holo.
function normToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function pickExact<T>(guess: string, hits: T[], tokensOf: (t: T) => string[]): T | null {
  const nq = normToken(guess);
  if (!nq) return null;
  const exact = hits.find((h) => tokensOf(h).some((t) => normToken(t) === nq));
  if (exact) return exact;
  return hits.length === 1 ? hits[0] : null;
}

/** Resolve an AI/free-text rarity guess to a canonical catalogue rarity, or null.
 *  Region-aware: a code shared by an English and a Japanese tier (e.g. "SAR",
 *  "AR") resolves to the region-appropriate entry — jp_* on a Japanese card,
 *  the English tier on a western card. */
export function resolveRarityGuess(guess: string | null | undefined, region?: string | null): PokemonRarity | null {
  const q = String(guess ?? "").trim();
  if (!q) return null;
  const nq = normToken(q);
  const hits = searchCatalogue(q).rarities;
  const exact = hits.filter((r) => [...r.codes, r.label, ...r.aliases].some((t) => normToken(t) === nq));
  const pool = exact.length ? exact : hits.length === 1 ? hits : [];
  if (pool.length === 0) return null;
  if (region && pool.length > 1) {
    const compat = pool.filter((r) => r.regions === "all" || r.regions.includes(region as never));
    const candidates = compat.length ? compat : pool;
    if (region !== "western") {
      // Prefer a region-specific (non-western-inclusive) entry for JP/KR/CN/SEA.
      const specific = candidates.find((r) => r.regions !== "all" && !r.regions.includes("western"));
      if (specific) return specific;
    } else {
      const en = candidates.find((r) => r.regions !== "all" && r.regions.includes("western"));
      if (en) return en;
    }
    return candidates[0];
  }
  return pool[0];
}

export function resolveFinishGuess(guess: string | null | undefined): string | null {
  const q = String(guess ?? "").trim();
  if (!q) return null;
  return pickExact(q, searchCatalogue(q).finishes, (f) => [f.label, ...f.aliases])?.value ?? null;
}

/** Resolve a promo/subset guess → { value, kind } or null. */
export function resolvePromoGuess(guess: string | null | undefined): { value: string; kind: "promo" | "subset" } | null {
  const q = String(guess ?? "").trim();
  if (!q) return null;
  const p = pickExact(q, searchCatalogue(q).promos, (x) => [x.label, ...x.aliases]);
  return p ? { value: p.value, kind: p.kind } : null;
}

/**
 * Does an AI-claimed symbol (colour/count) match the canonical rarity's printed
 * symbol? This is the anti-hallucination check: if the model says "Special
 * Illustration Rare" (★★ gold) but also claims it saw SILVER stars, that's a
 * conflict the grader must see. Returns null when the claim is empty (nothing to
 * check), true/false otherwise.
 */
export function symbolMatchesRarity(
  rarity: PokemonRarity,
  claimedColour: string | null | undefined,
  claimedCount: number | null | undefined,
): boolean | null {
  const colour = String(claimedColour ?? "").trim().toLowerCase();
  const count = claimedCount ?? null;
  if (!colour && count == null) return null;
  const canonColour = rarity.symbol.colour;
  const canonCount = rarity.symbol.count ?? (rarity.symbol.shape === "star" ? 1 : null);
  if (colour && canonColour !== "none" && colour !== canonColour) return false;
  if (count != null && canonCount != null && count !== canonCount) return false;
  return true;
}

/** True when a rarity is printed in a region ("all" or includes it). */
export function rarityCompatibleWithRegion(rarity: PokemonRarity, region: string | null): boolean | null {
  if (!region) return null;
  return rarity.regions === "all" || rarity.regions.includes(region as never);
}
export function rarityCompatibleWithEra(rarity: PokemonRarity, era: string | null): boolean | null {
  if (!era) return null;
  return rarity.eras === "all" || rarity.eras.includes(era as never);
}

/** Build a validated rarity field from an AI guess + region/era context. */
export function buildRarityField(
  guess: string | null | undefined,
  claimedColour: string | null | undefined,
  claimedCount: number | null | undefined,
  region: string | null,
  era: string | null,
): { rarityCode: SuggestedField<string>; label: string | null; symbol: string | null; count: number | null; colour: string | null } {
  const rarity = resolveRarityGuess(guess, region);
  if (!rarity) {
    return { rarityCode: { ...emptyField<string>(), evidence: guess ? [evidenceSummary("ai_visual_inference", `AI saw "${guess}" — no catalogue match`)] : [] }, label: null, symbol: null, count: null, colour: null };
  }
  const conflicts: string[] = [];
  const symMatch = symbolMatchesRarity(rarity, claimedColour, claimedCount);
  if (symMatch === false) conflicts.push(`Claimed symbol (${claimedColour ?? "?"}${claimedCount != null ? ` ×${claimedCount}` : ""}) ≠ ${describeSymbol(rarity.symbol)}`);
  const regionOk = rarityCompatibleWithRegion(rarity, region);
  if (regionOk === false) conflicts.push(`${rarity.label} is not printed in the ${region} region`);
  const eraOk = rarityCompatibleWithEra(rarity, era);
  if (eraOk === false) conflicts.push(`${rarity.label} did not exist in the ${era} era`);

  const status: ValidationStatus = conflicts.length ? "conflict" : "validated";
  const band: ConfidenceBand = conflicts.length ? "conflict" : "high";
  return {
    rarityCode: {
      value: rarity.value,
      confidence: band,
      source: "ai",
      validationStatus: status,
      evidence: [
        evidenceSummary("ai_visual_inference", `AI: ${guess}`),
        evidenceSummary("knowledge_engine_match", `${rarity.label} — ${describeSymbol(rarity.symbol)}`),
        ...(conflicts.length ? [evidenceSummary("visible_star_symbol", conflicts[0])] : []),
      ],
      canonicalAlternative: conflicts.length ? rarity.value : undefined,
    },
    label: rarity.label,
    symbol: rarity.symbol.glyph,
    count: rarity.symbol.count ?? null,
    colour: rarity.symbol.colour,
  };
}

export { rarityByValue, finishByValue, promoByValue, languageByValueOrLabel };

// ── Deterministic MOCK provider (tests + dev — NEVER a real call) ────────────
/**
 * A pure, deterministic stand-in for the vision provider. Given tiny "scenario"
 * hints (as a real provider would infer from pixels), it returns a
 * RawAiCardObservation. Used by tests and the local no-key path so the pipeline
 * is fully exercisable with ZERO provider calls and ZERO credits.
 */
export function mockCardObservation(scenario: Partial<RawAiCardObservation>): RawAiCardObservation {
  return {
    game: "pokemon",
    modelConfidence: 0.75,
    evidenceNotes: ["mock observation (no provider call)"],
    ...scenario,
  };
}
