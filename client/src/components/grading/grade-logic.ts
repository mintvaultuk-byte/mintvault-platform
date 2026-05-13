/**
 * Client-side grade calculation logic.
 * Mirrors server/grade-calculator.ts exactly — keep in sync.
 */

export interface SubGrades {
  centering: number;
  corners: number;
  edges: number;
  surface: number;
}

export function calculateOverallGrade(sub: SubGrades, hasCrease: boolean, hasTear: boolean): number {
  const weighted = (sub.centering * 0.10) + (sub.corners * 0.25) + (sub.edges * 0.25) + (sub.surface * 0.40);
  let grade = Math.round(weighted);
  const lowest = Math.min(sub.centering, sub.corners, sub.edges, sub.surface);
  grade = Math.min(grade, lowest + 1.0);
  if (hasCrease) grade = Math.min(grade, 5);
  if (hasTear)   grade = Math.min(grade, 3);
  return Math.max(1, Math.min(10, grade));
}

export function getGradeLabel(grade: number | string): string {
  if (grade === "AA") return "AUTHENTIC ALTERED";
  if (grade === "NO") return "NOT ORIGINAL";
  const g = typeof grade === "string" ? parseFloat(grade) : grade;
  if (g >= 10) return "GEM MINT";
  if (g >= 9)  return "MINT";
  if (g >= 8)  return "NM-MT";
  if (g >= 7)  return "NM";
  if (g >= 6)  return "EX-MT";
  if (g >= 5)  return "EX";
  if (g >= 4)  return "VG-EX";
  if (g >= 3)  return "VG";
  if (g >= 2)  return "GOOD";
  return "PR";
}

export function isBlackLabel(sub: SubGrades, overall: number): boolean {
  return overall === 10 &&
    sub.centering === 10 &&
    sub.corners   === 10 &&
    sub.edges     === 10 &&
    sub.surface   === 10;
}

// ── PSA-standard centering calculator ─────────────────────────────────────
// Distinct from getCenteringGrade() below (MintVault's lenient mapping —
// kept for the auto subgrade displayed beside the inputs). The PSA chart
// is stricter: any deviation from 50/50 demotes by one grade per 10 pts.
//
// Bands (deviation = |major - minor| after normalising to total = 100):
//   0 pt   → 10 (only exact 50/50 gets a 10)
//   1–10   → 9
//   11–20  → 8
//   21–30  → 7
//   31–40  → 6
//   41–50  → 5
//   51–60  → 4
//   61–70  → 3
//   71–80  → 2
//   81+    → 1
//
// The card's centering subgrade is the WORST axis across all four
// measurements (Front L/R, Front T/B, Back L/R, Back T/B). Returns null if
// any input is malformed (parseRatio fails), the sum is zero, or any field
// is empty — caller is expected to toast "all 4 ratios required".

export interface PsaCenteringResult {
  subgrade: number;          // 1-10
  worstAxisName: "Front L/R" | "Front T/B" | "Back L/R" | "Back T/B";
  worstAxisValue: number;    // = subgrade (kept distinct in case future bands break the rule)
  worstAxisRatio: string;    // canonicalised "minor/major", e.g. "30/70"
}

function parseRatio(raw: string): { minor: number; major: number } | null {
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!m) return null;
  const a = parseInt(m[1], 10);
  const b = parseInt(m[2], 10);
  if (isNaN(a) || isNaN(b)) return null;
  if (a + b === 0) return null;  // div-zero guard
  return { minor: Math.min(a, b), major: Math.max(a, b) };
}

function psaAxisSubgrade(r: { minor: number; major: number }): number {
  const total = r.minor + r.major;
  const dev   = ((r.major - r.minor) / total) * 100;  // 0 = perfect, max 100
  if (dev === 0)  return 10;
  if (dev <= 10)  return 9;
  if (dev <= 20)  return 8;
  if (dev <= 30)  return 7;
  if (dev <= 40)  return 6;
  if (dev <= 50)  return 5;
  if (dev <= 60)  return 4;
  if (dev <= 70)  return 3;
  if (dev <= 80)  return 2;
  return 1;
}

export function psaCenteringSubgrade(
  frontLR: string, frontTB: string, backLR: string, backTB: string,
): PsaCenteringResult | null {
  const axes = [
    { name: "Front L/R" as const, raw: frontLR },
    { name: "Front T/B" as const, raw: frontTB },
    { name: "Back L/R"  as const, raw: backLR },
    { name: "Back T/B"  as const, raw: backTB },
  ];
  let worst: PsaCenteringResult | null = null;
  for (const a of axes) {
    const r = parseRatio(a.raw);
    if (!r) return null;  // any malformed / empty → null, caller toasts error
    const sg = psaAxisSubgrade(r);
    if (worst === null || sg < worst.subgrade) {
      worst = {
        subgrade:        sg,
        worstAxisName:   a.name,
        worstAxisValue:  sg,
        worstAxisRatio:  `${r.minor}/${r.major}`,
      };
    }
  }
  return worst;
}

export function getCenteringGrade(frontLR: string, frontTB: string, backLR: string, backTB: string): number {
  const parseLarger = (ratio: string): number => {
    const parts = ratio.split("/").map(Number);
    if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1])) return 50;
    return Math.max(parts[0], parts[1]);
  };

  const frontWorst = Math.max(parseLarger(frontLR), parseLarger(frontTB));
  const backWorst  = Math.max(parseLarger(backLR),  parseLarger(backTB));

  let frontGrade: number;
  if (frontWorst <= 55) frontGrade = 10;
  else if (frontWorst <= 60) frontGrade = 9;
  else if (frontWorst <= 65) frontGrade = 8;
  else if (frontWorst <= 70) frontGrade = 7;
  else if (frontWorst <= 80) frontGrade = 6;
  else if (frontWorst <= 85) frontGrade = 5;
  else frontGrade = 4;

  let backGrade: number;
  if (backWorst <= 75) backGrade = 10;
  else if (backWorst <= 90) backGrade = 9;
  else backGrade = 7;

  return Math.min(frontGrade, backGrade);
}
