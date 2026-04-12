import { useState, useRef, useCallback } from "react";
import { X, Save, ZoomIn, ZoomOut, RotateCcw, Crop, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface Rect { left: number; top: number; right: number; bottom: number; }

type DragTarget = "none" | "crop-tl" | "crop-tr" | "crop-br" | "crop-bl" | "crop-t" | "crop-r" | "crop-b" | "crop-l" | "crop-body";

interface Props {
  certId: number;
  side: "front" | "back";
  rawImageUrl: string;
  onDone: () => void;
  onCancel: () => void;
}

const ZOOM_STEPS = [1, 1.5, 2, 3, 4];

export default function ManualCrop({ certId, side, rawImageUrl, onDone, onCancel }: Props) {
  const { toast } = useToast();
  const [crop, setCrop] = useState<Rect>({ left: 5, top: 5, right: 95, bottom: 95 });
  const [zoom, setZoom] = useState(1);
  const [saving, setSaving] = useState(false);
  const [dragTarget, setDragTarget] = useState<DragTarget>("none");
  const [dragStart, setDragStart] = useState({ x: 0, y: 0, rect: { left: 0, top: 0, right: 0, bottom: 0 } });
  const imgRef = useRef<HTMLImageElement>(null);

  const cropW = Math.max(0, crop.right - crop.left);
  const cropH = Math.max(0, crop.bottom - crop.top);

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
    setDragTarget(target);
    setDragStart({ x: pos.x, y: pos.y, rect: { ...crop } });
  }

  function onMouseMove(e: React.MouseEvent) {
    if (dragTarget === "none") return;
    const pos = toImagePct(e.clientX, e.clientY);
    const dx = pos.x - dragStart.x;
    const dy = pos.y - dragStart.y;
    const s = dragStart.rect;

    if (dragTarget === "crop-body") {
      setCrop({ left: s.left + dx, top: s.top + dy, right: s.right + dx, bottom: s.bottom + dy });
    } else if (dragTarget === "crop-tl") {
      setCrop({ ...s, left: s.left + dx, top: s.top + dy });
    } else if (dragTarget === "crop-tr") {
      setCrop({ ...s, right: s.right + dx, top: s.top + dy });
    } else if (dragTarget === "crop-br") {
      setCrop({ ...s, right: s.right + dx, bottom: s.bottom + dy });
    } else if (dragTarget === "crop-bl") {
      setCrop({ ...s, left: s.left + dx, bottom: s.bottom + dy });
    } else if (dragTarget === "crop-t") {
      setCrop({ ...s, top: s.top + dy });
    } else if (dragTarget === "crop-b") {
      setCrop({ ...s, bottom: s.bottom + dy });
    } else if (dragTarget === "crop-l") {
      setCrop({ ...s, left: s.left + dx });
    } else if (dragTarget === "crop-r") {
      setCrop({ ...s, right: s.right + dx });
    }
  }

  function onMouseUp() { setDragTarget("none"); }

  async function applyCrop() {
    if (cropW < 5 || cropH < 5) {
      toast({ title: "Crop box too small", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const r = await fetch(`/api/admin/certificates/${certId}/recrop`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          side,
          left_pct: Math.max(0, crop.left),
          top_pct: Math.max(0, crop.top),
          width_pct: cropW,
          height_pct: cropH,
        }),
      });
      if (!r.ok) { const d = await r.json(); throw new Error(d.error); }
      toast({ title: `${side} image manually cropped and variants regenerated` });
      onDone();
    } catch (e: any) {
      toast({ title: "Crop failed", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  const handleSize = 1.2;
  const handles: { id: DragTarget; x: number; y: number }[] = [
    { id: "crop-tl", x: crop.left, y: crop.top },
    { id: "crop-tr", x: crop.right, y: crop.top },
    { id: "crop-br", x: crop.right, y: crop.bottom },
    { id: "crop-bl", x: crop.left, y: crop.bottom },
    { id: "crop-t", x: crop.left + cropW / 2, y: crop.top },
    { id: "crop-b", x: crop.left + cropW / 2, y: crop.bottom },
    { id: "crop-l", x: crop.left, y: crop.top + cropH / 2 },
    { id: "crop-r", x: crop.right, y: crop.top + cropH / 2 },
  ];

  const zoomIn = () => { const i = ZOOM_STEPS.indexOf(zoom); if (i < ZOOM_STEPS.length - 1) setZoom(ZOOM_STEPS[i + 1]); };
  const zoomOut = () => { const i = ZOOM_STEPS.indexOf(zoom); if (i > 0) setZoom(ZOOM_STEPS[i - 1]); };

  return (
    <div className="fixed inset-0 z-50 bg-black/95 flex flex-col select-none"
      onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseUp}>

      {/* Top bar */}
      <div className="flex-shrink-0 px-4 py-3 flex items-center justify-between border-b border-[#333333]">
        <div className="flex items-center gap-6">
          <div>
            <p className="text-[#D4AF37] text-xs font-bold uppercase tracking-widest flex items-center gap-2">
              <Crop size={14} /> Manual Crop — {side}
            </p>
            <p className="text-[#888888] text-[10px]">Drag corners to fit the actual card edges. Include the entire card but NOT the black mat.</p>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-center">
              <p className="text-[#555555] text-[9px] uppercase">Size</p>
              <p className="text-white text-sm font-bold font-mono leading-none">{cropW.toFixed(0)}% x {cropH.toFixed(0)}%</p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={zoomOut} disabled={zoom <= 1} className="w-8 h-8 flex items-center justify-center text-white hover:text-[#D4AF37] disabled:text-[#555555]"><ZoomOut size={16} /></button>
          <span className="text-white text-xs font-mono w-10 text-center">{Math.round(zoom * 100)}%</span>
          <button type="button" onClick={zoomIn} disabled={zoom >= 4} className="w-8 h-8 flex items-center justify-center text-white hover:text-[#D4AF37] disabled:text-[#555555]"><ZoomIn size={16} /></button>
          <button type="button" onClick={onCancel} className="ml-4 text-[#888888] hover:text-white"><X size={20} /></button>
        </div>
      </div>

      {/* Image area with crop rectangle */}
      <div className="flex-1 flex items-center justify-center p-4 min-h-0">
        <div className="relative w-full h-full max-w-[85vh] overflow-hidden rounded-lg bg-[#0A0A0A]">
          <div className="relative w-full h-full" style={{ transform: zoom > 1 ? `scale(${zoom})` : "none", transition: "transform 0.15s" }}>
            <img ref={imgRef} src={rawImageUrl} alt={`${side} raw`} className="w-full h-full object-contain" draggable={false} />

            {/* Dim overlay outside crop area */}
            <div className="absolute inset-0 pointer-events-none" style={{
              background: `linear-gradient(transparent, transparent)`,
              boxShadow: `
                inset ${crop.left}vw 0 0 0 rgba(0,0,0,0.6),
                inset -${100 - crop.right}vw 0 0 0 rgba(0,0,0,0.6)
              `,
            }} />

            <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none"
              style={{ pointerEvents: dragTarget !== "none" ? "none" : "auto" }}>
              {/* Dim regions outside crop */}
              <rect x="0" y="0" width={crop.left} height="100" fill="rgba(0,0,0,0.55)" />
              <rect x={crop.right} y="0" width={100 - crop.right} height="100" fill="rgba(0,0,0,0.55)" />
              <rect x={crop.left} y="0" width={cropW} height={crop.top} fill="rgba(0,0,0,0.55)" />
              <rect x={crop.left} y={crop.bottom} width={cropW} height={100 - crop.bottom} fill="rgba(0,0,0,0.55)" />

              {/* Crop rectangle */}
              <rect x={crop.left} y={crop.top} width={cropW} height={cropH}
                fill="none" stroke="#D4AF37" strokeWidth="0.5" opacity="0.9" />

              {/* Rule-of-thirds guides */}
              <line x1={crop.left + cropW / 3} y1={crop.top} x2={crop.left + cropW / 3} y2={crop.bottom} stroke="#D4AF37" strokeWidth="0.1" opacity="0.3" />
              <line x1={crop.left + cropW * 2 / 3} y1={crop.top} x2={crop.left + cropW * 2 / 3} y2={crop.bottom} stroke="#D4AF37" strokeWidth="0.1" opacity="0.3" />
              <line x1={crop.left} y1={crop.top + cropH / 3} x2={crop.right} y2={crop.top + cropH / 3} stroke="#D4AF37" strokeWidth="0.1" opacity="0.3" />
              <line x1={crop.left} y1={crop.top + cropH * 2 / 3} x2={crop.right} y2={crop.top + cropH * 2 / 3} stroke="#D4AF37" strokeWidth="0.1" opacity="0.3" />

              {/* Invisible body drag area */}
              <rect x={crop.left} y={crop.top} width={cropW} height={cropH}
                fill="transparent" cursor="move"
                onMouseDown={(e) => startDrag(e as any, "crop-body")} />

              {/* Corner + edge handles */}
              {handles.map(h => (
                <circle key={h.id} cx={h.x} cy={h.y} r={handleSize}
                  fill="#D4AF37" stroke="white" strokeWidth="0.2"
                  cursor="pointer" opacity="0.9"
                  onMouseDown={(e) => startDrag(e as any, h.id)} />
              ))}
            </svg>
          </div>
        </div>
      </div>

      {/* Bottom toolbar */}
      <div className="flex-shrink-0 px-4 py-3 flex items-center justify-between border-t border-[#333333]">
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => setCrop({ left: 5, top: 5, right: 95, bottom: 95 })}
            className="flex items-center gap-1 text-[#888888] hover:text-white text-xs"><RotateCcw size={12} /> Reset</button>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onCancel} className="border border-[#333333] text-[#888888] text-xs px-4 py-2 rounded-lg hover:bg-[#1A1A1A]">Cancel</button>
          <button type="button" onClick={applyCrop} disabled={saving}
            className="flex items-center gap-2 bg-gradient-to-r from-[#D4AF37] to-[#B8960C] text-[#1A1400] text-xs font-bold uppercase px-5 py-2 rounded-lg hover:opacity-90 disabled:opacity-50">
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            {saving ? "Cropping..." : "Apply Crop"}
          </button>
        </div>
      </div>
    </div>
  );
}
