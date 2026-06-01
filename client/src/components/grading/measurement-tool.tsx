/**
 * MVGS v2 Phase 2 — measurement tool (whitening lines + crease).
 *
 * Fullscreen overlay (`z-[100]`, parallel to ManualCardTool) the operator
 * opens from the grading workstation to capture the v2 measurements that
 * feed the engine via shared/mvgs-input-builder.ts:
 *
 *   - Whitening lines: along card edges. EDGE-PICK-FIRST per spec — the
 *     operator selects the edge (front/back × top/right/bottom/left)
 *     BEFORE drawing. No geometry inference. Coverage % = the drawn line's
 *     length along the edge axis, as % of the image's edge dimension.
 *   - Crease line: drawn across the card. Span % = max(|dx|, |dy|) (the
 *     dominant axis run), as % of card dimension. Single value per cert.
 *
 * Wrinkle + tear severity are dropdowns and live in surface-grading.tsx
 * alongside the legacy has_crease/has_tear booleans. Engine precedence is
 * enforced in shared/mvgs-input-builder.ts (measurement always wins).
 *
 * NOT in this component:
 *   - Pin marker (lives in image-viewer.tsx mark mode, unchanged).
 *   - Wrinkle/tear severity dropdowns (surface-grading.tsx).
 *
 * State here mirrors the parent's whitening_lines / crease_span_pct in
 * grading-panel.tsx via the onChange callbacks; nothing persists in this
 * component — the panel's autoSave PUTs the cert.
 */

import { useEffect, useRef, useState } from "react";
import { X, Pencil, Minus, Check, Trash2 } from "lucide-react";
import type { WhiteningEdge } from "@shared/mvgs-scoring";

type Side = "front" | "back";
type EdgeKey = "top" | "right" | "bottom" | "left";
type Tool = "whitening" | "crease";
type Pt = { x: number; y: number };
// Structural extension of the engine's WhiteningEdge: the same required fields
// the engine reads (side, edge, coveragePct) PLUS the operator's actual drawn
// segment (start/end, image-relative %) for redraw. The engine still consumes
// WhiteningEdge[] — these extra keys are ignored via structural typing, so
// shared/mvgs-scoring.ts stays frozen.
type DrawnWhiteningEdge = WhiteningEdge & { start?: Pt; end?: Pt };

interface Props {
  certIdStr: string;
  /** Display image URLs — cropped / final view. Operator draws on these. */
  frontImageUrl: string | null;
  backImageUrl: string | null;
  /** Current persisted measurements; the tool seeds from these and reports
   *  changes via onWhiteningLinesChange / onCreaseSpanPctChange. */
  whiteningLines: DrawnWhiteningEdge[];
  creaseSpanPct: number | null;
  /** Crease drawn segment — session-only display state owned by the parent
   *  (crease_span_pct persists; the segment does not). Lets the committed
   *  crease line redraw within the grading session. */
  creaseSegment: { side: Side; start: Pt; end: Pt } | null;
  onWhiteningLinesChange: (next: DrawnWhiteningEdge[]) => void;
  onCreaseSpanPctChange: (next: number | null) => void;
  onCreaseSegmentChange: (next: { side: Side; start: Pt; end: Pt } | null) => void;
  onClose: () => void;
}

const EDGE_LABELS: Record<EdgeKey, string> = {
  top: "TOP",
  right: "RIGHT",
  bottom: "BOTTOM",
  left: "LEFT",
};

/** Compute per-edge coverage % from a drawn segment. For top/bottom edges
 *  the coverage axis is X (horizontal run); for left/right edges it's Y
 *  (vertical run). Both expressed as % of the image's natural dimension —
 *  the line's start/end are already image-relative percents. */
function coverageFromSegment(
  startPct: { x: number; y: number },
  endPct: { x: number; y: number },
  edge: EdgeKey
): number {
  const dx = Math.abs(endPct.x - startPct.x);
  const dy = Math.abs(endPct.y - startPct.y);
  const along = edge === "top" || edge === "bottom" ? dx : dy;
  return Math.max(0, Math.min(100, Math.round(along * 10) / 10));
}

