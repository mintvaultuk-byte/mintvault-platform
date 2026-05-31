/**
 * CrossGradeDisplay — shows equivalent grades across PSA, BGS, and TAG scales.
 * Used on admin grading workstation and public estimate results.
 */

interface Props {
  mvGrade: number;
  subgrades?: { centering: number; corners: number; edges: number; surface: number } | null;
  strengthScore?: number | null;
  compact?: boolean; // single-line for tight spaces
}

function mapGrades(mvGrade: number, sub?: Props["subgrades"], strength?: number | null) {
  const grade = Math.round(mvGrade);
  const psa = grade;
  let bgs: number;
  let bgsLabel: string;
  if (grade === 10 && sub) {
    const allTen = sub.centering === 10 && sub.corners === 10 && sub.edges === 10 && sub.surface === 10;
    bgs = allTen ? 10 : 9.5;
    bgsLabel = allTen ? "Pristine" : "Gem Mint";
  } else {
    bgs = grade;
    bgsLabel = grade >= 9 ? "Mint" : grade >= 8 ? "NM-MT" : grade >= 7 ? "NM" : `${grade}`;
  }
  let tag: number;
  if (strength != null && strength >= 0) {
    tag = Math.round((grade - 1) * 100 + strength);
    tag = Math.max(100, Math.min(1000, tag));
  } else {
    tag = grade * 100;
  }
  return { psa, bgs, bgsLabel, tag };
}

export default function CrossGradeDisplay({ mvGrade, subgrades, strengthScore, compact }: Props) {
  if (!mvGrade || mvGrade <= 0) return null;
  const { psa, bgs, bgsLabel, tag } = mapGrades(mvGrade, subgrades, strengthScore);

  if (compact) {
    return (
      <div className="flex items-center gap-3 text-[10px]">
        <span className="text-[var(--admin-gold)] font-bold">MV {mvGrade}</span>
        <span className="text-[var(--admin-ink-faint)]">|</span>
        <span className="text-[var(--admin-ink-dim)]">
          PSA <strong className="text-[var(--admin-ink)]">{psa}</strong>
        </span>
        <span className="text-[var(--admin-ink-faint)]">|</span>
        <span className="text-[var(--admin-ink-dim)]">
          BGS <strong className="text-[var(--admin-ink)]">{bgs}</strong>
        </span>
        <span className="text-[var(--admin-ink-faint)]">|</span>
        <span className="text-[var(--admin-ink-dim)]">
          TAG <strong className="text-[var(--admin-ink)]">{tag}</strong>
        </span>
      </div>
    );
  }

  return (
    <div className="bg-[var(--admin-panel2)] border border-[var(--admin-line)] rounded-lg p-3">
      <p className="text-[9px] font-bold text-[var(--admin-gold)] uppercase tracking-wider mb-2">
        Cross-Grade Estimate
      </p>
      <div className="grid grid-cols-4 gap-2 text-center">
        <div>
          <p className="text-[8px] text-[var(--admin-ink-faint)] uppercase">MintVault</p>
          <p className="text-lg font-black text-[var(--admin-gold)]">{mvGrade}</p>
        </div>
        <div>
          <p className="text-[8px] text-[var(--admin-ink-faint)] uppercase">PSA</p>
          <p className="text-lg font-black text-[var(--admin-ink)]">{psa}</p>
        </div>
        <div>
          <p className="text-[8px] text-[var(--admin-ink-faint)] uppercase">BGS</p>
          <p className="text-lg font-black text-[var(--admin-ink)]">{bgs}</p>
          <p className="text-[8px] text-[var(--admin-ink-faint)]">{bgsLabel}</p>
        </div>
        <div>
          <p className="text-[8px] text-[var(--admin-ink-faint)] uppercase">TAG</p>
          <p className="text-lg font-black text-[var(--admin-ink)]">{tag}</p>
        </div>
      </div>
    </div>
  );
}
