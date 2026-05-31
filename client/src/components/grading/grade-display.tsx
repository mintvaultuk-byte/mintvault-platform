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
  /** v413 — Option A: AI baseline subgrades (snapshot of what scan-time
   *  Haiku originally graded). Used to surface "AI: X" when the admin has
   *  overridden, and a low-confidence pip when AI flagged uncertainty. */
  aiSubgrades?: { centering: number | null; corners: number | null; edges: number | null; surface: number | null };
  aiConfidence?: {
    centering: "high" | "medium" | "low" | null;
    corners: "high" | "medium" | "low" | null;
    edges: "high" | "medium" | "low" | null;
    surface: "high" | "medium" | "low" | null;
  };
  /** True when MVGS pins are present — the MVGS engine is authoritative
   *  for the overall grade, so the manual override dropdown is locked. */
  lockedByMvgs?: boolean;
}

const GRADE_OPTIONS = [10, 9.5, 9, 8.5, 8, 7.5, 7, 6, 5, 4, 3, 2, 1];

function subgradeColor(g: number): string {
  if (g >= 10) return "#D4AF37";
  if (g >= 8) return "#16A34A";
  if (g >= 6) return "#CA8A04";
  return "#DC2626";
}

function overallBg(g: number): string {
  if (g >= 9) return "from-[var(--admin-gold)] to-[var(--admin-gold-deep)]";
  if (g >= 7) return "from-[#888888] to-[#555555]";
  if (g >= 5) return "from-[#B87333] to-[#8B4513]";
  return "from-[#444444] to-[#222222]";
}

function strengthColor(s: number): string {
  if (s >= 80) return "#16A34A"; // green — strong
  if (s >= 40) return "#D4AF37"; // gold — solid
  return "#D97706"; // amber — weak
}

