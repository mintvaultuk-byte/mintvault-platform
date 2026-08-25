import React, { type ReactNode, type Ref } from "react";

/**
 * CanonicalGradingWorkstationShell — the ONE grading-workstation outer shell for
 * the entire MintVault grading network (Super Admin /admin, Staff, Grader, Admin
 * Review, and Partner grading).
 *
 * This is the EXACT proven outer geometry previously inlined only in
 * client/src/components/certificate-form.tsx (the founder-approved Super Admin
 * workstation): a fixed viewport-height, full-width, two-panel pane with a
 * shrink-0 header/stage region and an internally-scrolling grading body. It was
 * extracted verbatim (same class strings, same testids, same nesting) so every
 * role renders byte-identical geometry — only capabilities, data source, API
 * base, read-only state and available actions differ by role, never the layout.
 *
 * Deliberately NOT configurable: width, max-width, desktop grid, gradient,
 * preview sizing, scroll model, stage-bar layout, MVGS/Overall-Grade geometry,
 * sticky-footer behaviour and responsive breakpoints are all owned here and
 * cannot be overridden by a route. Routes may supply ONLY structural inputs:
 * the surrounding-chrome viewport offset, the header content, the preview aside,
 * and the grading body.
 *
 * The body (children) MUST be the canonical scroll element
 * (`min-h-0 flex-1 space-y-2 overflow-y-auto md:pr-1`) — Super Admin passes its
 * existing <form> with exactly those classes (unchanged); role routes pass a
 * <div> with the same classes (see WORKSTATION_BODY_SCROLL_CLASS). An
 * architecture test enforces this so no route can fork the scroll model.
 */

/**
 * The shell FILLS its parent's height (`h-full`) and never sets a viewport-
 * relative height of its own. This is the canonical height contract:
 *
 *   caller provides a bounded flex-column parent  →  shell fills it exactly.
 *
 * This replaces the earlier per-route fixed viewport-calc height map, whose
 * magic offsets could not match every route's real surrounding chrome and left a
 * dark/black band below the shell whenever the offset was too large or an
 * ancestor (admin-root min-height, a fixed black overlay) was taller than the
 * shell. Deriving the height from the real parent removes the whole class of
 * "black bar at the bottom" defects and needs no per-route tuning.
 *
 * Contract for callers (enforced by the architecture test):
 *   - Super Admin /admin: CertificateForm wraps the shell in the ONE sanctioned
 *     bounded viewport-height flex-column div → /admin height unchanged.
 *   - Staff / Grader / Admin Review: the route wraps the shell in a focused
 *     full-viewport flex-column container (or a flex-1 min-h-0 slot).
 */
export const WORKSTATION_FILL_CLASS = "flex min-h-0 flex-col h-full";

/** The one canonical fixed (shrink-0) header-region class. Both admin and role
 *  routes compose their stage bar / ID tools inside a div with exactly this. */
export const WORKSTATION_HEADER_REGION_CLASS = "shrink-0 space-y-1";

/** The one canonical grading-body scroll class. Admin's <form> and every role
 *  <div> use exactly this — enforced by the architecture test. */
export const WORKSTATION_BODY_SCROLL_CLASS = "min-h-0 flex-1 space-y-2 overflow-y-auto md:pr-1";

/**
 * The two-pane floor is derived from the smallest usable control/card split:
 * 540 CSS px leaves roughly 243px for a complete 45% card rail and 297px for
 * the independently scrolling controls. It also keeps the owner's measured
 * 845px laptop in two-pane mode through 150% browser zoom (about 563 CSS px),
 * avoiding the old `md` breakpoint cliff. True narrow screens stack below it.
 */
export const WORKSTATION_TWO_PANE_CLASS = "min-[540px]:flex-row";

export interface CanonicalGradingWorkstationShellProps {
  /** Persistent left card + live-certificate preview rail. */
  previewAside?: ReactNode;
  /** Ref to the outer root — used by routes for stage-scroll section queries. */
  rootRef?: Ref<HTMLDivElement>;
  /**
   * The control-panel body: exactly two composed regions — a fixed header
   * (`WORKSTATION_HEADER_REGION_CLASS`) and the canonical scroll body
   * (`WORKSTATION_BODY_SCROLL_CLASS`). Admin passes its existing header div +
   * <form> unchanged; role routes pass the header div + a <div> body. The shell
   * owns the surrounding pane geometry; callers never own width/height/scroll.
   */
  children: ReactNode;
}

export function CanonicalGradingWorkstationShell({
  previewAside,
  rootRef,
  children,
}: CanonicalGradingWorkstationShellProps) {
  return (
    <div ref={rootRef} className={WORKSTATION_FILL_CLASS} data-testid="grading-workspace" data-canonical-shell="true">
      <div className={`flex min-h-0 flex-1 flex-col gap-2 ${WORKSTATION_TWO_PANE_CLASS}`}>
        {previewAside}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="grading-control-panel">
          {children}
        </div>
      </div>
    </div>
  );
}

export default CanonicalGradingWorkstationShell;
