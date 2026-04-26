import { useState, useRef, useEffect } from "react";
import { Loader2, Crop, X, RotateCcw, Crosshair } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface Props {
  side: "front" | "back";
  certId: number;
  rawImageUrl: string;
  onDone: () => void;
  onCancel: () => void;
}

interface Point { x: number; y: number; }
interface CropQuad { tl: Point; tr: Point; br: Point; bl: Point; }

const CORNER_KEYS: (keyof CropQuad)[] = ["tl", "tr", "br", "bl"];
const DEFAULT_QUAD: CropQuad = {
  tl: { x: 5, y: 5 },
  tr: { x: 95, y: 5 },
  br: { x: 95, y: 95 },
  bl: { x: 5, y: 95 },
};

function clamp(v: number, min = 0, max = 100) { return Math.max(min, Math.min(max, v)); }

/** Compute bounding box of quad for backend crop */
function quadBounds(q: CropQuad) {
  const xs = [q.tl.x, q.tr.x, q.br.x, q.bl.x];
  const ys = [q.tl.y, q.tr.y, q.br.y, q.bl.y];
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);
  return { left_pct: left, top_pct: top, width_pct: right - left, height_pct: bottom - top };
}

/** Compute rotation angle from the top edge of the quad (TL → TR) */
function quadRotation(q: CropQuad): number {
  const dx = q.tr.x - q.tl.x;
  const dy = q.tr.y - q.tl.y;
  return Math.atan2(dy, dx) * (180 / Math.PI);
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
    const xi = pts[i].x, yi = pts[i].y;
    const xj = pts[j].x, yj = pts[j].y;
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

const CORNER_LABELS: Record<keyof CropQuad, string> = { tl: "TL", tr: "TR", br: "BR", bl: "BL" };

export default function ManualCrop({ side, certId, rawImageUrl, onDone, onCancel }: Props) {
  const [quad, setQuad] = useState<CropQuad>({ ...DEFAULT_QUAD });
  const [rotation, setRotation] = useState(0);
  const [saving, setSaving] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [drag, setDrag] = useState<null | { type: "corner" | "body"; corner?: keyof CropQuad; startMouse: Point; startQuad: CropQuad }>(null);
  const containerRef = useRef<HTMLDivElement>(null);
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
    e.stopPropagation();
    e.preventDefault();
    setDrag({ type: "corner", corner, startMouse: { x: e.clientX, y: e.clientY }, startQuad: { ...quad, tl: { ...quad.tl }, tr: { ...quad.tr }, br: { ...quad.br }, bl: { ...quad.bl } } });
  }

  function startBodyDrag(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    // Only start body drag if click is inside the quad
    const pt = toPct(e);
    if (!pt || !pointInQuad(pt.x, pt.y, quad)) return;
    setDrag({ type: "body", startMouse: { x: e.clientX, y: e.clientY }, startQuad: { ...quad, tl: { ...quad.tl }, tr: { ...quad.tr }, br: { ...quad.br }, bl: { ...quad.bl } } });
  }

  useEffect(() => {
    if (!drag) return;
    function onMove(e: MouseEvent) {
      const cw = containerRef.current?.clientWidth || 1;
      const ch = containerRef.current?.clientHeight || 1;
      const dx = ((e.clientX - drag!.startMouse.x) / cw) * 100;
      const dy = ((e.clientY - drag!.startMouse.y) / ch) * 100;
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
    function onUp() { setDrag(null); }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [drag]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "Escape") onCancel();
      else if (e.key === "Enter") handleApply();
      else if (e.key === "r" || e.key === "R") { setQuad({ tl: { x: 0, y: 0 }, tr: { x: 100, y: 0 }, br: { x: 100, y: 100 }, bl: { x: 0, y: 100 } }); setRotation(0); }
      else if (e.key === "a" || e.key === "A") handleAutoDetect();
      else if (e.key === "0") setRotation(0);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quad, rotation]);

  async function handleApply() {
    setSaving(true);
    try {
      // Compute bounding box + rotation from quad for the backend
      const bounds = quadBounds(quad);
      const autoRotation = rotation || quadRotation(quad);
      // Only apply quad-derived rotation if slider is at zero AND quad is visibly skewed
      const effectiveRotation = Math.abs(rotation) > 0.1 ? rotation : (Math.abs(autoRotation) > 0.3 ? autoRotation : 0);

      const r = await fetch(`/api/admin/certificates/${certId}/recrop`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          side,
          left_pct: bounds.left_pct,
          top_pct: bounds.top_pct,
          width_pct: bounds.width_pct,
          height_pct: bounds.height_pct,
          rotation_deg: effectiveRotation,
          quad: { tl: quad.tl, tr: quad.tr, br: quad.br, bl: quad.bl },
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Recrop failed");
      toast({ title: `${side} image cropped${Math.abs(effectiveRotation) > 0.1 ? ` and rotated ${effectiveRotation.toFixed(1)}\u00B0` : ""}, variants regenerated` });
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
      const r = await fetch(`/api/admin/certificates/${certId}/detect-card-bounds`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ side }),
      });
      const j = await r.json();
      if (j.ok && j.bounds) {
        const { left_pct: l, top_pct: t, width_pct: w, height_pct: h } = j.bounds;
        setQuad({
          tl: { x: l, y: t },
          tr: { x: l + w, y: t },
          br: { x: l + w, y: t + h },
          bl: { x: l, y: t + h },
        });
        toast({ title: "Card detected \u2014 quad fitted to edges" });
      } else {
        toast({ title: "Auto-detect failed", description: j.message || "Drag corners manually", variant: "destructive" });
      }
    } catch (e: any) {
      toast({ title: "Auto-detect error", description: e.message, variant: "destructive" });
    } finally {
      setDetecting(false);
    }
  }

  const bounds = quadBounds(quad);
  const derivedAngle = quadRotation(quad);

  return (
    <div className="fixed inset-0 z-[100] bg-[#F7F7F5]/95 flex flex-col select-none">
      {/* Top bar */}
      <div className="flex-shrink-0 px-4 py-3 flex items-center justify-between border-b border-[#D4D0C8]">
        <div>
          <p className="text-[#D4AF37] text-xs font-bold uppercase tracking-widest flex items-center gap-2">
            <Crop size={14} /> Perspective Crop \u2014 {side}
          </p>
          <p className="text-[#555555] text-[10px]">Drag each corner independently to match the card edges. Drag inside to move all corners. Esc to cancel.</p>
        </div>
        <button type="button" onClick={onCancel} className="text-[#555555] hover:text-[#1A1A1A] p-1"><X size={20} /></button>
      </div>

      {/* Image area */}
      <div className="flex-1 flex items-center justify-center p-4 min-h-0 overflow-auto">
        <div className="relative" style={{ maxHeight: "80vh", maxWidth: "90vw" }}>
          <div style={{ transform: `rotate(${rotation}deg)`, transformOrigin: "center center", transition: drag ? "none" : "transform 0.2s ease" }}>
            {/* Image + overlay container — NO overflow-hidden so handles aren't clipped */}
            <div ref={containerRef} className="relative rounded-lg bg-[#F7F7F5]"
              onMouseDown={startBodyDrag}>
              <img src={rawImageUrl} alt={`${side} raw`} className="block max-h-[75vh] w-auto" draggable={false} />

              {/* Layer 1: SVG overlay — dark mask + edge lines — NO pointer events */}
              <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none"
                style={{ pointerEvents: "none", zIndex: 10 }}>
                <defs>
                  <mask id="quadMask">
                    <rect width="100" height="100" fill="white" />
                    <polygon points={polyPoints(quad)} fill="black" />
                  </mask>
                </defs>
                <rect width="100" height="100" fill="black" fillOpacity="0.55" mask="url(#quadMask)" />
                <polygon points={polyPoints(quad)} fill="none" stroke="#D4AF37" strokeWidth="0.4" opacity="0.9" />
              </svg>
            </div>

            {/* Layer 2: Corner handles — OUTSIDE the container div, positioned relative to it */}
            {/* Uses the same parent (rotation wrapper) so coordinates align with the image */}
            {CORNER_KEYS.map(k => {
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
                  {/* Invisible 32px hit area for easy grabbing */}
                  <div
                    className="cursor-grab active:cursor-grabbing"
                    style={{ width: 32, height: 32, transform: "translate(-50%, -50%)", position: "relative" }}
                    onMouseDown={(e) => startCornerDrag(k, e)}
                  >
                    {/* Visible 16px handle centered inside */}
                    <div className="absolute bg-[#D4AF37] border-2 border-white rounded-sm shadow-lg hover:scale-125 transition-transform"
                      style={{ inset: 8, pointerEvents: "none" }} />
                    {/* Label */}
                    <span className="absolute -top-3 left-1/2 -translate-x-1/2 text-[8px] text-[#D4AF37] font-bold pointer-events-none select-none">
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
      <div className="flex-shrink-0 px-4 py-3 border-t border-[#D4D0C8] space-y-3">
        {/* Row 1: Quick actions */}
        <div className="flex items-center gap-2">
          <button type="button" onClick={handleAutoDetect} disabled={detecting}
            className="flex items-center gap-1.5 text-[#D4AF37] text-xs border border-[#D4AF37]/30 px-3 py-1.5 rounded-lg hover:bg-[#D4AF37]/10 disabled:opacity-50 transition-colors">
            {detecting ? <Loader2 size={12} className="animate-spin" /> : <Crosshair size={12} />}
            {detecting ? "Detecting..." : "Auto-Detect"} <span className="text-[#555555] text-[9px]">A</span>
          </button>
          <button type="button" onClick={() => { setQuad({ tl: { x: 0, y: 0 }, tr: { x: 100, y: 0 }, br: { x: 100, y: 100 }, bl: { x: 0, y: 100 } }); setRotation(0); }}
            className="flex items-center gap-1 text-[#555555] text-xs border border-[#D4D0C8] px-3 py-1.5 rounded-lg hover:bg-[#E8E4DC] transition-colors">
            <RotateCcw size={12} /> Reset <span className="text-[#555555] text-[9px]">R</span>
          </button>
          <div className="flex-1" />
          <span className="text-[#555555] text-xs font-mono">{Math.round(bounds.width_pct)}% \u00D7 {Math.round(bounds.height_pct)}%</span>
          {Math.abs(derivedAngle) > 0.3 && <span className="text-[#D4AF37]/60 text-xs font-mono">skew {derivedAngle.toFixed(1)}\u00B0</span>}
        </div>

        {/* Row 2: Rotation slider */}
        <div className="flex items-center gap-2 text-xs">
          <span className="text-[#555555]">Rotate</span>
          <input type="range" min="-15" max="15" step="0.5" value={rotation}
            onChange={(e) => setRotation(Number(e.target.value))}
            className="flex-1 max-w-[200px] accent-[#D4AF37]" />
          <span className="text-[#D4AF37] font-mono w-14 text-right">{rotation.toFixed(1)}\u00B0</span>
          {Math.abs(rotation) > 0.1 && (
            <button type="button" onClick={() => setRotation(0)} className="text-[10px] text-[#555555] hover:text-[#D4AF37] underline">Zero <span className="text-[#555555]">0</span></button>
          )}
        </div>

        {/* Row 3: Cancel + Apply */}
        <div className="flex items-center justify-between">
          <button type="button" onClick={onCancel} className="border border-[#D4D0C8] text-[#555555] text-xs px-4 py-2 rounded-lg hover:bg-[#E8E4DC]">
            Cancel <span className="text-[#555555] text-[9px]">Esc</span>
          </button>
          <button type="button" onClick={handleApply} disabled={saving}
            className="flex items-center gap-2 bg-gradient-to-r from-[#D4AF37] to-[#B8960C] text-[#1A1400] text-xs font-bold uppercase px-6 py-2.5 rounded-lg hover:opacity-90 disabled:opacity-50">
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Crop size={13} />}
            {saving ? "Cropping..." : "Apply Crop"} <span className="text-[#1A1400]/50 text-[9px] normal-case">\u21B5</span>
          </button>
        </div>
      </div>
    </div>
  );
}
