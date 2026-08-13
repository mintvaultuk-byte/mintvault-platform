/**
 * Server-owned grade resolution for every workstation draft write.
 *
 * The browser may collect observations, but it must never choose a grade,
 * subgrade, Pristine designation, or tier.  This module is deliberately
 * server-only: route handlers pass the persisted certificate plus the proposed
 * observation fields and persist only this result.
 *
 * The scoring engine and its calibration remain unchanged.  The small legacy
 * fallback below is the former grading-panel formula, transcribed unchanged so
 * pre-MVGS-pin records retain their established behaviour while authority moves
 * off the client.
 */
import { centeringSubgrade, centeringSubgradeStrict } from "@shared/centering";
import { scoreMvgsV2 } from "@shared/mvgs-input-builder";
import { gradeFromMvgsScore, legacyCeilingForFlags, mvgsTierName } from "@shared/mvgs-scoring";
import { isPristine } from "@shared/pristine";
import { kindOfGradeType } from "./grade-kind";
import { loadMvgsCalibration } from "./mvgs-calibration";

export interface DraftGradeAuthority {
  overall: string;
  gradeType: "numeric" | "AA" | "NO";
  label: string;
  subgrades: {
    centering: number | null;
    corners: number | null;
    edges: number | null;
    surface: number | null;
  };
  pristine: boolean;
  score: number | null;
  deductions: Record<string, number>;
}

type AnyRecord = Record<string, any>;

function supplied(body: AnyRecord, key: string, current: unknown): unknown {
  return body[key] === undefined ? current : body[key];
}

function asRecord(value: unknown): AnyRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as AnyRecord) : {};
}

function asArray(value: unknown): AnyRecord[] {
  return Array.isArray(value) ? value.filter((entry): entry is AnyRecord => !!entry && typeof entry === "object") : [];
}

function numberOr(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function persistedSubgrade(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 1 && n <= 10 ? n : null;
}

function selectedZoneMinimum(values: unknown): number {
  const selected = Object.values(asRecord(values)).filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0
  );
  return selected.length === 0 ? 10 : Math.min(...selected);
}

function remainingToGrade(remaining: number): number {
  if (remaining >= 23) return 10;
  if (remaining >= 20) return 9;
  if (remaining >= 17) return 8;
  if (remaining >= 14) return 7;
  if (remaining >= 11) return 6;
  if (remaining >= 8) return 5;
  if (remaining >= 3) return 3;
  if (remaining >= 1) return 2;
  return 1;
}

function legacyOverall(
  subgrades: { centering: number; corners: number; edges: number; surface: number },
  hasCrease: boolean,
  hasTear: boolean
): number {
  const weighted =
    subgrades.centering * 0.1 + subgrades.corners * 0.25 + subgrades.edges * 0.25 + subgrades.surface * 0.4;
  let grade = Math.round(weighted);
  const lowest = Math.min(subgrades.centering, subgrades.corners, subgrades.edges, subgrades.surface);
  grade = Math.min(grade, lowest + 1.0);
  const ceiling = legacyCeilingForFlags({ hasCrease, hasTear });
  if (ceiling) grade = Math.min(grade, ceiling.grade);
  return Math.max(1, Math.min(10, grade));
}

