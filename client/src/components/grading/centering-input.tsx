import { useState } from "react";
import { Crosshair } from "lucide-react";

interface Props {
  frontLR: string;
  frontTB: string;
  backLR: string;
  backTB: string;
  subgrade: number | null;
  onChange: (field: "frontLR" | "frontTB" | "backLR" | "backTB", val: string) => void;
  overrideGrade: number | null;
  onOverride: (val: number | null) => void;
}

const GRADE_OPTIONS = [10, 9.5, 9, 8.5, 8, 7.5, 7, 6.5, 6, 5.5, 5, 4.5, 4, 3.5, 3, 2.5, 2, 1.5, 1];

function gradeColor(g: number | null): string {
  if (g === null) return "#888888";
  if (g >= 10) return "#D4AF37";
  if (g >= 8) return "#16A34A";
  if (g >= 6) return "#CA8A04";
  return "#DC2626";
}

function parseRatio(ratio: string): [number, number] | null {
  const parts = ratio.split("/").map((s) => parseFloat(s.trim()));
  if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1]) && parts[0] + parts[1] === 100) {
    return [parts[0], parts[1]];
  }
  return null;
}

function validateRatio(val: string): boolean {
  const p = parseRatio(val);
  return p !== null;
}

function CenteringDiagram({ frontLR, frontTB }: { frontLR: string; frontTB: string }) {
  const flr = parseRatio(frontLR);
  const ftb = parseRatio(frontTB);

  const left = flr ? flr[0] : 50;
  const right = flr ? flr[1] : 50;
  const top = ftb ? ftb[0] : 50;
  const bottom = ftb ? ftb[1] : 50;

  const maxVal = Math.max(left, right, top, bottom);
  const borderColor = maxVal <= 55 ? "#16A34A" : maxVal <= 65 ? "#CA8A04" : "#DC2626";

  // Scale borders: outer rect is 100px. Max inner border = 20px, proportional
  const scale = 16 / 50;
  const bLeft = Math.round(left * scale);
  const bRight = Math.round(right * scale);
  const bTop = Math.round(top * scale);
  const bBottom = Math.round(bottom * scale);

  return (
    <div className="flex flex-col items-center gap-1">
      <p className="text-[var(--admin-ink-dim)] text-[9px] uppercase tracking-widest">Front centering</p>
      <div className="relative w-20 h-28 border border-[var(--admin-line)] rounded bg-[var(--admin-panel2)] flex items-center justify-center">
        <div
          className="absolute rounded-sm"
          style={{
            top: bTop,
            left: bLeft,
            right: bRight,
            bottom: bBottom,
            border: `1.5px solid ${borderColor}`,
            opacity: 0.9,
          }}
        />
        <span className="text-[var(--admin-ink-dim)] text-[8px] absolute top-0.5 left-1/2 -translate-x-1/2">
          {top}%
        </span>
        <span className="text-[var(--admin-ink-dim)] text-[8px] absolute bottom-0.5 left-1/2 -translate-x-1/2">
          {bottom}%
        </span>
        <span
          className="text-[var(--admin-ink-dim)] text-[8px] absolute left-0.5 top-1/2 -translate-y-1/2"
          style={{ writingMode: "vertical-rl" }}
        >
          {left}%
        </span>
        <span
          className="text-[var(--admin-ink-dim)] text-[8px] absolute right-0.5 top-1/2 -translate-y-1/2"
          style={{ writingMode: "vertical-rl" }}
        >
          {right}%
        </span>
      </div>
    </div>
  );
}

export default function CenteringInput({
  frontLR,
  frontTB,
  backLR,
  backTB,
  subgrade,
  onChange,
  overrideGrade,
  onOverride,
}: Props) {
  const [showOverride, setShowOverride] = useState(false);
  const displayGrade = overrideGrade ?? subgrade;

  const fields: { key: "frontLR" | "frontTB" | "backLR" | "backTB"; label: string; value: string }[] = [
    { key: "frontLR", label: "Front L/R", value: frontLR },
    { key: "frontTB", label: "Front T/B", value: frontTB },
    { key: "backLR", label: "Back L/R", value: backLR },
    { key: "backTB", label: "Back T/B", value: backTB },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Crosshair size={14} className="text-[var(--admin-gold)]" />
        <h3 className="text-[var(--admin-gold)] text-xs font-bold uppercase tracking-widest">Centering</h3>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {fields.map((f) => (
          <div key={f.key}>
            <label className="text-[var(--admin-ink-dim)] text-[10px] block mb-1">{f.label}</label>
            <input
              type="text"
              value={f.value}
              onChange={(e) => onChange(f.key, e.target.value)}
              placeholder="—"
              className={`w-full bg-[var(--admin-panel2)] border rounded px-2 py-1.5 text-xs font-mono text-[var(--admin-ink)] ${
                f.value && !validateRatio(f.value) ? "border-[var(--admin-red)]" : "border-[var(--admin-line)]"
              }`}
            />
          </div>
        ))}
      </div>

      <div className="flex items-center gap-4">
        <CenteringDiagram frontLR={frontLR} frontTB={frontTB} />
        <div className="flex-1">
          <p className="text-[var(--admin-ink-dim)] text-[10px] mb-1 uppercase tracking-widest">Calculated subgrade</p>
          <p className="text-3xl font-black" style={{ color: gradeColor(displayGrade) }}>
            {displayGrade !== null ? displayGrade : "—"}
          </p>
          {overrideGrade !== null && <span className="text-[9px] text-[var(--admin-ink-dim)]">(manual)</span>}
          {!showOverride && (
            <button
              type="button"
              onClick={() => setShowOverride(true)}
              className="text-[var(--admin-gold)]/50 text-[10px] hover:text-[var(--admin-gold)] mt-1 block"
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
    </div>
  );
}
