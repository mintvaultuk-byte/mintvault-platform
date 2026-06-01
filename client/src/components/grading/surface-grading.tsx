import { useState } from "react";
import { Eye, AlertTriangle } from "lucide-react";

export interface SurfaceValues {
  front: number;
  back: number;
  hasPrintLines: boolean;
  hasHoloScratches: boolean;
  hasSurfaceScratches: boolean;
  hasStaining: boolean;
  hasIndentation: boolean;
  hasRollerMarks: boolean;
  hasColorRegistration: boolean;
  hasCrease: boolean;
  hasTear: boolean;
}

/** MVGS v2 severity enums — paired with the engine's TAG-aligned ceilings.
 *  Stored on the cert in dedicated columns (wrinkle_severity / tear_severity).
 *  Engine reads them via shared/mvgs-input-builder.ts; when set they OVERRIDE
 *  the legacy hasCrease/hasTear booleans (measurement-wins precedence). */
export type WrinkleSeverity = "tiny_back" | "longer_back" | "small_front" | "multiple_front";
export type TearSeverity = "minor" | "significant" | "major";

interface Props {
  values: SurfaceValues;
  onChange: (values: SurfaceValues) => void;
  overrideGrade: number | null;
  onOverride: (val: number | null) => void;
  // MVGS v2 — severity selectors. Wrinkle has no legacy boolean (new input
  // only). Tear has a legacy `hasTear` boolean on `values`; severity wins
  // when set, boolean is the fallback for legacy data.
  wrinkleSeverity?: WrinkleSeverity | null;
  onWrinkleSeverityChange?: (v: WrinkleSeverity | null) => void;
  tearSeverity?: TearSeverity | null;
  onTearSeverityChange?: (v: TearSeverity | null) => void;
}

const WRINKLE_OPTIONS: { value: WrinkleSeverity; label: string; cap: string }[] = [
  { value: "tiny_back", label: "Tiny (back, hi-res only)", cap: "cap 6.5" },
  { value: "longer_back", label: "Longer / visible (back)", cap: "cap 6" },
  { value: "small_front", label: "Small (front)", cap: "cap 5.5" },
  { value: "multiple_front", label: "Multiple (front)", cap: "cap 5" },
];

const TEAR_OPTIONS: { value: TearSeverity; label: string; cap: string }[] = [
  { value: "minor", label: "Minor (one edge)", cap: "cap 2" },
  { value: "significant", label: "Significant / multiple", cap: "cap 1.5" },
  { value: "major", label: "Major / missing material", cap: "→ NO (Not Graded)" },
];

const GRADE_OPTIONS = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

function gradeColor(g: number): string {
  if (g >= 10) return "#D4AF37";
  if (g >= 8) return "#16A34A";
  if (g >= 6) return "#CA8A04";
  return "#DC2626";
}

const ISSUES: { key: keyof SurfaceValues; label: string; warning?: string }[] = [
  { key: "hasPrintLines", label: "Print lines present" },
  { key: "hasHoloScratches", label: "Holo scratches present" },
  { key: "hasSurfaceScratches", label: "Surface scratches present" },
  { key: "hasStaining", label: "Staining present" },
  { key: "hasIndentation", label: "Indentation present" },
  { key: "hasRollerMarks", label: "Roller marks present" },
  { key: "hasColorRegistration", label: "Colour / registration issues" },
  // v2 ceiling text — see shared/mvgs-scoring.ts legacyCeilingForFlags().
  // The boolean is a coarse "any crease/tear present" signal; Phase 2's
  // line-tool measurement will refine to the explicit %-span ladder.
  { key: "hasCrease", label: "Crease present", warning: "Maximum overall grade capped at 4.5 (legacy flag)" },
  { key: "hasTear", label: "Tear or missing material", warning: "Maximum overall grade capped at 2.0 (legacy flag)" },
];

export function calcSurfaceSubgrade(v: SurfaceValues): number {
  return Math.min(v.front, v.back);
}

