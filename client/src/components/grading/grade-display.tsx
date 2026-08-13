import { Info, Star } from "lucide-react";

export interface DisplaySubgrades {
  centering: number;
  corners: number;
  edges: number;
  surface: number;
}

interface Props {
  overall: number;
  sub: DisplaySubgrades;
  gradeLabel: string;
  isBlack: boolean;
  strengthScore?: number | null;
  aiSubgrades?: { centering: number | null; corners: number | null; edges: number | null; surface: number | null };
  aiConfidence?: {
    centering: "high" | "medium" | "low" | null;
    corners: "high" | "medium" | "low" | null;
    edges: "high" | "medium" | "low" | null;
    surface: "high" | "medium" | "low" | null;
  };
}

function subgradeColor(grade: number): string {
  if (grade >= 10) return "#D4AF37";
  if (grade >= 8) return "#16A34A";
  if (grade >= 6) return "#CA8A04";
  return "#DC2626";
}

function overallBg(grade: number): string {
  if (grade >= 9) return "from-[var(--admin-gold)] to-[var(--admin-gold-deep)]";
  if (grade >= 7) return "from-[#888888] to-[#555555]";
  if (grade >= 5) return "from-[#B87333] to-[#8B4513]";
  return "from-[#444444] to-[#222222]";
}

function strengthColor(score: number): string {
  if (score >= 80) return "#16A34A";
  if (score >= 40) return "#D4AF37";
  return "#D97706";
}

/** Presentation only. Values have already been resolved by the server. */
export default function GradeDisplay({
  overall,
  sub,
  gradeLabel,
  isBlack,
  strengthScore,
  aiSubgrades,
  aiConfidence,
}: Props) {
  const values: Array<{ label: keyof DisplaySubgrades; value: number }> = [
    { label: "centering", value: sub.centering },
    { label: "corners", value: sub.corners },
    { label: "edges", value: sub.edges },
    { label: "surface", value: sub.surface },
  ];
  return (
    <div className="space-y-3">
      <div
        className={`rounded-xl p-4 bg-gradient-to-br ${overall > 0 ? overallBg(overall) : "from-[#333333] to-[#222222]"} text-center`}
      >
        <p className="text-[#1A1400]/70 text-[10px] font-bold uppercase tracking-widest mb-1">Overall Grade</p>
        <p className="text-5xl font-black text-[#1A1400] leading-none">{overall > 0 ? overall : "—"}</p>
        <p className="text-[#1A1400] text-xs font-bold uppercase tracking-widest mt-1">
          {overall > 0 ? gradeLabel : "Awaiting server calculation"}
        </p>
      </div>

      {strengthScore != null && (
        <div className="bg-[var(--admin-panel2)] border border-[var(--admin-line)] rounded-lg p-3 text-center">
          <div className="flex items-center justify-center gap-1 mb-1">
            <p className="text-[var(--admin-ink-dim)] text-[10px] font-bold uppercase tracking-widest">
              Grade Strength
            </p>
            <Info size={10} className="text-[var(--admin-ink-dim)]" />
          </div>
          <p className="leading-none">
            <span className="text-3xl font-black" style={{ color: strengthColor(strengthScore) }}>
              {strengthScore}
            </span>
            <span className="text-sm text-[var(--admin-ink-dim)] font-bold">/100</span>
          </p>
        </div>
      )}

      {isBlack && (
        <div className="flex items-center justify-center gap-2 border border-[var(--admin-gold)]/50 rounded-lg px-3 py-2 bg-[var(--admin-gold)]/10 animate-pulse">
          <Star size={14} className="text-[var(--admin-gold)] fill-[var(--admin-gold)]" />
          <span className="text-[var(--admin-gold)] text-xs font-bold uppercase tracking-widest">
            Pristine 10P Candidate
          </span>
        </div>
      )}

      <div className="grid grid-cols-4 gap-1.5">
        {values.map(({ label, value }) => {
          const baseline = aiSubgrades?.[label] ?? null;
          const lowConfidence = aiConfidence?.[label] === "low";
          return (
            <div
              key={label}
              className="bg-[var(--admin-panel2)] border border-[var(--admin-line)] rounded p-2 text-center"
            >
              <p className="text-[var(--admin-ink-dim)] text-[10px] font-semibold uppercase tracking-wider">
                {label}
                {lowConfidence ? " · review" : ""}
              </p>
              <p className="text-sm font-black mt-0.5" style={{ color: value > 0 ? subgradeColor(value) : "#888888" }}>
                {value > 0 ? value : "—"}
              </p>
              {baseline != null && <p className="text-[var(--admin-ink-faint)] text-[8px] uppercase">AI: {baseline}</p>}
            </div>
          );
        })}
      </div>

      <p className="text-[var(--admin-ink-faint)] text-[9px] italic">
        Grade outcome is calculated and issued by the MintVault server when observations are saved.
      </p>
    </div>
  );
}
