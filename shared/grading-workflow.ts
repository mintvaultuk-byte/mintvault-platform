/**
 * Grading workflow stages — the backbone of the 3-stage grading flow
 * (Card Details → Grade → Review & Save).
 *
 * Consolidated 2026-07-26: the former separate "Rarity" stage was folded into
 * Card Details so ALL card identity (game, set, name, number, year, language,
 * variant, finish, promo, designation, subset, optional attributes) is captured
 * on ONE screen. "Rarity" is user-facing-renamed to "Variant". Variant remains
 * OPTIONAL — it is deliberately NOT part of the Card Details completion test.
 *
 * Pure data + status logic only (no DOM/React) so the stage state is
 * unit-testable. The presentational bar (GradingWorkflowBar) and the grading
 * form consume this. NOTHING here touches grading calculations, the centering
 * engine, certificate numbering, labels, save logic, or any API — it is purely
 * a UI progress model.
 */

export interface WorkflowStage {
  key: "card-details" | "grade" | "review";
  label: string;
  sublabel: string;
}

export const GRADING_STAGES: readonly WorkflowStage[] = [
  { key: "card-details", label: "Card Details", sublabel: "Identity, variant & finish" },
  { key: "grade", label: "Grade", sublabel: "Front, back, centering" },
  { key: "review", label: "Review", sublabel: "Notes & save" },
];

export type StageStatus = "complete" | "current" | "pending";

/**
 * Status for each stage given the current stage index and the furthest stage
 * reached. The current stage is "current"; any stage before the furthest reached
 * (and not current) keeps its gold tick as "complete"; everything else is
 * "pending". `maxReached` lets ticks persist when the grader steps backward.
 */
export function stageStatuses(currentIndex: number, maxReached = currentIndex): StageStatus[] {
  const cur = clamp(currentIndex);
  const max = Math.max(cur, clamp(maxReached));
  return GRADING_STAGES.map((_, i) => (i === cur ? "current" : i <= max ? "complete" : "pending"));
}

function clamp(i: number): number {
  if (!Number.isFinite(i)) return 0;
  return Math.min(GRADING_STAGES.length - 1, Math.max(0, Math.floor(i)));
}

/** Derive real progress from the draft form so the bar reflects where the grader
 *  actually is (advisory only — never gates saving or grading). */
export interface WorkflowProgressInput {
  cardName?: string;
  setName?: string;
  rarityCode?: string;
  variant?: string;
  finishVariant?: string;
  promoType?: string;
  subsetName?: string;
  gradeOverall?: string | number | null;
}

/** True for each stage that has enough data to be considered done.
 *
 *  Card Details is complete on card NAME + SET only. Variant/finish/promo/
 *  subset are deliberately excluded: the founder spec makes Variant optional,
 *  so requiring it here would strand the progress bar on cards that genuinely
 *  have no variant. */
export function deriveStageCompletion(f: WorkflowProgressInput): boolean[] {
  const filled = (v: unknown) => typeof v === "string" && v.trim() !== "";
  const cardDetails = filled(f.cardName) && filled(f.setName);
  const grade = f.gradeOverall != null && String(f.gradeOverall).trim() !== "";
  // Review is only "complete" once saved — the form owns that; keep false here.
  return [cardDetails, grade, false];
}

/** True when the grader has entered any classification value at all. Advisory
 *  display only (Card Details summary chip) — never gates anything, because
 *  Variant is optional. */
export function hasAnyVariantData(f: WorkflowProgressInput): boolean {
  const filled = (v: unknown) => typeof v === "string" && v.trim() !== "";
  return (
    filled(f.rarityCode) ||
    filled(f.variant) ||
    filled(f.finishVariant) ||
    filled(f.promoType) ||
    filled(f.subsetName)
  );
}

/** The furthest contiguous completed stage index (for the bar's tick trail). */
export function furthestReached(completion: boolean[]): number {
  let i = 0;
  while (i < completion.length && completion[i]) i++;
  return Math.min(i, GRADING_STAGES.length - 1);
}

// ── Stage transitions (pure, so Continue/Back are testable against PRODUCTION
//    code rather than by matching source text) ─────────────────────────────────

export const CARD_DETAILS_STAGE = 0;
export const GRADE_STAGE = 1;
export const REVIEW_STAGE = 2;

/** Clamp any index (including NaN/±Infinity) into a real stage index. */
export function clampStageIndex(i: number): number {
  if (!Number.isFinite(i)) return 0;
  return Math.min(GRADING_STAGES.length - 1, Math.max(0, Math.floor(i)));
}

/** Continue → the next stage, saturating at Review. */
export function nextStageIndex(i: number): number {
  return clampStageIndex(clampStageIndex(i) + 1);
}

/** Back → the previous stage, saturating at Card Details. */
export function prevStageIndex(i: number): number {
  return clampStageIndex(clampStageIndex(i) - 1);
}

/** Index of a stage by key; -1 when the key is not a stage (e.g. "rarity"). */
export function stageIndexByKey(key: string): number {
  return GRADING_STAGES.findIndex((s) => s.key === key);
}

/** The preview aside is shown on Card Details and Review. Grade is the single
 *  documented exception: the protected grading workstation renders its own
 *  interactive card image there, and a second copy would duplicate it. */
export function showsPreviewAside(stage: number): boolean {
  const s = clampStageIndex(stage);
  return s === CARD_DETAILS_STAGE || s === REVIEW_STAGE;
}
