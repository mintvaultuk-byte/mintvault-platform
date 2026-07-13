/**
 * Phase 6 — artwork quality / identity / character-health helpers.
 *
 * PURE DERIVATION over data that already exists: the identity scorer already
 * produces an overall 0-100 score plus a per-trait breakdown (bodyShape, colours,
 * markings, eyes, silhouette, accessories, familyTraits, stageTraits). Nothing
 * here calls a model, adds a table, or changes generation — it only presents.
 */

export type HealthState = "pass" | "review" | "fail" | "grey";
export const STATE_CLS: Record<HealthState, string> = {
  pass: "border-emerald-700 bg-emerald-950/50 text-emerald-300",
  review: "border-amber-700 bg-amber-950/40 text-amber-300",
  fail: "border-red-800 bg-red-950/40 text-red-300",
  grey: "border-slate-700 bg-slate-900 text-slate-500",
};

/** Founder-friendly band for an identity/trait score. */
export function scoreBand(n: number | null | undefined): { label: string; state: HealthState } {
  if (n == null) return { label: "—", state: "grey" };
  if (n >= 90) return { label: "Excellent", state: "pass" };
  if (n >= 80) return { label: "Good", state: "pass" };
  if (n >= 70) return { label: "Needs Review", state: "review" };
  return { label: "Reject", state: "fail" };
}

/** Pass / Needs Review / Fail for a trait-match score. */
export function matchBand(n: number | null | undefined): { label: string; state: HealthState } {
  if (n == null) return { label: "—", state: "grey" };
  if (n >= 80) return { label: "Pass", state: "pass" };
  if (n >= 70) return { label: "Needs Review", state: "review" };
  return { label: "Fail", state: "fail" };
}

export type IdentityBreakdown = Partial<Record<
  "bodyShape" | "colours" | "markings" | "eyes" | "silhouette" | "accessories" | "familyTraits" | "stageTraits",
  number
>> & {
  notes?: string;
  /** Action Reference only — independent of identity above (see server/vault-quest/ai/pose-diversity.ts). */
  poseDiversity?: { difference?: number; verdict?: "pass" | "fail"; threshold?: number };
  /** Stage 2/3 Master Reference only — independent of identity above (see
   *  server/vault-quest/ai/evolution-diversity.ts). */
  evolutionDifference?: { difference?: number; verdict?: "pass" | "fail"; threshold?: number; stageNumber?: number };
};

/** Founder-facing Pass/Fail for the Action Reference pose-diversity gate. Absent
 *  (non-action-pose candidates, or scorer unavailable) renders as unscored, not a fail. */
export function poseDiversityBand(pd: IdentityBreakdown["poseDiversity"] | null | undefined): { label: string; state: HealthState } {
  if (!pd || pd.verdict == null) return { label: "—", state: "grey" };
  return pd.verdict === "pass" ? { label: "Pass", state: "pass" } : { label: "Fail", state: "fail" };
}

/** Founder-facing Pass/Fail for the Stage 2/3 evolution-difference gate. Absent
 *  (Stage 1, non-master candidates, or scorer unavailable) renders as unscored, not a fail. */
export function evolutionDifferenceBand(ed: IdentityBreakdown["evolutionDifference"] | null | undefined): { label: string; state: HealthState } {
  if (!ed || ed.verdict == null) return { label: "—", state: "grey" };
  return ed.verdict === "pass" ? { label: "Pass", state: "pass" } : { label: "Fail", state: "fail" };
}

/** Map the raw breakdown to the founder-facing trait rows (only traits that exist). */
export function traitsFromBreakdown(bd: IdentityBreakdown | null | undefined): { label: string; score: number | null }[] {
  const b = (bd ?? {}) as IdentityBreakdown;
  return [
    { label: "Face / Eyes", score: b.eyes ?? null },
    { label: "Body Shape", score: b.bodyShape ?? null },
    { label: "Colour", score: b.colours ?? null },
    { label: "Markings", score: b.markings ?? null },
    { label: "Accessories", score: b.accessories ?? null },
    { label: "Style", score: b.silhouette ?? null },
  ];
}

/** Minimal character shape the health check needs (subset of VqCharacterRow). */
export interface HealthCharacter {
  characterId: string;
  descriptionStatus?: string | null;
  approvalStatus?: string | null;
  locked?: boolean | null;
  referencePack?: Partial<Record<string, { r2Key: string; identityScore?: number | null }>> | null;
}