/** Crease span % = dominant axis run of the drawn line, as % of the card's
 *  span on that axis. Spec §4 — "by how far it runs proportionally,
 *  matches TAG's 'half across', 'three-quarters across' language". */
function creaseSpanFromSegment(startPct: { x: number; y: number }, endPct: { x: number; y: number }): number {
  const dx = Math.abs(endPct.x - startPct.x);
  const dy = Math.abs(endPct.y - startPct.y);
  return Math.max(0, Math.min(100, Math.round(Math.max(dx, dy) * 10) / 10));
}

export default function MeasurementTool({
  certIdStr,
  frontImageUrl,
  backImageUrl,
  whiteningLines,
  creaseSpanPct,
  creaseSegment,
  onWhiteningLinesChange,
  onCreaseSpanPctChange,
  onCreaseSegmentChange,
  onClose,
}: Props) {
  const [side, setSide] = useState<Side>("front");
  const [tool, setTool] = useState<Tool>("whitening");
  const [edge, setEdge] = useState<EdgeKey | null>(null);
  // Drawing-in-progress state. startPct captured on mousedown; endPct
  // tracks the cursor for the live preview line; commit on mouseup.
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
  const [drawEnd, setDrawEnd] = useState<{ x: number; y: number } | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const currentImageUrl = side === "front" ? frontImageUrl : backImageUrl;
  const sideEdgeLines = whiteningLines.filter((l) => l.side === side);
  const canDraw = tool === "crease" || (tool === "whitening" && edge !== null);

  // Esc → close, or cancel in-progress draw if active.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (drawStart) {
          setDrawStart(null);
          setDrawEnd(null);
          return;
        }
        onClose();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawStart, onClose]);

  function pctFromEvent(e: React.MouseEvent | React.TouchEvent): { x: number; y: number } | null {
    const el = imgRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cx = "touches" in e ? (e.touches[0]?.clientX ?? 0) : e.clientX;
    const cy = "touches" in e ? (e.touches[0]?.clientY ?? 0) : e.clientY;
    return {
      x: Math.max(0, Math.min(100, ((cx - r.left) / r.width) * 100)),
      y: Math.max(0, Math.min(100, ((cy - r.top) / r.height) * 100)),
    };
  }

  function onImgMouseDown(e: React.MouseEvent) {
    if (!canDraw) return;
    const pt = pctFromEvent(e);
    if (!pt) return;
    setDrawStart(pt);
    setDrawEnd(pt);
  }
  function onImgMouseMove(e: React.MouseEvent) {
    if (!drawStart) return;
    const pt = pctFromEvent(e);
    if (pt) setDrawEnd(pt);
  }
  function onImgMouseUp() {
    if (!drawStart || !drawEnd) {
      setDrawStart(null);
      setDrawEnd(null);
      return;
    }
    if (tool === "whitening" && edge) {
      const coveragePct = coverageFromSegment(drawStart, drawEnd, edge);
      // Replace any existing line for this (side, edge) — single coverage value
      // per edge keeps the engine's ladder count simple. Store the operator's
      // actual drawn segment (start/end) alongside so it redraws exactly where
      // marked; the engine still reads only coveragePct.
      const remaining = whiteningLines.filter((l) => !(l.side === side && l.edge === edge));
      onWhiteningLinesChange([...remaining, { side, edge, coveragePct, start: drawStart, end: drawEnd }]);
    } else if (tool === "crease") {
      onCreaseSpanPctChange(creaseSpanFromSegment(drawStart, drawEnd));
      onCreaseSegmentChange({ side, start: drawStart, end: drawEnd });
    }
    setDrawStart(null);
    setDrawEnd(null);
  }

  function removeWhiteningLine(s: Side, e: EdgeKey) {
    onWhiteningLinesChange(whiteningLines.filter((l) => !(l.side === s && l.edge === e)));
  }
  function clearCrease() {
    onCreaseSpanPctChange(null);
    onCreaseSegmentChange(null);
  }

  return (
    <div className="fixed inset-0 z-[100] bg-[var(--admin-bg,#0f0e0c)] flex flex-col select-none text-[var(--admin-ink,#d8d4cc)]">
      {/* Top bar */}
      <div className="flex-shrink-0 px-3 py-2 sm:px-4 sm:py-3 flex items-center justify-between border-b border-[var(--admin-line,#2a2620)]">
        <div>
          <p className="text-[var(--admin-gold,#D4AF37)] text-xs font-bold uppercase tracking-widest flex items-center gap-2">
            <Pencil size={14} /> Measurement Tool — {certIdStr}
          </p>
          <p className="text-[var(--admin-ink-dim,#888)] text-[10px]">
            MVGS v2 · whitening line per edge (edge-pick FIRST) · crease span line across card
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg overflow-hidden border border-[var(--admin-line,#2a2620)] text-[10px] font-bold uppercase">
            <button
              type="button"
              onClick={() => setSide("front")}
              className={`px-2 py-1 ${side === "front" ? "bg-[var(--admin-gold,#D4AF37)] text-[#1A1400]" : "text-[var(--admin-ink-dim,#888)] hover:bg-[var(--admin-panel2,#1c1815)]"}`}
            >
              Front
            </button>
            <button
              type="button"
              onClick={() => setSide("back")}
              className={`px-2 py-1 ${side === "back" ? "bg-[var(--admin-gold,#D4AF37)] text-[#1A1400]" : "text-[var(--admin-ink-dim,#888)] hover:bg-[var(--admin-panel2,#1c1815)]"}`}
            >
              Back
            </button>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--admin-ink-dim,#888)] hover:text-[var(--admin-ink,#d8d4cc)] p-1"
            title="Close (Esc)"
          >
            <X size={20} />
          </button>
        </div>
      </div>

      {/* Tool palette + edge picker */}
      <div className="flex-shrink-0 px-3 py-2 sm:px-4 sm:py-3 border-b border-[var(--admin-line,#2a2620)] bg-[var(--admin-panel,#15120f)] flex items-center gap-3 flex-wrap">
        <div className="flex rounded-lg overflow-hidden border border-[var(--admin-line,#2a2620)] text-[11px] font-bold uppercase">
          <button
            type="button"
            onClick={() => {
              setTool("whitening");
              setDrawStart(null);
              setDrawEnd(null);
            }}
            className={`px-3 py-1.5 ${tool === "whitening" ? "bg-[var(--admin-gold,#D4AF37)] text-[#1A1400]" : "text-[var(--admin-ink-dim,#888)] hover:bg-[var(--admin-panel2,#1c1815)]"}`}
          >
            Whitening Line
          </button>
          <button
            type="button"
            onClick={() => {
              setTool("crease");
              setEdge(null);
              setDrawStart(null);
              setDrawEnd(null);
            }}
            className={`px-3 py-1.5 ${tool === "crease" ? "bg-[var(--admin-gold,#D4AF37)] text-[#1A1400]" : "text-[var(--admin-ink-dim,#888)] hover:bg-[var(--admin-panel2,#1c1815)]"}`}
          >
            Crease Line
          </button>
        </div>

        {tool === "whitening" && (
          <>
            <span className="text-[var(--admin-ink-dim,#888)] text-[10px] uppercase tracking-widest">
              Edge ({side}) — pick before drawing
            </span>
            <div className="flex gap-1">
              {(Object.keys(EDGE_LABELS) as EdgeKey[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setEdge(k)}
                  className={`text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded border transition-colors ${
                    edge === k
                      ? "bg-[var(--admin-gold,#D4AF37)] text-[#1A1400] border-[var(--admin-gold,#D4AF37)]"
                      : "bg-[var(--admin-panel,#15120f)] text-[var(--admin-ink-dim,#888)] border-[var(--admin-line,#2a2620)] hover:border-[var(--admin-gold,#D4AF37)]"
                  }`}
                >
                  {EDGE_LABELS[k]}
                </button>
              ))}
            </div>
          </>
        )}

        {tool === "crease" && (
          <span className="text-[var(--admin-ink-dim,#888)] text-[10px] uppercase tracking-widest">
            Crease line — draw across the card (span % = dominant axis run)
          </span>
        )}

        <div className="flex-1" />

        <p className="text-[var(--admin-ink-dim,#888)] text-[10px]">
          {canDraw ? "Click-drag on the image" : "Pick an edge to start"}
        </p>
      </div>

      {/* Image area */}
      <div className="flex-1 min-h-0 p-2 sm:p-4 overflow-auto">
        <div className="w-full h-full flex items-center justify-center">
          <div
            className="relative max-h-full"
            style={{ aspectRatio: "5 / 7" }}
            onMouseDown={onImgMouseDown}
            onMouseMove={onImgMouseMove}
            onMouseUp={onImgMouseUp}
            onMouseLeave={onImgMouseUp}
          >
            {currentImageUrl ? (
              <img
                ref={imgRef}
                src={currentImageUrl}
                alt={`${side} card`}
                className={`block max-h-[70vh] w-auto rounded-md ${canDraw ? "cursor-crosshair" : "cursor-not-allowed"}`}
                draggable={false}
              />
            ) : (
              <div className="flex items-center justify-center w-[200px] h-[280px] bg-[var(--admin-panel2,#1c1815)] text-[var(--admin-ink-dim,#888)] text-xs">
                No {side} image
              </div>
            )}
            {/* SVG overlay — committed whitening lines + crease + in-progress
                segment. Lines are drawn in the same image-% space the cursor is
                captured in, so committed lines land exactly where drawn. */}
            <svg
              className="absolute inset-0 w-full h-full pointer-events-none"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
            >
              {sideEdgeLines.map((l) => {
                // Preferred: redraw the operator's ACTUAL drawn segment. A dark
                // halo underneath + a bright line on top so it shows over light
                // edges. The % label is crisp HTML below (SVG <text> would be
                // non-uniformly squashed by preserveAspectRatio="none").
                if (l.start && l.end) {
                  return (
                    <g key={`${l.side}-${l.edge}`}>
                      <line
                        x1={l.start.x}
                        y1={l.start.y}
                        x2={l.end.x}
                        y2={l.end.y}
                        stroke="#000000"
                        strokeOpacity={0.55}
                        strokeWidth={4.5}
                        strokeLinecap="round"
                        vectorEffect="non-scaling-stroke"
                      />
                      <line
                        x1={l.start.x}
                        y1={l.start.y}
                        x2={l.end.x}
                        y2={l.end.y}
                        stroke="#FF3B6B"
                        strokeWidth={2}
                        strokeLinecap="round"
                        vectorEffect="non-scaling-stroke"
                      />
                    </g>
                  );
                }
                // Legacy fallback (rows saved before start/end existed): the
                // corner-anchored indicator along the edge axis, length =
                // coverage %.
                const len = l.coveragePct;
                if (l.edge === "top") {
                  return (
                    <line
                      key={`${l.side}-${l.edge}`}
                      x1={0}
                      y1={2}
                      x2={len}
                      y2={2}
                      stroke="#FF3B6B"
                      strokeWidth={1}
                      vectorEffect="non-scaling-stroke"
                    />
                  );
                }
                if (l.edge === "bottom") {
                  return (
                    <line
                      key={`${l.side}-${l.edge}`}
                      x1={0}
                      y1={98}
                      x2={len}
                      y2={98}
                      stroke="#FF3B6B"
                      strokeWidth={1}
                      vectorEffect="non-scaling-stroke"
                    />
                  );
                }
                if (l.edge === "left") {
                  return (
                    <line
                      key={`${l.side}-${l.edge}`}
                      x1={2}
                      y1={0}
                      x2={2}
                      y2={len}
                      stroke="#FF3B6B"
                      strokeWidth={1}
                      vectorEffect="non-scaling-stroke"
                    />
                  );
                }
                return (
                  <line
                    key={`${l.side}-${l.edge}`}
                    x1={98}
                    y1={0}
                    x2={98}
                    y2={len}
                    stroke="#FF3B6B"
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })}
              {/* Committed crease segment (session-only; redraws within the
                  grading session on the side it was drawn). */}
              {creaseSegment && creaseSegment.side === side && (
                <g>
                  <line
                    x1={creaseSegment.start.x}
                    y1={creaseSegment.start.y}
                    x2={creaseSegment.end.x}
                    y2={creaseSegment.end.y}
                    stroke="#000000"
                    strokeOpacity={0.55}
                    strokeWidth={4.5}
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                  />
                  <line
                    x1={creaseSegment.start.x}
                    y1={creaseSegment.start.y}
                    x2={creaseSegment.end.x}
                    y2={creaseSegment.end.y}
                    stroke="#00CCFF"
                    strokeWidth={2}
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              )}
              {drawStart && drawEnd && (
                <line
                  x1={drawStart.x}
                  y1={drawStart.y}
                  x2={drawEnd.x}
                  y2={drawEnd.y}
                  stroke={tool === "whitening" ? "#FFD400" : "#00CCFF"}
                  strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </svg>
            {/* HTML label layer — % labels at segment midpoints. Rendered as
                absolutely-positioned HTML (not SVG <text>) so the glyphs stay
                crisp and undistorted: the SVG uses preserveAspectRatio="none"
                on a 5:7 card, which would non-uniformly squash SVG text. */}
            <div className="absolute inset-0 pointer-events-none">
              {sideEdgeLines.map((l) =>
                l.start && l.end ? (
                  <span
                    key={`lbl-${l.side}-${l.edge}`}
                    className="absolute -translate-x-1/2 -translate-y-1/2 rounded bg-black/70 px-1 py-0.5 text-[10px] font-bold font-mono leading-none"
                    style={{
                      left: `${(l.start.x + l.end.x) / 2}%`,
                      top: `${(l.start.y + l.end.y) / 2}%`,
                      color: "#FF3B6B",
                    }}
                  >
                    {l.coveragePct}%
                  </span>
                ) : null
              )}
              {creaseSegment && creaseSegment.side === side && creaseSpanPct != null && (
                <span
                  className="absolute -translate-x-1/2 -translate-y-1/2 rounded bg-black/70 px-1 py-0.5 text-[10px] font-bold font-mono leading-none"
                  style={{
                    left: `${(creaseSegment.start.x + creaseSegment.end.x) / 2}%`,
                    top: `${(creaseSegment.start.y + creaseSegment.end.y) / 2}%`,
                    color: "#00CCFF",
                  }}
                >
                  {creaseSpanPct}%
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Bottom panel — measurement summary */}
      <div className="flex-shrink-0 px-3 py-2 sm:px-4 sm:py-3 border-t border-[var(--admin-line,#2a2620)] bg-[var(--admin-panel,#15120f)]">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <p className="text-[var(--admin-ink-dim,#888)] text-[10px] uppercase tracking-widest mb-1">
              Whitening lines ({whiteningLines.length})
            </p>
            {whiteningLines.length === 0 ? (
              <p className="text-[var(--admin-ink-faint,#666)] text-[10px]">— none drawn —</p>
            ) : (
              <ul className="space-y-0.5">
                {whiteningLines.map((l) => (
                  <li key={`${l.side}-${l.edge}`} className="flex items-center justify-between text-[11px] font-mono">
                    <span>
                      {l.side} · {l.edge}: <strong>{l.coveragePct}%</strong>
                    </span>
                    <button
                      type="button"
                      onClick={() => removeWhiteningLine(l.side, l.edge)}
                      className="text-[var(--admin-ink-dim,#888)] hover:text-red-500"
                      title="Remove"
                    >
                      <Trash2 size={11} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <p className="text-[var(--admin-ink-dim,#888)] text-[10px] uppercase tracking-widest mb-1">Crease span</p>
            {creaseSpanPct == null ? (
              <p className="text-[var(--admin-ink-faint,#666)] text-[10px]">— none drawn —</p>
            ) : (
              <div className="flex items-center justify-between text-[11px] font-mono">
                <span>
                  <Minus size={11} className="inline" /> <strong>{creaseSpanPct}%</strong> of card span
                </span>
                <button
                  type="button"
                  onClick={clearCrease}
                  className="text-[var(--admin-ink-dim,#888)] hover:text-red-500"
                  title="Clear crease"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="flex justify-end mt-2">
          <button
            type="button"
            onClick={onClose}
            className="flex items-center gap-1.5 bg-gradient-to-r from-[var(--admin-gold,#D4AF37)] to-[#B8960C] text-[#1A1400] text-xs font-bold uppercase px-4 py-1.5 rounded-lg hover:opacity-90"
          >
            <Check size={13} /> Done
          </button>
        </div>
      </div>
    </div>
  );
}
