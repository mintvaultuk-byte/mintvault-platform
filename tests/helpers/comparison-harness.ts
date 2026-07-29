/**
 * Baseline-vs-patched comparison harness.
 *
 * The previous harness read `report.cropConfidence` as a decision INPUT. That
 * field is written by tightenForDisplay *after* it decides ("high" on accept),
 * so the baseline path silently evaluated at the strict tolerance while the
 * patched path used the widened one. The two paths never received equivalent
 * inputs and every reported delta was an artefact of that.
 *
 * The immutable pre-decision confidence is `report.retainedMat.confidence`
 * (assigned from `measured.confidence` before the verdict runs). This harness
 * snapshots that, deep-clones every nested value, freezes the snapshot, and
 * derives two fully isolated decision inputs from it.
 */
import {
  evaluateCropIntegrity,
  MAX_EDGE_TRIM_BEYOND_MAT_MM,
  LOW_CONFIDENCE_MAT_MULTIPLE,
  MAX_EDGE_TRIM_UNKNOWN_MAT_MM,
  type CropIntegrityReport,
} from "../../server/image-processing";

export const HARNESS_VERSION = "comparison-harness/2";

export type Edges = { top: number; bottom: number; left: number; right: number };

export interface ImmutableSnapshot {
  readonly harnessVersion: string;
  readonly codeVersion: string;
  readonly cert: string;
  readonly face: "front" | "back";
  readonly sourceSha: string;
  readonly sourceW: number;
  readonly sourceH: number;
  readonly centredSha: string;
  readonly centredW: number;
  readonly centredH: number;
  readonly detectionState: string;
  readonly proposal: { w: number; h: number } | null;
  readonly edgeTrimPx: Edges | null;
  readonly rawMat: Edges | null;
  readonly plausibilityState: string;
  readonly matUsableForAcceptance: boolean;
  /** Pre-decision measured confidence — NEVER report.cropConfidence. */
  readonly measuredConfidenceBeforeDecision: "high" | "low";
  readonly discardedBand: Edges | null;
  readonly artefactDetected: boolean;
}

/** Structural deep clone that also drops any prototype/reference sharing. */
function clone<T>(v: T): T {
  return v == null ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    for (const k of Object.keys(o as Record<string, unknown>)) {
      deepFreeze((o as Record<string, unknown>)[k]);
    }
    Object.freeze(o);
  }
  return o;
}

export interface SnapshotMeta {
  cert: string;
  face: "front" | "back";
  sourceSha: string;
  sourceW: number;
  sourceH: number;
  centredSha: string;
  centredW: number;
  centredH: number;
  codeVersion: string;
}

/**
 * Build the immutable snapshot from a COMPLETED tightenForDisplay report.
 * Everything is cloned out of the report, so later mutation of that report
 * (or of either decision path) cannot reach the snapshot.
 */
export function buildSnapshot(report: CropIntegrityReport, meta: SnapshotMeta): ImmutableSnapshot {
  const snap: ImmutableSnapshot = {
    harnessVersion: HARNESS_VERSION,
    codeVersion: meta.codeVersion,
    cert: meta.cert,
    face: meta.face,
    sourceSha: meta.sourceSha,
    sourceW: meta.sourceW,
    sourceH: meta.sourceH,
    centredSha: meta.centredSha,
    centredW: meta.centredW,
    centredH: meta.centredH,
    detectionState: report.cardDetectionState,
    proposal: report.proposed ? { w: report.proposed.w, h: report.proposed.h } : null,
    edgeTrimPx: clone(report.edgeTrimPx),
    rawMat: report.retainedMat
      ? {
          top: report.retainedMat.top,
          bottom: report.retainedMat.bottom,
          left: report.retainedMat.left,
          right: report.retainedMat.right,
        }
      : null,
    plausibilityState: report.matPlausibility?.state ?? "not_recorded",
    matUsableForAcceptance: report.matUsedForAcceptance,
    // THE FIX: pre-decision confidence, not report.cropConfidence.
    measuredConfidenceBeforeDecision: report.retainedMat?.confidence ?? "low",
    discardedBand: clone(report.discardedBandContentFraction),
    artefactDetected: (report.matPlausibility?.state ?? "").includes("artefact_skip"),
  };
  return deepFreeze(snap);
}

