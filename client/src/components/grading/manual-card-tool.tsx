import { useState, useRef, useEffect } from "react";
import { Loader2, Crop, X, Check, Undo2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { type Point } from "./crop-geometry";
import {
  computeCardTool,
  ptsToQuad,
  cropBoxForOuter,
  routePlacement,
  nextPass,
  type CardToolMode,
} from "./card-tool-geometry";
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
// Plain-English corner names for the guidance banner (index → name).
const CORNER_NAMES = ["TOP-LEFT", "TOP-RIGHT", "BOTTOM-RIGHT", "BOTTOM-LEFT"] as const;
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

/**
 * Thin two-tone crosshair marker: a dark halo underlay (contrast on light
 * cards) plus a coloured "+" with an open centre and ring (contrast on dark
 * cards). Shared by every placed dot AND the live cursor reticle so they read
 * as one family. No solid fill — the artwork and the exact centre stay visible.
 */
function Crosshair({ color }: { color: string }) {
  return (
    <svg className="absolute inset-0 pointer-events-none" width={44} height={44} viewBox="0 0 44 44" aria-hidden="true">
      <g fill="none" strokeLinecap="round">
        <g stroke="rgba(0,0,0,0.5)" strokeWidth={1.75}>
          <line x1={22} y1={15} x2={22} y2={19} />
          <line x1={22} y1={25} x2={22} y2={29} />
          <line x1={15} y1={22} x2={19} y2={22} />
          <line x1={25} y1={22} x2={29} y2={22} />
          <circle cx={22} cy={22} r={2} />
        </g>
        <g stroke={color} strokeWidth={1}>
          <line x1={22} y1={15} x2={22} y2={19} />
          <line x1={22} y1={25} x2={22} y2={29} />
          <line x1={15} y1={22} x2={19} y2={22} />
          <line x1={25} y1={22} x2={29} y2={22} />
          <circle cx={22} cy={22} r={2} />
        </g>
      </g>
    </svg>
  );
}

/**
 * Mini card-shape map showing WHICH corner is active (so the operator doesn't
 * have to decode TL/TR/BR/BL). The active corner is a large ring in the current
 * pass colour (gold = placing OUTER, green = placing INNER); already-placed
 * corners are solid grey; pending corners are hollow. `activeCorner` is -1 when
 * every point is down. Corner order matches CORNER_LABELS: [TL, TR, BR, BL].
 */
function CornerDiagram({
  activeCorner,
  activePass,
  outerCount,
  innerCount,
  mode,
}: {
  activeCorner: number;
  activePass: DotPass;
  outerCount: number;
  innerCount: number;
  mode: CardToolMode;
}) {
  const CX = [13, 43, 43, 13]; // TL, TR, BR, BL
  const CY = [13, 13, 65, 65];
  const activeColor = activePass === "outer" ? OUTER_COLOR : INNER_COLOR;
  return (
    <svg width={40} height={56} viewBox="0 0 56 78" className="flex-shrink-0" aria-hidden="true">
      {/* Card body + faint inner frame */}
      <rect x={6} y={6} width={44} height={66} rx={4} fill="#F7F7F5" stroke="#C9C5BD" strokeWidth={2} />
      <rect x={14} y={14} width={28} height={50} rx={2} fill="none" stroke="#E2DED6" strokeWidth={1.25} />
      {[0, 1, 2, 3].map((i) => {
        const done = mode === "outer-only" ? i < outerCount : i < innerCount;
        if (i === activeCorner) {
          return (
            <g key={i}>
              <circle cx={CX[i]} cy={CY[i]} r={7} fill="none" stroke={activeColor} strokeWidth={2.5} />
              <circle cx={CX[i]} cy={CY[i]} r={3} fill={activeColor} />
            </g>
          );
        }
        return (
          <circle
            key={i}
            cx={CX[i]}
            cy={CY[i]}
            r={3.5}
            fill={done ? "#9CA3AF" : "none"}
            stroke={done ? "#9CA3AF" : "#C9C5BD"}
            strokeWidth={1.5}
          />
        );
      })}
    </svg>
  );
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
  // Cursor position in % while hovering the image in placement mode; drives the
  // live targeting reticle. Null when not hovering / not placing.
  const [hover, setHover] = useState<Point | null>(null);
  const [drag, setDrag] = useState<null | {
    pass: DotPass;
    index: number;
    startMouse: Point;
    startPts: Point[];
  }>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastTouchAtRef = useRef<number>(0);
  const { toast } = useToast();

  // Corner-by-corner capture: work TL → TR → BR → BL, placing this corner's
  // OUTER then its INNER before moving on. The next click's pass is decided by
  // parity (arrays level → OUTER, outer one ahead → INNER). The arrays still end
  // ordered [TL,TR,BR,BL], so all downstream geometry is unchanged. Once both
  // are full, clicks become near-miss grabs.
  const activePass: DotPass = nextPass(mode, outerPts, innerPts);
  const activeArr = activePass === "outer" ? outerPts : innerPts;
  const outerReady = outerPts.length === 4;
  const innerReady = innerPts.length === 4;
  const canCompute = outerReady && (mode === "outer-only" || innerReady);
  // Still placing points in the active pass → show the cursor reticle + guides.
  const placing = activeArr.length < 4;
  const activeColor = activePass === "outer" ? OUTER_COLOR : INNER_COLOR;
  // Guidance: total points down, target, and the corner index (0..3) we're on.
  const totalPlaced = outerPts.length + innerPts.length;
  const target = mode === "outer-only" ? 4 : 8;
  const activeCorner = mode === "outer-only" ? outerPts.length : Math.floor(totalPlaced / 2);
  // Large step prompt shown in the guidance banner (replaces the old 10px text).
  const bannerText = canCompute
    ? "Ready — drag any dot to fine-tune, then Compute"
    : activePass === "outer"
      ? `Corner ${activeCorner + 1} of 4 — ${CORNER_NAMES[activeCorner]}. Click the OUTER corner (card edge).`
      : `Corner ${activeCorner + 1} of 4 — ${CORNER_NAMES[activeCorner]}. Click the INNER corner (where border meets artwork).`;

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
    // Route by corner-by-corner parity. routePlacement returns the unchanged
    // array by reference, so the matching setState bails out (no extra render).
    const next = routePlacement(mode, outerPts, innerPts, pt);
    setOuterPts(next.outer);
    setInnerPts(next.inner);
  }

  // Per-point undo: pop the most recently placed dot, reversing the capture
  // sequence. Mid-corner (outer ahead of inner) the last point was an OUTER;
  // when the corner is complete (arrays level, >0) the last was an INNER.
  function undoLast() {
    if (mode === "outer-only") {
      if (outerPts.length > 0) setOuterPts(outerPts.slice(0, -1));
      return;
    }
    if (outerPts.length > innerPts.length) setOuterPts(outerPts.slice(0, -1));
    else if (innerPts.length > 0) setInnerPts(innerPts.slice(0, -1));
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

  // Track the cursor for the live targeting reticle — placement mode only,
  // never while dragging. Purely visual (the reticle is pointer-events:none);
  // the capture handlers above are untouched.
  function onContainerMouseMove(e: React.MouseEvent) {
    if (drag || !placing) {
      if (hover) setHover(null);
      return;
    }
    setHover(toPct(e));
  }
  function onContainerMouseLeave() {
    if (hover) setHover(null);
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
      else if ((e.key === "Backspace" || e.key === "Delete") && outerPts.length + innerPts.length > 0) {
        e.preventDefault();
        undoLast();
      }
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
          {/* Visible crosshair marker (shared with the cursor reticle). Thin
              "+" with an open centre so the exact captured pixel stays visible;
              the ~44px hit area above is unchanged. */}
          <Crosshair color={color} />
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
          <p className="text-[#555555] text-[10px]">
            <span style={{ color: OUTER_COLOR }}>●</span> Outer = card edge &middot;{" "}
            <span style={{ color: INNER_COLOR }}>●</span> Inner = border → artwork
          </p>
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

      {/* Guidance banner — corner map + large step prompt + progress + undo.
          Replaces the old 10px instruction so the next action is unmissable. */}
      <div className="flex-shrink-0 px-2 py-2 sm:px-4 sm:py-2.5 border-b border-[#D4D0C8] bg-white flex items-center gap-2 sm:gap-3">
        <CornerDiagram
          activeCorner={canCompute ? -1 : activeCorner}
          activePass={activePass}
          outerCount={outerPts.length}
          innerCount={innerPts.length}
          mode={mode}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {!canCompute && (
              <span
                className="text-[10px] sm:text-xs font-black uppercase tracking-wide px-2 py-0.5 rounded"
                style={{ background: activeColor, color: activePass === "outer" ? "#1A1400" : "#FFFFFF" }}
              >
                {activePass === "outer" ? "Outer" : "Inner"}
              </span>
            )}
            <p className="text-[#1A1A1A] text-sm sm:text-lg font-extrabold leading-tight">{bannerText}</p>
          </div>
          <p className="text-[#777777] text-[11px] sm:text-xs mt-0.5 font-mono">
            {totalPlaced} of {target} points placed
          </p>
        </div>
        <button
          type="button"
          onClick={undoLast}
          disabled={totalPlaced === 0}
          title="Undo last point (Backspace)"
          className="flex-shrink-0 flex items-center gap-1 border border-[#D4D0C8] text-[#555555] text-[11px] sm:text-xs px-2.5 py-1.5 rounded-lg hover:bg-[#E8E4DC] hover:text-[#1A1A1A] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Undo2 size={13} /> Undo
        </button>
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
            onMouseMove={onContainerMouseMove}
            onMouseLeave={onContainerMouseLeave}
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
              {/* Full-length guides through each placed point in the ACTIVE
                  pass — line the next dot up exactly above/below/beside a
                  committed corner. Faint pass-coloured over a dark underlay,
                  true 1px dashes via non-scaling-stroke. The brighter white
                  cursor guides below paint over these. */}
              {placing &&
                activeArr.map((p, i) => (
                  <g key={`pguide-${activePass}-${i}`} strokeDasharray="4,4">
                    <g stroke="rgba(0,0,0,0.3)">
                      <line x1={0} y1={p.y} x2={100} y2={p.y} strokeWidth={1.75} vectorEffect="non-scaling-stroke" />
                      <line x1={p.x} y1={0} x2={p.x} y2={100} strokeWidth={1.75} vectorEffect="non-scaling-stroke" />
                    </g>
                    <g stroke={activeColor} opacity={0.4}>
                      <line x1={0} y1={p.y} x2={100} y2={p.y} strokeWidth={1} vectorEffect="non-scaling-stroke" />
                      <line x1={p.x} y1={0} x2={p.x} y2={100} strokeWidth={1} vectorEffect="non-scaling-stroke" />
                    </g>
                  </g>
                ))}
              {/* Live cursor guide lines (placement mode) — full-span sniper-
                  scope crosshairs through the cursor for edge alignment. White
                  ~0.6 alpha over a thin dark underlay so they read on light and
                  dark cards. non-scaling-stroke → true 1px + uniform dashes on
                  screen despite the preserveAspectRatio="none" stretch. */}
              {placing && hover && !drag && (
                <g strokeDasharray="5,4">
                  {/* Dark underlay so the white guides read on light borders */}
                  <g stroke="rgba(0,0,0,0.4)">
                    <line x1={0} y1={hover.y} x2={100} y2={hover.y} strokeWidth={2} vectorEffect="non-scaling-stroke" />
                    <line x1={hover.x} y1={0} x2={hover.x} y2={100} strokeWidth={2} vectorEffect="non-scaling-stroke" />
                  </g>
                  {/* White full-length guides */}
                  <g stroke="rgba(255,255,255,0.6)">
                    <line x1={0} y1={hover.y} x2={100} y2={hover.y} strokeWidth={1} vectorEffect="non-scaling-stroke" />
                    <line x1={hover.x} y1={0} x2={hover.x} y2={100} strokeWidth={1} vectorEffect="non-scaling-stroke" />
                  </g>
                </g>
              )}
            </svg>

            {/* Hit-tested dots — HTML, %-positioned against the SAME box as the
                capture container. Large invisible hit area, small visible dot. */}
            {renderDots(outerPts, "outer", OUTER_COLOR)}
            {mode === "full" && renderDots(innerPts, "inner", INNER_COLOR)}

            {/* Live targeting reticle — follows the cursor in placement mode,
                centred on where the next dot will land. pointer-events:none so
                clicks fall through to the capture container below. */}
            {placing && hover && !drag && (
              <div
                className="absolute pointer-events-none"
                style={{ left: `${hover.x}%`, top: `${hover.y}%`, zIndex: 25 }}
                aria-hidden="true"
              >
                <div style={{ position: "relative", width: 44, height: 44, transform: "translate(-50%, -50%)" }}>
                  <Crosshair color={activeColor} />
                </div>
              </div>
            )}
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
