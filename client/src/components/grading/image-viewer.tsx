import { useState, useRef, useEffect, lazy, Suspense } from "react";
import { createPortal } from "react-dom";
import { Pencil, Eye, EyeOff, X, Maximize2, ZoomIn, ZoomOut, RotateCcw, Trash2, Upload, Loader2, Crop } from "lucide-react";

const ManualCrop = lazy(() => import("./manual-crop"));
import { DEFECT_TYPES } from "./defect-annotation";
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

interface FrameRect { left_pct: number; right_pct: number; top_pct: number; bottom_pct: number; }

export interface CenteringOverlayData {
  ratioLR: string;
  ratioTB: string;
  outerFrame?: FrameRect | null;
  innerFrame?: FrameRect | null;
}

interface Props {
  urls: ImageUrls;
  defects: Defect[];
  onDefectAdded: (defect: Defect) => void;
  /** Required for the click-marker-to-edit popover. Receives the full new
   *  defects array (after edit or delete). Optional for backward compat —
   *  marker clicks become no-ops if absent. */
  onDefectsChange?: (defects: Defect[]) => void;
  highlightId: number | null;
  referenceImageUrl?: string | null;
  centeringFront?: CenteringOverlayData | null;
  centeringBack?: CenteringOverlayData | null;
  certId?: number;
  onImageDeleted?: () => void;
  onSideChange?: (side: string) => void;
  onZoomChange?: (zoom: number) => void;
  onModeChange?: (mode: { fullscreen: boolean; markMode: boolean }) => void;
  /** When true, defect markers render but clicks are inert (tooltip explains
   *  why). Used by the post-approval read-only state in the parent's edit-mode
   *  gate so admins can still SEE the defects but can't edit until they click
   *  EDIT GRADE. */
  readOnly?: boolean;
  /** Optional controlled side. When provided, the parent owns the side state
   *  and ImageViewer becomes a controlled component for this prop. Falls back
   *  to internal state if undefined (preserves backward compat). */
  side?: Side;
  /** Hide the FRONT/BACK chip row in the inline (non-fullscreen) tab bar.
   *  Used when the parent renders its own chip row in a different layout
   *  position (e.g. above an absolute-positioning anchor wrapper). The
   *  fullscreen-mode renderTabs is unaffected. */
  omitSideTabs?: boolean;
}

const SEVERITY_VALUES: Defect["severity"][] = ["minor", "moderate", "significant"];

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

const ZOOM_STEPS = [1, 1.5, 2, 3, 4, 6];

function nextZoomStep(current: number): number {
  for (const s of ZOOM_STEPS) { if (s > current + 0.01) return s; }
  return ZOOM_STEPS[ZOOM_STEPS.length - 1];
}

function prevZoomStep(current: number): number {
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) { if (ZOOM_STEPS[i] < current - 0.01) return ZOOM_STEPS[i]; }
  return 1;
}

const PULSE_CSS = `
@keyframes defect-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(212,175,55,0.4); }
  50% { box-shadow: 0 0 0 6px rgba(212,175,55,0); }
}
.defect-ring-pulse { animation: defect-pulse 2s ease-in-out infinite; }
`;

