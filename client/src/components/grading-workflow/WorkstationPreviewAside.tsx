/**
 * Shared workstation preview aside — the persistent left-column card + live
 * certificate zone used by Card Details, Grade and Review. ONE constant drives
 * the column ratio/breakpoint
 * (`WORKSTATION_PREVIEW_WIDTH_CLASS`) so every stage that shows a preview
 * uses the exact same geometry; there is no second copy of this class string
 * anywhere else to drift out of sync.
 *
 * On Grade, the existing interactive GradingPanel image/defect surface is
 * portalled into this rail. Card Details and Review use CardPreviewPanel. That
 * keeps one card surface and preserves the grading tool's original React state
 * and handlers without creating a second role-specific shell.
 */
import type { ReactNode, Ref } from "react";
import { CardPreviewPanel } from "./CardPreviewPanel";
import type { CardInspectionState } from "./card-inspection-state";

/** Single source of truth for the preview column's width + breakpoint. */
export const WORKSTATION_PREVIEW_WIDTH_CLASS = "md:w-[35%] md:shrink-0";

export function WorkstationPreviewAside({
  certificateId,
  frontFile,
  backFile,
  apiBase = "/api/admin",
  below,
  interactiveCardHostRef,
  inspectionState,
  onInspectionStateChange,
}: {
  certificateId: number | null;
  frontFile?: File | null;
  backFile?: File | null;
  /** Cert-scoped API base for the preview images. Defaults to /api/admin so the
      admin certificate editor is unchanged; role-safe shells pass their own. */
  apiBase?: string;
  /** Optional panel stacked UNDER the card image (e.g. the live certificate
      preview on Rarity/Review). When omitted the layout is unchanged. */
  below?: ReactNode;
  /** Grade-stage host for the existing interactive ImageViewer/defect surface.
      This keeps one card surface in the canonical left rail rather than adding
      a read-only duplicate beside GradingPanel's editor. */
  interactiveCardHostRef?: Ref<HTMLDivElement>;
  inspectionState: CardInspectionState;
  onInspectionStateChange: (state: CardInspectionState) => void;
}) {
  // ONE card-image render site (invariant enforced by the workstation-shell
  // tests). When a `below` panel is present the aside stacks; otherwise the
  // layout is byte-identical to before, so the Card stage is untouched.
  const card = interactiveCardHostRef ? (
    <div
      ref={interactiveCardHostRef}
      className="min-h-0 h-full overflow-hidden"
      data-testid="grading-interactive-card-host"
    />
  ) : (
    <CardPreviewPanel
      fill
      certificateId={certificateId}
      frontFile={frontFile}
      backFile={backFile}
      apiBase={apiBase}
      inspectionState={inspectionState}
      onInspectionStateChange={onInspectionStateChange}
    />
  );
  if (!below) {
    return (
      <aside
        className={`min-h-0 max-md:max-h-[55vh] ${WORKSTATION_PREVIEW_WIDTH_CLASS}`}
        data-testid="grading-preview-panel"
      >
        {card}
      </aside>
    );
  }
  return (
    <aside
      className={`flex min-h-0 flex-col gap-1.5 max-md:max-h-[55vh] ${WORKSTATION_PREVIEW_WIDTH_CLASS}`}
      data-testid="grading-preview-panel"
    >
      <div className="min-h-0 flex-1">{card}</div>
      <div className="shrink-0">{below}</div>
    </aside>
  );
}
