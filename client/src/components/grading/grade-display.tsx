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
  gradeLabel: string;
  isBlack: boolean;
  strengthScore?: number | null;
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

export default function GradeDisplay({ overall, sub, hasCrease, hasTear, manualOverride, onOverride, gradeLabel, isBlack, strengthScore }: Props) {
  const [showOverride, setShowOverride] = useState(false);
  const [showCalc, setShowCalc] = useState(false);
  const display = manualOverride ?? overall;

  const weighted = (sub.centering * 0.10) + (sub.corners * 0.25) + (sub.edges * 0.25) + (sub.surface * 0.40);
  const rounded = Math.floor(weighted);
  const lowest = Math.min(sub.centering, sub.corners, sub.edges, sub.surface);
  const capped = Math.min(rounded, lowest + 1.0);
  const creaseCap = hasCrease ? 5.0 : 99;
  const tearCap = hasTear ? 3.0 : 99;

  return (
    <div className="space-y-3">
      {/* Main grade box */}
      <div className={`rounded-xl p-4 bg-gradient-to-br ${overallBg(display)} text-center`}>
        <p className="text-[#1A1400]/70 text-[10px] font-bold uppercase tracking-widest mb-1">Overall Grade</p>
        <p className="text-5xl font-black text-[#1A1400] leading-none">{display}</p>
        <p className="text-[#1A1400] text-xs font-bold uppercase tracking-widest mt-1">{gradeLabel}</p>
        {manualOverride !== null && (
          <p className="text-[#1A1400]/60 text-[9px] mt-1">(manual override)</p>
        )}
      </div>

      {/* Grade Strength Score */}
      {strengthScore != null && (
        <div className="bg-[#111111] border border-[#222222] rounded-lg p-3 text-center">
          <div className="flex items-center justify-center gap-1 mb-1">
            <p className="text-[#555555] text-[10px] font-bold uppercase tracking-widest">Grade Strength</p>
            <div className="relative group">
              <Info size={10} className="text-[#555555] cursor-help" />
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 w-48 bg-[#1A1A1A] border border-[#333333] rounded p-2 text-[9px] text-[#888888] leading-relaxed hidden group-hover:block z-20">
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

      {/* Subgrade summary */}
      <div className="grid grid-cols-4 gap-1.5">
        {[
          { label: "C", val: sub.centering },
          { label: "Co", val: sub.corners },
          { label: "E", val: sub.edges },
          { label: "S", val: sub.surface },
        ].map(({ label, val }) => (
          <div key={label} className="bg-[#111111] border border-[#222222] rounded p-2 text-center">
            <p className="text-[#555555] text-[9px] uppercase">{label}</p>
            <p className="text-sm font-black" style={{ color: subgradeColor(val) }}>{val}</p>
          </div>
        ))}
      </div>

      {/* Calculation details */}
      <button type="button" onClick={() => setShowCalc(!showCalc)} className="text-[#D4AF37]/50 text-[10px] hover:text-[#D4AF37]">
        {showCalc ? "Hide" : "Show"} calculation details
      </button>
      {showCalc && (
        <div className="bg-[#0A0A0A] border border-[#222222] rounded-lg p-3 text-[10px] text-[#666666] font-mono space-y-1">
          <p>Weighted: ({sub.centering}×10%) + ({sub.corners}×25%) + ({sub.edges}×25%) + ({sub.surface}×40%) = {weighted.toFixed(2)}</p>
          <p>→ Floored to whole number: {rounded}</p>
          <p>→ Lowest subgrade ({lowest}) + 1.0 = max {lowest + 1.0} — result: {capped}</p>
          {hasCrease && <p className="text-red-400">→ Crease cap applied: max 5.0 — result: {Math.min(capped, creaseCap)}</p>}
          {hasTear   && <p className="text-red-400">→ Tear cap applied: max 3.0 — result: {Math.min(capped, tearCap)}</p>}
          <p className="text-[#888888]">Final: {overall}</p>
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
            className="bg-[#111111] border border-[#333333] text-[#CCCCCC] text-xs rounded px-2 py-1"
          >
            <option value="">Auto (formula)</option>
            {GRADE_OPTIONS.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
          <button type="button" onClick={() => { setShowOverride(false); onOverride(null); }} className="text-[#555555] text-[10px] hover:text-[#888888]">clear</button>
        </div>
      )}
    </div>
  );
}
