import React, { useCallback, useRef, useState, type ReactNode } from "react";
import GradingPanel from "@/components/grading/grading-panel";
import { WorkstationHeaderStrip } from "@/components/grading-workflow/WorkstationHeaderStrip";
import { WorkstationPreviewAside } from "@/components/grading-workflow/WorkstationPreviewAside";
import {
  CanonicalGradingWorkstationShell,
  WORKSTATION_BODY_SCROLL_CLASS,
  WORKSTATION_HEADER_REGION_CLASS,
} from "@/components/grading-workflow/CanonicalGradingWorkstationShell";

/**
 * GradingWorkstation — a THIN role adapter for /staff, /grader and /admin/staff.
 *
 * It owns NO layout: all workstation geometry (full width, two-panel columns,
 * internal scroll, sticky actions, responsive breakpoints) comes from the single
 * CanonicalGradingWorkstationShell — the exact same shell /admin CertificateForm
 * renders. Role differences are capabilities + data source only.
 *
 * HEIGHT CONTRACT: the shell fills its parent (h-full). This adapter's own root
 * is `flex min-h-0 flex-1 flex-col`, so it fills whatever bounded flex slot the
 * route gives it (each active grading view is a `h-[100dvh] flex flex-col`
 * focused container). It does NOT set a viewport-relative height and does NOT
 * wrap the shell in an `admin-root` (min-height:100vh) box — both of those made
 * the shell shorter than its container and left a black band at the bottom. The
 * `--admin-*` tokens are global (:root), so colours work without admin-root.
 *
 * `identityEditor` (Admin Review): rendered INSIDE the workstation — pinned at
 * the top of the scroll body (right column), beside the card preview — never as
 * a detached full-width section above the shell.
 */
export type GradingWorkstationMode = "super-admin" | "admin" | "admin-review" | "staff" | "grader";

type GradingPanelProps = React.ComponentProps<typeof GradingPanel>;

type Props = GradingPanelProps & {
  mode: GradingWorkstationMode;
  /** Optional queue position for the header strip (e.g. Staff "3 / 40"). */
  queue?: { position: number; total: number };
  /** Admin Review identity editor, rendered inside the workstation body (top of
   *  the right column, beside the preview). When present, the preview aside is
   *  forced on so the card sits left / editor right. */
  identityEditor?: ReactNode;
};


export function GradingWorkstation({ mode, queue, identityEditor, ...panelProps }: Props) {
  const apiBase = panelProps.apiBase ?? "/api/admin";
  const rootRef = useRef<HTMLDivElement>(null);
  // Grade is the working stage for these role surfaces; Card/Rarity are already
  // captured upstream. Start on Grade, keep every stage reachable.
  const [stage, setStage] = useState(2);

  // The stage bar GATES content (hidden-not-unmounted via the .grading-stage-gate
  // CSS on the body wrapper below): selecting a stage shows only that stage's
  // GradingPanel sections. Scroll back to the top so the new stage starts at the
  // top of the scroll body.
  const goToStage = useCallback((index: number) => {
    setStage(index);
    rootRef.current?.querySelector<HTMLElement>('[data-testid="grading-workstation-slot"]')?.scrollTo({ top: 0 });
  }, []);

  // Grade is stage 2; showing the preview aside beside GradingPanel would
  // duplicate its own image tool. Show it on the identity stages, and ALWAYS when
  // the Admin Review identity editor is open (so the card is left / editor right).
  const showPreviewAside = stage <= 1 || (mode === "admin-review" && !!identityEditor);
  const certId = panelProps.certId;

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid="grading-workstation"
      data-mode={mode}
      data-api-base={apiBase}
    >
      <CanonicalGradingWorkstationShell
        rootRef={rootRef}
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
        {/* Canonical scroll body — same class as the /admin <form> body. The
            grading-stage-gate + data-ws-stage drive stage-content gating (CSS in
            admin-tokens.css) so the stage bar controls which GradingPanel
            sections are shown — hidden-not-unmounted, no grading-logic change. */}
        <div
          className={`${WORKSTATION_BODY_SCROLL_CLASS} grading-stage-gate`}
          data-testid="grading-workstation-slot"
          data-ws-stage={stage}
        >
          {/* Admin Review identity editor — inside the workstation body (right
              column), above the grading panel; never a detached section. */}
          {identityEditor && <div data-testid="workstation-identity-editor">{identityEditor}</div>}
          {/* Remount per card so no identity/grade/approval state leaks between
              records (GradingPanel seeds a lot of state from props at mount). */}
          <GradingPanel key={`${apiBase}:${certId}`} {...panelProps} />
        </div>
      </CanonicalGradingWorkstationShell>
    </div>
  );
}

export default GradingWorkstation;
