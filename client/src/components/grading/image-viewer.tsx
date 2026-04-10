import { useState, useRef } from "react";
import { Pencil, Eye, EyeOff } from "lucide-react";
import DefectHeatmap from "./defect-heatmap";
import { DefectForm } from "./defect-annotation";
import type { Defect } from "./defect-annotation";

type Side = "front" | "back" | "angled" | "closeup";
type Variant = "original" | "greyscale" | "highcontrast" | "edgeenhanced" | "inverted";

interface ImageUrls {
  front_original?: string | null;
  front_cropped?: string | null;
  front_greyscale?: string | null;
  front_highcontrast?: string | null;
  front_edgeenhanced?: string | null;
  front_inverted?: string | null;
  back_original?: string | null;
  back_cropped?: string | null;
  back_greyscale?: string | null;
  back_highcontrast?: string | null;
  back_edgeenhanced?: string | null;
  back_inverted?: string | null;
  angled_original?: string | null;
  angled_cropped?: string | null;
  closeup_original?: string | null;
  closeup_cropped?: string | null;
}

export interface CenteringOverlayData {
  ratioLR: string;
  ratioTB: string;
  innerFrame?: { left_pct: number; right_pct: number; top_pct: number; bottom_pct: number } | null;
}

interface Props {
  urls: ImageUrls;
  defects: Defect[];
  onDefectAdded: (defect: Defect) => void;
  highlightId: number | null;
  referenceImageUrl?: string | null;
  centeringFront?: CenteringOverlayData | null;
  centeringBack?: CenteringOverlayData | null;
}

const SIDES: Side[] = ["front", "back"];
const VARIANTS: { key: Variant; label: string }[] = [
  { key: "original",     label: "Original" },
  { key: "greyscale",    label: "Greyscale" },
  { key: "highcontrast", label: "Hi-Contrast" },
  { key: "edgeenhanced", label: "Edge" },
  { key: "inverted",     label: "Inverted" },
];

function getUrl(urls: ImageUrls, side: Side, variant: Variant): string | null {
  if (variant === "original") return urls[`${side}_cropped`] || urls[`${side}_original`] || null;
  const key = `${side}_${variant}` as keyof ImageUrls;
  return urls[key] as string | null || urls[`${side}_cropped`] || urls[`${side}_original`] || null;
}

function hasAny(urls: ImageUrls, side: Side): boolean {
  return !!(urls[`${side}_original`] || urls[`${side}_cropped`]);
}

// ── CSS for marker pulse animation (injected once) ────────────────────────
const PULSE_CSS = `
@keyframes defect-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(212,175,55,0.4); }
  50% { box-shadow: 0 0 0 6px rgba(212,175,55,0); }
}
.defect-ring-pulse { animation: defect-pulse 2s ease-in-out infinite; }
`;