export type PathName = "baseline" | "patched";

export interface PathOutcome {
  path: PathName;
  appliedConfidence: "high" | "low";
  toleranceMm: number;
  toleranceReason: "strict_measured_mat" | "widened_low_confidence" | "unknown_mat_ceiling";
  decision: "accepted" | "rejected";
  reasons: string[];
  matUsed: Edges | null;
}

/** Mirrors the production tolerance rule exactly; changes nothing about it. */
function toleranceFor(mat: Edges | null, confidence: "high" | "low"): { mm: number; reason: PathOutcome["toleranceReason"] } {
  if (!mat) return { mm: MAX_EDGE_TRIM_UNKNOWN_MAT_MM, reason: "unknown_mat_ceiling" };
  return confidence === "low"
    ? { mm: MAX_EDGE_TRIM_BEYOND_MAT_MM * LOW_CONFIDENCE_MAT_MULTIPLE, reason: "widened_low_confidence" }
    : { mm: MAX_EDGE_TRIM_BEYOND_MAT_MM, reason: "strict_measured_mat" };
}

/**
 * Evaluate ONE path from a freshly cloned copy of the snapshot's inputs.
 * `baseline` trusts the raw mat (pre-plausibility behaviour); `patched`
 * withholds it when plausibility marked it unusable.
 */
export function runPath(snap: ImmutableSnapshot, path: PathName): PathOutcome | null {
  if (!snap.proposal || !snap.edgeTrimPx) return null;
  const rawMat = clone(snap.rawMat);
  const matUsed = path === "baseline" ? rawMat : snap.matUsableForAcceptance ? rawMat : null;
  const confidence = snap.measuredConfidenceBeforeDecision;
  const tol = toleranceFor(matUsed, confidence);
  const v = evaluateCropIntegrity({
    inputW: snap.centredW,
    inputH: snap.centredH,
    cropLeft: snap.edgeTrimPx.left,
    cropTop: snap.edgeTrimPx.top,
    cropW: snap.proposal.w,
    cropH: snap.proposal.h,
    discardedBandContentFraction: clone(snap.discardedBand) ?? undefined,
    matMarginPx: matUsed,
    matConfidence: confidence,
  });
  return {
    path,
    appliedConfidence: confidence,
    toleranceMm: tol.mm,
    toleranceReason: tol.reason,
    decision: v.accepted ? "accepted" : "rejected",
    reasons: [...v.reasons],
    matUsed,
  };
}

export interface ComparisonResult {
  snapshot: ImmutableSnapshot;
  baseline: PathOutcome | null;
  patched: PathOutcome | null;
  changed: boolean;
  changeKind: "none" | "baseline_only_accepted" | "patched_only_accepted" | "no_proposal";
}

/** Run both paths. `order` exists solely so tests can prove order independence. */
export function compare(snap: ImmutableSnapshot, order: PathName[] = ["baseline", "patched"]): ComparisonResult {
  const out: Partial<Record<PathName, PathOutcome | null>> = {};
  for (const p of order) out[p] = runPath(snap, p);
  const baseline = out.baseline ?? null;
  const patched = out.patched ?? null;
  let changeKind: ComparisonResult["changeKind"] = "none";
  if (!baseline || !patched) changeKind = "no_proposal";
  else if (baseline.decision !== patched.decision) {
    changeKind = baseline.decision === "accepted" ? "baseline_only_accepted" : "patched_only_accepted";
  }
  return { snapshot: snap, baseline, patched, changed: changeKind !== "none" && changeKind !== "no_proposal", changeKind };
}

/** Resume key — a cached row is reusable only when every component matches. */
export function resumeKey(snap: ImmutableSnapshot, optionsHash: string): string {
  return [
    snap.cert,
    snap.face,
    snap.sourceSha,
    snap.harnessVersion,
    snap.codeVersion,
    optionsHash,
  ].join("|");
}
