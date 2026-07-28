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

/** 3-stage flow: 0 = Card Details, 1 = Grade, 2 = Review. */
const GRADE_STAGE = 1;
/** M-2 · Approve/Publish lives on Review, so the Ctrl+Enter shortcut does too. */
const REVIEW_STAGE = 2;

type GradingPanelProps = React.ComponentProps<typeof GradingPanel>;

/**
 * PR A (hostile review M-1) · `active` is OMITTED from this adapter's public
 * props ON PURPOSE.
 *
 * /grader, /staff and /admin/staff all mount the workstation through here, and
 * the stage that decides whether Grade is on screen is THIS component's own
 * `stage` state (below) — the pages never see it. Letting a page pass `active`
 * would let it contradict the stage the user is actually looking at, which is
 * precisely the fail-open shape the review flagged. The adapter derives the flag
 * from its own state and passes it explicitly to GradingPanel, so all three
 * standalone surfaces are covered by construction rather than by remembering.
 */
// MUST stay multi-line. Collapsed onto one line, `Omit<` and `GradingPanelProps`
// become adjacent and form the JSX open-tag literal for the grading panel. The
// protected architecture suite locates the single real render site by the FIRST
// occurrence of that literal (it asserts the identity-editor slot comes above
// it), so a one-line form silently breaks that check. Hence prettier-ignore.
// prettier-ignore
type Props = Omit<
  GradingPanelProps,
  "active" | "approvalStageActive"
> & {
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
  // Grade is the working stage for these role surfaces; Card Details is already
  // captured upstream. Start on Grade, keep every stage reachable.
  // 3-stage flow: 0 = Card Details, 1 = Grade, 2 = Review.
  const [stage, setStage] = useState(GRADE_STAGE);

  // The stage bar GATES content (hidden-not-unmounted via the .grading-stage-gate
  // CSS on the body wrapper below): selecting a stage shows only that stage's
  // GradingPanel sections. Scroll back to the top so the new stage starts at the
  // top of the scroll body.
  const goToStage = useCallback((index: number) => {
    setStage(index);
    rootRef.current?.querySelector<HTMLElement>('[data-testid="grading-workstation-slot"]')?.scrollTo({ top: 0 });
  }, []);

  // Grade is stage 1; showing the preview aside beside GradingPanel would
  // duplicate its own image tool. Show it on Card Details, and ALWAYS when the
  // Admin Review identity editor is open (so the card is left / editor right).
  const showPreviewAside = stage === 0 || (mode === "admin-review" && !!identityEditor);
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
          {/* PR A · EXPLICIT lifecycle. The Grade panel is hidden-not-unmounted
              by the stage gate above, so it must be told when it is genuinely on
              screen — otherwise its debounced auto-save keeps running behind
              Card Details / Review and persists UI defaults as grading data.
              Derived from this adapter's own stage, which is the only thing that
              knows; `active` is not accepted from the page for that reason. */}
          {/* M-2 · each shortcut is wired to the stage that OWNS it: Ctrl+S to
              Grade (`active`), Ctrl+Enter to Review (`approvalStageActive`).
              Both derive from THIS adapter's own stage for the same reason —
              a page must not be able to contradict what is on screen. */}
          <GradingPanel
            key={`${apiBase}:${certId}`}
            {...panelProps}
            active={stage === GRADE_STAGE}
            approvalStageActive={stage === REVIEW_STAGE}
          />
        </div>
      </CanonicalGradingWorkstationShell>
    </div>
  );
}

export default GradingWorkstation;
