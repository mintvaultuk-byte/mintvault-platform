import { useState } from "react";
import { Star, Info } from "lucide-react";
import type { SubGrades } from "./grade-logic";

interface Props {
  overall: number;
  sub: SubGrades;
  hasCrease: boolean;
  hasTear: boolean;
  manualOverride: number | null;
  onOverride: (val: number | null) => void;
  onSubgradeChange?: (key: keyof SubGrades, value: number) => void;
  gradeLabel: string;
  isBlack: boolean;
  strengthScore?: number | null;
  /** Optional partial-zone diagnostics surfaced on the summary stepper.
   *  cornersZonesSet / edgesZonesSet count non-zero entries (max 8 each).
   *  cornersWorstKey / edgesWorstKey identify the worst-graded zone for the
   *  "Limited by …" tooltip. Empty string means no worst-key (e.g. all-10
   *  case, or override is in effect — we suppress the tooltip then). */
  cornersZonesSet?: number;
  edgesZonesSet?: number;
  cornersWorstKey?: string;
  edgesWorstKey?: string;
}

const GRADE_OPTIONS = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

function subgradeColor(g: number): string {
  if (g >= 10) return "#D4AF37";
  if (g >= 8)   return "#16A34A";
  if (g >= 6)   return "#CA8A04";
  return "#DC2626";
}

function overallBg(g: number): string {
  if (g >= 9)   return "from-[#D4AF37] to-[#B8960C]";
  if (g >= 7)   return "from-[#888888] to-[#555555]";
  if (g >= 5)   return "from-[#B87333] to-[#8B4513]";
  return "from-[#444444] to-[#222222]";
}

function strengthColor(s: number): string {
  if (s >= 80) return "#16A34A"; // green — strong
  if (s >= 40) return "#D4AF37"; // gold — solid
  return "#D97706"; // amber — weak
}

