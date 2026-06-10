import { useState } from "react";
import { Minus } from "lucide-react";

export interface EdgeValues {
  frontTop: number;
  frontBottom: number;
  frontLeft: number;
  frontRight: number;
  backTop: number;
  backBottom: number;
  backLeft: number;
  backRight: number;
}

interface Props {
  values: EdgeValues;
  onChange: (values: EdgeValues) => void;
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

export function EdgeSelect({
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
      onChange={(e) => {
        e.stopPropagation();
        onChange(Number(e.target.value));
      }}
      className={`text-[8px] rounded px-1 py-0.5 font-bold border cursor-pointer shadow-sm ${
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

export function calcEdgeSubgrade(v: EdgeValues): { grade: number; worstKey: string } {
  const entries: [string, number][] = [
    ["Front Top", v.frontTop],
    ["Front Bottom", v.frontBottom],
    ["Front Left", v.frontLeft],
    ["Front Right", v.frontRight],
    ["Back Top", v.backTop],
    ["Back Bottom", v.backBottom],
    ["Back Left", v.backLeft],
    ["Back Right", v.backRight],
  ];
  // Treat 0 as "unset" — see calcCornerSubgrade for rationale.
  const set = entries.filter(([, g]) => g > 0);
  if (set.length === 0) return { grade: 0, worstKey: "" };
  const worst = set.reduce((a, b) => (a[1] <= b[1] ? a : b));
  return { grade: worst[1], worstKey: worst[0] };
}

function EdgePanel({
  label,
  values,
  allLowest,
  onChange,
}: {
  label: "Front" | "Back";
  values: { top: number; bottom: number; left: number; right: number };
  allLowest: number;
  onChange: (side: "top" | "bottom" | "left" | "right", v: number) => void;
}) {
  return (
    <div>
      <p className="text-[var(--admin-ink-dim)] text-[10px] uppercase tracking-widest mb-1.5">{label}</p>
      <div className="relative flex flex-col items-center gap-1" style={{ width: 180 }}>
        {/* Top */}
        <GradeSelect value={values.top} onChange={(v) => onChange("top", v)} isLowest={values.top === allLowest} />
        {/* Middle row */}
        <div className="flex items-center gap-2">
          <GradeSelect value={values.left} onChange={(v) => onChange("left", v)} isLowest={values.left === allLowest} />
          <div className="border border-[var(--admin-line)] rounded bg-[var(--admin-panel2)] w-20 h-12 flex items-center justify-center">
            <span className="text-[var(--admin-ink-faint)] text-[9px] uppercase tracking-widest">{label}</span>
          </div>
          <GradeSelect
            value={values.right}
            onChange={(v) => onChange("right", v)}
            isLowest={values.right === allLowest}
          />
        </div>
        {/* Bottom */}
        <GradeSelect
          value={values.bottom}
          onChange={(v) => onChange("bottom", v)}
          isLowest={values.bottom === allLowest}
        />
      </div>
    </div>
  );
}

export default function EdgeGrading({ values, onChange, overrideGrade, onOverride }: Props) {
  const [showOverride, setShowOverride] = useState(false);
  const { grade, worstKey } = calcEdgeSubgrade(values);
  const displayGrade = overrideGrade ?? grade;
  const allVals = Object.values(values);
  const lowest = Math.min(...allVals);

  function update(key: keyof EdgeValues, val: number) {
    onChange({ ...values, [key]: val });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Minus size={14} className="text-[var(--admin-gold)]" />
        <h3 className="text-[var(--admin-gold)] text-xs font-bold uppercase tracking-widest">Edges</h3>
      </div>

      <div className="flex flex-wrap gap-6">
        <EdgePanel
          label="Front"
          values={{
            top: values.frontTop,
            bottom: values.frontBottom,
            left: values.frontLeft,
            right: values.frontRight,
          }}
          allLowest={lowest}
          onChange={(side, v) => update(`front${side.charAt(0).toUpperCase() + side.slice(1)}` as keyof EdgeValues, v)}
        />
        <EdgePanel
          label="Back"
          values={{ top: values.backTop, bottom: values.backBottom, left: values.backLeft, right: values.backRight }}
          allLowest={lowest}
          onChange={(side, v) => update(`back${side.charAt(0).toUpperCase() + side.slice(1)}` as keyof EdgeValues, v)}
        />
      </div>

      <div>
        <p className="text-[var(--admin-ink-dim)] text-[10px]">
          Edges:{" "}
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