export interface HealthItem { label: string; state: HealthState; value: string }
export interface CharacterHealth {
  items: HealthItem[];
  identityScore: number | null;
  readyForCards: boolean;
  missing: string[];
  /** deep-link step key for the exact next action */
  nextStepKey: "description" | "master" | "action" | "lock" | "cards";
  /** category for founder-dashboard bucketing */
  bucket: "ready" | "needs_master" | "needs_action" | "needs_review" | "failed_identity" | "needs_description";
}

const IDENTITY_OK = 70; // matches the existing server auto-reject safety threshold; not weakened

export function characterHealth(ch: HealthCharacter): CharacterHealth {
  const descOk = ch.descriptionStatus === "approved";
  const masterKey = ch.referencePack?.master_portrait?.r2Key;
  const actionKey = ch.referencePack?.action_pose?.r2Key;
  const masterOk = !!masterKey;
  const actionOk = !!actionKey;
  const masterScore = ch.referencePack?.master_portrait?.identityScore ?? null;
  const actionScore = ch.referencePack?.action_pose?.identityScore ?? null;
  const scores = [masterScore, actionScore].filter((s): s is number => typeof s === "number");
  const identityScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
  const identityState: HealthState = identityScore == null ? "grey" : identityScore >= 80 ? "pass" : identityScore >= IDENTITY_OK ? "review" : "fail";
  const failedIdentity = identityScore != null && identityScore < IDENTITY_OK;
  const locked = !!ch.locked;

  // Background = bg-validated at master generation, so an approved master implies a pass.
  // Colour/Style consistency are derived from the identity analysis (which scores colour,
  // markings and shape) — presented honestly as "from identity analysis", no new classifier.
  // Uses the WORST approved-reference score, not the average: a 95 master must not
  // smooth over a 72 action pose that actually needs review.
  const worstScore = scores.length ? Math.min(...scores) : null;
  const consistencyState: HealthState = !masterOk || worstScore == null ? "grey" : worstScore >= 80 ? "pass" : worstScore >= IDENTITY_OK ? "review" : "fail";
  const bandLabel = (s: HealthState) => (s === "pass" ? "PASS" : s === "review" ? "REVIEW" : s === "fail" ? "FAIL" : "—");

  const items: HealthItem[] = [
    { label: "Description Approved", state: descOk ? "pass" : "grey", value: descOk ? "✅" : "—" },
    { label: "Master Reference Approved", state: masterOk ? "pass" : "grey", value: masterOk ? "✅" : "—" },
    { label: "Action Pose Approved", state: actionOk ? "pass" : masterOk ? "grey" : "grey", value: actionOk ? "✅" : "—" },
    { label: "Identity Score", state: identityState, value: identityScore != null ? `${identityScore}%` : "—" },
    { label: "Background Check", state: masterOk ? "pass" : "grey", value: masterOk ? "PASS" : "—" },
    { label: "Colour Consistency", state: consistencyState, value: bandLabel(consistencyState) },
    { label: "Style Consistency", state: consistencyState, value: bandLabel(consistencyState) },
    { label: "Character Locked", state: locked ? "pass" : "grey", value: locked ? "YES" : "NO" },
  ];

  // The engine's canonical order includes a reference-approval review step between
  // the pack being filled and locking — surface it instead of skipping to "Lock".
  const refsApproved = ch.approvalStatus === "approved";

  const missing: string[] = [];
  if (!descOk) missing.push("Approve Description");
  if (!masterOk) missing.push("Approve Master Reference");
  if (masterOk && !actionOk) missing.push("Approve Action Pose");
  if (failedIdentity) missing.push("Identity score too low — regenerate a closer match");
  if (descOk && masterOk && actionOk && !failedIdentity && !refsApproved && !locked) missing.push("Approve References");
  if (!locked && descOk && masterOk && actionOk && !failedIdentity) missing.push("Lock Character");

  const readyForCards = descOk && masterOk && actionOk && !failedIdentity && locked;
  items.push({ label: "Ready for Cards", state: readyForCards ? "pass" : failedIdentity ? "fail" : "grey", value: readyForCards ? "✅" : "—" });

  const nextStepKey: CharacterHealth["nextStepKey"] = !descOk ? "description" : !masterOk ? "master" : !actionOk ? "action" : !locked ? "lock" : "cards";
  const bucket: CharacterHealth["bucket"] = readyForCards ? "ready"
    : failedIdentity ? "failed_identity"
      : !descOk ? "needs_description"
        : !masterOk ? "needs_master"
          : !actionOk ? "needs_action"
            : "needs_review";

  return { items, identityScore, readyForCards, missing, nextStepKey, bucket };
}
