import { useState } from "react";
import { X, Plus } from "lucide-react";

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

interface Props {
  defects: Defect[];
  onChange: (defects: Defect[]) => void;
  highlightId: number | null;
  onHighlight: (id: number | null) => void;
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

interface PendingDefect {
  type: string;
  severity: "minor" | "moderate" | "significant";
  description: string;
  location: string;
  image_side: string;
  x_percent: number;
  y_percent: number;
}

interface DefectFormProps {
  pending: PendingDefect;
  onChange: (p: PendingDefect) => void;
  onSave: () => void;
  onCancel: () => void;
}

export function DefectForm({ pending, onChange, onSave, onCancel }: DefectFormProps) {
  return (
    <div className="bg-[#F7F7F5] border border-[#D4D0C8] rounded-lg p-3 space-y-2">
      <p className="text-[#D4AF37] text-[10px] font-bold uppercase tracking-widest">New Defect</p>

      <div>
        <label className="text-[#666666] text-[10px] block mb-1">Type</label>
        <select
          value={pending.type}
          onChange={e => onChange({ ...pending, type: e.target.value })}
          className="w-full bg-white border border-[#D4D0C8] text-[#3A3A3A] text-xs rounded px-2 py-1.5"
        >
          {DEFECT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      <div>
        <label className="text-[#666666] text-[10px] block mb-1">Severity</label>
        <div className="flex gap-2">
          {(["minor", "moderate", "significant"] as const).map(s => (
            <button
              key={s}
              type="button"
              onClick={() => onChange({ ...pending, severity: s })}
              className={`flex-1 text-[10px] font-bold uppercase px-2 py-1 rounded border transition-all ${
                pending.severity === s ? SEV_COLOR[s] : "bg-white border-[#D4D0C8] text-[#888888] hover:border-[#D4AF37]/40"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="text-[#666666] text-[10px] block mb-1">Description</label>
        <textarea
          value={pending.description}
          onChange={e => onChange({ ...pending, description: e.target.value })}
          placeholder="Optional notes"
          rows={2}
          className="w-full bg-white border border-[#D4D0C8] text-[#3A3A3A] text-xs rounded px-2 py-1.5 placeholder-[#AAAAAA] resize-none"
        />
      </div>

      <div>
        <label className="text-[#666666] text-[10px] block mb-1">Location</label>
        <input
          type="text"
          value={pending.location}
          onChange={e => onChange({ ...pending, location: e.target.value })}
          className="w-full bg-white border border-[#D4D0C8] text-[#3A3A3A] text-xs rounded px-2 py-1.5"
        />
      </div>

      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={onSave}
          disabled={!pending.type}
          className="flex-1 bg-[#D4AF37]/10 border border-[#D4AF37]/40 text-[#D4AF37] text-xs font-bold uppercase px-3 py-1.5 rounded hover:bg-[#D4AF37]/20 disabled:opacity-40"
        >
          Save
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 bg-[#F0EEE8] border border-[#D4D0C8] text-[#666666] text-xs px-3 py-1.5 rounded hover:bg-[#E8E4DC]"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export default function DefectAnnotation({ defects, onChange, highlightId, onHighlight }: Props) {
  const [showForm, setShowForm] = useState(false);
  const [pending, setPending] = useState<PendingDefect>({
    type: "Scratch",
    severity: "minor",
    description: "",
    location: "",
    image_side: "front",
    x_percent: 50,
    y_percent: 50,
  });

  function saveDefect() {
    const nextId = defects.length > 0 ? Math.max(...defects.map(d => d.id)) + 1 : 1;
    onChange([...defects, { ...pending, id: nextId }]);
    setPending({ type: "Scratch", severity: "minor", description: "", location: "", image_side: "front", x_percent: 50, y_percent: 50 });
    setShowForm(false);
  }

  function removeDefect(id: number) {
    onChange(defects.filter(d => d.id !== id));
    if (highlightId === id) onHighlight(null);
  }

  return (
    <div className="space-y-3">
      {/* Defect list */}
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
                  <span className="text-[#3A3A3A] text-[10px] font-bold">{d.type}</span>
                  <span className={`text-[9px] uppercase px-1.5 py-0.5 rounded-full border ${SEV_COLOR[d.severity]}`}>
                    {d.severity}
                  </span>
                  <span className="text-[#888888] text-[9px]">{d.location}</span>
                </div>
                {d.description && <p className="text-[#666666] text-[10px] mt-0.5 leading-relaxed">{d.description}</p>}
              </div>
              <button
                type="button"
                onClick={e => { e.stopPropagation(); removeDefect(d.id); }}
                className="flex-shrink-0 text-[#AAAAAA] hover:text-red-600 transition-colors p-0.5"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {defects.length === 0 && !showForm && (
        <p className="text-[#888888] text-xs text-center py-2">No defects marked. Click on the image or use Add Defect.</p>
      )}

      {/* Add defect form */}
      {showForm && (
        <DefectForm
          pending={pending}
          onChange={setPending}
          onSave={saveDefect}
          onCancel={() => setShowForm(false)}
        />
      )}

      {!showForm && (
        <button
          type="button"
          onClick={() => setShowForm(true)}
          className="flex items-center gap-1.5 text-[#D4AF37]/60 hover:text-[#D4AF37] text-xs transition-colors"
        >
          <Plus size={12} />
          Add Defect
        </button>
      )}
    </div>
  );
}
