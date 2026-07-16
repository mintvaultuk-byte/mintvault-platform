/**
 * Interface CONTRACT ONLY for a future image-based rarity suggestion feature.
 *
 * Phase 13 (deliberately): NO AI/provider call, NO automatic selection, NO credit
 * use. Automatic recognition will be a separate, audited phase AFTER the manual
 * visual picker is proven accurate. This file exists so that future work has a
 * stable shape to build against — and so tests can assert nothing here ever
 * reaches a provider. The default resolver is a pure no-op that returns null.
 */

/** A single suggested structured selection with its evidence + confidence. */
export interface RaritySuggestion {
  rarityCode: string | null;
  finishVariant: string | null;
  promoType: string | null;
  subsetName: string | null;
  /** 0..1 model confidence — advisory only, never auto-applied. */
  confidence: number;
  /** Human-readable reasons a reviewer can check the suggestion against. */
  evidence: string[];
}

/** What a future suggestion request would carry (image keys, not raw images). */
export interface RaritySuggestionRequest {
  certId?: string;
  frontImageKey?: string;
  backImageKey?: string;
}

/** The founder's decision on a suggestion — always explicit, never automatic. */
export type RaritySuggestionDecision = "accept" | "reject";

/**
 * Placeholder resolver. Makes ZERO provider calls and consumes ZERO credits —
 * it always returns null (no suggestion). Wiring a real model is a future,
 * separately-audited phase.
 */
export function suggestRarityFromImage(_req: RaritySuggestionRequest): RaritySuggestion | null {
  return null;
}

// ── v2 contract (Knowledge Engine) — full card identification, still stub-only ──

/** One candidate identification. Everything is a PROPOSAL — nothing auto-saves. */
export interface CardIdentificationCandidate {
  setValue: string | null; // canonical pokemon_sets value/code
  setCode: string | null;
  rarityCode: string | null; // canonical catalogue rarity value
  finishVariant: string | null;
  promoType: string | null;
  subsetName: string | null;
  language: string | null; // catalogue language value
  /** 0..1 — advisory only. */
  confidence: number;
  /** Human-checkable reasons (symbol seen, code seen, number format matched…). */
  evidence: string[];
}

/** Full v2 suggestion: a primary candidate + ranked alternatives.
 *  `needsHumanReview` is ALWAYS true in this phase — no auto-selection exists. */
export interface CardIdentificationSuggestion {
  primary: CardIdentificationCandidate;
  alternatives: CardIdentificationCandidate[];
  needsHumanReview: true;
}

/**
 * v2 placeholder resolver — identical safety contract to v1: ZERO provider
 * calls, ZERO credits, always returns null (no suggestion). The UI built on
 * this must offer only Accept / Reject / Choose-alternative, never auto-save.
 */
export function identifyCardFromImages(_req: RaritySuggestionRequest): CardIdentificationSuggestion | null {
  return null;
}
