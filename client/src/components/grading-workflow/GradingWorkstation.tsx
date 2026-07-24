import React, { useCallback, useRef, useState } from "react";
import GradingPanel from "@/components/grading/grading-panel";
import { WorkstationHeaderStrip } from "@/components/grading-workflow/WorkstationHeaderStrip";
import { WorkstationPreviewAside } from "@/components/grading-workflow/WorkstationPreviewAside";

/**
 * Shared, role-safe grading WORKSTATION shell.
 *
 * Gives /staff, /grader and /admin/staff (review) the SAME workstation chrome
 * the /admin certificate editor already renders — the shared
 * `WorkstationHeaderStrip` (Card -> Rarity -> Grade -> Review stage bar +
 * session HUD) and the shared `WorkstationPreviewAside` card preview — wrapped
 * around the existing protected `GradingPanel`, WITHOUT touching CertificateForm
 * (so /admin cannot regress) and WITHOUT duplicating any grading/identity/submit
 * logic (GradingPanel already owns all of that, role-safely, via its
 * graderMode / adminReview / apiBase props).
 *
 * Role-safety is structural, not by hiding controls: this shell never renders
 * the admin certificate editor, never calls /api/admin write endpoints, and the
 * mode only drives PRESENTATION + which GradingPanel props are passed. Server
 * RBAC remains the authority.
 *
 * The stage bar is scroll-navigation only (exactly like the admin workstation's
 * bar — it never gates, saves, or grades); clicking a stage scrolls the matching
 * GradingPanel section into view.
 */
export type GradingWorkstationMode = "super-admin" | "admin" | "admin-review" | "staff" | "grader";

type GradingPanelProps = React.ComponentProps<typeof GradingPanel>;

type Props = GradingPanelProps & {
  mode: GradingWorkstationMode;
  /** Optional queue position for the header strip (e.g. Staff "3 / 40"). */
  queue?: { position: number; total: number };
};

// Which GradingPanel section each workflow stage scrolls to. GradingPanel is a
// single scrolling panel (not four separate mounts), so the bar navigates its
// canonical sections rather than swapping panes — matching the admin bar, which
// also scrolls rather than gates.
const STAGE_SECTION: Record<number, string> = {
  0: "identity-fields", // Card — identity
  1: "identity-fields", // Rarity & variant live in the identity block
  2: "grading-controls", // Grade
  3: "footer-actions", // Review & submit
};

export function GradingWorkstation({ mode, queue, ...panelProps }: Props) {
  const apiBase = panelProps.apiBase ?? "/api/admin";
  const rootRef = useRef<HTMLDivElement>(null);
  // Grade is the working stage for these role surfaces; Card/Rarity are already
  // captured upstream. Start on Grade, keep every stage reachable.
  const [stage, setStage] = useState(2);

  const goToStage = useCallback((index: number) => {
    setStage(index);
    const section = STAGE_SECTION[index];
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-canonical-section="${section}"]`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  // Grade is stage 2; showing the preview aside beside GradingPanel would
  // duplicate its own image tool, so — exactly like the admin Grade stage — the
  // aside is only shown when the operator navigates to the identity stages.
  const showPreviewAside = stage <= 1;
  const certId = panelProps.certId;

  return (
    <section
      ref={rootRef}
      className="admin-root mx-auto w-full max-w-6xl px-3 py-3"
      data-testid="grading-workstation"
      data-mode={mode}
      data-api-base={apiBase}
    >
      <div className="grading-workspace" data-testid="grading-workspace">
        {/* Shared workstation header strip — identical component + geometry as
            the admin workstation (WorkstationHeaderStrip). */}
        <WorkstationHeaderStrip
          workflowCurrent={stage}
          workflowMax={3}
          onStageClick={(i) => goToStage(i)}
          queue={queue}
          sessionCompleted={0}
        />
        <div className="mt-2 flex min-h-0 min-w-0 flex-col gap-3 md:flex-row">
          {showPreviewAside && certId != null && (
            <WorkstationPreviewAside certificateId={certId} apiBase={apiBase} />
          )}
          <div className="min-h-0 min-w-0 flex-1" data-testid="grading-workstation-slot">
            {/* Remount per card so no identity/grade/approval state leaks between
                records (GradingPanel seeds a lot of state from props at mount). */}
            <GradingPanel key={`${apiBase}:${certId}`} {...panelProps} />
          </div>
        </div>
      </div>
    </section>
  );
}

export default GradingWorkstation;
