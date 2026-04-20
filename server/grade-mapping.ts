/**
 * MintVault → PSA / BGS / TAG grade mapping.
 *
 * MintVault grades are stored as DECIMAL(4,1) but the calculation pipeline
 * produces whole integers 1–10 (Math.round). The grade_strength_score (0–100)
 * captures within-tier granularity.
 *
 * PSA: 1–10 integer scale (same as MintVault).
 *   PSA 10 = Gem Mint. PSA uses "Pristine 10" for perfect centering but
 *   MintVault doesn't distinguish that — we map all 10s to PSA 10.
 *
 * BGS: 1–10 with half-grade precision (9.5, 10 "Pristine").
 *   BGS 10 Pristine = all subgrades 10. BGS 9.5 Gem Mint = subgrades ≥ 9.5.
 *   Since MintVault subgrades are integers, we map:
 *     MV 10 all-10-subs → BGS 10 Pristine
 *     MV 10 (not all 10s) → BGS 9.5 Gem Mint
 *     MV 9 → BGS 9 Mint
 *     MV N (N < 10) → BGS N
 *
 * TAG: 1000-point scale. TAG 1000 = perfect.
 *   Base: MV grade × 100. Refined by strength score if available.
 *   MV 9 strength 75 → TAG 975. MV 10 strength 90 → TAG 990.
 */

export interface SubGrades {
  centering: number;
  corners: number;
  edges: number;
  surface: number;
}

export interface CrossGradeResult {
  mintvault: number;
  psa: number;
  bgs: number;       // half-grade precision
  bgsLabel: string;   // "Pristine", "Gem Mint", "Mint", etc.
  tag: number;        // 0–1000
}

const BGS_LABELS: Record<string, string> = {
  "10": "Pristine",
  "9.5": "Gem Mint",
  "9": "Mint",
  "8.5": "NM-MT+",
  "8": "NM-MT",
  "7.5": "NM+",
  "7": "NM",
  "6.5": "EX-MT+",
  "6": "EX-MT",
  "5.5": "EX+",
  "5": "EX",
  "4": "VG-EX",
  "3": "VG",
  "2": "Good",
  "1": "Poor",
};

/**
 * Map a MintVault grade + subgrades to equivalent PSA, BGS, and TAG grades.
 *
 * @param mvGrade - MintVault overall grade (integer 1–10)
 * @param subgrades - Individual subgrade scores (integers 1–10)
 * @param strengthScore - Optional grade_strength_score (0–100) for TAG refinement
 */
export function mapToExternalGrades(
  mvGrade: number,
  subgrades: SubGrades,
  strengthScore?: number | null,
): CrossGradeResult {
  const grade = Math.round(mvGrade);

  // PSA: direct 1:1 integer mapping
  const psa = grade;

  // BGS: half-grade precision based on subgrade composition
  let bgs: number;
  if (grade === 10) {
    const allTen = subgrades.centering === 10 && subgrades.corners === 10 &&
                   subgrades.edges === 10 && subgrades.surface === 10;
    bgs = allTen ? 10 : 9.5;
  } else {
    bgs = grade;
  }
  const bgsLabel = BGS_LABELS[String(bgs)] || `${bgs}`;

  // TAG: 1000-point scale. Base = grade × 100, refined by strength score.
  let tag: number;
  if (strengthScore != null && strengthScore >= 0) {
    tag = Math.round(((grade - 1) * 100) + strengthScore);
    tag = Math.max(100, Math.min(1000, tag));
  } else {
    tag = grade * 100;
  }

  return { mintvault: grade, psa, bgs, bgsLabel, tag };
}
