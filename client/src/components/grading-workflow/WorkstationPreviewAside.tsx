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
import { useEffect, useState, type ReactNode, type Ref } from "react";
import { RAIL_SAFE_MIN_WIDTH_PX } from "@shared/rail-width";
import { useRailWidth } from "./rail-width-context";
import { CardPreviewPanel } from "./CardPreviewPanel";
import type { CardInspectionState } from "./card-inspection-state";

/** Single source of truth for the preview column's width + breakpoint. */
/**
 * The ONE canonical desktop split for every grading role: 45% card rail / 55% controls.
 *
 * Raised from 35% on owner instruction after real measurement at the owner's actual
 * laptop viewport (845x685). The card frame is 5:7, so at a 35% rail its WIDTH capped its
 * height at ~405px while the rail host offered ~638px — a third of the rail was
 * unreachable and no card-side CSS could recover it, because the card was width-bound.
 * Rail width is the only lever.
 *
 * Measured, all fully visible with the certificate below and no horizontal overflow:
 *
 *   845x685   35% -> 286.9x405.2 (116k px^2)   45% -> 368.8x520.9 (192k, +65%)
 *   1024x768  35% -> 347.6x491.0 (171k)        45% -> 434.6x614.0 (267k, +56%)
 *   1280x800  35% -> 434.6x613.8 (267k)        45% -> 454.0x642.5 (292k,  +9%)
 *
 * 48% was rejected: it returns less at 845 and is slightly WORSE at 1024/1280, where the
 * card becomes height-bound and the extra width only narrows the controls. Right pane at
 * the tightest tested viewport is 456.8px, with no content overflow and its own vertical
 * scroll intact.
 */
export const WORKSTATION_PREVIEW_WIDTH_CLASS = "md:w-[45%] md:shrink-0";

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
  /**
   * ADAPTIVE WIDTH. `WORKSTATION_PREVIEW_WIDTH_CLASS` stays the responsive
   * DEFAULT and the safe MAXIMUM; the predicted requirement can only narrow the
   * rail from there, never widen it past what the layout gives today.
   *
   * That asymmetry is what protects the accepted card at small viewports: at
   * 845x685 the requirement (375.0px) already exceeds the current rail
   * (371.3px), so the clamp returns the current width and the card is untouched.
   * A complete card outranks recovered space.
   *
   * Desktop only — below `md` the rail is a stacked full-width block and a px
   * width would fight the responsive column layout.
   */
  const requiredRailWidth = useRailWidth();
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const sync = () => setIsDesktop(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  /**
   * Applied as `max-width`, NOT `width`, and that choice is load-bearing.
   *
   * `WORKSTATION_PREVIEW_WIDTH_CLASS` keeps supplying the 45% width, so the
   * browser evaluates `min(45%, requirement)` itself. Nothing has to measure the
   * rail to learn its own safe maximum — and measuring it is exactly the loop
   * this design exists to avoid, because after the first adjustment the measured
   * width would BE the adjusted width.
   *
   * `max-width` clamps a flex item's used main size, so `md:shrink-0` and the
   * flex row are untouched. Below `md` no cap is applied at all: the rail is a
   * stacked full-width block there and a px cap would fight the column layout.
   */
  const railMaxWidth =
    isDesktop && requiredRailWidth != null && requiredRailWidth > 0
      ? Math.max(requiredRailWidth, RAIL_SAFE_MIN_WIDTH_PX)
      : null;
  const railStyle = railMaxWidth != null ? { maxWidth: `${railMaxWidth}px` } : undefined;

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
        style={railStyle}
        data-rail-max-width={railMaxWidth ?? ""}
        data-testid="grading-preview-panel"
      >
        {card}
      </aside>
    );
  }
  return (
    <aside
      className={`flex min-h-0 flex-col gap-1 max-md:max-h-[55vh] ${WORKSTATION_PREVIEW_WIDTH_CLASS}`}
      style={railStyle}
      data-rail-max-width={railMaxWidth ?? ""}
      data-testid="grading-preview-panel"
    >
      <div className="min-h-0 flex-1">{card}</div>
      <div className="shrink-0">{below}</div>
    </aside>
  );
}