/** Resolve the only grade output a draft write is allowed to persist. */
export async function resolveDraftGradeAuthority(cert: AnyRecord, body: AnyRecord): Promise<DraftGradeAuthority> {
  const surface = asRecord(supplied(body, "surface", cert.surfaceValues));
  const defects = asArray(supplied(body, "defects", cert.defects));
  const pins = defects
    .filter((defect) => defect.mvgsCode && defect.tier && defect.zone)
    .map((defect) => ({
      mvgsCode: String(defect.mvgsCode),
      tier: String(defect.tier),
      zone: String(defect.zone),
    }));
  const calibration = await loadMvgsCalibration();
  const result = scoreMvgsV2(
    {
      centeringFrontLr: String(supplied(body, "centering_front_lr", cert.centeringFrontLr) || "") || null,
      centeringFrontTb: String(supplied(body, "centering_front_tb", cert.centeringFrontTb) || "") || null,
      centeringBackLr: String(supplied(body, "centering_back_lr", cert.centeringBackLr) || "") || null,
      centeringBackTb: String(supplied(body, "centering_back_tb", cert.centeringBackTb) || "") || null,
      defects: pins,
      darkBorderFront: Boolean(supplied(body, "dark_border_front", cert.darkBorderFront ?? cert.darkBorder)),
      darkBorderBack: Boolean(supplied(body, "dark_border_back", cert.darkBorderBack ?? cert.darkBorder)),
      eyeAppealModifier: numberOr(supplied(body, "eye_appeal_modifier", cert.eyeAppealModifier)),
      whiteningLines: asArray(supplied(body, "whitening_lines", cert.whiteningLines)) as any,
      creaseLines: asArray(supplied(body, "crease_lines", cert.creaseLines)) as any,
      creaseSpanPct: numberOr(supplied(body, "crease_span_pct", cert.creaseSpanPct), 0) || null,
      wrinkleSeverity: (supplied(body, "wrinkle_severity", cert.wrinkleSeverity) || null) as any,
      tearSeverity: (supplied(body, "tear_severity", cert.tearSeverity) || null) as any,
      hasCrease: Boolean(surface.hasCrease),
      hasTear: Boolean(surface.hasTear),
    },
    calibration
  );

  const centeringRatios = [
    String(supplied(body, "centering_front_lr", cert.centeringFrontLr) || "") || null,
    String(supplied(body, "centering_front_tb", cert.centeringFrontTb) || "") || null,
    String(supplied(body, "centering_back_lr", cert.centeringBackLr) || "") || null,
    String(supplied(body, "centering_back_tb", cert.centeringBackTb) || "") || null,
  ] as const;
  // The old workstation used a strict measurement result when all four ratios
  // existed, otherwise its last server-persisted subgrade. Keep that migration
  // behaviour so opening a historical record cannot silently regrade it.
  const centering =
    pins.length > 0
      ? centeringSubgrade(...centeringRatios).subgrade
      : (centeringSubgradeStrict(...centeringRatios)?.subgrade ?? persistedSubgrade(cert.gradeCentering) ?? 10);
  const corners =
    pins.length > 0
      ? remainingToGrade(25 - Math.abs(result.deductions.corners ?? 0))
      : (persistedSubgrade(cert.gradeCorners) ?? selectedZoneMinimum(supplied(body, "corners", cert.cornerValues)));
  const pinEdges = remainingToGrade(25 - Math.abs(result.deductions.edges ?? 0));
  const edges =
    pins.length > 0
      ? result.edgesSubgradeFromWhitening == null
        ? pinEdges
        : Math.min(pinEdges, result.edgesSubgradeFromWhitening)
      : (persistedSubgrade(cert.gradeEdges) ?? selectedZoneMinimum(supplied(body, "edges", cert.edgeValues)));
  const surfaceGrade =
    persistedSubgrade(cert.gradeSurface) ?? remainingToGrade(25 - Math.abs(result.deductions.surface ?? 0));

  const authStatus = String(supplied(body, "auth_status", cert.authStatus) || "genuine");
  // Historical records can carry only grade_type, without the newer auth_status
  // column populated. Preserve their issued kind when an observation update does
  // not provide a replacement authentication finding.
  const storedKind = kindOfGradeType(cert.gradeType);
  const resolvedKind =
    authStatus === "authentic_altered" || (body.auth_status === undefined && storedKind === "AA")
      ? "AA"
      : authStatus === "not_original" ||
          (body.auth_status === undefined && storedKind === "NO") ||
          result.tearForceNotGraded
        ? "NO"
        : "numeric";
  if (resolvedKind === "AA") {
    return {
      overall: "AA",
      gradeType: "AA",
      label: "AUTHENTIC ALTERED",
      subgrades: { centering: null, corners: null, edges: null, surface: null },
      pristine: false,
      score: null,
      deductions: result.deductions,
    };
  }
  if (resolvedKind === "NO") {
    return {
      overall: "NO",
      gradeType: "NO",
      label: "NOT ORIGINAL",
      subgrades: { centering: null, corners: null, edges: null, surface: null },
      pristine: false,
      score: null,
      deductions: result.deductions,
    };
  }

  const subgrades = { centering, corners, edges, surface: surfaceGrade };
  const overall =
    pins.length > 0
      ? gradeFromMvgsScore(result.score)
      : legacyOverall(subgrades, Boolean(surface.hasCrease), Boolean(surface.hasTear));
  return {
    overall: String(overall),
    gradeType: "numeric",
    label: mvgsTierName(overall),
    subgrades,
    pristine: isPristine(subgrades, overall, result.deductions),
    score: result.score,
    deductions: result.deductions,
  };
}
