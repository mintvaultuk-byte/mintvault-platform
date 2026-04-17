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
    tag = Math.round(((grade - 1) * 100) + strength);
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
        <span className="text-[#D4AF37] font-bold">MV {mvGrade}</span>
        <span className="text-[#888888]">|</span>
        <span className="text-[#555555]">PSA <strong className="text-[#1A1A1A]">{psa}</strong></span>
        <span className="text-[#888888]">|</span>
        <span className="text-[#555555]">BGS <strong className="text-[#1A1A1A]">{bgs}</strong></span>
        <span className="text-[#888888]">|</span>
        <span className="text-[#555555]">TAG <strong className="text-[#1A1A1A]">{tag}</strong></span>
      </div>
    );
  }

  return (
    <div className="bg-[#F7F7F5] border border-[#E8E4DC] rounded-lg p-3">
      <p className="text-[9px] font-bold text-[#D4AF37] uppercase tracking-wider mb-2">Cross-Grade Estimate</p>
      <div className="grid grid-cols-4 gap-2 text-center">
        <div>
          <p className="text-[8px] text-[#888888] uppercase">MintVault</p>
          <p className="text-lg font-black text-[#D4AF37]">{mvGrade}</p>
        </div>
        <div>
          <p className="text-[8px] text-[#888888] uppercase">PSA</p>
          <p className="text-lg font-black text-[#1A1A1A]">{psa}</p>
        </div>
        <div>
          <p className="text-[8px] text-[#888888] uppercase">BGS</p>
          <p className="text-lg font-black text-[#1A1A1A]">{bgs}</p>
          <p className="text-[8px] text-[#888888]">{bgsLabel}</p>
        </div>
        <div>
          <p className="text-[8px] text-[#888888] uppercase">TAG</p>
          <p className="text-lg font-black text-[#1A1A1A]">{tag}</p>
        </div>
      </div>
    </div>
  );
}
