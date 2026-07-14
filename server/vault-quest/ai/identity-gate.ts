/**
 * Action Reference — STRICT per-trait identity gate.
 *
 * Root cause this fixes: approval was gated ONLY by a single AVERAGED overall score
 * (identity.ts's identityThreshold(), default 70) — a real candidate scored an overall
 * 75 ("Needs Review") while individual critical traits (Markings, "Style" = silhouette)
 * scored well below an acceptable match — the overall AVERAGE let a good pose-diversity
 * score paper over a changed creature. A collectibles-grade Action Reference must be
 * the EXACT approved creature in a different pose — a good pose can never compensate
 * for changed markings, anatomy or art style. This module makes every critical trait
 * individually load-bearing: ANY one of them failing (or merely "needs review") blocks
 * approval, regardless of how well the others or the overall number scored.
 *
 * Pure (no network, no DB) — used both to decide the automatic retry inside
 * generateCharacterCandidate and as the real, mandatory approve-candidate guard. The
 * approve-candidate route recomputes this fresh from the candidate's already-stored
 * identityScore/identityBreakdown, so the gate also applies retroactively to any
 * candidate generated before this fix shipped — nothing new needs to be persisted.
 */
import { identityThreshold } from "./identity";

export type IdentityTraitVerdict = "pass" | "needs_review" | "fail";

/** The 6 founder-visible critical identity traits (server field → founder-facing
 *  label) — matches client/src/components/vault-quest/quality.ts's traitsFromBreakdown
 *  exactly: bodyShape→Body Shape, colours→Colour, markings→Markings, eyes→Face/Eyes,
 *  accessories→Accessories, silhouette→Style. familyTraits/stageTraits still feed the
 *  overall average (unchanged) but aren't founder-visible per-trait, so aren't gated
 *  individually here. */
export const CRITICAL_IDENTITY_TRAITS = ["bodyShape", "colours", "markings", "eyes", "accessories", "silhouette"] as const;
export type CriticalIdentityTrait = (typeof CRITICAL_IDENTITY_TRAITS)[number];

export const CRITICAL_IDENTITY_TRAIT_LABELS: Record<CriticalIdentityTrait, string> = {
  bodyShape: "Body Shape",
  colours: "Colour",
  markings: "Markings",
  eyes: "Face / Eyes",
  accessories: "Accessories",
  silhouette: "Style",
};

/** Minimum to count as a genuine PASS — not merely "not auto-rejected". Matches the
 *  founder-facing UI's existing Pass band (scoreBand/matchBand already treat >=80 as
 *  Pass/Good); this makes that band load-bearing for approval, not just cosmetic.
 *  Override with VQ_IDENTITY_CRITICAL_MIN. */
export function identityCriticalMin(): number {
  const n = Number(process.env.VQ_IDENTITY_CRITICAL_MIN);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 80;
}

/** A missing score (scorer unavailable, or a legacy candidate scored before a trait
 *  existed) is treated as "needs_review" — NEVER a silent pass. An Action Reference
 *  cannot be approved on an unverified identity. */
export function traitVerdict(score: number | null | undefined): IdentityTraitVerdict {
  if (score == null) return "needs_review";
  const passMin = identityCriticalMin();
  const reviewMin = identityThreshold(); // the existing auto-reject floor (default 70)
  if (score >= passMin) return "pass";
  if (score >= reviewMin) return "needs_review";
  return "fail";
}

export interface IdentityGateBreakdown {
  bodyShape?: number | null;
  colours?: number | null;
  markings?: number | null;
  eyes?: number | null;
  accessories?: number | null;
  silhouette?: number | null;
}

export interface IdentityGateResult {
  overallVerdict: IdentityTraitVerdict;
  traitVerdicts: Record<CriticalIdentityTrait, IdentityTraitVerdict>;
  /** True only when the overall verdict AND every critical trait are a genuine Pass. */
  approvalReady: boolean;
  /** Human-readable "Trait: Fail/Needs Review" reasons — for the founder-facing
   *  message and the server's 422 error body. Empty when approvalReady. */
  failReasons: string[];
}

/** Evaluate the strict gate from an overall score + per-trait breakdown. Any trait
 *  (or the overall score) below the Pass band blocks approval — never averaged away. */
export function evaluateIdentityGate(
  overallScore: number | null | undefined,
  breakdown: IdentityGateBreakdown | null | undefined,
): IdentityGateResult {
  const b = breakdown ?? {};
  const overallVerdict = traitVerdict(overallScore);
  const traitVerdicts = Object.fromEntries(
    CRITICAL_IDENTITY_TRAITS.map((t) => [t, traitVerdict(b[t])]),
  ) as Record<CriticalIdentityTrait, IdentityTraitVerdict>;
  const failReasons: string[] = [];
  if (overallVerdict !== "pass") failReasons.push(`Overall Identity: ${overallVerdict === "fail" ? "Fail" : "Needs Review"}`);
  for (const t of CRITICAL_IDENTITY_TRAITS) {
    if (traitVerdicts[t] !== "pass") failReasons.push(`${CRITICAL_IDENTITY_TRAIT_LABELS[t]}: ${traitVerdicts[t] === "fail" ? "Fail" : "Needs Review"}`);
  }
  const approvalReady = overallVerdict === "pass" && CRITICAL_IDENTITY_TRAITS.every((t) => traitVerdicts[t] === "pass");
  return { overallVerdict, traitVerdicts, approvalReady, failReasons };
}