export default function ImageViewer({ urls, defects, onDefectAdded, highlightId, referenceImageUrl, centeringFront, centeringBack }: Props) {
  const [side, setSide] = useState<Side>("front");
  const [variant, setVariant] = useState<Variant>("original");
  const [showReference, setShowReference] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [showDefects, setShowDefects] = useState(true);
  const [showCentering, setShowCentering] = useState(false);
  const [markMode, setMarkMode] = useState(false);
  const [pendingXY, setPendingXY] = useState<{ x: number; y: number } | null>(null);
  const [pendingDefect, setPendingDefect] = useState({
    type: "Scratch", severity: "minor" as "minor" | "moderate" | "significant",
    description: "", location: "", image_side: "front",
    x_percent: 50, y_percent: 50,
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const imgElRef = useRef<HTMLImageElement>(null);

  const currentUrl = getUrl(urls, side, variant);
  const sideDefects = defects.filter(d => d.image_side === side);
  const frontDefectCount = defects.filter(d => d.image_side === "front").length;
  const backDefectCount = defects.filter(d => d.image_side === "back").length;

  function handleContainerClick(e: React.MouseEvent<HTMLDivElement>) {
    if (dragging) return;

    if (markMode && imgElRef.current) {
      // Calculate click position relative to the IMAGE element (not container)
      const imgRect = imgElRef.current.getBoundingClientRect();
      const xPct = ((e.clientX - imgRect.left) / imgRect.width) * 100;
      const yPct = ((e.clientY - imgRect.top) / imgRect.height) * 100;
      // Clamp to 0-100
      const cx = Math.max(0, Math.min(100, xPct));
      const cy = Math.max(0, Math.min(100, yPct));
      setPendingXY({ x: cx, y: cy });
      const locDesc = locationFromPercent(cx, cy, side);
      setPendingDefect(p => ({ ...p, image_side: side, x_percent: cx, y_percent: cy, location: locDesc }));
      return;
    }

    // Cycle zoom
    if (zoom === 1) {
      const rect = e.currentTarget.getBoundingClientRect();
      const xPct = ((e.clientX - rect.left) / rect.width) * 100;
      const yPct = ((e.clientY - rect.top) / rect.height) * 100;
      setZoom(2);
      setPan({ x: xPct, y: yPct });
    } else if (zoom === 2) {
      setZoom(4);
    } else {
      setZoom(1);
      setPan({ x: 50, y: 50 });
    }
  }

  function handleWheel(e: React.WheelEvent) {
    e.preventDefault();
    setZoom(z => Math.max(1, Math.min(8, z - e.deltaY * 0.005)));
  }

  function handleMouseDown(e: React.MouseEvent) {
    if (zoom <= 1 || markMode) return;
    setDragging(true);
    setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
  }

  function handleMouseMove(e: React.MouseEvent) {
    if (!dragging) return;
    setPan({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
  }

  function handleMouseUp() { setDragging(false); }

  function saveNewDefect() {
    const nextId = defects.length > 0 ? Math.max(...defects.map(d => d.id)) + 1 : 1;
    onDefectAdded({ ...pendingDefect, id: nextId });
    setPendingXY(null);
    setPendingDefect({ type: "Scratch", severity: "minor", description: "", location: "", image_side: side, x_percent: 50, y_percent: 50 });
  }

  const transformStyle = zoom > 1
    ? `scale(${zoom}) translate(${(50 - pan.x) / zoom}%, ${(50 - pan.y) / zoom}%)`
    : "none";
  const transitionStyle = dragging ? "none" : "transform 0.15s";

  return (
    <div className="space-y-2">
      <style>{PULSE_CSS}</style>

      {/* Side tabs with defect counts */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {SIDES.map(s => {
          const count = s === "front" ? frontDefectCount : s === "back" ? backDefectCount : 0;
          return (
            <button
              key={s}
              type="button"
              onClick={() => { setSide(s); setShowReference(false); }}
              disabled={!hasAny(urls, s)}
              className={`flex-shrink-0 rounded px-3 py-1 text-[10px] font-bold uppercase tracking-wider border transition-all ${
                side === s && !showReference
                  ? "border-[#D4AF37] text-[#D4AF37] bg-[#D4AF37]/10"
                  : hasAny(urls, s)
                    ? "border-[#333333] text-[#888888] hover:border-[#555555]"
                    : "border-[#222222] text-[#333333] cursor-not-allowed"
              }`}
            >
              {s}{count > 0 ? ` (${count})` : ""}
            </button>
          );
        })}
        {referenceImageUrl && (
          <button
            type="button"
            onClick={() => setShowReference(v => !v)}
            className={`flex-shrink-0 rounded px-3 py-1 text-[10px] font-bold uppercase tracking-wider border transition-all ${
              showReference
                ? "border-[#D4AF37] text-[#D4AF37] bg-[#D4AF37]/10"
                : "border-[#333333] text-[#888888] hover:border-[#555555]"
            }`}
          >
            Reference
          </button>
        )}
      </div>

      {/* Variant tabs */}
      <div className="flex gap-1 overflow-x-auto">
        {VARIANTS.map(v => (
          <button
            key={v.key}
            type="button"
            onClick={() => setVariant(v.key)}
            className={`flex-shrink-0 px-2.5 py-1 text-[10px] uppercase tracking-widest rounded transition-all border-b-2 ${
              variant === v.key
                ? "text-[#D4AF37] border-[#D4AF37]"
                : "text-[#555555] border-transparent hover:text-[#888888]"
            }`}
          >
            {v.label}
          </button>
        ))}
      </div>

      {/* Reference comparison view */}
      {showReference && referenceImageUrl && (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <p className="text-[#555555] text-[9px] uppercase tracking-widest text-center">Your Scan (Front)</p>
            <div className="rounded-lg bg-[#0A0A0A] border border-[#222222] overflow-hidden" style={{ aspectRatio: "5/7" }}>
              {urls.front_cropped || urls.front_original ? (
                <img src={urls.front_cropped || urls.front_original || ""} alt="scan front" className="w-full h-full object-contain" />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <p className="text-[#333333] text-xs">No scan</p>
                </div>
              )}
            </div>
          </div>
          <div className="space-y-1">
            <p className="text-[#555555] text-[9px] uppercase tracking-widest text-center">Reference Image</p>
            <div className="rounded-lg bg-[#0A0A0A] border border-[#D4AF37]/20 overflow-hidden" style={{ aspectRatio: "5/7" }}>
              <img src={referenceImageUrl} alt="reference" className="w-full h-full object-contain" />
            </div>
          </div>
        </div>
      )}

      {/* Main image area — outer container handles click/scroll/drag events */}
      {!showReference && (
        <div
          ref={containerRef}
          className={`relative overflow-hidden rounded-lg bg-[#0A0A0A] border border-[#222222] select-none ${
            markMode ? "cursor-crosshair" : zoom > 1 ? (dragging ? "cursor-grabbing" : "cursor-grab") : "cursor-zoom-in"
          }`}
          style={{ aspectRatio: "5/7", maxHeight: 500 }}
          onClick={handleContainerClick}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          {currentUrl ? (
            /* Single transformed wrapper — image + all overlays move together on zoom/pan */
            <div
              className="relative w-full h-full"
              style={{ transform: transformStyle, transition: transitionStyle }}
            >
              <img
                ref={imgElRef}
                src={currentUrl}
                alt={`${side} ${variant}`}
                className="w-full h-full object-contain"
                draggable={false}
              />

              {/* Centering overlay (inside transform wrapper — zooms with image) */}
              {showCentering && (() => {
                const cd = side === "front" ? centeringFront : centeringBack;
                if (!cd) return null;
                const frame = cd.innerFrame;
                const lr = cd.ratioLR?.split("/").map(Number) || [50, 50];
                const tb = cd.ratioTB?.split("/").map(Number) || [50, 50];
                return (
                  <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
                    <rect x="0.5" y="0.5" width="99" height="99" fill="none" stroke="#D4AF37" strokeWidth="0.4" strokeDasharray="1.5,1" opacity="0.6" />
                    {frame && (
                      <rect
                        x={frame.left_pct} y={frame.top_pct}
                        width={frame.right_pct - frame.left_pct}
                        height={frame.bottom_pct - frame.top_pct}
                        fill="none" stroke="#D4AF37" strokeWidth="0.5" opacity="0.8"
                      />
                    )}
                    {frame && <>
                      <line x1="0" y1="50" x2={frame.left_pct} y2="50" stroke="#D4AF37" strokeWidth="0.3" opacity="0.5" />
                      <text x={frame.left_pct / 2} y="48" textAnchor="middle" fill="#D4AF37" fontSize="3.5" fontWeight="bold" opacity="0.9">{lr[0]}%</text>
                      <line x1={frame.right_pct} y1="50" x2="100" y2="50" stroke="#D4AF37" strokeWidth="0.3" opacity="0.5" />
                      <text x={(frame.right_pct + 100) / 2} y="48" textAnchor="middle" fill="#D4AF37" fontSize="3.5" fontWeight="bold" opacity="0.9">{lr[1]}%</text>
                      <line x1="50" y1="0" x2="50" y2={frame.top_pct} stroke="#D4AF37" strokeWidth="0.3" opacity="0.5" />
                      <text x="50" y={frame.top_pct / 2 + 1.5} textAnchor="middle" fill="#D4AF37" fontSize="3.5" fontWeight="bold" opacity="0.9">{tb[0]}%</text>
                      <line x1="50" y1={frame.bottom_pct} x2="50" y2="100" stroke="#D4AF37" strokeWidth="0.3" opacity="0.5" />
                      <text x="50" y={(frame.bottom_pct + 100) / 2 + 1.5} textAnchor="middle" fill="#D4AF37" fontSize="3.5" fontWeight="bold" opacity="0.9">{tb[1]}%</text>
                    </>}
                  </svg>
                );
              })()}

              {/* Heatmap overlay */}
              {showDefects && sideDefects.length > 0 && (
                <DefectHeatmap
                  defects={sideDefects}
                  width={containerRef.current?.clientWidth || 300}
                  height={containerRef.current?.clientHeight || 420}
                />
              )}

              {/* Defect ring markers — anchored to image coordinates */}
              {showDefects && sideDefects.map(d => {
                const isAi = !!(d as any).detected_in;
                const isHighlighted = highlightId === d.id;
                const ringColor = isAi ? "#DC2626" : "#D4AF37";
                return (
                  <div
                    key={d.id}
                    className={`absolute pointer-events-none ${isHighlighted ? "defect-ring-pulse" : ""}`}
                    style={{
                      left: `${d.x_percent}%`,
                      top: `${d.y_percent}%`,
                      transform: "translate(-50%, -50%)",
                      width: 32,
                      height: 32,
                    }}
                  >
                    {/* Transparent ring */}
                    <div
                      className="w-full h-full rounded-full transition-all"
                      style={{
                        border: `${isHighlighted ? 3 : 2}px solid ${ringColor}`,
                        background: "transparent",
                        boxShadow: isHighlighted ? `0 0 8px ${ringColor}80` : "none",
                      }}
                    />
                    {/* Label badge — top-right of ring */}
                    <span
                      className="absolute -top-1 -right-1 text-[8px] font-black px-1 rounded-full leading-none py-0.5"
                      style={{
                        background: ringColor,
                        color: isAi ? "#fff" : "#1A1400",
                      }}
                    >
                      {isAi ? "AI" : d.id}
                    </span>
                  </div>
                );
              })}

              {/* Pending defect marker */}
              {pendingXY && (
                <div
                  className="absolute pointer-events-none animate-pulse"
                  style={{
                    left: `${pendingXY.x}%`,
                    top: `${pendingXY.y}%`,
                    transform: "translate(-50%, -50%)",
                    width: 32,
                    height: 32,
                  }}
                >
                  <div className="w-full h-full rounded-full border-2 border-yellow-400" style={{ background: "transparent" }} />
                  <span className="absolute -top-1 -right-1 text-[8px] font-black bg-yellow-400 text-black px-1 rounded-full leading-none py-0.5">?</span>
                </div>
              )}
            </div>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center">
              <p className="text-[#333333] text-xs">No image</p>
            </div>
          )}

          {/* Zoom indicator (outside transform — stays in corner) */}
          {zoom > 1 && (
            <div className="absolute top-2 right-2 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded z-10">
              {Math.round(zoom * 100)}%
            </div>
          )}
        </div>
      )}

      {/* Controls row */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => { setMarkMode(!markMode); setPendingXY(null); }}
          className={`flex items-center gap-1.5 text-[10px] font-bold uppercase px-3 py-1.5 rounded border transition-all ${
            markMode
              ? "border-[#D4AF37] text-[#D4AF37] bg-[#D4AF37]/10"
              : "border-[#333333] text-[#888888] hover:border-[#555555]"
          }`}
        >
          <Pencil size={11} />
          {markMode ? "Marking…" : "Mark Defects"}
        </button>
        <button
          type="button"
          onClick={() => setShowDefects(!showDefects)}
          className="flex items-center gap-1.5 text-[10px] text-[#888888] hover:text-[#CCCCCC] border border-[#333333] px-3 py-1.5 rounded transition-all"
        >
          {showDefects ? <EyeOff size={11} /> : <Eye size={11} />}
          {showDefects ? "Hide Defects" : "Show Defects"}
        </button>
        {(centeringFront || centeringBack) && (
          <button
            type="button"
            onClick={() => setShowCentering(!showCentering)}
            className={`flex items-center gap-1.5 text-[10px] font-bold uppercase px-3 py-1.5 rounded border transition-all ${
              showCentering
                ? "border-[#D4AF37] text-[#D4AF37] bg-[#D4AF37]/10"
                : "border-[#333333] text-[#888888] hover:border-[#555555]"
            }`}
          >
            {showCentering ? "Hide Centering" : "Show Centering"}
          </button>
        )}
        {zoom > 1 && (
          <button type="button" onClick={() => { setZoom(1); setPan({ x: 50, y: 50 }); }} className="text-[10px] text-[#555555] hover:text-[#888888]">
            Reset zoom
          </button>
        )}
      </div>

      {/* Pending defect form */}
      {pendingXY && (
        <DefectForm
          pending={pendingDefect}
          onChange={setPendingDefect}
          onSave={saveNewDefect}
          onCancel={() => { setPendingXY(null); }}
        />
      )}
    </div>
  );
}

function locationFromPercent(x: number, y: number, side: string): string {
  const hLabel = x < 33 ? "left" : x > 66 ? "right" : "centre";
  const vLabel = y < 33 ? "top" : y > 66 ? "bottom" : "middle";
  return `${side.charAt(0).toUpperCase() + side.slice(1)}, ${vLabel}-${hLabel}`;
}
