import { useState } from "react";
import { Square } from "lucide-react";

// MOVED to shared/legacy-grade-fallback.ts so the SERVER can run the identical
// fallback maths for the partner grading adapter. Re-exported here unchanged, so every
// existing import path in this component tree keeps working. One implementation, no fork.
export type { CornerValues } from "@shared/legacy-grade-fallback";
export { calcCornerSubgrade } from "@shared/legacy-grade-fallback";
import type { CornerValues } from "@shared/legacy-grade-fallback";
import { calcCornerSubgrade } from "@shared/legacy-grade-fallback";

interface Props {
  values: CornerValues;
  subgrade: number;
  onChange: (values: CornerValues) => void;
  overrideGrade: number | null;
  onOverride: (val: number | null) => void;
}

const GRADE_OPTIONS = [10, 9.5, 9, 8.5, 8, 7.5, 7, 6.5, 6, 5.5, 5, 4.5, 4, 3.5, 3, 2.5, 2, 1.5, 1];

function gradeColor(g: number): string {
  if (g >= 10) return "#D4AF37";
  if (g >= 8) return "#16A34A";
  if (g >= 6) return "#CA8A04";
  return "#DC2626";
}

function GradeSelect({
  value,
  onChange,
  isLowest,
}: {
  value: number;
  onChange: (v: number) => void;
  isLowest: boolean;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      className={`text-[10px] rounded px-1 py-0.5 font-bold border ${isLowest ? "border-[var(--admin-red)]" : "border-[var(--admin-line)]"} bg-[var(--admin-panel2)]`}
      style={{ color: gradeColor(value) }}
    >
      <option value={0} disabled hidden>
        —
      </option>
      {GRADE_OPTIONS.map((g) => (
        <option key={g} value={g}>
          {g}
        </option>
      ))}
    </select>
  );
}

export function CornerSelect({
  value,
  onChange,
  isLowest = false,
}: {
  value: number;
  onChange: (v: number) => void;
  isLowest?: boolean;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className={`text-[10px] rounded px-1 py-0.5 font-bold border cursor-pointer shadow-sm ${
        isLowest
          ? "border-[var(--admin-red)] bg-[var(--admin-panel)]/90"
          : "border-[var(--admin-line)] bg-[var(--admin-panel)]/90"
      } backdrop-blur-sm`}
      style={{ color: gradeColor(value) }}
      onClick={(e) => e.stopPropagation()}
    >
      <option value={0} disabled hidden>
        —
      </option>
      {GRADE_OPTIONS.map((g) => (
        <option key={g} value={g}>
          {g}
        </option>
      ))}
    </select>
  );
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

  function isLowest(v: number) {
    return v === lowest;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Square size={14} className="text-[var(--admin-gold)]" />
        <h3 className="text-[var(--admin-gold)] text-xs font-bold uppercase tracking-widest">Corners</h3>
      </div>

      {/* Front */}
      <div>
        <p className="text-[var(--admin-ink-dim)] text-[10px] uppercase tracking-widest mb-1.5">Front</p>
        <div
          className="relative border border-[var(--admin-line)] rounded-lg p-3 bg-[var(--admin-panel2)]"
          style={{ aspectRatio: "5/3.5", maxWidth: 220 }}
        >
          <div className="absolute top-1.5 left-1.5">
            <GradeSelect
              value={values.frontTL}
              onChange={(v) => update("frontTL", v)}
              isLowest={isLowest(values.frontTL)}
            />
          </div>
          <div className="absolute top-1.5 right-1.5">
            <GradeSelect
              value={values.frontTR}
              onChange={(v) => update("frontTR", v)}
              isLowest={isLowest(values.frontTR)}
            />
          </div>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-[var(--admin-ink-faint)] text-[10px] uppercase tracking-widest">Front</span>
          </div>
          <div className="absolute bottom-1.5 left-1.5">
            <GradeSelect
              value={values.frontBL}
              onChange={(v) => update("frontBL", v)}
              isLowest={isLowest(values.frontBL)}
            />
          </div>
          <div className="absolute bottom-1.5 right-1.5">
            <GradeSelect
              value={values.frontBR}
              onChange={(v) => update("frontBR", v)}
              isLowest={isLowest(values.frontBR)}
            />
          </div>
        </div>
      </div>

      {/* Back */}
      <div>
        <p className="text-[var(--admin-ink-dim)] text-[10px] uppercase tracking-widest mb-1.5">Back</p>
        <div
          className="relative border border-[var(--admin-line)] rounded-lg p-3 bg-[var(--admin-panel2)]"
          style={{ aspectRatio: "5/3.5", maxWidth: 220 }}
        >
          <div className="absolute top-1.5 left-1.5">
            <GradeSelect
              value={values.backTL}
              onChange={(v) => update("backTL", v)}
              isLowest={isLowest(values.backTL)}
            />
          </div>
          <div className="absolute top-1.5 right-1.5">
            <GradeSelect
              value={values.backTR}
              onChange={(v) => update("backTR", v)}
              isLowest={isLowest(values.backTR)}
            />
          </div>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-[var(--admin-ink-faint)] text-[10px] uppercase tracking-widest">Back</span>
          </div>
          <div className="absolute bottom-1.5 left-1.5">
            <GradeSelect
              value={values.backBL}
              onChange={(v) => update("backBL", v)}
              isLowest={isLowest(values.backBL)}
            />
          </div>
          <div className="absolute bottom-1.5 right-1.5">
            <GradeSelect
              value={values.backBR}
              onChange={(v) => update("backBR", v)}
              isLowest={isLowest(values.backBR)}
            />
          </div>
        </div>
      </div>

      {/* Subgrade */}
      <div>
        <p className="text-[var(--admin-ink-dim)] text-[10px]">
          Corners:{" "}
          <span className="font-bold text-sm" style={{ color: gradeColor(displayGrade) }}>
            {displayGrade}
          </span>
          {worstKey && <span className="text-[var(--admin-ink-dim)]"> (limited by {worstKey})</span>}
          {overrideGrade !== null && <span className="text-[var(--admin-ink-dim)]"> (manual)</span>}
        </p>
        {!showOverride && (
          <button
            type="button"
            onClick={() => setShowOverride(true)}
            className="text-[var(--admin-gold)]/50 text-[10px] hover:text-[var(--admin-gold)]"
          >
            Override
          </button>
        )}
        {showOverride && (
          <div className="flex items-center gap-2 mt-1">
            <select
              value={overrideGrade ?? ""}
              onChange={(e) => onOverride(e.target.value === "" ? null : parseFloat(e.target.value))}
              className="bg-[var(--admin-panel2)] border border-[var(--admin-line)] text-[var(--admin-ink)] text-xs rounded px-2 py-1"
            >
              <option value="">Auto</option>
              <option value={0} disabled hidden>
                —
              </option>
              {GRADE_OPTIONS.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => {
                setShowOverride(false);
                onOverride(null);
              }}
              className="text-[var(--admin-ink-dim)] text-[10px] hover:text-[var(--admin-ink-dim)]"
            >
              clear
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
