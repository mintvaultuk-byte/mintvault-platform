import React, { useCallback, useRef, useState } from "react";
import GradingPanel from "@/components/grading/grading-panel";
import { WorkstationHeaderStrip } from "@/components/grading-workflow/WorkstationHeaderStrip";
import { WorkstationPreviewAside } from "@/components/grading-workflow/WorkstationPreviewAside";
import {
  CanonicalGradingWorkstationShell,
  WORKSTATION_BODY_SCROLL_CLASS,
  WORKSTATION_HEADER_REGION_CLASS,
  type WorkstationViewportOffset,
} from "@/components/grading-workflow/CanonicalGradingWorkstationShell";

/**
 * GradingWorkstation — a THIN role adapter for /staff, /grader and /admin/staff.
 *
 * It owns NO layout: all workstation geometry (fixed viewport height, full
 * width, two-panel columns, internal scroll, sticky actions, responsive
 * breakpoints) comes from the single CanonicalGradingWorkstationShell — the
 * exact same shell the /admin CertificateForm renders. This adapter only wires
 * role-specific inputs (apiBase, capability props, stage nav, preview) and the
 * shared building blocks (WorkstationHeaderStrip, WorkstationPreviewAside,
 * GradingPanel) into that canonical shell. Role differences are capabilities and
 * data source only — never a competing layout.
 *
 * The `admin-root` wrapper is the admin token scope + dark ground (same as this
 * adapter previously provided, and as /admin/staff's review overlay provides);
 * it sits OUTSIDE the shell so it never forces the fixed-height pane taller.
 */
export type GradingWorkstationMode = "super-admin" | "admin" | "admin-review" | "staff" | "grader";

type GradingPanelProps = React.ComponentProps<typeof GradingPanel>;

type Props = GradingPanelProps & {
  mode: GradingWorkstationMode;
  /** Optional queue position for the header strip (e.g. Staff "3 / 40"). */
  queue?: { position: number; total: number };
};

// Which canonical GradingPanel section each workflow stage scrolls to.
const STAGE_SECTION: Record<number, string> = {
  0: "identity-fields", // Card — identity
  1: "identity-fields", // Rarity & variant live in the identity block
  2: "grading-controls", // Grade
  3: "footer-actions", // Review & submit
};

// Per-route surrounding-chrome offset (keys into the shell's literal class map).
// Tuned against real authenticated staging screenshots.
const MODE_VIEWPORT_OFFSET: Record<GradingWorkstationMode, WorkstationViewportOffset> = {
  "super-admin": "4.5rem",
  admin: "4.5rem",
  "admin-review": "4.5rem", // review overlay is full-viewport
  staff: "8.5rem", // header row + tab bar
  grader: "6.5rem", // single header row
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
    <div className="admin-root" data-testid="grading-workstation" data-mode={mode} data-api-base={apiBase}>
      <CanonicalGradingWorkstationShell
        rootRef={rootRef}
        viewportOffset={MODE_VIEWPORT_OFFSET[mode]}
        previewAside={
          showPreviewAside && certId != null ? (
            <WorkstationPreviewAside certificateId={certId} apiBase={apiBase} />
          ) : null
        }
      >
        {/* Fixed (shrink-0) header region — canonical class, same as /admin. */}
        <div className={WORKSTATION_HEADER_REGION_CLASS}>
          <WorkstationHeaderStrip
            workflowCurrent={stage}
            workflowMax={3}
            onStageClick={(i) => goToStage(i)}
            queue={queue}
            sessionCompleted={0}
          />
        </div>
        {/* Canonical scroll body — same class as the /admin <form> body. */}
        <div className={WORKSTATION_BODY_SCROLL_CLASS} data-testid="grading-workstation-slot">
          {/* Remount per card so no identity/grade/approval state leaks between
              records (GradingPanel seeds a lot of state from props at mount). */}
          <GradingPanel key={`${apiBase}:${certId}`} {...panelProps} />
        </div>
      </CanonicalGradingWorkstationShell>
    </div>
  );
}

export default GradingWorkstation;