export default function GradeDisplay({
  overall,
  sub,
  hasCrease,
  hasTear,
  manualOverride,
  onOverride,
  onSubgradeChange,
  gradeLabel,
  isBlack,
  strengthScore,
  cornersZonesSet,
  edgesZonesSet,
  cornersWorstKey,
  edgesWorstKey,
  aiSubgrades,
  aiConfidence,
  lockedByMvgs,
}: Props) {
  const [showOverride, setShowOverride] = useState(false);
  const [showCalc, setShowCalc] = useState(false);
  const display = manualOverride ?? overall;

  const weighted = sub.centering * 0.1 + sub.corners * 0.25 + sub.edges * 0.25 + sub.surface * 0.4;
  const rounded = Math.round(weighted);
  const lowest = Math.min(sub.centering, sub.corners, sub.edges, sub.surface);
  const capped = Math.min(rounded, lowest + 1.0);
  const creaseCap = hasCrease ? 5.0 : 99;
  const tearCap = hasTear ? 3.0 : 99;

  return (
    <div className="space-y-3">
      {/* Main grade box */}
      <div
        className={`rounded-xl p-4 bg-gradient-to-br ${display > 0 ? overallBg(display) : "from-[#333333] to-[#222222]"} text-center`}
      >
        <p className="text-[#1A1400]/70 text-[10px] font-bold uppercase tracking-widest mb-1">Overall Grade</p>
        <p className="text-5xl font-black text-[#1A1400] leading-none">{display > 0 ? display : "—"}</p>
        <p className="text-[#1A1400] text-xs font-bold uppercase tracking-widest mt-1">
          {display > 0 ? gradeLabel : "Not graded yet"}
        </p>
        {manualOverride !== null && <p className="text-[#1A1400]/60 text-[9px] mt-1">(manual override)</p>}
      </div>

      {/* Grade Strength Score */}
      {strengthScore != null && (
        <div className="bg-[var(--admin-panel2)] border border-[var(--admin-line)] rounded-lg p-3 text-center">
          <div className="flex items-center justify-center gap-1 mb-1">
            <p className="text-[var(--admin-ink-dim)] text-[10px] font-bold uppercase tracking-widest">
              Grade Strength
            </p>
            <div className="relative group">
              <Info size={10} className="text-[var(--admin-ink-dim)] cursor-help" />
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 w-48 bg-[var(--admin-panel2)] border border-[var(--admin-line)] rounded p-2 text-[9px] text-[var(--admin-ink-dim)] leading-relaxed hidden group-hover:block z-20">
                Where this card sits within its grade tier. Higher = stronger example. Internal use only — not shown on
                customer reports.
              </div>
            </div>
          </div>
          <p className="leading-none">
            <span className="text-3xl font-black" style={{ color: strengthColor(strengthScore) }}>
              {strengthScore}
            </span>
            <span className="text-sm text-[var(--admin-ink-dim)] font-bold">/100</span>
          </p>
          <p className="text-[var(--admin-ink-dim)] text-[9px] mt-1">Position within tier — higher = stronger</p>
        </div>
      )}

      {/* Black Label candidate */}
      {isBlack && (
        <div className="flex items-center justify-center gap-2 border border-[var(--admin-gold)]/50 rounded-lg px-3 py-2 bg-[var(--admin-gold)]/10 animate-pulse">
          <Star size={14} className="text-[var(--admin-gold)] fill-[var(--admin-gold)]" />
          <span className="text-[var(--admin-gold)] text-xs font-bold uppercase tracking-widest">
            Pristine 10P Candidate
          </span>
        </div>
      )}

      {/* Subgrade summary — editable. Cells show:
          - "(partial)" indicator + "Limited by …" tooltip from PR #46
          - "AI: N" baseline subscript when admin has overridden the AI value
          - amber low-confidence pip when AI flagged uncertainty on this subgrade */}
      <div className="grid grid-cols-4 gap-1.5">
        {[
          {
            label: "Centering",
            key: "centering" as keyof SubGrades,
            val: sub.centering,
            zonesSet: undefined as number | undefined,
            worstKey: "",
            aiBaseline: aiSubgrades?.centering ?? null,
            aiConf: aiConfidence?.centering ?? null,
          },
          {
            label: "Corners",
            key: "corners" as keyof SubGrades,
            val: sub.corners,
            zonesSet: cornersZonesSet,
            worstKey: cornersWorstKey || "",
            aiBaseline: aiSubgrades?.corners ?? null,
            aiConf: aiConfidence?.corners ?? null,
          },
          {
            label: "Edges",
            key: "edges" as keyof SubGrades,
            val: sub.edges,
            zonesSet: edgesZonesSet,
            worstKey: edgesWorstKey || "",
            aiBaseline: aiSubgrades?.edges ?? null,
            aiConf: aiConfidence?.edges ?? null,
          },
          {
            label: "Surface",
            key: "surface" as keyof SubGrades,
            val: sub.surface,
            zonesSet: undefined,
            worstKey: "",
            aiBaseline: aiSubgrades?.surface ?? null,
            aiConf: aiConfidence?.surface ?? null,
          },
        ].map(({ label, key, val, zonesSet, worstKey, aiBaseline, aiConf }) => {
          const isPartial = zonesSet != null && zonesSet > 0 && zonesSet < 8;
          const showWorstKey = val > 0 && val < 10 && worstKey !== "";
          const aiOverridden = aiBaseline != null && val > 0 && val !== aiBaseline;
          const aiMatched = aiBaseline != null && val > 0 && val === aiBaseline;
          const lowConfidence = aiConf === "low";
          const tooltipParts: string[] = [];
          if (showWorstKey) tooltipParts.push(`Limited by ${worstKey}`);
          if (isPartial) tooltipParts.push(`${zonesSet} of 8 zones graded — set remaining for accurate subgrade`);
          if (aiOverridden) tooltipParts.push(`AI suggested ${aiBaseline} — admin override`);
          else if (aiMatched) tooltipParts.push(`AI graded ${aiBaseline} — admin confirmed`);
          if (lowConfidence) tooltipParts.push("AI low confidence — review carefully");
          const tooltip = tooltipParts.join(" · ");
          return (
            <div
              key={label}
              className="relative group bg-[var(--admin-panel2)] border border-[var(--admin-line)] rounded p-2 text-center"
              title={tooltip || undefined}
            >
              <p className="text-[var(--admin-ink-dim)] text-[10px] font-semibold uppercase tracking-wider flex items-center justify-center gap-1">
                {label}
                {lowConfidence && (
                  <span
                    className="inline-block w-3 h-3 rounded-full bg-[color-mix(in_srgb,var(--admin-amber)_18%,transparent)] border border-[var(--admin-amber)] text-[var(--admin-amber)] text-[8px] leading-[10px] font-bold"
                    title="AI low confidence — review carefully"
                  >
                    ?
                  </span>
                )}
              </p>
              <div className="flex items-center justify-center gap-1 mt-0.5">
                {onSubgradeChange && (
                  <button
                    type="button"
                    onClick={() => onSubgradeChange(key, Math.max(1, val - 1))}
                    className="text-[var(--admin-ink-dim)] hover:text-[var(--admin-gold)] text-xs leading-none"
                  >
                    ▼
                  </button>
                )}
                <p
                  className="text-sm font-black min-w-[1.5em]"
                  style={{ color: val > 0 ? subgradeColor(val) : "#888888" }}
                >
                  {val > 0 ? val : "—"}
                </p>
                {onSubgradeChange && (
                  <button
                    type="button"
                    onClick={() => onSubgradeChange(key, Math.min(10, val + 1))}
                    className="text-[var(--admin-ink-dim)] hover:text-[var(--admin-gold)] text-xs leading-none"
                  >
                    ▲
                  </button>
                )}
              </div>
              {aiOverridden && (
                <p className="text-[var(--admin-ink-faint)] text-[8px] uppercase tracking-wider leading-none mt-0.5">
                  AI: {aiBaseline}
                </p>
              )}
              {aiMatched && !aiOverridden && (
                <p className="text-[var(--admin-gold)]/60 text-[8px] uppercase tracking-wider leading-none mt-0.5">
                  AI
                </p>
              )}
              {isPartial && (
                <p className="text-[var(--admin-gold-deep)] text-[8px] uppercase tracking-wider leading-none mt-0.5">
                  (partial)
                </p>
              )}
              {tooltip && (
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 w-48 bg-[var(--admin-panel2)] border border-[var(--admin-line)] rounded p-2 text-[9px] text-[var(--admin-ink-dim)] leading-relaxed hidden group-hover:block z-20">
                  {tooltip}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Calculation details */}
      <button
        type="button"
        onClick={() => setShowCalc(!showCalc)}
        className="text-[var(--admin-gold)]/50 text-[10px] hover:text-[var(--admin-gold)]"
      >
        {showCalc ? "Hide" : "Show"} calculation details
      </button>
      {showCalc && (
        <div className="bg-[var(--admin-panel)] border border-[var(--admin-line)] rounded-lg p-3 text-[10px] text-[var(--admin-ink-dim)] font-mono space-y-1">
          <p>
            Weighted: ({sub.centering}×10%) + ({sub.corners}×25%) + ({sub.edges}×25%) + ({sub.surface}×40%) ={" "}
            {weighted.toFixed(2)}
          </p>
          <p>→ Rounded to whole number: {rounded}</p>
          <p>
            → Lowest subgrade ({lowest}) + 1.0 = max {lowest + 1.0} — result: {capped}
          </p>
          {hasCrease && (
            <p className="text-[var(--admin-red)]">
              → Crease cap applied: max 5.0 — result: {Math.min(capped, creaseCap)}
            </p>
          )}
          {hasTear && (
            <p className="text-[var(--admin-red)]">→ Tear cap applied: max 3.0 — result: {Math.min(capped, tearCap)}</p>
          )}
          <p className="text-[var(--admin-ink-dim)]">Final: {overall}</p>
        </div>
      )}

      {/* Override — locked when MVGS pins drive the grade */}
      {lockedByMvgs ? (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <select
              value=""
              disabled
              title="Grade locked by MVGS — adjust via eye appeal only"
              className="bg-[var(--admin-panel2)] border border-[var(--admin-line)] text-[var(--admin-ink-faint)] text-xs rounded px-2 py-1 cursor-not-allowed opacity-60"
            >
              <option value="">Locked by MVGS</option>
            </select>
          </div>
          <p className="text-[var(--admin-ink-faint)] text-[9px] italic">
            Grade locked by MVGS — adjust via eye appeal only
          </p>
        </div>
      ) : (
        <>
          {!showOverride && (
            <button
              type="button"
              onClick={() => setShowOverride(true)}
              className="text-[var(--admin-gold)]/50 text-[10px] hover:text-[var(--admin-gold)]"
            >
              Override Grade
            </button>
          )}
          {showOverride && (
            <div className="flex items-center gap-2">
              <select
                value={manualOverride ?? ""}
                onChange={(e) => onOverride(e.target.value === "" ? null : parseFloat(e.target.value))}
                className="bg-[var(--admin-panel2)] border border-[var(--admin-line)] text-[var(--admin-ink)] text-xs rounded px-2 py-1"
              >
                <option value="">Auto (formula)</option>
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
        </>
      )}
    </div>
  );
}
