import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { MVGS_DEFECT_TYPES } from "./defect-annotation";
import type { MvgsCode } from "./defect-annotation";

/**
 * Defect type picker — anchored portal'd dropdown used after the operator
 * drops a batch of pins on the card image. Two consumers share this:
 *
 *  - <ImageViewer> mark mode — pins dropped on the cropped display image
 *    inside the grading panel.
 *  - <ManualCardTool> defects phase — pins dropped on the freshly-cropped
 *    image right after the 8-dot Compute, without closing the overlay.
 *
 * Both consumers manage their own batch + picker open/anchor state; this
 * component only renders the dropdown when called with an anchor. Kept
 * minimal on props so it stays trivial to share.
 *
 * Renders via document.body portal so it escapes any ancestor
 * `transform: scale(...)` (the image container uses transform for zoom
 * which would otherwise break position: fixed).
 */

export type DefectTier = "D1" | "D2" | "D3";

export interface DefectPickerAnchor {
  /** Viewport-absolute pixel position of the last pin in the batch — used
   *  as the dropdown's anchor point. */
  pxX: number;
  pxY: number;
  /** Image-relative percent of the same pin — used purely to decide flip
   *  direction so the dropdown doesn't fall off-screen when pinning near
   *  the right or bottom edge of the card. */
  xPct: number;
  yPct: number;
}

interface Props {
  anchor: DefectPickerAnchor;
  tier: DefectTier;
  onTierChange: (t: DefectTier) => void;
  onPick: (opts: { mvgsCode: MvgsCode; label: string; tier: DefectTier }) => void;
  onCancel: () => void;
  /** Pending pin count shown in the header — operator-facing batch size hint. */
  pinCount: number;
}

const DROPDOWN_W = 180;
const DROPDOWN_H = 360;
const GAP = 6;

export default function DefectTypePicker({ anchor, tier, onTierChange, onPick, onCancel, pinCount }: Props) {
  const flipLeft = anchor.xPct > 70;
  const flipUp = anchor.yPct > 70;
  const left = flipLeft ? anchor.pxX - GAP - DROPDOWN_W : anchor.pxX + GAP;
  const top = flipUp ? anchor.pxY - GAP - DROPDOWN_H : anchor.pxY + GAP;
  const clampedLeft = Math.max(8, Math.min(window.innerWidth - DROPDOWN_W - 8, left));
  const clampedTop = Math.max(8, Math.min(window.innerHeight - DROPDOWN_H - 8, top));
  return createPortal(
    <>
      <div className="fixed inset-0" style={{ zIndex: 9998 }} onClick={onCancel} />
      <div
        className="fixed bg-white border border-[#D4AF37]/60 rounded-lg shadow-2xl overflow-hidden"
        style={{ zIndex: 9999, left: clampedLeft, top: clampedTop, width: DROPDOWN_W, maxHeight: DROPDOWN_H }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-3 py-2 border-b border-[#E8E4DC] bg-[#F7F7F5] flex items-center justify-between">
          <span className="text-[#D4AF37] text-[10px] font-bold uppercase tracking-widest">Defect ({pinCount})</span>
          <button
            type="button"
            onClick={onCancel}
            className="text-[#888888] hover:text-red-600 transition-colors"
            aria-label="Cancel"
          >
            <X size={12} />
          </button>
        </div>
        <div className="px-3 py-2 border-b border-[#E8E4DC] bg-white">
          <div className="text-[9px] uppercase tracking-widest text-[#888] mb-1">Tier</div>
          <div className="flex gap-1">
            {(["D1", "D2", "D3"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => onTierChange(t)}
                className={`flex-1 text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded border transition-colors ${
                  tier === t
                    ? "bg-[#D4AF37] text-[#1A1400] border-[#D4AF37]"
                    : "bg-white text-[#555] border-[#E8E4DC] hover:border-[#D4AF37]"
                }`}
                data-testid={`btn-tier-${t}`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
        <div className="overflow-y-auto" style={{ maxHeight: DROPDOWN_H - 90 }}>
          {MVGS_DEFECT_TYPES.map((t) => (
            <button
              key={t.code}
              type="button"
              onClick={() => onPick({ mvgsCode: t.code, label: t.label, tier })}
              className="w-full text-left px-3 py-1.5 text-[#1A1A1A] text-xs hover:bg-[#D4AF37]/10 border-b border-[#F0EEE8] last:border-b-0 transition-colors flex items-center justify-between gap-2"
              data-testid={`mvgs-pick-${t.code}`}
            >
              <span>{t.label}</span>
              <span className="font-mono text-[10px] text-[#888]">{t.code}</span>
            </button>
          ))}
        </div>
      </div>
    </>,
    document.body
  );
}