export default function SurfaceGrading({
  values,
  onChange,
  overrideGrade,
  onOverride,
  wrinkleSeverity,
  onWrinkleSeverityChange,
  tearSeverity,
  onTearSeverityChange,
}: Props) {
  const [showOverride, setShowOverride] = useState(false);
  const grade = calcSurfaceSubgrade(values);
  const displayGrade = overrideGrade ?? grade;

  function update<K extends keyof SurfaceValues>(key: K, val: SurfaceValues[K]) {
    onChange({ ...values, [key]: val });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Eye size={14} className="text-[var(--admin-gold)]" />
        <h3 className="text-[var(--admin-gold)] text-xs font-bold uppercase tracking-widest">Surface</h3>
      </div>

      {/* Crease / Tear warning banners — v2 ceilings (engine is source of
          truth via legacyCeilingForFlags). Phase 2 swaps these for
          measurement-driven copy on the line-tool flow. */}
      {values.hasCrease && (
        <div className="flex items-center gap-2 bg-[color-mix(in_srgb,var(--admin-red)_12%,transparent)] border border-[color-mix(in_srgb,var(--admin-red)_40%,transparent)] rounded px-3 py-2">
          <AlertTriangle size={12} className="text-[var(--admin-red)] flex-shrink-0" />
          <p className="text-[var(--admin-red)] text-xs">Crease detected — maximum overall grade capped at 4.5</p>
        </div>
      )}
      {values.hasTear && (
        <div className="flex items-center gap-2 bg-[color-mix(in_srgb,var(--admin-red)_18%,transparent)] border border-[var(--admin-red)] rounded px-3 py-2">
          <AlertTriangle size={12} className="text-[var(--admin-red)] flex-shrink-0" />
          <p className="text-[var(--admin-red)] text-xs">
            Tear or missing material — maximum overall grade capped at 2.0
          </p>
        </div>
      )}

      {/* MVGS v2 severity dropdowns. Measurement-wins precedence is enforced
          in shared/mvgs-input-builder.ts: when set, these OVERRIDE the legacy
          has_crease/has_tear booleans on `values`. Wrinkle has no legacy
          boolean (new input only). */}
      {onWrinkleSeverityChange && (
        <div className="space-y-1">
          <label className="text-[var(--admin-ink-dim)] text-[10px] block uppercase tracking-widest">
            Wrinkle severity <span className="text-[var(--admin-ink-faint)] normal-case">(MVGS v2)</span>
          </label>
          <select
            value={wrinkleSeverity ?? ""}
            onChange={(e) => onWrinkleSeverityChange((e.target.value || null) as WrinkleSeverity | null)}
            className="w-full bg-[var(--admin-panel)] border border-[var(--admin-line)] rounded px-2 py-1 text-xs text-[var(--admin-ink)]"
            data-testid="select-wrinkle-severity"
          >
            <option value="">— none —</option>
            {WRINKLE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label} · {o.cap}
              </option>
            ))}
          </select>
        </div>
      )}
      {onTearSeverityChange && (
        <div className="space-y-1">
          <label className="text-[var(--admin-ink-dim)] text-[10px] block uppercase tracking-widest">
            Tear severity{" "}
            <span className="text-[var(--admin-ink-faint)] normal-case">(MVGS v2 · overrides "tear" checkbox)</span>
          </label>
          <select
            value={tearSeverity ?? ""}
            onChange={(e) => onTearSeverityChange((e.target.value || null) as TearSeverity | null)}
            className="w-full bg-[var(--admin-panel)] border border-[var(--admin-line)] rounded px-2 py-1 text-xs text-[var(--admin-ink)]"
            data-testid="select-tear-severity"
          >
            <option value="">— none —</option>
            {TEAR_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label} · {o.cap}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Front / Back dropdowns */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-[var(--admin-ink-dim)] text-[10px] block mb-1">Front Surface</label>
          <select
            value={values.front}
            onChange={(e) => update("front", parseFloat(e.target.value))}
            className="w-full bg-[var(--admin-panel2)] border border-[var(--admin-line)] rounded px-2 py-1.5 text-xs font-bold"
            style={{ color: gradeColor(values.front) }}
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
        </div>
        <div>
          <label className="text-[var(--admin-ink-dim)] text-[10px] block mb-1">Back Surface</label>
          <select
            value={values.back}
            onChange={(e) => update("back", parseFloat(e.target.value))}
            className="w-full bg-[var(--admin-panel2)] border border-[var(--admin-line)] rounded px-2 py-1.5 text-xs font-bold"
            style={{ color: gradeColor(values.back) }}
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
        </div>
      </div>

      {/* Issue checkboxes */}
      <div className="space-y-1.5">
        {ISSUES.map((issue) => (
          <label key={String(issue.key)} className="flex items-start gap-2 cursor-pointer group">
            <input
              type="checkbox"
              checked={values[issue.key] as boolean}
              onChange={(e) =>
                update(issue.key as keyof SurfaceValues, e.target.checked as SurfaceValues[typeof issue.key])
              }
              className="mt-0.5 accent-[var(--admin-gold)]"
            />
            <span
              className={`text-xs group-hover:text-[var(--admin-ink)] transition-colors ${
                issue.warning
                  ? "text-[color-mix(in_srgb,var(--admin-red)_50%,transparent)]"
                  : "text-[var(--admin-ink-faint)]"
              }`}
            >
              {issue.warning && "⚠️ "}
              {issue.label}
              {issue.warning && <span className="text-[var(--admin-red)] text-[10px] block ml-1">{issue.warning}</span>}
            </span>
          </label>
        ))}
      </div>

      {/* Subgrade */}
      <div>
        <p className="text-[var(--admin-ink-dim)] text-[10px]">
          Surface:{" "}
          <span className="font-bold text-sm" style={{ color: gradeColor(displayGrade) }}>
            {displayGrade}
          </span>
          <span className="text-[var(--admin-ink-dim)]"> (lower of front/back)</span>
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
