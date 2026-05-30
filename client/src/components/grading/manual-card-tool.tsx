import { useState, useRef, useEffect } from "react";
import { Loader2, Crop, X, Check } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { type Point } from "./crop-geometry";
import { computeCardTool, ptsToQuad, cropBoxForOuter, type CardToolMode } from "./card-tool-geometry";
import { type CenteringResult } from "./manual-centering";

interface Props {
  side: "front" | "back";
  certId: number;
  /** RAW original image URL. Display the raw (not the cropped) so /recrop —
   *  which rotates the raw first then crops — never double-rotates. */
  rawImageUrl: string;
  /** Called after a successful compute (recrop ± centering) so the panel can
   *  refresh the images + grading queries. */
  onDone: () => void;
  onCancel: () => void;
  /** In full mode, fired with the centering result so the panel updates its
   *  L/R, T/B, outer/inner and method state (same shape as ManualCentering). */
  onCentering?: (result: CenteringResult) => void;
}

// Dots are captured in corner order. Index → label.
const CORNER_LABELS = ["TL", "TR", "BR", "BL"] as const;
// Near-miss grab radius (screen px): a click within this of an already-placed
// dot grabs the nearest dot for dragging instead of doing nothing.
const GRAB_PX = 40;
// Thin mat margin (0–100 units) added around the outer bbox before cropping, so
// a deskew rotation doesn't clip the card corners.
const CROP_MARGIN_PCT = 1.0;
const OUTER_COLOR = "#D4AF37"; // gold — card-edge dots
const INNER_COLOR = "#16A34A"; // green — border→art dots

type DotPass = "outer" | "inner";

function clamp(v: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, v));
}

function polyPoints(pts: Point[]): string {
  return pts.map((p) => `${p.x},${p.y}`).join(" ");
}

function centroid(pts: Point[]): Point {
  if (pts.length === 0) return { x: 50, y: 50 };
  const sx = pts.reduce((s, p) => s + p.x, 0);
  const sy = pts.reduce((s, p) => s + p.y, 0);
  return { x: sx / pts.length, y: sy / pts.length };
}

