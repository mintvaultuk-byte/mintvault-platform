/**
 * MintVault Grade Calculator
 * Weighted formula with PSA-style rules. Whole number grades only.
 */

export interface SubGrades {
  centering: number;
  corners: number;
  edges: number;
  surface: number;
}

export function calculateOverallGrade(sub: SubGrades, hasCrease: boolean, hasTear: boolean): number {
  // Weighted formula
  const weighted = (sub.centering * 0.10) + (sub.corners * 0.25) + (sub.edges * 0.25) + (sub.surface * 0.40);

  // Round to nearest whole number
  let grade = Math.round(weighted);

  // Cannot be more than 1.0 above lowest subgrade
  const lowest = Math.min(sub.centering, sub.corners, sub.edges, sub.surface);
  grade = Math.min(grade, lowest + 1.0);

  // Crease rule — maximum 5
  if (hasCrease) grade = Math.min(grade, 5);

  // Tear/missing material rule — maximum 3
  if (hasTear) grade = Math.min(grade, 3);

  // Clamp to valid range
  grade = Math.max(1, Math.min(10, grade));

  return grade;
}

export function getGradeLabel(grade: number | string): string {
  if (grade === 'AA') return 'AUTHENTIC ALTERED';
  if (grade === 'NO') return 'NOT ORIGINAL';
  const g = typeof grade === 'string' ? parseFloat(grade) : grade;
  if (g >= 10) return 'GEM MINT';
  if (g >= 9)  return 'MINT';
  if (g >= 8)  return 'NM-MT';
  if (g >= 7)  return 'NM';
  if (g >= 6)  return 'EX-MT';
  if (g >= 5)  return 'EX';
  if (g >= 4)  return 'VG-EX';
  if (g >= 3)  return 'VG';
  if (g >= 2)  return 'GOOD';
  return 'PR';
}

export function isBlackLabel(sub: SubGrades, overall: number): boolean {
  return overall === 10 &&
    sub.centering === 10 &&
    sub.corners === 10 &&
    sub.edges === 10 &&
    sub.surface === 10;
}

export function getCenteringGrade(frontLR: string, frontTB: string, backLR: string, backTB: string): number {
  const parseLarger = (ratio: string): number => {
    const parts = ratio.split('/').map(Number);
    if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1])) return 50;
    return Math.max(parts[0], parts[1]);
  };

  const frontLRVal = parseLarger(frontLR);
  const frontTBVal = parseLarger(frontTB);
  const frontWorst = Math.max(frontLRVal, frontTBVal);

  const backLRVal = parseLarger(backLR);
  const backTBVal = parseLarger(backTB);
  const backWorst = Math.max(backLRVal, backTBVal);

  // Front centering grade (whole numbers only)
  let frontGrade: number;
  if (frontWorst <= 55) frontGrade = 10;
  else if (frontWorst <= 60) frontGrade = 9;
  else if (frontWorst <= 65) frontGrade = 8;
  else if (frontWorst <= 70) frontGrade = 7;
  else if (frontWorst <= 80) frontGrade = 6;
  else if (frontWorst <= 85) frontGrade = 5;
  else frontGrade = 4;

  // Back centering grade
  let backGrade: number;
  if (backWorst <= 75) backGrade = 10;
  else if (backWorst <= 90) backGrade = 9;
  else backGrade = 7;

  return Math.min(frontGrade, backGrade);
}
