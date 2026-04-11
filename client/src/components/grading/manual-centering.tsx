import { useState, useRef, useCallback } from "react";
import { X, Save, ZoomIn, ZoomOut, RotateCcw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface Rect { left: number; top: number; right: number; bottom: number; }

interface Props {
  certId: number;
  side: "front" | "back";
  imageUrl: string;
  onSave: (result: CenteringResult) => void;
  onCancel: () => void;
}

export interface CenteringResult {
  side: "front" | "back";
  outer: Rect;
  inner: Rect;
  leftRight: string;
  topBottom: string;
  subgrade: number;
}

const ZOOM_STEPS = [1, 1.5, 2, 3, 4, 6];

function computeCentering(outer: Rect, inner: Rect) {
  const leftB = inner.left - outer.left;
  const rightB = outer.right - inner.right;
  const topB = inner.top - outer.top;
  const bottomB = outer.bottom - inner.bottom;
  const totalH = leftB + rightB;
  const totalV = topB + bottomB;

  const lPct = totalH > 0 ? Math.round((leftB / totalH) * 1000) / 10 : 50;
  const rPct = Math.round((100 - lPct) * 10) / 10;
  const tPct = totalV > 0 ? Math.round((topB / totalV) * 1000) / 10 : 50;
  const bPct = Math.round((100 - tPct) * 10) / 10;

  const worstDev = Math.max(Math.abs(lPct - 50), Math.abs(tPct - 50));
  const subgrade = worstDev <= 2 ? 10 : worstDev <= 5 ? 9 : worstDev <= 10 ? 8 : worstDev <= 15 ? 7 : worstDev <= 20 ? 6 : worstDev <= 35 ? 5 : 4;

  const lr = lPct >= rPct ? `${lPct}/${rPct}` : `${rPct}/${lPct}`;
  const tb = tPct >= bPct ? `${tPct}/${bPct}` : `${bPct}/${tPct}`;

  return { lr, tb, subgrade, lPct, rPct, tPct, bPct };
}

type DragTarget = "none" | "outer-tl" | "outer-tr" | "outer-br" | "outer-bl" | "outer-t" | "outer-r" | "outer-b" | "outer-l" | "outer-body" | "inner-tl" | "inner-tr" | "inner-br" | "inner-bl" | "inner-t" | "inner-r" | "inner-b" | "inner-l" | "inner-body";

export default function ManualCentering({ certId, side, imageUrl, onSave, onCancel }: Props) {
  const { toast } = useToast();
  const [outer, setOuter] = useState<Rect>({ left: 1, top: 1, right: 99, bottom: 99 });
  const [inner, setInner] = useState<Rect>({ left: 5, top: 4, right: 95, bottom: 96 });
  const [zoom, setZoom] = useState(1);
  const [saving, setSaving] = useState(false);
  const [dragTarget, setDragTarget] = useState<DragTarget>("none");
  const [dragStart, setDragStart] = useState({ x: 0, y: 0, rect: { left: 0, top: 0, right: 0, bottom: 0 } });
  const imgRef = useRef<HTMLImageElement>(null);

  const result = computeCentering(outer, inner);

  const toImagePct = useCallback((clientX: number, clientY: number) => {
    if (!imgRef.current) return { x: 50, y: 50 };
    const r = imgRef.current.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100)),
      y: Math.max(0, Math.min(100, ((clientY - r.top) / r.height) * 100)),
    };
  }, []);

  function startDrag(e: React.MouseEvent, target: DragTarget) {
    e.stopPropagation();
    e.preventDefault();
    const pos = toImagePct(e.clientX, e.clientY);
    const rect = target.startsWith("outer") ? outer : inner;
    setDragTarget(target);
    setDragStart({ x: pos.x, y: pos.y, rect: { ...rect } });
  }

  function onMouseMove(e: React.MouseEvent) {
    if (dragTarget === "none") return;
    const pos = toImagePct(e.clientX, e.clientY);
    const dx = pos.x - dragStart.x;
    const dy = pos.y - dragStart.y;
    const s = dragStart.rect;
    const isOuter = dragTarget.startsWith("outer");
    const setRect = isOuter ? setOuter : setInner;

    if (dragTarget.endsWith("-body")) {
      setRect({ left: s.left + dx, top: s.top + dy, right: s.right + dx, bottom: s.bottom + dy });
    } else if (dragTarget.endsWith("-tl")) {
      setRect({ ...s, left: s.left + dx, top: s.top + dy });
    } else if (dragTarget.endsWith("-tr")) {
      setRect({ ...s, right: s.right + dx, top: s.top + dy });
    } else if (dragTarget.endsWith("-br")) {
      setRect({ ...s, right: s.right + dx, bottom: s.bottom + dy });
    } else if (dragTarget.endsWith("-bl")) {
      setRect({ ...s, left: s.left + dx, bottom: s.bottom + dy });
    } else if (dragTarget.endsWith("-t")) {
      setRect({ ...s, top: s.top + dy });
    } else if (dragTarget.endsWith("-b")) {
      setRect({ ...s, bottom: s.bottom + dy });
    } else if (dragTarget.endsWith("-l")) {
      setRect({ ...s, left: s.left + dx });
    } else if (dragTarget.endsWith("-r")) {
      setRect({ ...s, right: s.right + dx });
    }
  }

  function onMouseUp() { setDragTarget("none"); }

  function renderRect(rect: Rect, prefix: "outer" | "inner", color: string, dashed: boolean) {
    const w = rect.right - rect.left;
    const h = rect.bottom - rect.top;
    const handleSize = 1.2; // percentage
    const handles = [
      { id: `${prefix}-tl`, x: rect.left, y: rect.top },
      { id: `${prefix}-tr`, x: rect.right, y: rect.top },
      { id: `${prefix}-br`, x: rect.right, y: rect.bottom },
      { id: `${prefix}-bl`, x: rect.left, y: rect.bottom },
      { id: `${prefix}-t`, x: rect.left + w / 2, y: rect.top },
      { id: `${prefix}-b`, x: rect.left + w / 2, y: rect.bottom },
      { id: `${prefix}-l`, x: rect.left, y: rect.top + h / 2 },
      { id: `${prefix}-r`, x: rect.right, y: rect.top + h / 2 },
    ];

    return (
      <>
        {/* Rectangle border */}
        <rect x={rect.left} y={rect.top} width={w} height={h}
          fill="none" stroke={color} strokeWidth="0.4"
          strokeDasharray={dashed ? "1.5,1" : "none"} opacity="0.9" />
        {/* Invisible body drag area */}
        <rect x={rect.left} y={rect.top} width={w} height={h}
          fill="transparent" cursor="move"
          onMouseDown={(e) => startDrag(e as any, `${prefix}-body` as DragTarget)} />
        {/* Corner + edge handles */}
        {handles.map(h => (
          <circle key={h.id} cx={h.x} cy={h.y} r={handleSize}
            fill={color} stroke="white" strokeWidth="0.2"
            cursor="pointer" opacity="0.9"
            onMouseDown={(e) => startDrag(e as any, h.id as DragTarget)} />
        ))}
      </>
    );
  }

  async function save() {
    setSaving(true);
    try {
      const r = await fetch(`/api/admin/certificates/${certId}/manual-centering`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ side, outer, inner }),
      });
      if (!r.ok) { const d = await r.json(); throw new Error(d.error); }
      onSave({ side, outer, inner, leftRight: result.lr, topBottom: result.tb, subgrade: result.subgrade });
      toast({ title: `${side} centering: ${result.lr} L/R, ${result.tb} T/B → grade ${result.subgrade}` });
    } catch (e: any) {
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  const zoomIn = () => { const i = ZOOM_STEPS.indexOf(zoom); if (i < ZOOM_STEPS.length - 1) setZoom(ZOOM_STEPS[i + 1]); };
  const zoomOut = () => { const i = ZOOM_STEPS.indexOf(zoom); if (i > 0) setZoom(ZOOM_STEPS[i - 1]); };

  return (
    <div className="fixed inset-0 z-50 bg-black/95 flex flex-col select-none"
      onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseUp}>

      {/* Top bar: live stats */}
      <div className="flex-shrink-0 px-4 py-3 flex items-center justify-between border-b border-[#333333]">
        <div className="flex items-center gap-6">
          <div>
            <p className="text-[#D4AF37] text-xs font-bold uppercase tracking-widest">Manual Centering — {side}</p>
            <p className="text-[#888888] text-[10px]">Drag the <span className="text-[#D4AF37]">gold outer</span> rect to card edges, <span className="text-[#16A34A]">green inner</span> rect to border interior</p>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-center">
              <p className="text-[#555555] text-[9px] uppercase">L/R</p>
              <p className="text-white text-lg font-bold font-mono leading-none">{result.lr}</p>
            </div>
            <div className="text-center">
              <p className="text-[#555555] text-[9px] uppercase">T/B</p>
              <p className="text-white text-lg font-bold font-mono leading-none">{result.tb}</p>
            </div>
            <div className="text-center">
              <p className="text-[#555555] text-[9px] uppercase">Grade</p>
              <p className={`text-lg font-black leading-none ${result.subgrade >= 9 ? "text-[#D4AF37]" : result.subgrade >= 7 ? "text-[#16A34A]" : "text-[#D97706]"}`}>{result.subgrade}</p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={zoomOut} disabled={zoom <= 1} className="w-8 h-8 flex items-center justify-center text-white hover:text-[#D4AF37] disabled:text-[#555555]"><ZoomOut size={16} /></button>
          <span className="text-white text-xs font-mono w-10 text-center">{Math.round(zoom * 100)}%</span>
          <button type="button" onClick={zoomIn} disabled={zoom >= 6} className="w-8 h-8 flex items-center justify-center text-white hover:text-[#D4AF37] disabled:text-[#555555]"><ZoomIn size={16} /></button>
          <button type="button" onClick={onCancel} className="ml-4 text-[#888888] hover:text-white"><X size={20} /></button>
        </div>
      </div>

      {/* Image area with rects */}
      <div className="flex-1 flex items-center justify-center p-4 min-h-0">
        <div className="relative w-full h-full max-w-[85vh] overflow-hidden rounded-lg bg-[#0A0A0A]">
          <div className="relative w-full h-full" style={{ transform: zoom > 1 ? `scale(${zoom})` : "none", transition: "transform 0.15s" }}>
            <img ref={imgRef} src={imageUrl} alt={side} className="w-full h-full object-contain" draggable={false} />
            <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none"
              style={{ pointerEvents: dragTarget !== "none" ? "none" : "auto" }}>
              {renderRect(outer, "outer", "#D4AF37", false)}
              {renderRect(inner, "inner", "#16A34A", true)}
              {/* Measurement lines */}
              <line x1={outer.left} y1={(inner.top + inner.bottom) / 2} x2={inner.left} y2={(inner.top + inner.bottom) / 2} stroke="#D4AF37" strokeWidth="0.15" opacity="0.5" />
              <line x1={inner.right} y1={(inner.top + inner.bottom) / 2} x2={outer.right} y2={(inner.top + inner.bottom) / 2} stroke="#D4AF37" strokeWidth="0.15" opacity="0.5" />
              <line x1={(inner.left + inner.right) / 2} y1={outer.top} x2={(inner.left + inner.right) / 2} y2={inner.top} stroke="#D4AF37" strokeWidth="0.15" opacity="0.5" />
              <line x1={(inner.left + inner.right) / 2} y1={inner.bottom} x2={(inner.left + inner.right) / 2} y2={outer.bottom} stroke="#D4AF37" strokeWidth="0.15" opacity="0.5" />
            </svg>
          </div>
        </div>
      </div>

      {/* Bottom toolbar */}
      <div className="flex-shrink-0 px-4 py-3 flex items-center justify-between border-t border-[#333333]">
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => { setOuter({ left: 1, top: 1, right: 99, bottom: 99 }); setInner({ left: 5, top: 4, right: 95, bottom: 96 }); }}
            className="flex items-center gap-1 text-[#888888] hover:text-white text-xs"><RotateCcw size={12} /> Reset</button>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onCancel} className="border border-[#333333] text-[#888888] text-xs px-4 py-2 rounded-lg hover:bg-[#1A1A1A]">Cancel</button>
          <button type="button" onClick={save} disabled={saving}
            className="flex items-center gap-2 bg-gradient-to-r from-[#D4AF37] to-[#B8960C] text-[#1A1400] text-xs font-bold uppercase px-5 py-2 rounded-lg hover:opacity-90 disabled:opacity-50">
            <Save size={13} /> {saving ? "Saving…" : "Save Centering"}
          </button>
        </div>
      </div>
    </div>
  );
}
