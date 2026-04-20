import { useEffect } from "react";
import { Zap, CheckCircle2, Loader2 } from "lucide-react";
import { calculateOverallGrade, getGradeLabel } from "./grade-logic";

const GRADE_OPTIONS = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

function gradeColor(g: number): string {
  if (g >= 10) return "#D4AF37";
  if (g >= 8)   return "#16A34A";
  if (g >= 6)   return "#CA8A04";
  return "#DC2626";
}

interface QuickSubgrades {
  centering: number;
  corners: number;
  edges: number;
  surface: number;
}

interface Props {
  subgrades: QuickSubgrades;
  onChange: (s: QuickSubgrades) => void;
  onApprove: () => void;
  onSave: () => void;
  approving: boolean;
  saving: boolean;
  focusField: keyof QuickSubgrades | null;
  onFocusField: (f: keyof QuickSubgrades | null) => void;
}

const FIELDS: { key: keyof QuickSubgrades; label: string; shortLabel: string }[] = [
  { key: "centering", label: "Centering", shortLabel: "C" },
  { key: "corners",   label: "Corners",   shortLabel: "Co" },
  { key: "edges",     label: "Edges",     shortLabel: "E" },
  { key: "surface",   label: "Surface",   shortLabel: "S" },
];

export default function QuickGrade({ subgrades, onChange, onApprove, onSave, approving, saving, focusField, onFocusField }: Props) {
  const overall = calculateOverallGrade(subgrades, false, false);
  const label = getGradeLabel(overall);

  // Keyboard: 1-9, 0=10.0, Tab between fields
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (!focusField) return;

      const keyMap: Record<string, number> = {
        "1": 1, "2": 2, "3": 3, "4": 4, "5": 5,
        "6": 6, "7": 7, "8": 8, "9": 9, "0": 10,
      };
      if (keyMap[e.key] !== undefined) {
        onChange({ ...subgrades, [focusField]: keyMap[e.key] });
        e.preventDefault();
      }
      // Tab moves to next field
      if (e.key === "Tab") {
        e.preventDefault();
        const idx = FIELDS.findIndex(f => f.key === focusField);
        const next = FIELDS[(idx + 1) % FIELDS.length];
        onFocusField(next.key);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [focusField, subgrades, onChange, onFocusField]);

  return (
    <div className="bg-white border border-[#D4AF37]/30 rounded-xl p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Zap size={14} className="text-[#D4AF37]" />
          <p className="text-[#D4AF37] text-xs font-bold uppercase tracking-widest">Quick Grade</p>
        </div>
        <p className="text-[#555555] text-[10px]">1-0 keys to set · Tab to move</p>
      </div>

      {/* Grade display */}
      <div className="text-center py-3 rounded-xl bg-[#F7F7F5] border border-[#E8E4DC]">
        <p className="text-5xl font-black" style={{ color: "#D4AF37" }}>{overall}</p>
        <p className="text-[#D4AF37] text-sm font-bold uppercase tracking-widest mt-1">{label}</p>
      </div>

      {/* Subgrade row */}
      <div className="flex gap-2">
        {FIELDS.map(f => (
          <div key={f.key} className="flex-1">
            <p className="text-[#555555] text-[10px] font-semibold uppercase tracking-wider text-center mb-1">{f.label}</p>
            <button
              type="button"
              onClick={() => onFocusField(focusField === f.key ? null : f.key)}
              className={`w-full text-center py-2 rounded-lg border text-sm font-black transition-all ${
                focusField === f.key
                  ? "border-[#D4AF37] bg-[#D4AF37]/10 ring-1 ring-[#D4AF37]/40"
                  : "border-[#D4D0C8] bg-[#F7F7F5] hover:border-[#D4AF37]/40"
              }`}
              style={{ color: gradeColor(subgrades[f.key]) }}
            >
              {subgrades[f.key]}
            </button>
            {focusField === f.key && (
              <select
                value={subgrades[f.key]}
                onChange={e => onChange({ ...subgrades, [f.key]: parseFloat(e.target.value) })}
                className="w-full mt-1 bg-[#F7F7F5] border border-[#D4AF37]/40 text-[#1A1A1A] text-xs rounded px-1 py-1"
                autoFocus
              >
                {GRADE_OPTIONS.map(g => <option key={g} value={g}>{g}</option>)}
              </select>
            )}
          </div>
        ))}
      </div>

      {/* Action buttons */}
      <div className="flex gap-2">
        <button
          type="button" onClick={onSave} disabled={saving}
          className="flex-1 border border-[#D4AF37]/20 text-[#D4AF37]/60 hover:text-[#D4AF37] hover:border-[#D4AF37]/40 text-xs font-bold py-2.5 rounded-lg transition-all disabled:opacity-40"
        >
          {saving ? <Loader2 size={13} className="animate-spin mx-auto" /> : "Save Draft"}
        </button>
        <button
          type="button" onClick={onApprove} disabled={approving}
          className="flex-[2] flex items-center justify-center gap-2 bg-gradient-to-r from-[#D4AF37] to-[#B8960C] text-[#1A1400] text-xs font-bold uppercase py-2.5 rounded-lg disabled:opacity-40 hover:opacity-90"
        >
          {approving ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
          Approve Grade
        </button>
      </div>
      <p className="text-[#888888] text-[9px] text-center">Cmd+Enter to approve · Cmd+S to save</p>
    </div>
  );
}