export default function ManualCardTool({ side, certId, rawImageUrl, onDone, onCancel, onCentering }: Props) {
  const [mode, setMode] = useState<CardToolMode>("full");
  const [outerPts, setOuterPts] = useState<Point[]>([]);
  const [innerPts, setInnerPts] = useState<Point[]>([]);
  // Deskew override in degrees. 0 = auto-derive from the 4 outer dots. A
  // non-zero value overrides the auto angle (it does NOT rotate the captured
  // image, so capturing stays free of getBoundingClientRect AABB distortion).
  const [rotation, setRotation] = useState(0);
  const [imgDims, setImgDims] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [saving, setSaving] = useState(false);
  const [drag, setDrag] = useState<null | {
    pass: DotPass;
    index: number;
    startMouse: Point;
    startPts: Point[];
  }>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastTouchAtRef = useRef<number>(0);
  const { toast } = useToast();

  // Which pass placement clicks flow into next: outer until 4 placed, then
  // inner (full mode only). Once both are full, clicks become near-miss grabs.
  const activePass: DotPass = mode === "outer-only" ? "outer" : outerPts.length < 4 ? "outer" : "inner";
  const activeArr = activePass === "outer" ? outerPts : innerPts;
  const outerReady = outerPts.length === 4;
  const innerReady = innerPts.length === 4;
  const canCompute = outerReady && (mode === "outer-only" || innerReady);

  function toPct(e: MouseEvent | React.MouseEvent): Point | null {
    const el = containerRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: clamp(((e.clientX - r.left) / r.width) * 100),
      y: clamp(((e.clientY - r.top) / r.height) * 100),
    };
  }

  function placePoint(pt: Point) {
    if (activePass === "outer") {
      if (outerPts.length < 4) setOuterPts([...outerPts, pt]);
    } else {
      if (innerPts.length < 4) setInnerPts([...innerPts, pt]);
    }
  }

  /** All placed dots (with pass + index) for near-miss grab tests. */
  function allDots(): { pass: DotPass; index: number; p: Point }[] {
    const list: { pass: DotPass; index: number; p: Point }[] = outerPts.map((p, i) => ({ pass: "outer", index: i, p }));
    if (mode !== "outer-only") innerPts.forEach((p, i) => list.push({ pass: "inner", index: i, p }));
    return list;
  }

  function nearestDot(clientX: number, clientY: number): { pass: DotPass; index: number } | null {
    const el = containerRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    let best: { pass: DotPass; index: number } | null = null;
    let bestD = Infinity;
    for (const c of allDots()) {
      const px = r.left + (c.p.x / 100) * r.width;
      const py = r.top + (c.p.y / 100) * r.height;
      const d = Math.hypot(clientX - px, clientY - py);
      if (d < bestD) {
        bestD = d;
        best = { pass: c.pass, index: c.index };
      }
    }
    return best && bestD <= GRAB_PX ? best : null;
  }

  function startDotDrag(pass: DotPass, index: number, clientX: number, clientY: number) {
    const startPts = (pass === "outer" ? outerPts : innerPts).map((p) => ({ ...p }));
    setDrag({ pass, index, startMouse: { x: clientX, y: clientY }, startPts });
  }

  // Container press: place the next dot, or — when the active pass is full —
  // grab the nearest dot within GRAB_PX for a near-miss fine-tune.
  function onContainerMouseDown(e: React.MouseEvent) {
    if (Date.now() - lastTouchAtRef.current < 500) return; // ignore synthetic touch
    if (activeArr.length < 4) {
      const pt = toPct(e);
      if (pt) placePoint(pt);
      return;
    }
    const hit = nearestDot(e.clientX, e.clientY);
    if (hit) {
      e.preventDefault();
      startDotDrag(hit.pass, hit.index, e.clientX, e.clientY);
    }
  }

  function onContainerTouchStart(e: React.TouchEvent) {
    lastTouchAtRef.current = Date.now();
    const t = e.touches[0];
    if (!t) return;
    if (activeArr.length < 4) {
      const el = containerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      placePoint({
        x: clamp(((t.clientX - r.left) / r.width) * 100),
        y: clamp(((t.clientY - r.top) / r.height) * 100),
      });
      return;
    }
    const hit = nearestDot(t.clientX, t.clientY);
    if (hit) startDotDrag(hit.pass, hit.index, t.clientX, t.clientY);
  }

  // Direct press on a dot's hit area — always a drag (stopPropagation so the
  // container handler doesn't also place/grab).
  function onDotMouseDown(pass: DotPass, index: number, e: React.MouseEvent) {
    if (Date.now() - lastTouchAtRef.current < 500) return;
    e.stopPropagation();
    e.preventDefault();
    startDotDrag(pass, index, e.clientX, e.clientY);
  }

  function onDotTouchStart(pass: DotPass, index: number, e: React.TouchEvent) {
    e.stopPropagation();
    lastTouchAtRef.current = Date.now();
    const t = e.touches[0];
    if (!t) return;
    startDotDrag(pass, index, t.clientX, t.clientY);
  }

  useEffect(() => {
    if (!drag) return;
    function applyDelta(clientX: number, clientY: number) {
      const cw = containerRef.current?.clientWidth || 1;
      const ch = containerRef.current?.clientHeight || 1;
      const dx = ((clientX - drag!.startMouse.x) / cw) * 100;
      const dy = ((clientY - drag!.startMouse.y) / ch) * 100;
      const next = drag!.startPts.map((p) => ({ ...p }));
      const base = drag!.startPts[drag!.index];
      next[drag!.index] = { x: clamp(base.x + dx), y: clamp(base.y + dy) };
      if (drag!.pass === "outer") setOuterPts(next);
      else setInnerPts(next);
    }
    function onMove(e: MouseEvent) {
      applyDelta(e.clientX, e.clientY);
    }
    function onTouchMove(e: TouchEvent) {
      if (e.touches.length === 0) return;
      e.preventDefault();
      const t = e.touches[0];
      applyDelta(t.clientX, t.clientY);
    }
    function onUp() {
      setDrag(null);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onUp);
    window.addEventListener("touchcancel", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onUp);
      window.removeEventListener("touchcancel", onUp);
    };
  }, [drag]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "Escape") onCancel();
      else if (e.key === "Enter" && canCompute && !saving) handleCompute();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line
  }, [outerPts, innerPts, mode, rotation, canCompute, saving]);

  function clearOuter() {
    setOuterPts([]);
  }
  function clearInner() {
    setInnerPts([]);
  }
  function setModeSafe(m: CardToolMode) {
    setMode(m);
    if (m === "outer-only") setInnerPts([]);
  }

  async function handleCompute() {
    if (!outerReady) {
      toast({ title: "Place all 4 outer corners first", variant: "destructive" });
      return;
    }
    if (mode === "full" && !innerReady) {
      toast({ title: "Place all 4 inner corners (or switch to Outer-only)", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const outerQuad = ptsToQuad(outerPts);
      const innerQuad = mode === "full" ? ptsToQuad(innerPts) : null;
      const { crop, deskewDeg, centering } = computeCardTool(
        mode,
        outerQuad,
        innerQuad,
        side,
        rotation,
        CROP_MARGIN_PCT,
        imgDims.w,
        imgDims.h
      );

      // 1) Crop + deskew via the existing recrop endpoint (crops the RAW
      //    original, rotating first — no double-rotation).
      const cropRes = await fetch(`/api/admin/certificates/${certId}/recrop`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          side,
          left_pct: crop.left_pct,
          top_pct: crop.top_pct,
          width_pct: crop.width_pct,
          height_pct: crop.height_pct,
          rotation_deg: deskewDeg,
          quad: outerQuad,
        }),
      });
      const cropJson = await cropRes.json();
      if (!cropRes.ok) throw new Error(cropJson.error || "Recrop failed");

      // 2) Centering via the existing manual-centering endpoint (full mode
      //    only). Rects are normalized to the post-crop frame; ratios/subgrade
      //    flow through the canonical chart (shared/centering.ts).
      if (mode === "full" && centering) {
        const cenRes = await fetch(`/api/admin/certificates/${certId}/manual-centering`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ side, outer: centering.outer, inner: centering.inner }),
        });
        const cenJson = await cenRes.json();
        if (!cenRes.ok) throw new Error(cenJson.error || "Centering save failed");
        onCentering?.({
          side,
          outer: centering.outer,
          inner: centering.inner,
          leftRight: centering.lr,
          topBottom: centering.tb,
          subgrade: centering.subgrade,
        });
      }

      const deskewNote = Math.abs(deskewDeg) > 0.1 ? `, deskew ${deskewDeg.toFixed(1)}°` : "";
      toast({
        title:
          mode === "full" && centering
            ? `${side}: cropped + centered ${centering.lr} / ${centering.tb} → grade ${centering.subgrade}${deskewNote}`
            : `${side}: cropped${deskewNote}`,
      });
      onDone();
    } catch (e: any) {
      toast({ title: "Card tool failed", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  // Live preview geometry (only meaningful once outer is placed).
  const previewCrop = outerReady ? cropBoxForOuter(ptsToQuad(outerPts), CROP_MARGIN_PCT) : null;
  const outerCentroid = outerReady ? centroid(outerPts) : null;
  const previewCentering =
    mode === "full" && outerReady && innerReady
      ? computeCardTool(
          "full",
          ptsToQuad(outerPts),
          ptsToQuad(innerPts),
          side,
          rotation,
          CROP_MARGIN_PCT,
          imgDims.w,
          imgDims.h
        ).centering
      : null;

  const nextLabel = CORNER_LABELS[activeArr.length] ?? "";
  const instruction = !outerReady
    ? `Click the 4 OUTER corners (card edge) — next: ${nextLabel}`
    : mode === "full" && !innerReady
      ? `Click the 4 INNER corners (border → artwork) — next: ${nextLabel}`
      : "Ready — drag any dot to fine-tune, then Compute";

  function renderDots(pts: Point[], pass: DotPass, color: string) {
    return pts.map((p, i) => (
      <div
        key={`${pass}-${i}`}
        style={{ position: "absolute", left: `${p.x}%`, top: `${p.y}%`, zIndex: 30, pointerEvents: "auto" }}
      >
        {/* Invisible 44px hit target (Apple HIG / Material min touch size) */}
        <div
          className="cursor-grab active:cursor-grabbing touch-none"
          style={{ width: 44, height: 44, transform: "translate(-50%, -50%)", position: "relative" }}
          onMouseDown={(e) => onDotMouseDown(pass, i, e)}
          onTouchStart={(e) => onDotTouchStart(pass, i, e)}
        >
          {/* Visible crosshair marker — thin "+" with an open centre so the
              exact captured pixel stays visible. Drawn twice: a dark halo
              underlay for contrast on light cards, the coloured reticle on top
              for contrast on dark cards. No solid fill; hit area unchanged. */}
          <svg
            className="absolute inset-0 pointer-events-none"
            width={44}
            height={44}
            viewBox="0 0 44 44"
            aria-hidden="true"
          >
            <g fill="none" strokeLinecap="round">
              <g stroke="rgba(0,0,0,0.5)" strokeWidth={2.5}>
                <line x1={22} y1={12} x2={22} y2={18} />
                <line x1={22} y1={26} x2={22} y2={32} />
                <line x1={12} y1={22} x2={18} y2={22} />
                <line x1={26} y1={22} x2={32} y2={22} />
                <circle cx={22} cy={22} r={3} />
              </g>
              <g stroke={color} strokeWidth={1.25}>
                <line x1={22} y1={12} x2={22} y2={18} />
                <line x1={22} y1={26} x2={22} y2={32} />
                <line x1={12} y1={22} x2={18} y2={22} />
                <line x1={26} y1={22} x2={32} y2={22} />
                <circle cx={22} cy={22} r={3} />
              </g>
            </g>
          </svg>
          <span
            className="absolute -top-3 left-1/2 -translate-x-1/2 text-[8px] font-bold pointer-events-none select-none"
            style={{ color }}
          >
            {CORNER_LABELS[i]}
          </span>
        </div>
      </div>
    ));
  }

  return (
    <div className="fixed inset-0 z-[100] bg-[#F7F7F5] flex flex-col select-none">
      {/* Top bar */}
      <div className="flex-shrink-0 px-2 py-1.5 sm:px-4 sm:py-3 flex items-center justify-between border-b border-[#D4D0C8]">
        <div>
          <p className="text-[#D4AF37] text-xs font-bold uppercase tracking-widest flex items-center gap-2">
            <Crop size={14} /> Card Tool — {side}
          </p>
          <p className="text-[#555555] text-[10px]">{instruction}</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Mode toggle */}
          <div className="flex rounded-lg overflow-hidden border border-[#D4D0C8] text-[10px] font-bold uppercase">
            <button
              type="button"
              onClick={() => setModeSafe("full")}
              className={`px-2 py-1 ${mode === "full" ? "bg-[#D4AF37] text-[#1A1400]" : "text-[#555555] hover:bg-[#E8E4DC]"}`}
            >
              8-Dot
            </button>
            <button
              type="button"
              onClick={() => setModeSafe("outer-only")}
              className={`px-2 py-1 ${mode === "outer-only" ? "bg-[#D4AF37] text-[#1A1400]" : "text-[#555555] hover:bg-[#E8E4DC]"}`}
            >
              Outer-only
            </button>
          </div>
          <button type="button" onClick={onCancel} className="text-[#555555] hover:text-[#1A1A1A] p-1">
            <X size={20} />
          </button>
        </div>
      </div>

      {/* Image area */}
      <div className="flex-1 flex items-center justify-center p-0 sm:p-4 min-h-0 overflow-auto">
        <div className="relative max-h-[90vh] sm:max-h-[85vh] max-w-[100vw]">
          {/* Capture container — shrink-wraps the natural-aspect image, so its
              box == the visible card. Dots are absolute children (same box). */}
          <div
            ref={containerRef}
            className="relative rounded-lg bg-[#F7F7F5]"
            onMouseDown={onContainerMouseDown}
            onTouchStart={onContainerTouchStart}
          >
            <img
              src={rawImageUrl}
              alt={`${side} raw`}
              className="block max-h-[88vh] sm:max-h-[80vh] max-w-[100vw] w-auto cursor-crosshair"
              draggable={false}
              onLoad={(e) => setImgDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            />

            {/* Non-interactive overlay: crop box, quads, crosshair. preserve-
                AspectRatio="none" is safe here — pointer-events:none, never
                hit-tested. */}
            <svg
              className="absolute inset-0 w-full h-full"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              style={{ pointerEvents: "none", zIndex: 10 }}
            >
              {/* Crop box preview (outer bbox + margin) */}
              {previewCrop && (
                <rect
                  x={previewCrop.left_pct}
                  y={previewCrop.top_pct}
                  width={previewCrop.width_pct}
                  height={previewCrop.height_pct}
                  fill="none"
                  stroke="#1A1A1A"
                  strokeWidth="0.25"
                  strokeDasharray="1,0.8"
                  opacity="0.4"
                />
              )}
              {/* Outer quad */}
              {outerPts.length >= 2 &&
                (outerReady ? (
                  <polygon
                    points={polyPoints(outerPts)}
                    fill="none"
                    stroke={OUTER_COLOR}
                    strokeWidth="0.4"
                    opacity="0.9"
                  />
                ) : (
                  <polyline
                    points={polyPoints(outerPts)}
                    fill="none"
                    stroke={OUTER_COLOR}
                    strokeWidth="0.4"
                    opacity="0.9"
                  />
                ))}
              {/* Inner quad */}
              {mode === "full" &&
                innerPts.length >= 2 &&
                (innerReady ? (
                  <polygon
                    points={polyPoints(innerPts)}
                    fill="none"
                    stroke={INNER_COLOR}
                    strokeWidth="0.4"
                    opacity="0.9"
                  />
                ) : (
                  <polyline
                    points={polyPoints(innerPts)}
                    fill="none"
                    stroke={INNER_COLOR}
                    strokeWidth="0.4"
                    opacity="0.9"
                  />
                ))}
              {/* Crosshair at outer centroid */}
              {outerCentroid && (
                <g stroke="#D4AF37" strokeWidth="0.3" opacity="0.6">
                  <line x1={0} y1={outerCentroid.y} x2={100} y2={outerCentroid.y} />
                  <line x1={outerCentroid.x} y1={0} x2={outerCentroid.x} y2={100} />
                </g>
              )}
            </svg>

            {/* Hit-tested dots — HTML, %-positioned against the SAME box as the
                capture container. Large invisible hit area, small visible dot. */}
            {renderDots(outerPts, "outer", OUTER_COLOR)}
            {mode === "full" && renderDots(innerPts, "inner", INNER_COLOR)}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="flex-shrink-0 px-2 py-1.5 sm:px-4 sm:py-3 border-t border-[#D4D0C8] space-y-1.5 sm:space-y-3">
        {/* Row 1: dot status + clear + live readout */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-mono" style={{ color: OUTER_COLOR }}>
            Outer {outerPts.length}/4
          </span>
          {outerPts.length > 0 && (
            <button
              type="button"
              onClick={clearOuter}
              className="text-[10px] text-[#555555] hover:text-[#D4AF37] underline"
            >
              clear
            </button>
          )}
          {mode === "full" && (
            <>
              <span className="text-xs font-mono ml-2" style={{ color: INNER_COLOR }}>
                Inner {innerPts.length}/4
              </span>
              {innerPts.length > 0 && (
                <button
                  type="button"
                  onClick={clearInner}
                  className="text-[10px] text-[#555555] hover:text-[#16A34A] underline"
                >
                  clear
                </button>
              )}
            </>
          )}
          <div className="flex-1" />
          {previewCentering && (
            <span className="text-xs font-mono text-[#333333]">
              {previewCentering.lr} L/R &middot; {previewCentering.tb} T/B →{" "}
              <span
                className={`font-black ${previewCentering.subgrade >= 9 ? "text-[#D4AF37]" : previewCentering.subgrade >= 7 ? "text-[#16A34A]" : "text-[#D97706]"}`}
              >
                {previewCentering.subgrade}
              </span>
            </span>
          )}
        </div>

        {/* Row 2: deskew override */}
        <div className="flex items-center gap-2 text-xs">
          <span className="text-[#555555]">Deskew override</span>
          <input
            type="range"
            min="-5"
            max="5"
            step="0.25"
            value={rotation}
            onChange={(e) => setRotation(Number(e.target.value))}
            className="flex-1 max-w-[200px] accent-[#D4AF37]"
          />
          <span className="text-[#D4AF37] font-mono w-14 text-right">{rotation.toFixed(2)}°</span>
          <span className="text-[#999999] text-[10px]">{rotation === 0 ? "(auto from dots)" : "(manual)"}</span>
          {rotation !== 0 && (
            <button
              type="button"
              onClick={() => setRotation(0)}
              className="text-[10px] text-[#555555] hover:text-[#D4AF37] underline"
            >
              auto
            </button>
          )}
        </div>

        {/* Row 3: cancel + compute */}
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={onCancel}
            className="border border-[#D4D0C8] text-[#555555] text-xs px-3 py-1.5 sm:px-4 sm:py-2 rounded-lg hover:bg-[#E8E4DC]"
          >
            Cancel <span className="text-[#555555] text-[9px]">Esc</span>
          </button>
          <button
            type="button"
            onClick={handleCompute}
            disabled={saving || !canCompute}
            className="flex items-center gap-2 bg-gradient-to-r from-[#D4AF37] to-[#B8960C] text-[#1A1400] text-xs font-bold uppercase px-6 py-2.5 rounded-lg hover:opacity-90 disabled:opacity-40"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
            {saving ? "Applying..." : mode === "full" ? "Compute crop + centering" : "Compute crop"}
            <span className="text-[#1A1400]/50 text-[9px] normal-case">↵</span>
          </button>
        </div>
      </div>
    </div>
  );
}
