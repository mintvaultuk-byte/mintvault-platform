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
