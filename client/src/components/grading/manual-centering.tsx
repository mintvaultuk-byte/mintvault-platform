import { useState, useRef } from "react";
import { X, RotateCcw, Save, ZoomIn, ZoomOut } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface Point { x: number; y: number; }

interface Props {
  certId: number;
  side: "front" | "back";
  imageUrl: string;
  onSave: (result: CenteringResult) => void;
  onCancel: () => void;
}

export interface CenteringResult {
  side: "front" | "back";
  points: Point[];
  leftRight: string;  // "54/46"
  topBottom: string;   // "47/53"
  subgrade: number;
}

const ZOOM_STEPS = [1, 1.5, 2, 3, 4, 6];

const STEP_LABELS = [
  "Click OUTER top-left corner (where card border meets background)",
  "Click OUTER top-right corner",
  "Click OUTER bottom-right corner",
  "Click OUTER bottom-left corner",
  "Click INNER top-left corner (where border meets card content)",
  "Click INNER top-right corner",
  "Click INNER bottom-right corner",
  "Click INNER bottom-left corner",
];

const POINT_COLORS = [
  "#D4AF37", "#D4AF37", "#D4AF37", "#D4AF37", // outer = gold
  "#16A34A", "#16A34A", "#16A34A", "#16A34A", // inner = green
];

function calculateCentering(points: Point[]): { lr: string; tb: string; subgrade: number } {
  if (points.length < 8) return { lr: "50/50", tb: "50/50", subgrade: 10 };

  const [oTL, oTR, oBR, oBL, iTL, iTR, iBR, iBL] = points;

  const outerLeft = (oTL.x + oBL.x) / 2;
  const outerRight = (oTR.x + oBR.x) / 2;
  const outerTop = (oTL.y + oTR.y) / 2;
  const outerBottom = (oBL.y + oBR.y) / 2;

  const innerLeft = (iTL.x + iBL.x) / 2;
  const innerRight = (iTR.x + iBR.x) / 2;
  const innerTop = (iTL.y + iTR.y) / 2;
  const innerBottom = (iBL.y + iBR.y) / 2;

  const leftBorder = innerLeft - outerLeft;
  const rightBorder = outerRight - innerRight;
  const topBorder = innerTop - outerTop;
  const bottomBorder = outerBottom - innerBottom;

  const totalH = leftBorder + rightBorder;
  const totalV = topBorder + bottomBorder;

  const lPct = totalH > 0 ? Math.round((leftBorder / totalH) * 1000) / 10 : 50;
  const rPct = Math.round((100 - lPct) * 10) / 10;
  const tPct = totalV > 0 ? Math.round((topBorder / totalV) * 1000) / 10 : 50;
  const bPct = Math.round((100 - tPct) * 10) / 10;

  // Subgrade from worst ratio
  const worstDev = Math.max(Math.abs(lPct - 50), Math.abs(tPct - 50));
  let subgrade: number;
  if (worstDev <= 2) subgrade = 10;
  else if (worstDev <= 5) subgrade = 9;
  else if (worstDev <= 10) subgrade = 8;
  else if (worstDev <= 15) subgrade = 7;
  else if (worstDev <= 20) subgrade = 6;
  else if (worstDev <= 35) subgrade = 5;
  else subgrade = 4;

  // Format: larger side first
  const lr = lPct >= rPct ? `${lPct}/${rPct}` : `${rPct}/${lPct}`;
  const tb = tPct >= bPct ? `${tPct}/${bPct}` : `${bPct}/${tPct}`;

  return { lr, tb, subgrade };
}