export default function GradeDisplay({ overall, sub, hasCrease, hasTear, manualOverride, onOverride, onSubgradeChange, gradeLabel, isBlack, strengthScore, cornersZonesSet, edgesZonesSet, cornersWorstKey, edgesWorstKey }: Props) {
  const [showOverride, setShowOverride] = useState(false);
  const [showCalc, setShowCalc] = useState(false);
  const display = manualOverride ?? overall;

  const weighted = (sub.centering * 0.10) + (sub.corners * 0.25) + (sub.edges * 0.25) + (sub.surface * 0.40);
  const rounded = Math.round(weighted);
  const lowest = Math.min(sub.centering, sub.corners, sub.edges, sub.surface);
  const capped = Math.min(rounded, lowest + 1.0);
  const creaseCap = hasCrease ? 5.0 : 99;
  const tearCap = hasTear ? 3.0 : 99;

  return (
    <div className="space-y-3">
      {/* Main grade box */}
      <div className={`rounded-xl p-4 bg-gradient-to-br ${display > 0 ? overallBg(display) : "from-[#333333] to-[#222222]"} text-center`}>
        <p className="text-[#1A1400]/70 text-[10px] font-bold uppercase tracking-widest mb-1">Overall Grade</p>
        <p className="text-5xl font-black text-[#1A1400] leading-none">{display > 0 ? display : "—"}</p>
        <p className="text-[#1A1400] text-xs font-bold uppercase tracking-widest mt-1">{display > 0 ? gradeLabel : "Not graded yet"}</p>
        {manualOverride !== null && (
          <p className="text-[#1A1400]/60 text-[9px] mt-1">(manual override)</p>
        )}
      </div>

      {/* Grade Strength Score */}
      {strengthScore != null && (
        <div className="bg-[#F7F7F5] border border-[#E8E4DC] rounded-lg p-3 text-center">
          <div className="flex items-center justify-center gap-1 mb-1">
            <p className="text-[#555555] text-[10px] font-bold uppercase tracking-widest">Grade Strength</p>
            <div className="relative group">
              <Info size={10} className="text-[#555555] cursor-help" />
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 w-48 bg-[#F0EEE8] border border-[#D4D0C8] rounded p-2 text-[9px] text-[#333333] leading-relaxed hidden group-hover:block z-20">
                Where this card sits within its grade tier. Higher = stronger example. Internal use only — not shown on customer reports.
              </div>
            </div>
          </div>
          <p className="leading-none">
            <span className="text-3xl font-black" style={{ color: strengthColor(strengthScore) }}>{strengthScore}</span>
            <span className="text-sm text-[#555555] font-bold">/100</span>
          </p>
          <p className="text-[#555555] text-[9px] mt-1">Position within tier — higher = stronger</p>
        </div>
      )}

      {/* Black Label candidate */}
      {isBlack && (
        <div className="flex items-center justify-center gap-2 border border-[#D4AF37]/50 rounded-lg px-3 py-2 bg-[#D4AF37]/10 animate-pulse">
          <Star size={14} className="text-[#D4AF37] fill-[#D4AF37]" />
          <span className="text-[#D4AF37] text-xs font-bold uppercase tracking-widest">Black Label Candidate</span>
        </div>
      )}

      {/* Subgrade summary — editable. Corners/Edges cells show a partial-zones
          indicator + a "Limited by {worstKey}" tooltip when the calc is
          dragged down by a specific zone. Helps the admin self-diagnose
          which zone they need to revise to lift the subgrade. */}
      <div className="grid grid-cols-4 gap-1.5">
        {([
          { label: "Centering", key: "centering" as keyof SubGrades, val: sub.centering, zonesSet: undefined as number | undefined, worstKey: "" },
          { label: "Corners",   key: "corners"   as keyof SubGrades, val: sub.corners,   zonesSet: cornersZonesSet, worstKey: cornersWorstKey || "" },
          { label: "Edges",     key: "edges"     as keyof SubGrades, val: sub.edges,     zonesSet: edgesZonesSet,   worstKey: edgesWorstKey   || "" },
          { label: "Surface",   key: "surface"   as keyof SubGrades, val: sub.surface,   zonesSet: undefined, worstKey: "" },
        ]).map(({ label, key, val, zonesSet, worstKey }) => {
          const isPartial = zonesSet != null && zonesSet > 0 && zonesSet < 8;
          const showWorstKey = val > 0 && val < 10 && worstKey !== "";
          const tooltipParts: string[] = [];
          if (showWorstKey) tooltipParts.push(`Limited by ${worstKey}`);
          if (isPartial)    tooltipParts.push(`${zonesSet} of 8 zones graded — set remaining for accurate subgrade`);
          const tooltip = tooltipParts.join(" · ");
          return (
            <div
              key={label}
              className="relative group bg-[#F7F7F5] border border-[#E8E4DC] rounded p-2 text-center"
              title={tooltip || undefined}
            >
              <p className="text-[#555555] text-[10px] font-semibold uppercase tracking-wider">{label}</p>
              <div className="flex items-center justify-center gap-1 mt-0.5">
                {onSubgradeChange && (
                  <button type="button" onClick={() => onSubgradeChange(key, Math.max(1, val - 1))}
                    className="text-[#555555] hover:text-[#D4AF37] text-xs leading-none">▼</button>
                )}
                <p className="text-sm font-black min-w-[1.5em]" style={{ color: val > 0 ? subgradeColor(val) : "#888888" }}>
                  {val > 0 ? val : "—"}
                </p>
                {onSubgradeChange && (
                  <button type="button" onClick={() => onSubgradeChange(key, Math.min(10, val + 1))}
                    className="text-[#555555] hover:text-[#D4AF37] text-xs leading-none">▲</button>
                )}
              </div>
              {isPartial && (
                <p className="text-[#B8960C] text-[8px] uppercase tracking-wider leading-none mt-0.5">(partial)</p>
              )}
              {tooltip && (
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 w-48 bg-[#F0EEE8] border border-[#D4D0C8] rounded p-2 text-[9px] text-[#333333] leading-relaxed hidden group-hover:block z-20">
                  {tooltip}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Calculation details */}
      <button type="button" onClick={() => setShowCalc(!showCalc)} className="text-[#D4AF37]/50 text-[10px] hover:text-[#D4AF37]">
        {showCalc ? "Hide" : "Show"} calculation details
      </button>
      {showCalc && (
        <div className="bg-white border border-[#E8E4DC] rounded-lg p-3 text-[10px] text-[#333333] font-mono space-y-1">
          <p>Weighted: ({sub.centering}×10%) + ({sub.corners}×25%) + ({sub.edges}×25%) + ({sub.surface}×40%) = {weighted.toFixed(2)}</p>
          <p>→ Rounded to whole number: {rounded}</p>
          <p>→ Lowest subgrade ({lowest}) + 1.0 = max {lowest + 1.0} — result: {capped}</p>
          {hasCrease && <p className="text-red-600">→ Crease cap applied: max 5.0 — result: {Math.min(capped, creaseCap)}</p>}
          {hasTear   && <p className="text-red-600">→ Tear cap applied: max 3.0 — result: {Math.min(capped, tearCap)}</p>}
          <p className="text-[#333333]">Final: {overall}</p>
        </div>
      )}

      {/* Override */}
      {!showOverride && (
        <button type="button" onClick={() => setShowOverride(true)} className="text-[#D4AF37]/50 text-[10px] hover:text-[#D4AF37]">Override Grade</button>
      )}
      {showOverride && (
        <div className="flex items-center gap-2">
          <select
            value={manualOverride ?? ""}
            onChange={e => onOverride(e.target.value === "" ? null : parseFloat(e.target.value))}
            className="bg-[#F7F7F5] border border-[#D4D0C8] text-[#1A1A1A] text-xs rounded px-2 py-1"
          >
            <option value="">Auto (formula)</option>
            {GRADE_OPTIONS.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
          <button type="button" onClick={() => { setShowOverride(false); onOverride(null); }} className="text-[#555555] text-[10px] hover:text-[#333333]">clear</button>
        </div>
      )}
    </div>
  );
}
