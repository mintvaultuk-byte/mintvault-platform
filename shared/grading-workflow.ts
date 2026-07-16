/**
 * Grading workflow stages — the backbone of the 4-stage grading flow
 * (Identify → Rarity & Variant → Grade → Review & Save).
 *
 * Pure data + status logic only (no DOM/React) so the stage state is
 * unit-testable. The presentational bar (GradingWorkflowBar) and the grading
 * form consume this. NOTHING here touches grading calculations, the centering
 * engine, certificate numbering, labels, save logic, or any API — it is purely
 * a UI progress model.
 */

export interface WorkflowStage {
  key: "identify" | "rarity" | "grade" | "review";
  label: string;
  sublabel: string;
}

export const GRADING_STAGES: readonly WorkflowStage[] = [
  { key: "identify", label: "Identify Card", sublabel: "Card details & variant" },
  { key: "rarity", label: "Rarity & Variant", sublabel: "Rarity, finish, promo" },
  { key: "grade", label: "Grade Card", sublabel: "Front + back + centering" },
  { key: "review", label: "Review & Save", sublabel: "Notes, score & certificate" },
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

/** True for each stage that has enough data to be considered done. */
export function deriveStageCompletion(f: WorkflowProgressInput): boolean[] {
  const filled = (v: unknown) => typeof v === "string" && v.trim() !== "";
  const identify = filled(f.cardName) && filled(f.setName);
  const rarity = filled(f.rarityCode) || filled(f.variant) || filled(f.finishVariant) || filled(f.promoType) || filled(f.subsetName);
  const grade = f.gradeOverall != null && String(f.gradeOverall).trim() !== "";
  // Review is only "complete" once saved — the form owns that; keep false here.
  return [identify, rarity, grade, false];
}

/** The furthest contiguous completed stage index (for the bar's tick trail). */
export function furthestReached(completion: boolean[]): number {
  let i = 0;
  while (i < completion.length && completion[i]) i++;
  return Math.min(i, GRADING_STAGES.length - 1);
}
