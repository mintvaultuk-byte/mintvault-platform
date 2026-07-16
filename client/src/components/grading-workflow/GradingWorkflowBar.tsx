/**
 * Persistent 4-stage grading workflow bar (Identify → Rarity & Variant → Grade →
 * Review & Save). Shows the current stage highlighted, completed stages with a
 * gold tick, and pending stages inactive. Clicking a stage scrolls its section
 * into view (by data-workflow-stage) — it does NOT gate, save, grade, or change
 * any form value. Purely a navigation + progress indicator.
 */
import { Check } from "lucide-react";
import { GRADING_STAGES, stageStatuses, type WorkflowStage } from "@shared/grading-workflow";

export function GradingWorkflowBar({
  currentIndex,
  maxReached,
  onStageClick,
}: {
  currentIndex: number;
  maxReached?: number;
  /** Called with the stage index when a stage is clicked (scroll/navigate only). */
  onStageClick?: (index: number, stage: WorkflowStage) => void;
}) {
  const statuses = stageStatuses(currentIndex, maxReached ?? currentIndex);

  return (
    <nav
      aria-label="Grading workflow"
      data-testid="grading-workflow-bar"
      className="sticky top-0 z-20 -mx-1 mb-4 flex items-stretch gap-1 rounded-xl border border-[var(--admin-line)] bg-[var(--admin-panel)]/95 p-1.5 backdrop-blur supports-[backdrop-filter]:bg-[var(--admin-panel)]/80"
    >
      {GRADING_STAGES.map((stage, i) => {
        const status = statuses[i];
        const isCurrent = status === "current";
        const isComplete = status === "complete";
        return (
          <button
            key={stage.key}
            type="button"
            aria-current={isCurrent ? "step" : undefined}
            data-status={status}
            data-testid={`workflow-stage-${stage.key}`}
            onClick={() => onStageClick?.(i, stage)}
            title={`${stage.label} — ${stage.sublabel}`}
            className={`flex flex-1 items-center gap-2 rounded-lg px-3 py-2 text-left transition ${
              isCurrent
                ? "border border-[var(--admin-gold)] bg-[var(--admin-gold)]/15"
                : isComplete
                  ? "border border-[var(--admin-gold)]/30 bg-[var(--admin-gold)]/5 hover:bg-[var(--admin-gold)]/10"
                  : "border border-transparent bg-[var(--admin-panel2)] opacity-70 hover:opacity-100"
            }`}
          >
            <span
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                isComplete
                  ? "bg-[var(--admin-gold)] text-[#1A1400]"
                  : isCurrent
                    ? "border-2 border-[var(--admin-gold)] text-[var(--admin-gold)]"
                    : "border border-[var(--admin-ink-faint)] text-[var(--admin-ink-faint)]"
              }`}
            >
              {isComplete ? <Check size={13} strokeWidth={3} /> : i + 1}
            </span>
            <span className="min-w-0 leading-tight">
              <span className={`block truncate text-xs font-bold ${isCurrent || isComplete ? "text-[var(--admin-ink)]" : "text-[var(--admin-ink-faint)]"}`}>
                {stage.label}
              </span>
              <span className="hidden truncate text-[10px] text-[var(--admin-ink-faint)] sm:block">{stage.sublabel}</span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}
