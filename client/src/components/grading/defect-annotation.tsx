import { X } from "lucide-react";

export interface Defect {
  id: number;
  type: string;
  severity: "minor" | "moderate" | "significant";
  description: string;
  location: string;
  image_side: string;
  x_percent: number;
  y_percent: number;
}

/** AI-suggested defect candidate. Same field shape as Defect but unconfirmed
 *  and id-less; admin promotes to Defect on confirm. */
export type DefectCandidate = Omit<Defect, "id">;

interface Props {
  defects: Defect[];
  onChange: (defects: Defect[]) => void;
  highlightId: number | null;
  onHighlight: (id: number | null) => void;
  /** Unconfirmed AI candidates surfaced from scan-ingest's Haiku defect pass.
   *  Optional — undefined/empty = legacy / no candidates. */
  candidates?: DefectCandidate[];
  onCandidatesChange?: (next: DefectCandidate[]) => void;
}

const DEFECT_TYPES = [
  "Scratch", "Print Line", "Whitening", "Silvering", "Corner Softness",
  "Corner Rounding", "Edge Chip", "Edge Roughness", "Indentation", "Stain",
  "Crease", "Ink Spot", "Foil Peel", "Roller Mark", "Colour Fade",
  "Registration Error", "Holo Scratch", "Missing Ink", "Other",
];

const SEV_COLOR: Record<string, string> = {
  minor:       "bg-amber-50 text-amber-600 border-amber-200",
  moderate:    "bg-orange-50 text-orange-600 border-orange-200",
  significant: "bg-red-50 text-red-600 border-red-200",
};

/** Defect type list — used by image-viewer.tsx's anchored dropdown so admin
 *  can place + tag in two clicks. Keep this export in sync with severity
 *  cycling logic below. */
export { DEFECT_TYPES };

const SEVERITY_CYCLE: Defect["severity"][] = ["minor", "moderate", "significant"];

export default function DefectAnnotation({ defects, onChange, highlightId, onHighlight, candidates }: Props) {
  function removeDefect(id: number) {
    onChange(defects.filter(d => d.id !== id));
    if (highlightId === id) onHighlight(null);
  }

  function cycleSeverity(id: number) {
    onChange(defects.map(d => {
      if (d.id !== id) return d;
      const i = SEVERITY_CYCLE.indexOf(d.severity);
      const next = SEVERITY_CYCLE[(i + 1) % SEVERITY_CYCLE.length];
      return { ...d, severity: next };
    }));
  }

  return (
    <div className="space-y-3">
      {/* Defect list — admin-placed only. Click body to highlight on image,
          click severity chip to cycle minor → moderate → significant, X to remove. */}
      {defects.length > 0 && (
        <div className="space-y-1.5">
          {defects.map(d => (
            <div
              key={d.id}
              className={`flex items-start gap-2 rounded-lg px-3 py-2 border cursor-pointer transition-all ${
                highlightId === d.id
                  ? "border-[#D4AF37]/60 bg-[#D4AF37]/5"
                  : "border-[#E8E4DC] bg-white hover:border-[#D4D0C8]"
              }`}
              onClick={() => onHighlight(highlightId === d.id ? null : d.id)}
            >
              <span className="flex-shrink-0 w-5 h-5 rounded-full bg-red-600 flex items-center justify-center text-white text-[9px] font-bold mt-0.5">
                {d.id}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[#1A1A1A] text-[10px] font-bold">{d.type}</span>
                  <button
                    type="button"
                    onClick={e => { e.stopPropagation(); cycleSeverity(d.id); }}
                    title="Click to cycle severity"
                    className={`text-[9px] uppercase px-1.5 py-0.5 rounded-full border cursor-pointer hover:opacity-80 ${SEV_COLOR[d.severity]}`}
                  >
                    {d.severity}
                  </button>
                  <span className="text-[#555555] text-[9px]">{d.location}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={e => { e.stopPropagation(); removeDefect(d.id); }}
                className="flex-shrink-0 text-[#888888] hover:text-red-600 transition-colors p-0.5"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* AI-suggested candidates — read-only decorative info. Admin places
          their own defects via image clicks; AI suggestions are not promoted
          automatically and have no confirm/reject UI here. */}
      {candidates && candidates.length > 0 && (
        <div className="space-y-1.5 border-t border-dashed border-[#D4AF37]/30 pt-2">
          <p className="text-[#D4AF37]/70 text-[9px] uppercase tracking-widest font-bold">AI suggestions ({candidates.length}) — info only</p>
          {candidates.map((c, i) => (
            <div
              key={`cand-${i}`}
              className="flex items-start gap-2 rounded-lg px-3 py-2 border border-dashed border-[#D4AF37]/40 bg-[#FBF8EE]"
            >
              <span className="flex-shrink-0 w-5 h-5 rounded-full border border-dashed border-[#D4AF37] bg-white flex items-center justify-center text-[#D4AF37] text-[9px] font-bold mt-0.5">
                ?
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[#1A1A1A] text-[10px] font-bold">{c.type}</span>
                  <span className={`text-[9px] uppercase px-1.5 py-0.5 rounded-full border ${SEV_COLOR[c.severity]}`}>
                    {c.severity}
                  </span>
                  <span className="text-[#555555] text-[9px]">{c.location}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {defects.length === 0 && (!candidates || candidates.length === 0) && (
        <p className="text-[#555555] text-xs text-center py-2">No defects marked. Click "Mark Defects" and tap the image to start.</p>
      )}
    </div>
  );
}
