/**
 * Shared workstation header strip — 3-stage workflow navigation (left/top
 * zone) + queue/session statistics (right/bottom zone). ONE component
 * rendered once per grading session (outside the 4 per-stage sections), so
 * Card Details, Grade and Review all see the byte-identical header — there
 * is no way for one stage to drift from another because there is only one
 * render site.
 *
 * The two zones are DELIBERATELY separate containers, never one shared
 * shrink-to-fit row: on a real 13" laptop the two pieces together don't
 * reliably fit on one line, and letting them share a row (relying on
 * flex-wrap + text truncation alone) let session-stat text render on top of
 * the stage buttons in production. Below the 2xl breakpoint they stack as
 * two full-width rows; at 2xl+ they sit side-by-side with the stats zone
 * shrink-0 so it can never eat into the nav zone's space. No absolute
 * positioning, no negative margins, no shared grid columns.
 *
 * Pure presentation: takes workflow/session state as props, calls back on
 * stage clicks — holds no state of its own, saves/mutates nothing.
 */
import { GradingWorkflowBar } from "./GradingWorkflowBar";
import { SessionHud } from "./SessionHud";
import type { WorkflowStage } from "@shared/grading-workflow";

export interface WorkstationBatchInfo {
  customer?: string;
  submissionId?: string;
  remaining?: number;
}

export function WorkstationHeaderStrip({
  workflowCurrent,
  workflowMax,
  onStageClick,
  batch,
  queue,
  sessionCompleted,
}: {
  workflowCurrent: number;
  workflowMax: number;
  onStageClick: (index: number, stage: WorkflowStage) => void;
  batch?: WorkstationBatchInfo;
  queue?: { position: number; total: number };
  sessionCompleted: number;
}) {
  return (
    <div
      className="flex flex-col gap-1 rounded-xl border border-[var(--admin-line)] bg-[var(--admin-panel)]/95 px-2 py-1 2xl:flex-row 2xl:items-center 2xl:gap-x-2.5 2xl:gap-y-0"
      data-testid="workstation-strip"
    >
      <div className="min-w-0 2xl:flex-1" data-testid="workflow-nav-zone">
        <GradingWorkflowBar embedded currentIndex={workflowCurrent} maxReached={workflowMax} onStageClick={onStageClick} />
      </div>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10px] 2xl:shrink-0 2xl:justify-end" data-testid="batch-header">
        {batch?.customer && (
          <span className="text-[var(--admin-ink)]" title="Customer">
            <span className="text-[9px] uppercase tracking-wider text-[var(--admin-ink-faint)]">Cust</span> {batch.customer}
          </span>
        )}
        {batch?.submissionId && (
          <span className="text-[var(--admin-ink)]" title="Submission">
            <span className="text-[9px] uppercase tracking-wider text-[var(--admin-ink-faint)]">Sub</span> {batch.submissionId}
          </span>
        )}
        {typeof batch?.remaining === "number" && (
          <span className="text-[var(--admin-ink)]" title="Remaining in batch">
            <span className="text-[9px] uppercase tracking-wider text-[var(--admin-ink-faint)]">Left</span> {batch.remaining}
          </span>
        )}
        {queue && (
          <span className="font-bold tabular-nums text-[var(--admin-gold)]" data-testid="queue-progress" title="Position in the grading queue">
            {queue.position} / {queue.total}
          </span>
        )}
        <SessionHud embedded completed={sessionCompleted} />
      </div>
    </div>
  );
}
