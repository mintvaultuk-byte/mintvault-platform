/**
 * Shared workstation preview aside — the left-column card image zone used by
 * Card, Rarity and Review. ONE constant drives the column ratio/breakpoint
 * (`WORKSTATION_PREVIEW_WIDTH_CLASS`) so every stage that shows a preview
 * uses the exact same geometry; there is no second copy of this class string
 * anywhere else to drift out of sync.
 *
 * Grade (Stage 3) does NOT use this component. The protected
 * client/src/components/grading/ workstation (GradingPanel) already renders
 * its own interactive image/defect-marking tool with its OWN internal
 * left-image/right-controls split (see grading-panel.tsx's
 * `grid-cols-1 lg:grid-cols-[60%_40%]` layout) — mounting this aside
 * alongside it would either duplicate the card image or squeeze that
 * protected tool's own grid into a much narrower width, degrading defect/
 * centering placement precision. That is a deliberate, documented exception,
 * not an oversight — see the architecture note in certificate-form.tsx where
 * this component is used.
 */
import type { ReactNode } from "react";
import { CardPreviewPanel } from "./CardPreviewPanel";

/** Single source of truth for the preview column's width + breakpoint. */
export const WORKSTATION_PREVIEW_WIDTH_CLASS = "md:w-[40%] md:shrink-0";

export function WorkstationPreviewAside({
  certificateId,
  frontFile,
  backFile,
  apiBase = "/api/admin",
  below,
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
}) {
  // No `below` → render exactly as before (Card stage is untouched).
  if (!below) {
    return (
      <aside className={`min-h-0 max-md:max-h-[55vh] ${WORKSTATION_PREVIEW_WIDTH_CLASS}`} data-testid="grading-preview-panel">
        <CardPreviewPanel fill certificateId={certificateId} frontFile={frontFile} backFile={backFile} apiBase={apiBase} />
      </aside>
    );
  }
  return (
    <aside className={`flex min-h-0 flex-col gap-2 max-md:max-h-[55vh] ${WORKSTATION_PREVIEW_WIDTH_CLASS}`} data-testid="grading-preview-panel">
      <div className="min-h-0 flex-1">
        <CardPreviewPanel fill certificateId={certificateId} frontFile={frontFile} backFile={backFile} apiBase={apiBase} />
      </div>
      <div className="shrink-0">{below}</div>
    </aside>
  );
}