export default function ImageViewer({ urls, defects, onDefectAdded, onDefectsChange, highlightId, referenceImageUrl, centeringFront, centeringBack, certId, onImageDeleted, onSideChange, onZoomChange, onModeChange, readOnly, side: controlledSide, omitSideTabs }: Props) {
  // Inline defect-edit popover anchored to a clicked marker. Null = closed.
  // Stores the defect id rather than the whole defect so we always read fresh
  // values from the live `defects` array (avoids stale closures during edit).
  const [editingDefectId, setEditingDefectId] = useState<number | null>(null);
  // Close popover on ESC. Plus a no-op cleanup when popover is closed —
  // the listener bind/unbind is cheap.
  useEffect(() => {
    if (editingDefectId == null) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setEditingDefectId(null);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [editingDefectId]);
  // Mutator helpers — both go through onDefectsChange. If not wired, marker
  // clicks degrade to no-op (and we'd never have opened the popover anyway
  // because `clickable` falls through to false).
  function updateDefectField<K extends keyof Defect>(id: number, key: K, value: Defect[K]) {
    if (!onDefectsChange) return;
    onDefectsChange(defects.map(d => d.id === id ? { ...d, [key]: value } : d));
  }
  function deleteDefect(id: number) {
    if (!onDefectsChange) return;
    onDefectsChange(defects.filter(d => d.id !== id));
    setEditingDefectId(null);
  }

  const [internalSide, setSideRaw] = useState<Side>("front");
  // Controlled when `side` prop supplied; otherwise falls back to internal state.
  const side: Side = controlledSide ?? internalSide;
  const [variant, setVariant] = useState<Variant>("original");
  const [showReference, setShowReference] = useState(false);
  const [zoom, setZoomRaw] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [showDefects, setShowDefects] = useState(true);
  const [showCentering, setShowCentering] = useState(false);
  const [markMode, setMarkModeRaw] = useState(false);
  const [fullscreen, setFullscreenRaw] = useState(false);

  function setSide(s: Side) {
    // Only mutate internal state when uncontrolled. Controlled callers
    // own the state — they must call onSideChange's value back into props.
    if (controlledSide === undefined) setSideRaw(s);
    onSideChange?.(s);
  }

  // Side-effects on side change (zoomReset + clear reference view) need to
  // fire on EVERY transition, not just clicks of the internal chip row —
  // otherwise a controlled-side change from the parent's external chips
  // would leave the zoom/reference state stale. Mirrors what the inline
  // chip onClick used to do directly.
  const prevSideRef = useRef<Side>(side);
  useEffect(() => {
    if (prevSideRef.current !== side) {
      prevSideRef.current = side;
      setShowReference(false);
      setZoomRaw(1);
      setPan({ x: 0, y: 0 });
      onZoomChange?.(1);
    }
  }, [side, onZoomChange]);
  function setZoom(z: number | ((prev: number) => number)) {
    setZoomRaw(prev => { const next = typeof z === "function" ? z(prev) : z; onZoomChange?.(next); return next; });
  }
  function setMarkMode(v: boolean) { setMarkModeRaw(v); onModeChange?.({ fullscreen: fullscreen, markMode: v }); }
  function setFullscreen(v: boolean) { setFullscreenRaw(v); onModeChange?.({ fullscreen: v, markMode: markMode }); }

  useEffect(() => { onSideChange?.("front"); }, []);
  const [manualCropSide, setManualCropSide] = useState<"front" | "back" | null>(null);
  // Batch defect placement: admin drops multiple pins (each click adds one),
  // then assigns a defect type once for the whole batch via the picker.
  // x/y are image-relative percents; pxX/pxY are viewport-absolute pixels
  // captured at click-time (drive the picker portal anchor — viewport pixels
  // because the image container has a scale() transform which would break
  // position:fixed otherwise). localId is the 1..N display number; real
  // defect ids are assigned in commitBatch.
  type PendingPin = { x: number; y: number; pxX: number; pxY: number; location: string; image_side: string; localId: number };
  const [pendingBatch, setPendingBatch] = useState<PendingPin[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerAnchor, setPickerAnchor] = useState<{ pxX: number; pxY: number; xPct: number; yPct: number } | null>(null);
  const lastClickTimeRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const imgElRef = useRef<HTMLImageElement>(null);

  const currentUrl = getUrl(urls, side, variant);
  const sideDefects = defects.filter(d => d.image_side === side);
  const frontDefectCount = defects.filter(d => d.image_side === "front").length;
  const backDefectCount = defects.filter(d => d.image_side === "back").length;

  // Keyboard shortcuts for fullscreen mode. Esc unwinds in order:
  // picker → pending batch → exit. Enter on a non-empty batch opens
  // the type picker. F/B switch sides (skipped while typing in a field).
  useEffect(() => {
    if (!fullscreen) return;
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      const inField = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || (t as any).isContentEditable);
      if (e.key === "Escape") {
        if (pickerOpen) { setPickerOpen(false); setPickerAnchor(null); return; }
        if (pendingBatch.length > 0) { setPendingBatch([]); return; }
        setFullscreen(false); setMarkMode(false);
      }
      else if (e.key === "Enter" && !inField && pendingBatch.length > 0 && !pickerOpen) {
        e.preventDefault();
        openTypePicker();
      }
      else if (!inField && (e.key === "f" || e.key === "F")) setSide("front");
      else if (!inField && (e.key === "b" || e.key === "B")) setSide("back");
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullscreen, pendingBatch, pickerOpen]);

  function enterMarkMode() {
    setMarkMode(true);
    setFullscreen(true);
  }

  function exitMarkMode() {
    setFullscreen(false);
    setMarkMode(false);
    cancelBatch();
  }

  function handleContainerClick(e: React.MouseEvent<HTMLDivElement>) {
    if (dragging) return;
    if (markMode && imgElRef.current) {
      // Double-click shortcut: two clicks within 280ms = "Done" — open the
      // type picker on the current batch instead of dropping a 2nd pin.
      const now = Date.now();
      const isDoubleClick = now - lastClickTimeRef.current < 280;
      lastClickTimeRef.current = now;
      if (isDoubleClick) {
        if (pendingBatch.length > 0) openTypePicker();
        return;
      }
      const imgRect = imgElRef.current.getBoundingClientRect();
      const xPct = ((e.clientX - imgRect.left) / imgRect.width) * 100;
      const yPct = ((e.clientY - imgRect.top) / imgRect.height) * 100;
      const cx = Math.max(0, Math.min(100, xPct));
      const cy = Math.max(0, Math.min(100, yPct));
      const locDesc = locationFromPercent(cx, cy, side);
      setPendingBatch(prev => [
        ...prev,
        { x: cx, y: cy, pxX: e.clientX, pxY: e.clientY, location: locDesc, image_side: side, localId: prev.length + 1 },
      ]);
      return;
    }
    if (zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1] - 0.01) {
      zoomReset();
    } else {
      const rect = e.currentTarget.getBoundingClientRect();
      setPan({ x: ((e.clientX - rect.left) / rect.width) * 100, y: ((e.clientY - rect.top) / rect.height) * 100 });
      setZoom(nextZoomStep(zoom));
    }
  }

  function handleWheel(e: React.WheelEvent) {
    e.preventDefault(); // prevent page scroll but don't zoom — use buttons instead
  }

  function zoomIn() { setZoom(z => nextZoomStep(z)); }
  function zoomOut() { setZoom(z => prevZoomStep(z)); }
  function zoomReset() { setZoom(1); setPan({ x: 50, y: 50 }); }

  function handleMouseDown(e: React.MouseEvent) {
    if (zoom <= 1 && !markMode) return;
    if (markMode && zoom <= 1) return;
    setDragging(true);
    setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
  }

  function handleMouseMove(e: React.MouseEvent) {
    if (!dragging) return;
    setPan({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
  }

  function handleMouseUp() { setDragging(false); }

  function openTypePicker() {
    const last = pendingBatch[pendingBatch.length - 1];
    if (!last) return;
    setPickerAnchor({ pxX: last.pxX, pxY: last.pxY, xPct: last.x, yPct: last.y });
    setPickerOpen(true);
  }

  function commitBatch(typeName: string) {
    let nextId = defects.length > 0 ? Math.max(...defects.map(d => d.id)) + 1 : 1;
    for (const pin of pendingBatch) {
      onDefectAdded({
        id: nextId++,
        type: typeName,
        severity: "moderate",
        description: "",
        location: pin.location,
        image_side: pin.image_side,
        x_percent: pin.x,
        y_percent: pin.y,
      });
    }
    setPendingBatch([]);
    setPickerOpen(false);
    setPickerAnchor(null);
    // Stay in markMode so admin can start the next batch immediately.
  }

  function cancelBatch() {
    setPendingBatch([]);
    setPickerOpen(false);
    setPickerAnchor(null);
  }

  const transformStyle = zoom > 1
    ? `scale(${zoom}) translate(${(50 - pan.x) / zoom}%, ${(50 - pan.y) / zoom}%)`
    : "none";
  const transitionStyle = dragging ? "none" : "transform 0.15s";

  // ── Shared tab bar ──────────────────────────────────────────────────────
  // The chip row (FRONT/BACK + trash) is suppressed when `omitSideTabs` is
  // true — used by the normal-inline grading-panel layout where the parent
  // renders a chip row in its own dedicated location above the absolute-
  // anchor wrapper for TL/T/TR labels. Fullscreen mode forces the chip row
  // ON regardless (its own self-contained layout has no external chip row).
  function renderTabs() {
    const showSideTabs = fullscreen || !omitSideTabs;
    return (
      <div className="space-y-1">
        {showSideTabs && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {SIDES.map(s => {
            const count = s === "front" ? frontDefectCount : s === "back" ? backDefectCount : 0;
            const hasImage = hasAny(urls, s);
            return (
              <div key={s} className="flex items-center gap-0.5">
                <button type="button"
                  onClick={() => { setSide(s); setShowReference(false); zoomReset(); }}
                  disabled={!hasImage}
                  className={`flex-shrink-0 rounded-l px-3 py-1 text-[10px] font-bold uppercase tracking-wider border transition-all ${
                    side === s && !showReference
                      ? "border-[#D4AF37] text-[#D4AF37] bg-[#D4AF37]/10"
                      : hasImage ? "border-[#D4D0C8] text-[#333333] hover:border-[#D4AF37]/40" : "border-[#E8E4DC] text-[#888888] cursor-not-allowed"
                  }`}
                >{s}{count > 0 ? ` (${count})` : ""}</button>
                {hasImage && certId && !fullscreen && (
                  <button type="button" title={`Delete ${s} image`}
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (!confirm(`Delete the ${s} image? You'll need to re-upload before grading.`)) return;
                      try {
                        const r = await fetch(`/api/admin/certificates/${certId}/images/${s}`, { method: "DELETE", credentials: "include" });
                        if (!r.ok) { const d = await r.json(); throw new Error(d.error); }
                        onImageDeleted?.();
                      } catch {}
                    }}
                    className="flex-shrink-0 rounded-r border border-l-0 border-[#D4D0C8] text-[#555555] hover:text-red-600 hover:border-red-400/40 px-1.5 py-1 transition-all"
                  >
                    <Trash2 size={10} />
                  </button>
                )}
              </div>
            );
          })}
          {!fullscreen && referenceImageUrl && (
            <button type="button" onClick={() => setShowReference(v => !v)}
              className={`flex-shrink-0 rounded px-3 py-1 text-[10px] font-bold uppercase tracking-wider border transition-all ${showReference ? "border-[#D4AF37] text-[#D4AF37] bg-[#D4AF37]/10" : "border-[#D4D0C8] text-[#333333] hover:border-[#D4AF37]/40"}`}
            >Reference</button>
          )}
        </div>
        )}
        <div className="flex gap-1 overflow-x-auto">
          {VARIANTS.filter(v => {
            // Original is always available (falls back to cropped or original)
            if (v.key === "original") return true;
            // Other variants only show if their URL exists for this side
            const key = `${side}_${v.key}` as keyof ImageUrls;
            return urls[key] != null;
          }).map(v => (
            <button key={v.key} type="button" onClick={() => setVariant(v.key)}
              className={`flex-shrink-0 px-2.5 py-1 text-[10px] uppercase tracking-widest rounded transition-all border-b-2 ${variant === v.key ? "text-[#D4AF37] border-[#D4AF37]" : "text-[#555555] border-transparent hover:text-[#333333]"}`}
            >{v.label}</button>
          ))}
        </div>
      </div>
    );
  }

  // ── Shared image area ───────────────────────────────────────────────────
  function renderImageArea(maxH: string | number) {
    return (
      <>
      <div
        ref={containerRef}
        className={`relative overflow-hidden rounded-lg select-none ${
          markMode ? "cursor-crosshair" : zoom > 1 ? (dragging ? "cursor-grabbing" : "cursor-grab") : "cursor-zoom-in"
        }`}
        style={{ aspectRatio: "5/7", maxHeight: maxH }}
        onClick={handleContainerClick}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {currentUrl ? (
          <div className="relative w-full h-full overflow-hidden rounded-[4%]" style={{ transform: transformStyle, transition: transitionStyle }}>
            <img ref={imgElRef} src={currentUrl} alt={`${side} ${variant}`} className="w-full h-full object-contain rounded-[4%]" draggable={false} />

            {/* Centering overlay — outer (card edge) + inner (artwork frame) */}
            {showCentering && (() => {
              const cd = side === "front" ? centeringFront : centeringBack;
              if (!cd) return null;
              const outer = cd.outerFrame || { left_pct: 0, right_pct: 100, top_pct: 0, bottom_pct: 100 };
              const inner = cd.innerFrame;
              // Compute geometric centering from outer + inner frame coordinates
              let lPct = 50, rPct = 50, tPct = 50, bPct = 50;
              if (inner) {
                const leftM = inner.left_pct - outer.left_pct;
                const rightM = outer.right_pct - inner.right_pct;
                const topM = inner.top_pct - outer.top_pct;
                const botM = outer.bottom_pct - inner.bottom_pct;
                const lrTotal = leftM + rightM;
                const tbTotal = topM + botM;
                if (lrTotal > 0) { lPct = Math.round(leftM / lrTotal * 100); rPct = 100 - lPct; }
                if (tbTotal > 0) { tPct = Math.round(topM / tbTotal * 100); bPct = 100 - tPct; }
              }
              // Sanity checks
              let warning = "";
              if (inner) {
                const innerW = inner.right_pct - inner.left_pct;
                const innerH = inner.bottom_pct - inner.top_pct;
                const outerW = outer.right_pct - outer.left_pct;
                const outerH = outer.bottom_pct - outer.top_pct;
                const areaRatio = (innerW * innerH) / (outerW * outerH);
                if (areaRatio < 0.4) warning = "⚠ Inner frame too small — may be measuring art window, not card border";
                if (Math.abs(lPct - tPct) > 20) warning = "⚠ L/R and T/B differ significantly — verify inner frame";
              }

              // Fallback to AI ratios if no frame coords
              const lr = inner ? [lPct, rPct] : (cd.ratioLR?.split("/").map(Number) || [50, 50]);
              const tb = inner ? [tPct, bPct] : (cd.ratioTB?.split("/").map(Number) || [50, 50]);
              const midY = inner ? (inner.top_pct + inner.bottom_pct) / 2 : 50;
              const midX = inner ? (inner.left_pct + inner.right_pct) / 2 : 50;
              return (
                <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
                  {/* Sanity warning */}
                  {warning && <text x="50" y="3" textAnchor="middle" fill="#FF6600" fontSize="2.5" fontWeight="bold">{warning}</text>}
                  {/* Outer frame — solid gold, traces card physical edge */}
                  <rect x={outer.left_pct} y={outer.top_pct}
                    width={outer.right_pct - outer.left_pct} height={outer.bottom_pct - outer.top_pct}
                    fill="none" stroke="#D4AF37" strokeWidth="0.6" opacity="0.7" />
                  {/* Inner frame — dashed gold, traces artwork boundary */}
                  {inner && <rect x={inner.left_pct} y={inner.top_pct}
                    width={inner.right_pct - inner.left_pct} height={inner.bottom_pct - inner.top_pct}
                    fill="none" stroke="#D4AF37" strokeWidth="0.4" strokeDasharray="1.5,1" opacity="0.8" />}
                  {/* Measurement lines + computed percentages */}
                  {inner && <>
                    <line x1={outer.left_pct} y1={midY} x2={inner.left_pct} y2={midY} stroke="#D4AF37" strokeWidth="0.3" opacity="0.6" />
                    <text x={(outer.left_pct + inner.left_pct) / 2} y={midY - 1.5} textAnchor="middle" fill="#D4AF37" fontSize="3" fontWeight="bold" opacity="0.9">{lr[0]}%</text>
                    <line x1={inner.right_pct} y1={midY} x2={outer.right_pct} y2={midY} stroke="#D4AF37" strokeWidth="0.3" opacity="0.6" />
                    <text x={(inner.right_pct + outer.right_pct) / 2} y={midY - 1.5} textAnchor="middle" fill="#D4AF37" fontSize="3" fontWeight="bold" opacity="0.9">{lr[1]}%</text>
                    <line x1={midX} y1={outer.top_pct} x2={midX} y2={inner.top_pct} stroke="#D4AF37" strokeWidth="0.3" opacity="0.6" />
                    <text x={midX} y={(outer.top_pct + inner.top_pct) / 2 + 1} textAnchor="middle" fill="#D4AF37" fontSize="3" fontWeight="bold" opacity="0.9">{tb[0]}%</text>
                    <line x1={midX} y1={inner.bottom_pct} x2={midX} y2={outer.bottom_pct} stroke="#D4AF37" strokeWidth="0.3" opacity="0.6" />
                    <text x={midX} y={(inner.bottom_pct + outer.bottom_pct) / 2 + 1} textAnchor="middle" fill="#D4AF37" fontSize="3" fontWeight="bold" opacity="0.9">{tb[1]}%</text>
                  </>}
                </svg>
              );
            })()}

            {/* Defect ring markers — clickable when not readOnly and an
                onDefectsChange handler exists. Click opens an inline popover
                anchored to the marker for edit / delete. AI markers are also
                editable (they share the defects[] array with admin-placed). */}
            {showDefects && (() => {
              let humanIdx = 0;
              const clickable = !readOnly && !!onDefectsChange;
              return sideDefects.map(d => {
                const isAi = !!(d as any)._aiSource || !!(d as any).detected_in;
                if (!isAi) humanIdx++;
                const isHL = highlightId === d.id;
                const col = isAi ? "#DC2626" : "#D4AF37";
                const badge = isAi ? "AI" : String(humanIdx);
                const isEditing = editingDefectId === d.id;
                // Popover above marker when marker is in lower half; below
                // when in upper half — keeps marker visible.
                const popoverAbove = d.y_percent > 50;
                return (
                  <div key={d.id} className={`absolute ${clickable ? "" : "pointer-events-none"} ${isHL ? "defect-ring-pulse" : ""}`}
                    style={{ left: `${d.x_percent}%`, top: `${d.y_percent}%`, transform: "translate(-50%, -50%)", width: 32, height: 32 }}>
                    {/* Marker ring — a button when clickable so keyboard nav
                        + role + aria-label come for free. Falls back to a
                        decorative div when read-only / handler missing. */}
                    {clickable ? (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setEditingDefectId(isEditing ? null : d.id); }}
                        title={`Defect ${badge}: ${d.type}, ${d.severity}`}
                        aria-label={`Defect ${badge}: ${d.type}, ${d.severity}. Click to edit or delete.`}
                        className="w-full h-full rounded-full transition-all cursor-pointer hover:scale-110 focus:outline-none focus:ring-2 focus:ring-[#D4AF37]/60"
                        style={{ border: `${isHL || isEditing ? 3 : 2}px solid ${col}`, background: "transparent", boxShadow: isHL || isEditing ? `0 0 8px ${col}80` : "none" }}
                      />
                    ) : (
                      <div
                        className="w-full h-full rounded-full transition-all"
                        title={readOnly ? "Click EDIT GRADE to edit defects" : undefined}
                        style={{ border: `${isHL ? 3 : 2}px solid ${col}`, background: "transparent", boxShadow: isHL ? `0 0 8px ${col}80` : "none" }}
                      />
                    )}
                    <span className="absolute -top-1 -right-1 text-[8px] font-black px-1 rounded-full leading-none py-0.5 pointer-events-none"
                      style={{ background: col, color: isAi ? "#fff" : "#1A1400" }}>{badge}</span>

                    {/* Inline edit/delete popover */}
                    {isEditing && (
                      <DefectEditPopover
                        defect={d}
                        badge={badge}
                        anchorAbove={popoverAbove}
                        onChangeField={(k, v) => updateDefectField(d.id, k, v)}
                        onDelete={() => deleteDefect(d.id)}
                        onClose={() => setEditingDefectId(null)}
                      />
                    )}
                  </div>
                );
              });
            })()}

            {/* Pending batch pins — grey numbered markers for the current
                click-batch. Each click in markMode adds a pin here; the Done
                button (or Enter / dbl-click) opens the picker which commits
                all of them at once. Filtered to the visible side. */}
            {pendingBatch.filter(p => p.image_side === side).map(p => (
              <div key={p.localId} className="absolute pointer-events-none"
                style={{ left: `${p.x}%`, top: `${p.y}%`, transform: "translate(-50%, -50%)", width: 32, height: 32 }}>
                <div className="w-full h-full rounded-full border-2 border-[#D4AF37] bg-transparent" />
                <span className="absolute -top-1 -right-1 text-[9px] font-black bg-[#555555] text-white px-1 rounded-full leading-none py-0.5">{p.localId}</span>
              </div>
            ))}
          </div>
        ) : certId ? (
          /* Inline drop zone for missing side */
          <InlineDropZone side={side} certId={certId} onUploaded={() => onImageDeleted?.()} />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-[#888888] text-xs">No image</p>
          </div>
        )}
      </div>

      {/* Zoom toolbar — sibling of the card frame so it doesn't overlap card
          art. Right-aligned row directly under the image, matching the
          existing "Mark Defects / Manual Crop" button row pattern. */}
      <div className="mt-2 flex items-center justify-end">
        <div className="flex items-center gap-0.5 bg-[#1A1A1A] border border-[#333333] rounded-full px-1 py-0.5">
          <button type="button" onClick={(e) => { e.stopPropagation(); zoomOut(); }} disabled={zoom <= 1}
            className="w-7 h-7 flex items-center justify-center text-white hover:text-[#D4AF37] disabled:text-[#555555] transition-colors rounded-full">
            <ZoomOut size={14} />
          </button>
          <span className="text-white text-[10px] font-mono w-10 text-center select-none">{Math.round(zoom * 100)}%</span>
          <button type="button" onClick={(e) => { e.stopPropagation(); zoomIn(); }} disabled={zoom >= 6}
            className="w-7 h-7 flex items-center justify-center text-white hover:text-[#D4AF37] disabled:text-[#555555] transition-colors rounded-full">
            <ZoomIn size={14} />
          </button>
          {zoom > 1 && (
            <button type="button" onClick={(e) => { e.stopPropagation(); zoomReset(); }}
              className="w-7 h-7 flex items-center justify-center text-[#555555] hover:text-white transition-colors rounded-full">
              <RotateCcw size={12} />
            </button>
          )}
        </div>
      </div>
      </>
    );
  }

  // ── Fullscreen overlay ──────────────────────────────────────────────────
  if (fullscreen) {
    return (
      <>
        <style>{PULSE_CSS}</style>
        <div className="fixed inset-0 z-50 bg-black/95 flex flex-col">
          {/* Top bar */}
          <div className="flex-shrink-0 px-4 py-3 flex items-center justify-between border-b border-[#333333]">
            <div className="flex-1">{renderTabs()}</div>
            <button type="button" onClick={exitMarkMode}
              className="ml-4 text-[#555555] hover:text-white transition-colors p-1">
              <X size={20} />
            </button>
          </div>

          {/* Main image — fills remaining space */}
          <div className="flex-1 flex items-center justify-center p-4 min-h-0">
            <div className="w-full h-full max-w-[85vh]">
              {renderImageArea("85vh")}
            </div>
          </div>

          {/* Dropdown rendered below via Portal — see DropdownPortal at the
              bottom of the fullscreen JSX so it escapes any ancestor
              transform (the image container has transform: scale(...) for
              zoom, which would break position: fixed otherwise). */}

          {/* Bottom toolbar */}
          <div className="flex-shrink-0 px-4 py-3 flex items-center justify-between border-t border-[#333333]">
            <p className="text-[#555555] text-xs">
              {defects.length} defect{defects.length !== 1 ? "s" : ""} marked
              <span className="text-[#555555] ml-3">Click pins, then Done to assign type · Enter / dbl-click = Done · F/B switch sides · Esc to exit</span>
            </p>
            <div className="flex items-center gap-3">
              {pendingBatch.length > 0 && !pickerOpen && (
                <button type="button" onClick={openTypePicker}
                  className="bg-[#D4AF37] text-[#1A1400] text-xs font-bold uppercase px-5 py-2 rounded-lg hover:bg-[#B8960C] transition-all border border-[#B8960C]">
                  Done — Assign Type ({pendingBatch.length})
                </button>
              )}
              <button type="button" onClick={exitMarkMode}
                className="flex items-center gap-2 bg-gradient-to-r from-[#D4AF37] to-[#B8960C] text-[#1A1400] text-xs font-bold uppercase px-5 py-2 rounded-lg hover:opacity-90 transition-all">
                Done Marking
              </button>
            </div>
          </div>
        </div>
        {pickerOpen && pickerAnchor && (() => {
          // Portal into document.body — bypasses any ancestor transform
          // (image container has transform: scale(...) for zoom which would
          // otherwise break position: fixed positioning). Anchor is the LAST
          // pin in the batch; flip logic uses its image-relative percent.
          const DROPDOWN_W = 180;
          const DROPDOWN_H = 360;
          const GAP = 6;
          const flipLeft = pickerAnchor.xPct > 70;
          const flipUp   = pickerAnchor.yPct > 70;
          const left = flipLeft
            ? pickerAnchor.pxX - GAP - DROPDOWN_W
            : pickerAnchor.pxX + GAP;
          const top = flipUp
            ? pickerAnchor.pxY - GAP - DROPDOWN_H
            : pickerAnchor.pxY + GAP;
          const clampedLeft = Math.max(8, Math.min(window.innerWidth - DROPDOWN_W - 8, left));
          const clampedTop  = Math.max(8, Math.min(window.innerHeight - DROPDOWN_H - 8, top));
          return createPortal(
            <>
              <div
                className="fixed inset-0"
                style={{ zIndex: 9998 }}
                onClick={cancelBatch}
              />
              <div
                className="fixed bg-white border border-[#D4AF37]/60 rounded-lg shadow-2xl overflow-hidden"
                style={{
                  zIndex: 9999,
                  left: clampedLeft,
                  top: clampedTop,
                  width: DROPDOWN_W,
                  maxHeight: DROPDOWN_H,
                }}
                onClick={e => e.stopPropagation()}
              >
                <div className="px-3 py-2 border-b border-[#E8E4DC] bg-[#F7F7F5] flex items-center justify-between">
                  <span className="text-[#D4AF37] text-[10px] font-bold uppercase tracking-widest">Defect type ({pendingBatch.length})</span>
                  <button
                    type="button"
                    onClick={cancelBatch}
                    className="text-[#888888] hover:text-red-600 transition-colors"
                    aria-label="Cancel"
                  >
                    <X size={12} />
                  </button>
                </div>
                <div className="overflow-y-auto" style={{ maxHeight: DROPDOWN_H - 36 }}>
                  {DEFECT_TYPES.map(t => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => commitBatch(t)}
                      className="w-full text-left px-3 py-1.5 text-[#1A1A1A] text-xs hover:bg-[#D4AF37]/10 border-b border-[#F0EEE8] last:border-b-0 transition-colors"
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
            </>,
            document.body
          );
        })()}
      </>
    );
  }

  // ── Normal (inline) view ────────────────────────────────────────────────
  return (
    <div className="space-y-2">
      <style>{PULSE_CSS}</style>

      {renderTabs()}

      {/* Reference comparison */}
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

      {/* Main image (normal size) */}
      {!showReference && renderImageArea(500)}

      {/* Controls row */}
      <div className="flex items-center gap-2 flex-wrap">
        <button type="button" onClick={enterMarkMode}
          className="flex items-center gap-1.5 text-[10px] font-bold uppercase px-3 py-1.5 rounded border transition-all border-[#D4AF37]/40 text-[#B8960C] hover:border-[#D4AF37] hover:bg-[#D4AF37]/10">
          <Maximize2 size={11} />
          Mark Defects
        </button>
        {certId && (side === "front" || side === "back") && urls[`${side}_original` as keyof ImageUrls] && (
          <button type="button" onClick={() => setManualCropSide(side as "front" | "back")}
            className="flex items-center gap-1.5 text-[10px] font-bold uppercase px-3 py-1.5 rounded border transition-all border-[#D4AF37]/40 text-[#B8960C] hover:border-[#D4AF37] hover:bg-[#D4AF37]/10">
            <Crop size={11} />
            Manual Crop
          </button>
        )}
        <button type="button" onClick={() => setShowDefects(!showDefects)}
          className="flex items-center gap-1.5 text-[10px] text-[#333333] hover:text-[#1A1A1A] border border-[#E8E4DC] px-3 py-1.5 rounded transition-all hover:border-[#D4AF37]/40">
          {showDefects ? <EyeOff size={11} /> : <Eye size={11} />}
          {showDefects ? "Hide Defects" : "Show Defects"}
        </button>
        {(centeringFront || centeringBack) && (
          <button type="button" onClick={() => setShowCentering(!showCentering)}
            className={`flex items-center gap-1.5 text-[10px] font-bold uppercase px-3 py-1.5 rounded border transition-all ${showCentering ? "border-[#D4AF37] text-[#B8960C] bg-[#D4AF37]/10" : "border-[#E8E4DC] text-[#333333] hover:border-[#D4AF37]/40"}`}>
            {showCentering ? "Hide Centering" : "Show Centering"}
          </button>
        )}
      </div>

      {/* Manual Crop modal (lazy-loaded — won't crash if module fails) */}
      {manualCropSide && certId && urls[`${manualCropSide}_original` as keyof ImageUrls] && (
        <Suspense fallback={<div className="fixed inset-0 z-[100] bg-black/95 flex items-center justify-center text-[#D4AF37] text-sm">Loading crop tool...</div>}>
          <ManualCrop
            side={manualCropSide}
            certId={certId}
            rawImageUrl={urls[`${manualCropSide}_original` as keyof ImageUrls] as string}
            onDone={() => { setManualCropSide(null); onImageDeleted?.(); }}
            onCancel={() => setManualCropSide(null)}
          />
        </Suspense>
      )}
    </div>
  );
}

