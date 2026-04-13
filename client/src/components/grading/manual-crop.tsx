import { useState, useRef, useEffect } from "react";
import { Loader2, Crop, X, RotateCcw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface Props {
  side: "front" | "back";
  certId: number;
  rawImageUrl: string;
  onDone: () => void;
  onCancel: () => void;
}

export default function ManualCrop({ side, certId, rawImageUrl, onDone, onCancel }: Props) {
  const [box, setBox] = useState({ left: 5, top: 5, right: 95, bottom: 95 });
  const [saving, setSaving] = useState(false);
  const [drag, setDrag] = useState<null | { handle: string; startX: number; startY: number; startBox: typeof box }>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  function startDrag(handle: string, e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    setDrag({ handle, startX: e.clientX, startY: e.clientY, startBox: { ...box } });
  }

  useEffect(() => {
    if (!drag) return;
    function onMove(e: MouseEvent) {
      const cw = containerRef.current?.clientWidth || 1;
      const ch = containerRef.current?.clientHeight || 1;
      const dx = ((e.clientX - drag!.startX) / cw) * 100;
      const dy = ((e.clientY - drag!.startY) / ch) * 100;
      const s = drag!.startBox;
      const nb = { ...s };
      const h = drag!.handle;

      if (h.includes("n")) nb.top = Math.max(0, Math.min(nb.bottom - 5, s.top + dy));
      if (h.includes("s")) nb.bottom = Math.min(100, Math.max(nb.top + 5, s.bottom + dy));
      if (h.includes("w")) nb.left = Math.max(0, Math.min(nb.right - 5, s.left + dx));
      if (h.includes("e")) nb.right = Math.min(100, Math.max(nb.left + 5, s.right + dx));
      if (h === "body") {
        const w = s.right - s.left;
        const ht = s.bottom - s.top;
        nb.left = Math.max(0, Math.min(100 - w, s.left + dx));
        nb.right = nb.left + w;
        nb.top = Math.max(0, Math.min(100 - ht, s.top + dy));
        nb.bottom = nb.top + ht;
      }
      setBox(nb);
    }
    function onUp() { setDrag(null); }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [drag]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  async function handleApply() {
    setSaving(true);
    try {
      const r = await fetch(`/api/admin/certificates/${certId}/recrop`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          side,
          left_pct: box.left,
          top_pct: box.top,
          width_pct: box.right - box.left,
          height_pct: box.bottom - box.top,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Recrop failed");
      toast({ title: `${side} image manually cropped and variants regenerated` });
      onDone();
    } catch (e: any) {
      toast({ title: "Crop failed", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  const cropW = box.right - box.left;
  const cropH = box.bottom - box.top;

  const handles = [
    { h: "nw", style: { left: 0, top: 0, cursor: "nwse-resize" } },
    { h: "n", style: { left: "50%", top: 0, marginLeft: -6, cursor: "ns-resize" } },
    { h: "ne", style: { right: 0, top: 0, cursor: "nesw-resize" } },
    { h: "e", style: { right: 0, top: "50%", marginTop: -6, cursor: "ew-resize" } },
    { h: "se", style: { right: 0, bottom: 0, cursor: "nwse-resize" } },
    { h: "s", style: { left: "50%", bottom: 0, marginLeft: -6, cursor: "ns-resize" } },
    { h: "sw", style: { left: 0, bottom: 0, cursor: "nesw-resize" } },
    { h: "w", style: { left: 0, top: "50%", marginTop: -6, cursor: "ew-resize" } },
  ];

  return (
    <div className="fixed inset-0 z-[100] bg-black/95 flex flex-col select-none">
      {/* Top bar */}
      <div className="flex-shrink-0 px-4 py-3 flex items-center justify-between border-b border-[#333333]">
        <div>
          <p className="text-[#D4AF37] text-xs font-bold uppercase tracking-widest flex items-center gap-2">
            <Crop size={14} /> Manual Crop — {side}
          </p>
          <p className="text-[#888888] text-[10px]">Drag corners to fit the actual card edges. Esc to cancel.</p>
        </div>
        <button type="button" onClick={onCancel} className="text-[#888888] hover:text-white p-1"><X size={20} /></button>
      </div>

      {/* Image area */}
      <div className="flex-1 flex items-center justify-center p-4 min-h-0">
        <div ref={containerRef} className="relative max-w-[85vh] w-full overflow-hidden rounded-lg bg-[#0A0A0A]" style={{ aspectRatio: "5/7" }}>
          <img src={rawImageUrl} alt={`${side} raw`} className="w-full h-full object-contain" draggable={false} />

          {/* Dim overlay outside crop via SVG mask */}
          <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
            <defs>
              <mask id="cropMask">
                <rect width="100" height="100" fill="white" />
                <rect x={box.left} y={box.top} width={cropW} height={cropH} fill="black" />
              </mask>
            </defs>
            <rect width="100" height="100" fill="black" fillOpacity="0.6" mask="url(#cropMask)" />
          </svg>

          {/* Crop box */}
          <div
            className="absolute border-2 border-[#D4AF37] cursor-move"
            style={{ left: `${box.left}%`, top: `${box.top}%`, width: `${cropW}%`, height: `${cropH}%` }}
            onMouseDown={(e) => startDrag("body", e)}
          >
            {/* Thirds guidelines */}
            <div className="absolute inset-0 pointer-events-none">
              <div className="absolute left-1/3 top-0 bottom-0 w-px bg-[#D4AF37]/20" />
              <div className="absolute left-2/3 top-0 bottom-0 w-px bg-[#D4AF37]/20" />
              <div className="absolute top-1/3 left-0 right-0 h-px bg-[#D4AF37]/20" />
              <div className="absolute top-2/3 left-0 right-0 h-px bg-[#D4AF37]/20" />
            </div>

            {/* Resize handles */}
            {handles.map(({ h, style }) => (
              <div key={h} className="absolute w-3 h-3 bg-[#D4AF37] border border-black rounded-sm" style={style as any}
                onMouseDown={(e) => startDrag(h, e)} />
            ))}
          </div>
        </div>
      </div>

      {/* Bottom bar */}
      <div className="flex-shrink-0 px-4 py-3 flex items-center justify-between border-t border-[#333333]">
        <div className="flex items-center gap-3">
          <span className="text-[#888888] text-xs font-mono">{Math.round(cropW)}% x {Math.round(cropH)}%</span>
          <button type="button" onClick={() => setBox({ left: 5, top: 5, right: 95, bottom: 95 })}
            className="flex items-center gap-1 text-[#888888] hover:text-white text-xs"><RotateCcw size={12} /> Reset</button>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onCancel} className="border border-[#333333] text-[#888888] text-xs px-4 py-2 rounded-lg hover:bg-[#1A1A1A]">Cancel</button>
          <button type="button" onClick={handleApply} disabled={saving}
            className="flex items-center gap-2 bg-gradient-to-r from-[#D4AF37] to-[#B8960C] text-[#1A1400] text-xs font-bold uppercase px-5 py-2 rounded-lg hover:opacity-90 disabled:opacity-50">
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Crop size={13} />}
            {saving ? "Cropping..." : "Apply Crop"}
          </button>
        </div>
      </div>
    </div>
  );
}
