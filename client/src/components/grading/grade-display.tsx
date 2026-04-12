import { useState } from "react";
import { Star, Info, ChevronDown, ChevronRight, Check, X as XIcon } from "lucide-react";
import type { SubGrades } from "./grade-logic";
import { getGradeLabel } from "./grade-logic";

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

export default function GradeDisplay({ overall, sub, hasCrease, hasTear, manualOverride, onOverride, onSubgradeChange, gradeLabel, isBlack, strengthScore }: Props) {
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

      {/* Subgrade summary — editable */}
      <div className="grid grid-cols-4 gap-1.5">
        {([
          { label: "Centering", key: "centering" as keyof SubGrades, val: sub.centering },
          { label: "Corners", key: "corners" as keyof SubGrades, val: sub.corners },
          { label: "Edges", key: "edges" as keyof SubGrades, val: sub.edges },
          { label: "Surface", key: "surface" as keyof SubGrades, val: sub.surface },
        ]).map(({ label, key, val }) => (
          <div key={label} className="bg-[#111111] border border-[#222222] rounded p-2 text-center">
            <p className="text-[#555555] text-[10px] font-semibold uppercase tracking-wider">{label}</p>
            <div className="flex items-center justify-center gap-1 mt-0.5">
              {onSubgradeChange && (
                <button type="button" onClick={() => onSubgradeChange(key, Math.max(1, val - 1))}
                  className="text-[#555555] hover:text-[#D4AF37] text-xs leading-none">▼</button>
              )}
              <p className="text-sm font-black min-w-[1.5em]" style={{ color: val > 0 ? subgradeColor(val) : "#555555" }}>
                {val > 0 ? val : "—"}
              </p>
              {onSubgradeChange && (
                <button type="button" onClick={() => onSubgradeChange(key, Math.min(10, val + 1))}
                  className="text-[#555555] hover:text-[#D4AF37] text-xs leading-none">▲</button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Calculation details — step-by-step reasoning */}
      <button type="button" onClick={() => setShowCalc(!showCalc)} className="flex items-center gap-1 text-[#D4AF37]/50 text-[10px] hover:text-[#D4AF37] transition-colors">
        {showCalc ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        {showCalc ? "Hide" : "Why this grade?"}
      </button>
      {showCalc && (
        <div className="bg-[#0A0A0A] border border-[#222222] rounded-lg p-3 space-y-3">
          {/* Step 1: Weighted formula */}
          <div>
            <p className="text-[#D4AF37]/60 text-[9px] font-bold uppercase tracking-widest mb-1">Step 1 — Weighted Average</p>
            <div className="text-[10px] font-mono text-[#666666] space-y-0.5">
              <p>({sub.centering}×10%) + ({sub.corners}×25%) + ({sub.edges}×25%) + ({sub.surface}×40%)</p>
              <p className="text-[#888888]">= {weighted.toFixed(2)} → floored to <span className="text-[#CCCCCC] font-bold">{rounded}</span></p>
            </div>
          </div>

          {/* Step 2: Lowest subgrade cap */}
          <div>
            <p className="text-[#D4AF37]/60 text-[9px] font-bold uppercase tracking-widest mb-1">Step 2 — Lowest Subgrade Cap</p>
            <div className="text-[10px] font-mono text-[#666666] space-y-0.5">
              <p>Lowest subgrade: <span className="text-[#CCCCCC]">{lowest}</span> ({
                sub.centering === lowest ? "centering" :
                sub.corners === lowest ? "corners" :
                sub.edges === lowest ? "edges" : "surface"
              })</p>
              <p>Max allowed: lowest + 1 = <span className="text-[#CCCCCC]">{lowest + 1}</span></p>
              {capped < rounded
                ? <p className="text-amber-400">→ Capped from {rounded} to <span className="font-bold">{capped}</span></p>
                : <p className="text-[#555555]">→ No cap needed ({rounded} ≤ {lowest + 1})</p>
              }
            </div>
          </div>

          {/* Step 3: Condition caps (only if crease/tear present) */}
          {(hasCrease || hasTear) && (
            <div>
              <p className="text-[#D4AF37]/60 text-[9px] font-bold uppercase tracking-widest mb-1">Step 3 — Condition Caps</p>
              <div className="text-[10px] font-mono space-y-0.5">
                {hasCrease && (
                  <p className={capped > 5 ? "text-red-400" : "text-[#666666]"}>
                    {capped > 5 ? <XIcon size={9} className="inline mr-1" /> : <Check size={9} className="inline mr-1 text-green-400" />}
                    Crease detected → max 5 {capped > 5 ? <span className="font-bold">— grade reduced from {capped} to {Math.min(capped, 5)}</span> : "(already ≤ 5)"}
                  </p>
                )}
                {hasTear && (
                  <p className={Math.min(capped, hasCrease ? 5 : 99) > 3 ? "text-red-400" : "text-[#666666]"}>
                    {Math.min(capped, hasCrease ? 5 : 99) > 3 ? <XIcon size={9} className="inline mr-1" /> : <Check size={9} className="inline mr-1 text-green-400" />}
                    Tear detected → max 3 {Math.min(capped, hasCrease ? 5 : 99) > 3 ? <span className="font-bold">— grade reduced to {Math.min(capped, tearCap, creaseCap)}</span> : "(already ≤ 3)"}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Step 4: Black Label eligibility */}
          <div>
            <p className="text-[#D4AF37]/60 text-[9px] font-bold uppercase tracking-widest mb-1">Black Label Check</p>
            <div className="text-[10px] font-mono">
              {isBlack ? (
                <p className="text-[#D4AF37]"><Check size={9} className="inline mr-1" /> BLACK LABEL — all four subgrades are 10</p>
              ) : overall >= 10 ? (
                <p className="text-[#666666]"><XIcon size={9} className="inline mr-1 text-red-400" /> Not eligible — {
                  sub.centering < 10 ? `centering is ${sub.centering}` :
                  sub.corners < 10 ? `corners is ${sub.corners}` :
                  sub.edges < 10 ? `edges is ${sub.edges}` :
                  `surface is ${sub.surface}`
                } (need all 10)</p>
              ) : (
                <p className="text-[#555555]"><XIcon size={9} className="inline mr-1" /> N/A — overall grade below 10</p>
              )}
            </div>
          </div>

          {/* Step 5: Final result */}
          <div className="border-t border-[#222222] pt-2">
            <div className="flex items-center justify-between">
              <p className="text-[#888888] text-[10px] font-mono">
                Final: <span className="text-[#CCCCCC] font-bold text-xs">{display}</span>
                {" "}<span className="text-[#D4AF37]">{display > 0 ? getGradeLabel(display) : ""}</span>
              </p>
              {manualOverride !== null && (
                <span className="text-[9px] text-amber-400 font-mono">manual override (formula: {overall})</span>
              )}
            </div>
          </div>
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
