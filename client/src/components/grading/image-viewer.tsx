import { useState, useRef, useCallback } from "react";
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

interface Props {
  urls: ImageUrls;
  defects: Defect[];
  onDefectAdded: (defect: Defect) => void;
  highlightId: number | null;
  referenceImageUrl?: string | null;
}

const SIDES: Side[] = ["front", "back", "angled", "closeup"];
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

export default function ImageViewer({ urls, defects, onDefectAdded, highlightId, referenceImageUrl }: Props) {
  const [side, setSide] = useState<Side>("front");
  const [variant, setVariant] = useState<Variant>("original");
  const [showReference, setShowReference] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [showDefects, setShowDefects] = useState(true);
  const [markMode, setMarkMode] = useState(false);
  const [pendingXY, setPendingXY] = useState<{ x: number; y: number } | null>(null);
  const [pendingDefect, setPendingDefect] = useState({
    type: "Scratch", severity: "minor" as "minor" | "moderate" | "significant",
    description: "", location: "", image_side: "front",
    x_percent: 50, y_percent: 50,
  });
  const imgRef = useRef<HTMLDivElement>(null);

  const currentUrl = getUrl(urls, side, variant);

  function handleImageClick(e: React.MouseEvent<HTMLDivElement>) {
    if (dragging) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const xPct = ((e.clientX - rect.left) / rect.width) * 100;
    const yPct = ((e.clientY - rect.top) / rect.height) * 100;

    if (markMode) {
      setPendingXY({ x: xPct, y: yPct });
      const locDesc = locationFromPercent(xPct, yPct, side);
      setPendingDefect(p => ({ ...p, image_side: side, x_percent: xPct, y_percent: yPct, location: locDesc }));
      return;
    }

    // Cycle zoom
    if (zoom === 1) { setZoom(2); setPan({ x: xPct, y: yPct }); }
    else if (zoom === 2) setZoom(4);
    else { setZoom(1); setPan({ x: 50, y: 50 }); }
  }

  function handleWheel(e: React.WheelEvent) {
    e.preventDefault();
    setZoom(z => Math.max(1, Math.min(8, z - e.deltaY * 0.005)));
  }

  function handleMouseDown(e: React.MouseEvent) {
    if (zoom <= 1) return;
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

  return (
    <div className="space-y-2">
      {/* Side thumbnails */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {SIDES.map(s => (
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
            {s}
          </button>
        ))}
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
            <div className="rounded-lg overflow-hidden" style={{ aspectRatio: "5/7" }}>
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
            <div className="rounded-lg border border-[#D4AF37]/20 overflow-hidden" style={{ aspectRatio: "5/7" }}>
              <img src={referenceImageUrl} alt="reference" className="w-full h-full object-contain" />
            </div>
          </div>
        </div>
      )}

      {/* Main image area */}
      {!showReference && <div
        ref={imgRef}
        className={`relative overflow-hidden rounded-lg select-none ${
          markMode ? "cursor-crosshair" : zoom > 1 ? (dragging ? "cursor-grabbing" : "cursor-grab") : "cursor-zoom-in"
        }`}
        style={{ aspectRatio: "5/7", maxHeight: 500 }}
        onClick={handleImageClick}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {currentUrl ? (
          <img
            src={currentUrl}
            alt={`${side} ${variant}`}
            className="w-full h-full object-contain transition-opacity duration-200"
            style={{
              transform: zoom > 1 ? `scale(${zoom}) translate(${(50 - pan.x) / zoom}%, ${(50 - pan.y) / zoom}%)` : "none",
              transition: dragging ? "none" : "transform 0.15s",
            }}
            draggable={false}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-[#333333] text-xs">No image</p>
          </div>
        )}

        {/* Heatmap overlay */}
        {showDefects && defects.filter(d => d.image_side === side).length > 0 && (
          <DefectHeatmap
            defects={defects.filter(d => d.image_side === side)}
            width={imgRef.current?.clientWidth || 300}
            height={imgRef.current?.clientHeight || 420}
          />
        )}

        {/* Defect markers */}
        {showDefects && defects
          .filter(d => d.image_side === side)
          .map(d => (
            <div
              key={d.id}
              className={`absolute w-6 h-6 rounded-full bg-red-600 border-2 border-white flex items-center justify-center text-white text-[9px] font-black pointer-events-none transition-all ${
                highlightId === d.id ? "scale-150 ring-2 ring-[#D4AF37]" : ""
              }`}
              style={{
                left: `calc(${d.x_percent}% - 12px)`,
                top:  `calc(${d.y_percent}% - 12px)`,
              }}
            >
              {d.id}
            </div>
          ))
        }

        {/* Pending defect marker */}
        {pendingXY && (
          <div
            className="absolute w-6 h-6 rounded-full bg-yellow-500 border-2 border-white flex items-center justify-center text-black text-[9px] font-black pointer-events-none animate-pulse"
            style={{ left: `calc(${pendingXY.x}% - 12px)`, top: `calc(${pendingXY.y}% - 12px)` }}
          >
            ?
          </div>
        )}

        {/* Zoom indicator */}
        {zoom > 1 && (
          <div className="absolute top-2 right-2 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded">
            {Math.round(zoom * 100)}%
          </div>
        )}
      </div>}

      {/* Controls row */}
      <div className="flex items-center gap-2">
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
