/**
 * Pristine 10P / black-label decision for DISPLAY surfaces — single source of
 * truth. Reconstructs the MVGS defect deductions from the cert's stored
 * measurement columns and runs the canonical isPristine() gate
 * (shared/pristine.ts). The stored `label_type` flag is NEVER consulted here.
 *
 * Mirrors the slab renderer's gate path (server/labels.ts) field-for-field, so
 * every customer-facing surface (PDF, cert page, logbook, vault) agrees with the
 * physical slab. Async because it loads MVGS calibration. Returns false for
 * non-numeric grades.
 *
 * NOTE: the slab keeps its own inline copy of this reconstruction (intentionally
 * not refactored, to avoid touching the physical-product renderer). A later
 * cleanup could collapse the slab onto this helper for full DRY; the grading
 * *rule* (isPristine) is already single-sourced in shared/pristine.ts.
 */
import type { CertificateRecord } from "@shared/schema";
import { isNonNumericGrade } from "@shared/schema";
import { isPristine } from "@shared/pristine";

export async function certIsPristine(cert: CertificateRecord): Promise<boolean> {
  const isNumericGrade = !isNonNumericGrade(cert.gradeType || "numeric");
  if (!isNumericGrade) return false;

  const gradeNum = parseFloat(cert.gradeOverall || "0");

  const rawDefects = cert.defects;
  const savedDefects: Array<Record<string, unknown>> = Array.isArray(rawDefects)
    ? (rawDefects as unknown as Array<Record<string, unknown>>)
    : [];
  const mvgsPins = savedDefects
    .filter((d) => d.mvgsCode && d.tier && d.zone)
    .map((d) => ({ mvgsCode: String(d.mvgsCode), tier: String(d.tier), zone: String(d.zone) }));

  const { scoreMvgsV2 } = await import("@shared/mvgs-input-builder");
  const { calibrationForRulesVersion } = await import("@shared/mvgs/registry");
  const certAny = cert as any;
  const surfaceFlags = (certAny.surfaceValues as any) ?? {};
  // Version-routed, not "current rules": a certificate is re-rendered under the
  // ruleset it was ISSUED under, so a future v1.5 cannot restate an old slab.
  const calibration = calibrationForRulesVersion((cert as any).mvgsRulesVersion);
  const mvgsDeductions = scoreMvgsV2(
    {
      centeringFrontLr: cert.centeringFrontLr,
      centeringFrontTb: cert.centeringFrontTb,
      centeringBackLr: cert.centeringBackLr,
      centeringBackTb: cert.centeringBackTb,
      defects: mvgsPins,
      darkBorderFront: cert.darkBorderFront,
      darkBorderBack: cert.darkBorderBack,
      eyeAppealModifier: cert.eyeAppealModifier,
      whiteningLines: Array.isArray(certAny.whiteningLines) ? certAny.whiteningLines : null,
      creaseLines: Array.isArray(certAny.creaseLines) ? certAny.creaseLines : null,
      creaseSpanPct: certAny.creaseSpanPct != null ? Number(certAny.creaseSpanPct) : null,
      wrinkleSeverity: certAny.wrinkleSeverity ?? null,
      tearSeverity: certAny.tearSeverity ?? null,
      hasCrease: !!surfaceFlags.hasCrease,
      hasTear: !!surfaceFlags.hasTear,
    },
    calibration
  ).deductions;

  return isPristine(
    {
      centering: parseFloat(cert.gradeCentering || "0"),
      corners: parseFloat(cert.gradeCorners || "0"),
      edges: parseFloat(cert.gradeEdges || "0"),
      surface: parseFloat(cert.gradeSurface || "0"),
    },
    gradeNum,
    mvgsDeductions
  );
}
