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

interface Box { left: number; top: number; right: number; bottom: number; }

// Minimum crop box size in percent
const MIN_SIZE = 3;

export default function ManualCrop({ side, certId, rawImageUrl, onDone, onCancel }: Props) {
  const [box, setBox] = useState<Box>({ left: 5, top: 5, right: 95, bottom: 95 });
  const [rotation, setRotation] = useState(0);
  const [saving, setSaving] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [drag, setDrag] = useState<null | { handle: string; startX: number; startY: number; startBox: Box }>(null);
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
      const h = drag!.handle;

      if (h === "body") {
        // Move entire box without resizing
        const w = s.right - s.left;
        const ht = s.bottom - s.top;
        const newLeft = Math.max(0, Math.min(100 - w, s.left + dx));
        const newTop = Math.max(0, Math.min(100 - ht, s.top + dy));
        setBox({ left: newLeft, top: newTop, right: newLeft + w, bottom: newTop + ht });
        return;
      }

      // Start from the original start box for all calculations
      let newLeft = s.left;
      let newTop = s.top;
      let newRight = s.right;
      let newBottom = s.bottom;

      // Apply dx to left or right edge based on handle
      if (h.includes("w")) newLeft = s.left + dx;
      if (h.includes("e")) newRight = s.right + dx;
      if (h.includes("n")) newTop = s.top + dy;
      if (h.includes("s")) newBottom = s.bottom + dy;

      // Clamp to image bounds [0, 100]
      newLeft = Math.max(0, newLeft);
      newTop = Math.max(0, newTop);
      newRight = Math.min(100, newRight);
      newBottom = Math.min(100, newBottom);

      // Enforce minimum size — don't let edges cross
      if (newRight - newLeft < MIN_SIZE) {
        if (h.includes("w")) newLeft = newRight - MIN_SIZE;
        else newRight = newLeft + MIN_SIZE;
      }
      if (newBottom - newTop < MIN_SIZE) {
        if (h.includes("n")) newTop = newBottom - MIN_SIZE;
        else newBottom = newTop + MIN_SIZE;
      }

      setBox({ left: newLeft, top: newTop, right: newRight, bottom: newBottom });
    }
    function onUp() { setDrag(null); }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [drag]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onCancel(); }
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
          rotation_deg: rotation,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Recrop failed");
      toast({ title: `${side} image cropped${Math.abs(rotation) > 0.1 ? ` and rotated ${rotation.toFixed(1)}\u00B0` : ""}, variants regenerated` });
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
        setBox({ left: j.bounds.left_pct, top: j.bounds.top_pct, right: j.bounds.left_pct + j.bounds.width_pct, bottom: j.bounds.top_pct + j.bounds.height_pct });
        toast({ title: "Card detected \u2014 crop box fitted to edges" });
      } else {
        toast({ title: "Auto-detect failed", description: j.message || "Drag corners manually", variant: "destructive" });
      }
    } catch (e: any) {
      toast({ title: "Auto-detect error", description: e.message, variant: "destructive" });
    } finally {
      setDetecting(false);
    }
  }

  const cropW = box.right - box.left;
  const cropH = box.bottom - box.top;

  // Corner handles: 14px gold squares. Edge handles: 10px gold circles.
  const handles: Array<{ id: string; isCorner: boolean; css: React.CSSProperties }> = [
    // Corners
    { id: "nw", isCorner: true, css: { left: -7, top: -7, cursor: "nwse-resize" } },
    { id: "ne", isCorner: true, css: { right: -7, top: -7, cursor: "nesw-resize" } },
    { id: "se", isCorner: true, css: { right: -7, bottom: -7, cursor: "nwse-resize" } },
    { id: "sw", isCorner: true, css: { left: -7, bottom: -7, cursor: "nesw-resize" } },
    // Edges
    { id: "n", isCorner: false, css: { left: "50%", top: -5, marginLeft: -5, cursor: "ns-resize" } },
    { id: "s", isCorner: false, css: { left: "50%", bottom: -5, marginLeft: -5, cursor: "ns-resize" } },
    { id: "w", isCorner: false, css: { left: -5, top: "50%", marginTop: -5, cursor: "ew-resize" } },
    { id: "e", isCorner: false, css: { right: -5, top: "50%", marginTop: -5, cursor: "ew-resize" } },
  ];

  return (
    <div className="fixed inset-0 z-[100] bg-black/95 flex flex-col select-none">
      {/* Top bar */}
      <div className="flex-shrink-0 px-4 py-3 flex items-center justify-between border-b border-[#333333]">
        <div>
          <p className="text-[#D4AF37] text-xs font-bold uppercase tracking-widest flex items-center gap-2">
            <Crop size={14} /> Manual Crop \u2014 {side}
          </p>
          <p className="text-[#888888] text-[10px]">Drag corners to resize freely. Edge handles resize one axis. Drag inside to move. Esc to cancel.</p>
        </div>
        <button type="button" onClick={onCancel} className="text-[#888888] hover:text-white p-1"><X size={20} /></button>
      </div>

      {/* Image area */}
      <div className="flex-1 flex items-center justify-center p-4 min-h-0 overflow-auto">
        <div className="relative" style={{ maxHeight: "80vh", maxWidth: "90vw" }}>
          <div style={{ transform: `rotate(${rotation}deg)`, transformOrigin: "center center", transition: drag ? "none" : "transform 0.2s ease" }}>
            <div ref={containerRef} className="relative rounded-lg bg-[#0A0A0A] overflow-hidden">
              <img src={rawImageUrl} alt={`${side} raw`} className="block max-h-[75vh] w-auto" draggable={false} />

              {/* Dim overlay outside crop */}
              <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
                <defs>
                  <mask id="cropMask">
                    <rect width="100" height="100" fill="white" />
                    <rect x={box.left} y={box.top} width={cropW} height={cropH} fill="black" />
                  </mask>
                </defs>
                <rect width="100" height="100" fill="black" fillOpacity="0.6" mask="url(#cropMask)" />
              </svg>

              {/* Crop box — body drag area */}
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

                {/* Handles — corners are larger squares, edges are smaller circles */}
                {handles.map(({ id, isCorner, css }) => (
                  <div
                    key={id}
                    className={`absolute bg-[#D4AF37] border-2 border-white shadow-md hover:scale-125 transition-transform z-10 ${isCorner ? "w-[14px] h-[14px] rounded-sm" : "w-[10px] h-[10px] rounded-full"}`}
                    style={css}
                    onMouseDown={(e) => startDrag(id, e)}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom bar */}
      <div className="flex-shrink-0 px-4 py-3 flex items-center justify-between border-t border-[#333333] gap-3">
        <div className="flex items-center gap-3">
          <span className="text-[#888888] text-xs font-mono">{Math.round(cropW)}% x {Math.round(cropH)}%</span>
          <button type="button" onClick={handleAutoDetect} disabled={detecting}
            className="flex items-center gap-1.5 text-[#D4AF37] hover:text-[#B8960C] text-xs border border-[#D4AF37]/30 px-3 py-1.5 rounded-lg hover:bg-[#D4AF37]/10 disabled:opacity-50 transition-colors">
            {detecting ? <Loader2 size={12} className="animate-spin" /> : <Crosshair size={12} />}
            {detecting ? "Detecting..." : "Auto-Detect"}
          </button>
          <button type="button" onClick={() => { setBox({ left: 5, top: 5, right: 95, bottom: 95 }); setRotation(0); }}
            className="flex items-center gap-1 text-[#888888] hover:text-white text-xs"><RotateCcw size={12} /> Reset</button>
        </div>

        {/* Rotation slider */}
        <div className="flex items-center gap-2 text-xs text-[#D4AF37]">
          <span className="text-[#888888]">Rotate</span>
          <input type="range" min="-15" max="15" step="0.5" value={rotation}
            onChange={(e) => setRotation(Number(e.target.value))}
            className="w-28 accent-[#D4AF37]" />
          <span className="font-mono w-12 text-right">{rotation.toFixed(1)}\u00B0</span>
          {Math.abs(rotation) > 0.1 && (
            <button type="button" onClick={() => setRotation(0)} className="text-[10px] text-[#888888] hover:text-[#D4AF37] underline">Zero</button>
          )}
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
