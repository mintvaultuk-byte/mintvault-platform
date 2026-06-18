import { useState, useRef, useEffect } from "react";
import { Loader2, Crop, X, RotateCcw, Crosshair } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { quadBounds, quadRotation, resolveDeskew, type Point, type CropQuad } from "./crop-geometry";
import { detectCardBounds, boundsToQuad } from "./crop-tools";

interface Props {
  side: "front" | "back";
  certId: number;
  rawImageUrl: string;
  onDone: () => void;
  onCancel: () => void;
  /** API base for cert endpoints: '/api/admin' (default) or '/api/grader'. */
  apiBase?: string;
  /** Panel-owned background crop upload (same per-side cropSync lifecycle the
   *  8-dot card tool uses). When provided, Apply fires this in the background
   *  and closes INSTANTLY instead of awaiting /recrop — the panel tracks the
   *  upload per side, retries on failure, and blocks approval until it lands.
   *  Absent → the legacy synchronous (await /recrop) path. */
  onStartCropUpload?: (payload: {
    side: "front" | "back";
    left_pct: number;
    top_pct: number;
    width_pct: number;
    height_pct: number;
    rotation_deg: number;
    quad: { tl: Point; tr: Point; br: Point; bl: Point };
  }) => Promise<string | undefined>;
}

const CORNER_KEYS: (keyof CropQuad)[] = ["tl", "tr", "br", "bl"];
const DEFAULT_QUAD: CropQuad = {
  tl: { x: 5, y: 5 },
  tr: { x: 95, y: 5 },
  br: { x: 95, y: 95 },
  bl: { x: 5, y: 95 },
};

function clamp(v: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, v));
}

/** SVG polygon points string */
function polyPoints(q: CropQuad): string {
  return `${q.tl.x},${q.tl.y} ${q.tr.x},${q.tr.y} ${q.br.x},${q.br.y} ${q.bl.x},${q.bl.y}`;
}