/** Inline drop zone for uploading a single missing side */
function InlineDropZone({ side, certId, onUploaded }: { side: string; certId: number; onUploaded: () => void }) {
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(f: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append(side, f);
      const res = await fetch(`/api/admin/certificates/${certId}/upload-images`, {
        method: "POST", credentials: "include", body: fd,
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error); }
      onUploaded();
    } catch {
      setUploading(false);
    }
  }

  return (
    <div
      className={`absolute inset-0 flex flex-col items-center justify-center gap-2 cursor-pointer transition-colors ${isDragging ? "bg-[#D4AF37]/10" : ""}`}
      onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={e => { e.preventDefault(); setIsDragging(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
      onClick={() => !uploading && inputRef.current?.click()}
    >
      <input ref={inputRef} type="file" accept="image/*" className="sr-only" onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
      {uploading ? (
        <>
          <Loader2 size={24} className="text-[#D4AF37] animate-spin" />
          <p className="text-[#555555] text-xs">Uploading {side}…</p>
        </>
      ) : (
        <>
          <Upload size={24} className="text-[#555555]" />
          <p className="text-[#333333] text-xs font-bold">Drop new {side} image here</p>
          <p className="text-[#555555] text-[10px]">or click to browse</p>
        </>
      )}
    </div>
  );
}

function locationFromPercent(x: number, y: number, side: string): string {
  const hLabel = x < 33 ? "left" : x > 66 ? "right" : "centre";
  const vLabel = y < 33 ? "top" : y > 66 ? "bottom" : "middle";
  return `${side.charAt(0).toUpperCase() + side.slice(1)}, ${vLabel}-${hLabel}`;
}

// ── Inline defect edit popover ─────────────────────────────────────────────
// Anchored to the marker via absolute positioning. anchorAbove flips it to
// sit above (when marker is in lower image half) vs below (upper half) so
// the marker stays visible. Click-outside closes via a capture-phase mousedown
// listener; ESC handled by the parent.
function DefectEditPopover({
  defect, badge, anchorAbove, onChangeField, onDelete, onClose,
}: {
  defect: Defect;
  badge: string;
  anchorAbove: boolean;
  onChangeField: <K extends keyof Defect>(key: K, value: Defect[K]) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Click outside closes. mousedown (not click) on capture phase so we beat
  // any synthetic React click that would re-open / interfere.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!ref.current) return;
      if (e.target instanceof Node && !ref.current.contains(e.target)) onClose();
    }
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [onClose]);

  // Position: anchored so the marker sits at one edge. Marker is 32px so
  // 20px gap clears it cleanly.
  const verticalCss = anchorAbove
    ? { bottom: "calc(100% + 20px)" }
    : { top:    "calc(100% + 20px)" };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={`Edit defect ${badge}`}
      className="absolute left-1/2 -translate-x-1/2 z-50 w-64 bg-white border border-[#D4AF37]/60 rounded-lg shadow-xl p-3 space-y-2 text-left"
      style={verticalCss}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between">
        <p className="text-[#D4AF37] text-[10px] font-bold uppercase tracking-widest">Defect #{badge}</p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="text-[#888888] hover:text-[#1A1A1A] transition-colors"
        >
          <X size={12} />
        </button>
      </div>

      <div className="space-y-1.5">
        <label className="text-[#555555] text-[9px] uppercase tracking-wider block">Type</label>
        <select
          value={defect.type}
          onChange={(e) => onChangeField("type", e.target.value)}
          className="w-full bg-[#F7F7F5] border border-[#D4D0C8] rounded px-2 py-1 text-xs text-[#1A1A1A]"
          autoFocus
        >
          {DEFECT_TYPES.map((t) => (<option key={t} value={t}>{t}</option>))}
        </select>
      </div>

      <div className="space-y-1.5">
        <label className="text-[#555555] text-[9px] uppercase tracking-wider block">Severity</label>
        <select
          value={defect.severity}
          onChange={(e) => onChangeField("severity", e.target.value as Defect["severity"])}
          className="w-full bg-[#F7F7F5] border border-[#D4D0C8] rounded px-2 py-1 text-xs text-[#1A1A1A]"
        >
          {SEVERITY_VALUES.map((s) => (<option key={s} value={s}>{s}</option>))}
        </select>
      </div>

      <div className="space-y-1.5">
        <label className="text-[#555555] text-[9px] uppercase tracking-wider block">Notes</label>
        <input
          type="text"
          value={defect.description ?? ""}
          onChange={(e) => onChangeField("description", e.target.value)}
          placeholder="Optional"
          className="w-full bg-[#F7F7F5] border border-[#D4D0C8] rounded px-2 py-1 text-xs text-[#1A1A1A]"
        />
      </div>

      <div className="flex items-center justify-between pt-1">
        <button
          type="button"
          onClick={onDelete}
          className="text-red-600 hover:text-red-700 hover:bg-red-50 text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded transition-colors"
        >
          Delete
        </button>
        <button
          type="button"
          onClick={onClose}
          className="bg-gradient-to-r from-[#D4AF37] to-[#B8960C] text-[#1A1400] text-[10px] font-bold uppercase tracking-widest px-3 py-1 rounded hover:opacity-90 transition-opacity"
        >
          Done
        </button>
      </div>
    </div>
  );
}
