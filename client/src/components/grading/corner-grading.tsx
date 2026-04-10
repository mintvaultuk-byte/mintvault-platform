import { useState } from "react";
import { Square } from "lucide-react";

export interface CornerValues {
  frontTL: number; frontTR: number; frontBL: number; frontBR: number;
  backTL: number;  backTR: number;  backBL: number;  backBR: number;
}

interface Props {
  values: CornerValues;
  subgrade: number;
  onChange: (values: CornerValues) => void;
  overrideGrade: number | null;
  onOverride: (val: number | null) => void;
}

const GRADE_OPTIONS = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

function gradeColor(g: number): string {
  if (g >= 10) return "#D4AF37";
  if (g >= 8)   return "#16A34A";
  if (g >= 6)   return "#CA8A04";
  return "#DC2626";
}

function GradeSelect({ value, onChange, isLowest }: { value: number; onChange: (v: number) => void; isLowest: boolean }) {
  return (
    <select
      value={value}
      onChange={e => onChange(parseFloat(e.target.value))}
      className={`text-[10px] rounded px-1 py-0.5 font-bold border ${isLowest ? "border-red-500" : "border-[#333333]"} bg-[#111111]`}
      style={{ color: gradeColor(value) }}
    >
      {GRADE_OPTIONS.map(g => <option key={g} value={g}>{g}</option>)}
    </select>
  );
}

export function calcCornerSubgrade(v: CornerValues): { grade: number; worstKey: string } {
  const entries: [string, number][] = [
    ["Front Top-Left",     v.frontTL],
    ["Front Top-Right",    v.frontTR],
    ["Front Bottom-Left",  v.frontBL],
    ["Front Bottom-Right", v.frontBR],
    ["Back Top-Left",      v.backTL],
    ["Back Top-Right",     v.backTR],
    ["Back Bottom-Left",   v.backBL],
    ["Back Bottom-Right",  v.backBR],
  ];
  const worst = entries.reduce((a, b) => a[1] <= b[1] ? a : b);
  return { grade: worst[1], worstKey: worst[0] };
}

export default function CornerGrading({ values, subgrade, onChange, overrideGrade, onOverride }: Props) {
  const [showOverride, setShowOverride] = useState(false);
  const { grade, worstKey } = calcCornerSubgrade(values);
  const displayGrade = overrideGrade ?? grade;

  function update(key: keyof CornerValues, val: number) {
    onChange({ ...values, [key]: val });
  }

  const allVals = Object.values(values);
  const lowest = Math.min(...allVals);

  function isLowest(v: number) { return v === lowest; }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Square size={14} className="text-[#D4AF37]" />
        <h3 className="text-[#D4AF37] text-xs font-bold uppercase tracking-widest">Corners</h3>
      </div>

      {/* Front */}
      <div>
        <p className="text-[#555555] text-[10px] uppercase tracking-widest mb-1.5">Front</p>
        <div className="relative border border-[#222222] rounded-lg p-3 bg-[#0D0D0D]" style={{ aspectRatio: "5/3.5", maxWidth: 220 }}>
          <div className="absolute top-1.5 left-1.5">
            <GradeSelect value={values.frontTL} onChange={v => update("frontTL", v)} isLowest={isLowest(values.frontTL)} />
          </div>
          <div className="absolute top-1.5 right-1.5">
            <GradeSelect value={values.frontTR} onChange={v => update("frontTR", v)} isLowest={isLowest(values.frontTR)} />
          </div>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-[#333333] text-[10px] uppercase tracking-widest">Front</span>
          </div>
          <div className="absolute bottom-1.5 left-1.5">
            <GradeSelect value={values.frontBL} onChange={v => update("frontBL", v)} isLowest={isLowest(values.frontBL)} />
          </div>
          <div className="absolute bottom-1.5 right-1.5">
            <GradeSelect value={values.frontBR} onChange={v => update("frontBR", v)} isLowest={isLowest(values.frontBR)} />
          </div>
        </div>
      </div>

      {/* Back */}
      <div>
        <p className="text-[#555555] text-[10px] uppercase tracking-widest mb-1.5">Back</p>
        <div className="relative border border-[#222222] rounded-lg p-3 bg-[#0D0D0D]" style={{ aspectRatio: "5/3.5", maxWidth: 220 }}>
          <div className="absolute top-1.5 left-1.5">
            <GradeSelect value={values.backTL} onChange={v => update("backTL", v)} isLowest={isLowest(values.backTL)} />
          </div>
          <div className="absolute top-1.5 right-1.5">
            <GradeSelect value={values.backTR} onChange={v => update("backTR", v)} isLowest={isLowest(values.backTR)} />
          </div>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-[#333333] text-[10px] uppercase tracking-widest">Back</span>
          </div>
          <div className="absolute bottom-1.5 left-1.5">
            <GradeSelect value={values.backBL} onChange={v => update("backBL", v)} isLowest={isLowest(values.backBL)} />
          </div>
          <div className="absolute bottom-1.5 right-1.5">
            <GradeSelect value={values.backBR} onChange={v => update("backBR", v)} isLowest={isLowest(values.backBR)} />
          </div>
        </div>
      </div>

      {/* Subgrade */}
      <div>
        <p className="text-[#888888] text-[10px]">
          Corners: <span className="font-bold text-sm" style={{ color: gradeColor(displayGrade) }}>{displayGrade}</span>
          {worstKey && <span className="text-[#555555]"> (limited by {worstKey})</span>}
          {overrideGrade !== null && <span className="text-[#888888]"> (manual)</span>}
        </p>
        {!showOverride && (
          <button type="button" onClick={() => setShowOverride(true)} className="text-[#D4AF37]/50 text-[10px] hover:text-[#D4AF37]">Override</button>
        )}
        {showOverride && (
          <div className="flex items-center gap-2 mt-1">
            <select
              value={overrideGrade ?? ""}
              onChange={e => onOverride(e.target.value === "" ? null : parseFloat(e.target.value))}
              className="bg-[#111111] border border-[#333333] text-[#CCCCCC] text-xs rounded px-2 py-1"
            >
              <option value="">Auto</option>
              {GRADE_OPTIONS.map(g => <option key={g} value={g}>{g}</option>)}
            </select>
            <button type="button" onClick={() => { setShowOverride(false); onOverride(null); }} className="text-[#555555] text-[10px] hover:text-[#888888]">clear</button>
          </div>
        )}
      </div>
    </div>
  );
}