/** Check if a point is inside the quad (ray casting) */
function pointInQuad(px: number, py: number, q: CropQuad): boolean {
  const pts = [q.tl, q.tr, q.br, q.bl];
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const xi = pts[i].x,
      yi = pts[i].y;
    const xj = pts[j].x,
      yj = pts[j].y;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

const CORNER_LABELS: Record<keyof CropQuad, string> = { tl: "TL", tr: "TR", br: "BR", bl: "BL" };

export default function ManualCrop({
  side,
  certId,
  rawImageUrl,
  onDone,
  onCancel,
  onStartCropUpload,
  apiBase = "/api/admin",
}: Props) {
  const [quad, setQuad] = useState<CropQuad>({ ...DEFAULT_QUAD });
  const [rotation, setRotation] = useState(0);
  // Natural pixel dimensions of the raw image, captured on load. Needed so the
  // deskew angle (quadRotation) is computed in pixel space rather than on
  // aspect-distorted percentages. 0 until the image loads (square fallback).
  const [imgDims, setImgDims] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [saving, setSaving] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [drag, setDrag] = useState<null | {
    type: "corner" | "body";
    corner?: keyof CropQuad;
    startMouse: Point;
    startQuad: CropQuad;
  }>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastTouchAtRef = useRef<number>(0);
  const { toast } = useToast();

  function toPct(e: MouseEvent | React.MouseEvent): Point | null {
    const el = containerRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: clamp(((e.clientX - r.left) / r.width) * 100),
      y: clamp(((e.clientY - r.top) / r.height) * 100),
    };
  }

  function startCornerDrag(corner: keyof CropQuad, e: React.MouseEvent) {
    // Ignore synthetic mouse events fired ~300-500ms after touchstart on iOS Safari
    if (Date.now() - lastTouchAtRef.current < 500) return;
    e.stopPropagation();
    e.preventDefault();
    setDrag({
      type: "corner",
      corner,
      startMouse: { x: e.clientX, y: e.clientY },
      startQuad: { ...quad, tl: { ...quad.tl }, tr: { ...quad.tr }, br: { ...quad.br }, bl: { ...quad.bl } },
    });
  }

  function startCornerTouch(corner: keyof CropQuad, e: React.TouchEvent) {
    e.stopPropagation();
    lastTouchAtRef.current = Date.now();
    const t = e.touches[0];
    if (!t) return;
    setDrag({
      type: "corner",
      corner,
      startMouse: { x: t.clientX, y: t.clientY },
      startQuad: { ...quad, tl: { ...quad.tl }, tr: { ...quad.tr }, br: { ...quad.br }, bl: { ...quad.bl } },
    });
  }

  function startBodyDrag(e: React.MouseEvent) {
    if (Date.now() - lastTouchAtRef.current < 500) return;
    e.stopPropagation();
    e.preventDefault();
    // Only start body drag if click is inside the quad
    const pt = toPct(e);
    if (!pt || !pointInQuad(pt.x, pt.y, quad)) return;
    setDrag({
      type: "body",
      startMouse: { x: e.clientX, y: e.clientY },
      startQuad: { ...quad, tl: { ...quad.tl }, tr: { ...quad.tr }, br: { ...quad.br }, bl: { ...quad.bl } },
    });
  }

  function startBodyTouch(e: React.TouchEvent) {
    lastTouchAtRef.current = Date.now();
    const t = e.touches[0];
    if (!t) return;
    const el = containerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const px = clamp(((t.clientX - r.left) / r.width) * 100);
    const py = clamp(((t.clientY - r.top) / r.height) * 100);
    if (!pointInQuad(px, py, quad)) return;
    setDrag({
      type: "body",
      startMouse: { x: t.clientX, y: t.clientY },
      startQuad: { ...quad, tl: { ...quad.tl }, tr: { ...quad.tr }, br: { ...quad.br }, bl: { ...quad.bl } },
    });
  }

  useEffect(() => {
    if (!drag) return;
    function applyDelta(clientX: number, clientY: number) {
      const cw = containerRef.current?.clientWidth || 1;
      const ch = containerRef.current?.clientHeight || 1;
      const dx = ((clientX - drag!.startMouse.x) / cw) * 100;
      const dy = ((clientY - drag!.startMouse.y) / ch) * 100;
      const sq = drag!.startQuad;

      if (drag!.type === "corner" && drag!.corner) {
        // Move only this corner
        const c = drag!.corner;
        const newQuad = { ...sq, tl: { ...sq.tl }, tr: { ...sq.tr }, br: { ...sq.br }, bl: { ...sq.bl } };
        newQuad[c] = { x: clamp(sq[c].x + dx), y: clamp(sq[c].y + dy) };
        setQuad(newQuad);
      } else {
        // Move all corners together
        const newQuad: CropQuad = { tl: { x: 0, y: 0 }, tr: { x: 0, y: 0 }, br: { x: 0, y: 0 }, bl: { x: 0, y: 0 } };
        for (const k of CORNER_KEYS) {
          newQuad[k] = { x: clamp(sq[k].x + dx), y: clamp(sq[k].y + dy) };
        }
        setQuad(newQuad);
      }
    }
    function onMove(e: MouseEvent) {
      applyDelta(e.clientX, e.clientY);
    }
    function onTouchMove(e: TouchEvent) {
      if (e.touches.length === 0) return;
      // Suppress page scroll / pinch-zoom while we own a drag
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
      else if (e.key === "Enter") handleApply();
      else if (e.key === "r" || e.key === "R") {
        setQuad({ tl: { x: 0, y: 0 }, tr: { x: 100, y: 0 }, br: { x: 100, y: 100 }, bl: { x: 0, y: 100 } });
        setRotation(0);
      } else if (e.key === "a" || e.key === "A") handleAutoDetect();
      else if (e.key === "0") setRotation(0);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line
  }, [quad, rotation]);

  async function handleApply() {
    // Compute bounding box + rotation from quad for the backend
    const bounds = quadBounds(quad);
    // Slider override wins; else the quad's top-edge tilt straightens the card.
    // resolveDeskew is the ONE shared slider→auto→zero rule (crop-geometry.ts).
    const effectiveRotation = resolveDeskew(quadRotation(quad, imgDims.w, imgDims.h), rotation);

    const payload = {
      side,
      left_pct: bounds.left_pct,
      top_pct: bounds.top_pct,
      width_pct: bounds.width_pct,
      height_pct: bounds.height_pct,
      rotation_deg: effectiveRotation,
      quad: { tl: quad.tl, tr: quad.tr, br: quad.br, bl: quad.bl },
    };

    // ── OPTIMISTIC PATH ────────────────────────────────────────────────────
    // Panel owns the upload: fire it in the background and close INSTANTLY. The
    // panel's per-side cropSync tracks/retries it and blocks approval until it
    // lands; the viewer refreshes to the new crop when the upload completes.
    if (onStartCropUpload) {
      onStartCropUpload(payload); // non-awaited — runs in the background
      toast({
        title: `${side} crop applied — saving in the background`,
        description: "You can keep working; approval waits until the crop is saved.",
      });
      onDone();
      return;
    }

    // ── LEGACY SYNCHRONOUS PATH (no panel upload owner) ─────────────────────
    setSaving(true);
    try {
      const r = await fetch(`${apiBase}/certificates/${certId}/recrop`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Recrop failed");
      toast({
        title: `${side} image cropped${Math.abs(effectiveRotation) > 0.1 ? ` and rotated ${effectiveRotation.toFixed(1)}°` : ""}, variants regenerated`,
      });
      onDone();
    } catch (e: any) {
      toast({ title: "Crop failed", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function handleAutoDetect() {
    setDetecting(true);
    try {
      const bounds = await detectCardBounds(certId, side, apiBase);
      if (bounds) {
        setQuad(boundsToQuad(bounds));
        toast({ title: "Card detected — quad fitted to edges" });
      } else {
        toast({
          title: "Auto-detect failed",
          description: "Drag corners manually",
          variant: "destructive",
        });
      }
    } catch (e: any) {
      toast({ title: "Auto-detect error", description: e.message, variant: "destructive" });
    } finally {
      setDetecting(false);
    }
  }

  const bounds = quadBounds(quad);
  const derivedAngle = quadRotation(quad, imgDims.w, imgDims.h);

  return (
    <div className="fixed inset-0 z-[100] bg-[var(--admin-panel2)] flex flex-col select-none">
      {/* Top bar */}
      <div className="flex-shrink-0 px-2 py-1.5 sm:px-4 sm:py-3 flex items-center justify-between border-b border-[var(--admin-line)]">
        <div>
          <p className="text-[var(--admin-gold)] text-xs font-bold uppercase tracking-widest flex items-center gap-2">
            <Crop size={14} /> Perspective Crop — {side}
          </p>
          <p className="text-[var(--admin-ink-dim)] text-[10px]">
            Drag each corner independently to match the card edges. Drag inside to move all corners. Esc to cancel.
          </p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="text-[var(--admin-ink-dim)] hover:text-[var(--admin-ink)] p-1"
        >
          <X size={20} />
        </button>
      </div>

      {/* Image area */}
      <div className="flex-1 flex items-center justify-center p-0 sm:p-4 min-h-0 overflow-auto">
        <div className="relative max-h-[90vh] sm:max-h-[85vh] max-w-[100vw]">
          <div
            style={{
              transform: `rotate(${rotation}deg)`,
              transformOrigin: "center center",
              transition: drag ? "none" : "transform 0.2s ease",
            }}
          >
            {/* Image + overlay container — NO overflow-hidden so handles aren't clipped */}
            <div
              ref={containerRef}
              className="relative rounded-lg bg-[var(--admin-panel2)]"
              onMouseDown={startBodyDrag}
              onTouchStart={startBodyTouch}
            >
              <img
                src={rawImageUrl}
                alt={`${side} raw`}
                className="block max-h-[88vh] sm:max-h-[80vh] max-w-[100vw] w-auto"
                draggable={false}
                onLoad={(e) => setImgDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
              />

              {/* Layer 1: SVG overlay — dark mask + edge lines — NO pointer events */}
              <svg
                className="absolute inset-0 w-full h-full"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                style={{ pointerEvents: "none", zIndex: 10 }}
              >
                <defs>
                  <mask id="quadMask">
                    <rect width="100" height="100" fill="white" />
                    <polygon points={polyPoints(quad)} fill="black" />
                  </mask>
                </defs>
                <rect width="100" height="100" fill="#1A1A1A" fillOpacity="0.18" mask="url(#quadMask)" />
                <polygon points={polyPoints(quad)} fill="none" stroke="#D4AF37" strokeWidth="0.4" opacity="0.9" />
              </svg>
            </div>

            {/* Layer 2: Corner handles — OUTSIDE the container div, positioned relative to it */}
            {/* Uses the same parent (rotation wrapper) so coordinates align with the image */}
            {CORNER_KEYS.map((k) => {
              // Position relative to containerRef bounds
              const cw = containerRef.current?.clientWidth || 0;
              const ch = containerRef.current?.clientHeight || 0;
              return (
                <div
                  key={k}
                  style={{
                    position: "absolute",
                    left: `${quad[k].x}%`,
                    top: `${quad[k].y}%`,
                    zIndex: 30,
                    pointerEvents: "auto",
                  }}
                >
                  {/* Invisible 44px hit area (Apple HIG / Google MD min touch target) */}
                  <div
                    className="cursor-grab active:cursor-grabbing touch-none"
                    style={{ width: 44, height: 44, transform: "translate(-50%, -50%)", position: "relative" }}
                    onMouseDown={(e) => startCornerDrag(k, e)}
                    onTouchStart={(e) => startCornerTouch(k, e)}
                  >
                    {/* Visible 20px handle centered inside */}
                    <div
                      className="absolute bg-[var(--admin-gold)] border-2 border-[var(--admin-bg)] rounded-sm shadow-lg hover:scale-125 transition-transform"
                      style={{ inset: 12, pointerEvents: "none" }}
                    />
                    {/* Label */}
                    <span className="absolute -top-3 left-1/2 -translate-x-1/2 text-[8px] text-[var(--admin-gold)] font-bold pointer-events-none select-none">
                      {CORNER_LABELS[k]}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Controls below image — always visible, no scrolling */}
      <div className="flex-shrink-0 px-2 py-1.5 sm:px-4 sm:py-3 border-t border-[var(--admin-line)] space-y-1.5 sm:space-y-3">
        {/* Row 1: Quick actions */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleAutoDetect}
            disabled={detecting}
            className="flex items-center gap-1.5 text-[var(--admin-gold)] text-xs border border-[var(--admin-gold)]/30 px-2 py-1 sm:px-3 sm:py-1.5 rounded-lg hover:bg-[var(--admin-gold)]/10 disabled:opacity-50 transition-colors"
          >
            {detecting ? <Loader2 size={12} className="animate-spin" /> : <Crosshair size={12} />}
            {detecting ? "Detecting..." : "Auto-Detect"}{" "}
            <span className="text-[var(--admin-ink-dim)] text-[9px]">A</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setQuad({ tl: { x: 0, y: 0 }, tr: { x: 100, y: 0 }, br: { x: 100, y: 100 }, bl: { x: 0, y: 100 } });
              setRotation(0);
            }}
            className="flex items-center gap-1 text-[var(--admin-ink-dim)] text-xs border border-[var(--admin-line)] px-2 py-1 sm:px-3 sm:py-1.5 rounded-lg hover:bg-[var(--admin-panel3)] transition-colors"
          >
            <RotateCcw size={12} /> Reset <span className="text-[var(--admin-ink-dim)] text-[9px]">R</span>
          </button>
          <div className="flex-1" />
          <span className="text-[var(--admin-ink-dim)] text-xs font-mono">
            {Math.round(bounds.width_pct)}% × {Math.round(bounds.height_pct)}%
          </span>
          {Math.abs(derivedAngle) > 0.3 && (
            <span className="text-[var(--admin-gold)]/60 text-xs font-mono">skew {derivedAngle.toFixed(1)}°</span>
          )}
        </div>

        {/* Row 2: Rotation slider */}
        <div className="flex items-center gap-2 text-xs">
          <span className="text-[var(--admin-ink-dim)]">Rotate</span>
          <input
            type="range"
            min="-15"
            max="15"
            step="0.5"
            value={rotation}
            onChange={(e) => setRotation(Number(e.target.value))}
            className="flex-1 max-w-[200px] accent-[var(--admin-gold)]"
          />
          <span className="text-[var(--admin-gold)] font-mono w-14 text-right">{rotation.toFixed(1)}°</span>
          {Math.abs(rotation) > 0.1 && (
            <button
              type="button"
              onClick={() => setRotation(0)}
              className="text-[10px] text-[var(--admin-ink-dim)] hover:text-[var(--admin-gold)] underline"
            >
              Zero <span className="text-[var(--admin-ink-dim)]">0</span>
            </button>
          )}
        </div>

        {/* Row 3: Cancel + Apply */}
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={onCancel}
            className="border border-[var(--admin-line)] text-[var(--admin-ink-dim)] text-xs px-3 py-1.5 sm:px-4 sm:py-2 rounded-lg hover:bg-[var(--admin-panel3)]"
          >
            Cancel <span className="text-[var(--admin-ink-dim)] text-[9px]">Esc</span>
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={saving}
            className="flex items-center gap-2 bg-gradient-to-r from-[var(--admin-gold)] to-[var(--admin-gold-deep)] text-[#1A1400] text-xs font-bold uppercase px-6 py-2.5 rounded-lg hover:opacity-90 disabled:opacity-50"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Crop size={13} />}
            {saving ? "Cropping..." : "Apply Crop"} <span className="text-[#1A1400]/50 text-[9px] normal-case">↵</span>
          </button>
        </div>
      </div>
    </div>
  );
}
