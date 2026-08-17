/**
 * Types for the canonical LiDE 400 capture profile.
 *
 * Hand-written for the same reason as the detector's: the implementation is CommonJS JavaScript so
 * the untranspiled Scanner and the esbuild server can share one copy. See the module header for the
 * geometry, the empirical basis for the 10 mm operator inset, and why the safe window is centred.
 */

export interface Lide400SizeMm {
  width: number;
  height: number;
}

export interface Lide400RectMm {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Lide400MarginMm {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Lide400CardRangeMm {
  nominalWidth: number;
  nominalHeight: number;
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight: number;
}

export interface Lide400CaptureProfile {
  id: string;
  label: string;
  version: string;
  scannerProfileVersion: string;
  coordinateSpace: string;
  cardMm: Readonly<Lide400CardRangeMm>;
  /** The FIXED capture area. Size is fixed; only its platen origin is calibrated. */
  outerWindowMm: Readonly<Lide400SizeMm>;
  /** THE authoritative master evidence floor, in millimetres. Never relaxed by a preview verdict. */
  evidenceMinMarginMm: number;
  /** Proven preview-to-master uncertainty. An input to previewGreenMinMarginMm, not a diagnostic. */
  previewToMasterBudgetMm: number;
  defaultOriginMm: Readonly<{ x: number; y: number }>;
  captureDpi: number;
  placementPreviewDpi: number;
}

export type Lide400PlacementState = "GREEN" | "RED";

export type Lide400PlacementCode =
  "ready" | "card_not_detected" | "card_outside_profile_range" | "card_inside_preview_margin";

export interface Lide400PlacementVerdict {
  state: Lide400PlacementState;
  code: Lide400PlacementCode;
  message: string;
  profileId: string;
  profileVersion: string;
  coordinateSpace: string;
  /** The capture area inset by the PREVIEW threshold: the rectangle the overlay draws. */
  placementBoundaryMm: Lide400RectMm;
  outerWindowMm: Lide400RectMm;
  evidenceMinMarginMm: number;
  cardBoundsMm: Lide400RectMm | null;
  marginMm?: Lide400MarginMm;
  minMarginMm?: number;
  /** Master floor + proven preview-to-master uncertainty. The threshold this verdict applied. */
  previewGreenMinMarginMm: number;
  /** RED only: how much further in the card must move to reach GREEN. */
  moveInwardMm?: number;
  /** RED only: the margin clears the master floor but not the preview threshold. */
  wouldLikelyPassMaster?: boolean;
}

export declare const PLATEN_MM: Readonly<Lide400SizeMm>;
export declare const MIN_PLATEN_INSET_MM: number;
export declare const COORDINATE_SPACE: string;
export declare const STANDARD_TCG: Lide400CaptureProfile;
export declare const PROFILES: Readonly<Record<string, Lide400CaptureProfile>>;
export declare const DEFAULT_PROFILE_ID: string;
export declare const PLACEMENT: Readonly<{ READY: "GREEN"; REPOSITION: "RED" }>;
export declare const PLACEMENT_MESSAGE: Readonly<{
  ready: string;
  reposition: string;
  notDetected: string;
  wrongProfile: string;
}>;

export declare function profileById(id?: string): Lide400CaptureProfile;
/** Master evidence floor + proven preview-to-master uncertainty. Derived; 5.6 is never a literal. */
export declare function previewGreenMinMarginMm(profile?: Lide400CaptureProfile): number;
export declare function placementBoundaryRectMm(profile?: Lide400CaptureProfile): Lide400RectMm;
export declare function clampCaptureOriginMm(
  origin: { x: number; y: number },
  profile?: Lide400CaptureProfile,
  platen?: Lide400SizeMm
): {
  originMm: { x: number; y: number };
  clamped: boolean;
  boundsMm: { minX: number; maxX: number; minY: number; maxY: number };
};
export declare function captureWindowRectMm(
  originMm: { x: number; y: number },
  profile?: Lide400CaptureProfile
): Lide400RectMm;
/** Real detected card bounds in canonical acquisition-rect millimetres — never a nominal size. */
export declare function evaluatePlacement(
  cardBoundsMm: { x: number; y: number; width: number; height: number } | null | undefined,
  profile?: Lide400CaptureProfile
): Lide400PlacementVerdict;
export declare function placementToleranceMm(
  cardSizeMm: Lide400SizeMm,
  profile?: Lide400CaptureProfile
): { horizontal: number; vertical: number };
export declare function assertPlacementBoundaryIsRotationInvariant(profile: Lide400CaptureProfile): true;