export default function ManualCentering({ certId, side, imageUrl, onSave, onCancel }: Props) {
  const { toast } = useToast();
  const [points, setPoints] = useState<Point[]>([]);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 50, y: 50 });
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [saving, setSaving] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  const step = points.length;
  const isDone = step >= 8;
  const result = isDone ? calculateCentering(points) : null;

  function handleImageClick(e: React.MouseEvent) {
    if (dragging || isDone) return;
    if (!imgRef.current) return;

    const imgRect = imgRef.current.getBoundingClientRect();
    const x = ((e.clientX - imgRect.left) / imgRect.width) * 100;
    const y = ((e.clientY - imgRect.top) / imgRect.height) * 100;

    setPoints(prev => [...prev, { x: Math.max(0, Math.min(100, x)), y: Math.max(0, Math.min(100, y)) }]);
  }

  function undo() {
    setPoints(prev => prev.slice(0, -1));
  }

  function reset() {
    setPoints([]);
  }

  async function save() {
    if (!result) return;
    setSaving(true);
    try {
      const r = await fetch(`/api/admin/certificates/${certId}/manual-centering`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ side, points }),
      });
      if (!r.ok) { const d = await r.json(); throw new Error(d.error); }
      onSave({ side, points, leftRight: result.lr, topBottom: result.tb, subgrade: result.subgrade });
      toast({ title: `${side} centering saved: ${result.lr} L/R, ${result.tb} T/B → grade ${result.subgrade}` });
    } catch (e: any) {
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  const zoomIn = () => { const idx = ZOOM_STEPS.indexOf(zoom); if (idx < ZOOM_STEPS.length - 1) setZoom(ZOOM_STEPS[idx + 1]); };
  const zoomOut = () => { const idx = ZOOM_STEPS.indexOf(zoom); if (idx > 0) setZoom(ZOOM_STEPS[idx - 1]); };

  const transformStyle = zoom > 1
    ? `scale(${zoom}) translate(${(50 - pan.x) / zoom}%, ${(50 - pan.y) / zoom}%)`
    : "none";

  return (
    <div className="fixed inset-0 z-50 bg-black/95 flex flex-col">
      {/* Top bar */}
      <div className="flex-shrink-0 px-4 py-3 flex items-center justify-between border-b border-[#333333]">
        <div>
          <p className="text-[#D4AF37] text-xs font-bold uppercase tracking-widest">Manual Centering — {side}</p>
          <p className="text-[#888888] text-xs mt-0.5">
            {isDone ? "Review your points and save" : `Step ${step + 1}/8: ${STEP_LABELS[step]}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={zoomOut} disabled={zoom <= 1} className="w-8 h-8 flex items-center justify-center text-white hover:text-[#D4AF37] disabled:text-[#555555] transition-colors">
            <ZoomOut size={16} />
          </button>
          <span className="text-white text-xs font-mono w-10 text-center">{Math.round(zoom * 100)}%</span>
          <button type="button" onClick={zoomIn} disabled={zoom >= 6} className="w-8 h-8 flex items-center justify-center text-white hover:text-[#D4AF37] disabled:text-[#555555] transition-colors">
            <ZoomIn size={16} />
          </button>
          <button type="button" onClick={onCancel} className="ml-4 text-[#888888] hover:text-white p-1">
            <X size={20} />
          </button>
        </div>
      </div>

      {/* Main image area */}
      <div className="flex-1 flex items-center justify-center p-4 min-h-0">
        <div
          className="relative overflow-hidden rounded-lg bg-[#0A0A0A] w-full h-full max-w-[85vh] cursor-crosshair"
          onClick={handleImageClick}
          onMouseDown={e => { if (zoom > 1) { setDragging(true); setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y }); } }}
          onMouseMove={e => { if (dragging) setPan({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y }); }}
          onMouseUp={() => setDragging(false)}
          onMouseLeave={() => setDragging(false)}
        >
          <div className="relative w-full h-full" style={{ transform: transformStyle, transition: dragging ? "none" : "transform 0.15s" }}>
            <img ref={imgRef} src={imageUrl} alt={side} className="w-full h-full object-contain" draggable={false} />

            {/* Placed points */}
            {points.map((p, i) => (
              <div
                key={i}
                className="absolute pointer-events-none"
                style={{ left: `${p.x}%`, top: `${p.y}%`, transform: "translate(-50%, -50%)" }}
              >
                <div className="w-5 h-5 rounded-full border-2 flex items-center justify-center text-[8px] font-black"
                  style={{ borderColor: POINT_COLORS[i], color: POINT_COLORS[i], background: `${POINT_COLORS[i]}20` }}>
                  {i + 1}
                </div>
              </div>
            ))}

            {/* Lines connecting outer points */}
            {points.length >= 4 && (
              <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
                <polygon
                  points={points.slice(0, 4).map(p => `${p.x},${p.y}`).join(" ")}
                  fill="none" stroke="#D4AF37" strokeWidth="0.3" opacity="0.6"
                />
                {points.length >= 8 && (
                  <polygon
                    points={points.slice(4, 8).map(p => `${p.x},${p.y}`).join(" ")}
                    fill="none" stroke="#16A34A" strokeWidth="0.3" opacity="0.6" strokeDasharray="1,1"
                  />
                )}
              </svg>
            )}
          </div>
        </div>
      </div>

      {/* Bottom toolbar */}
      <div className="flex-shrink-0 px-4 py-3 flex items-center justify-between border-t border-[#333333]">
        <div className="flex items-center gap-3">
          <button type="button" onClick={undo} disabled={points.length === 0}
            className="text-[#888888] hover:text-white text-xs disabled:opacity-30 transition-colors">
            Undo last point
          </button>
          <button type="button" onClick={reset} disabled={points.length === 0}
            className="flex items-center gap-1 text-[#888888] hover:text-white text-xs disabled:opacity-30 transition-colors">
            <RotateCcw size={12} /> Reset all
          </button>
          <span className="text-[#555555] text-xs">{points.length}/8 points placed</span>
        </div>

        {/* Result display */}
        {result && (
          <div className="flex items-center gap-4">
            <div className="text-center">
              <p className="text-[#888888] text-[9px] uppercase">L/R</p>
              <p className="text-white text-sm font-bold font-mono">{result.lr}</p>
            </div>
            <div className="text-center">
              <p className="text-[#888888] text-[9px] uppercase">T/B</p>
              <p className="text-white text-sm font-bold font-mono">{result.tb}</p>
            </div>
            <div className="text-center">
              <p className="text-[#888888] text-[9px] uppercase">Grade</p>
              <p className="text-[#D4AF37] text-sm font-black">{result.subgrade}</p>
            </div>
          </div>
        )}

        <div className="flex items-center gap-2">
          <button type="button" onClick={onCancel} className="border border-[#333333] text-[#888888] text-xs px-4 py-2 rounded-lg hover:bg-[#1A1A1A]">
            Cancel
          </button>
          {isDone && (
            <button type="button" onClick={save} disabled={saving}
              className="flex items-center gap-2 bg-gradient-to-r from-[#D4AF37] to-[#B8960C] text-[#1A1400] text-xs font-bold uppercase px-5 py-2 rounded-lg hover:opacity-90 disabled:opacity-50">
              <Save size={13} />
              {saving ? "Saving…" : "Save Centering"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
