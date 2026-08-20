import { useState, useRef, useEffect, useLayoutEffect, lazy, Suspense } from "react";
import { sessionRequiredRailWidth } from "@shared/rail-width";
import { usePublishRailWidth } from "@/components/grading-workflow/rail-width-context";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import {
  Pencil,
  Eye,
  EyeOff,
  X,
  Maximize2,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Trash2,
  Upload,
  Loader2,
  Crop,
} from "lucide-react";

const ManualCrop = lazy(() => import("./manual-crop"));
import { MVGS_DEFECT_TYPES, deriveZone, LINE_COLOUR_PALETTE } from "./defect-annotation";
import type { Defect, MvgsCode } from "./defect-annotation";
import DefectTypePicker from "./defect-type-picker";
import { detectEdge, coverageFromSegment, creaseSpanFromSegment } from "./measurement-math";
import {
  inspectionViewToPercentFocus,
  normaliseCardInspectionState,
  percentFocusToInspectionView,
  updateCardInspectionView,
  type CardInspectionState,
} from "../grading-workflow/card-inspection-state";

type Side = "front" | "back" | "angled" | "closeup";
type Variant = "original" | "greyscale" | "highcontrast" | "edgeenhanced" | "inverted";

interface ImageUrls {
  front_original?: string | null;
  front_working?: string | null;
  front_working_cropped?: string | null;
  front_cropped?: string | null;
  /** 1600px q80 viewer derivatives — preferred main-viewer source. The
   *  server falls back to the full-res cropped key on certs that predate
   *  the derivative pipeline. */
  front_display?: string | null;
  back_display?: string | null;
  front_greyscale?: string | null;
  front_highcontrast?: string | null;
  front_edgeenhanced?: string | null;
  front_inverted?: string | null;
  back_original?: string | null;
  back_working?: string | null;
  back_working_cropped?: string | null;
  back_cropped?: string | null;
  back_greyscale?: string | null;
  back_highcontrast?: string | null;
  back_edgeenhanced?: string | null;
  back_inverted?: string | null;
  angled_original?: string | null;
  angled_cropped?: string | null;
  closeup_original?: string | null;
  closeup_cropped?: string | null;
}

interface WorkingEvidenceStatus {
  available: boolean;
  reason: string | null;
  recovery: string | null;
  master: { dpi: number | null; width: number | null; height: number | null } | null;
  working: { width: number | null; height: number | null; format: string | null } | null;
}

interface FrameRect {
  left_pct: number;
  right_pct: number;
  top_pct: number;
  bottom_pct: number;
}

export interface CenteringOverlayData {
  ratioLR: string;
  ratioTB: string;
  outerFrame?: FrameRect | null;
  innerFrame?: FrameRect | null;
}

interface Props {
  urls: ImageUrls;
  /** Server-verified 1200-DPI/master-dimension admission state. Never inferred from a URL. */
  workingEvidence?: Partial<Record<"front" | "back", WorkingEvidenceStatus>>;
  defects: Defect[];
  onDefectAdded: (defect: Defect) => void;
  /** Opens the 8-dot Card Tool for a side. When provided, "Card Tool (Front)"
   *  and "Card Tool (Back)" render at the start of the controls row under the
   *  image (owner-requested workflow: the tool launchers live with the image,
   *  next to Mark Defects / Manual Crop). Display-only relocation — the modal
   *  itself stays with the parent's state. */
  onOpenCardTool?: (side: "front" | "back") => void;
  /** Required for the click-marker-to-edit popover. Receives the full new
   *  defects array (after edit or delete). Optional for backward compat —
   *  marker clicks become no-ops if absent. */
  onDefectsChange?: (defects: Defect[]) => void;
  highlightId: number | null;
  referenceImageUrl?: string | null;
  centeringFront?: CenteringOverlayData | null;
  centeringBack?: CenteringOverlayData | null;
  certId?: number;
  onImageDeleted?: () => void;
  /** Panel-owned background crop upload, threaded to the ManualCrop (perspective
   *  crop) tool so it uses the same per-side cropSync lifecycle + approval gate
   *  as the 8-dot card tool instead of blocking on /recrop. */
  onStartCropUpload?: (payload: {
    side: "front" | "back";
    left_pct: number;
    top_pct: number;
    width_pct: number;
    height_pct: number;
    rotation_deg: number;
    quad: {
      tl: { x: number; y: number };
      tr: { x: number; y: number };
      br: { x: number; y: number };
      bl: { x: number; y: number };
    };
  }) => Promise<string | undefined>;
  onSideChange?: (side: string) => void;
  onZoomChange?: (zoom: number) => void;
  onModeChange?: (mode: { fullscreen: boolean; markMode: boolean }) => void;
  /** Shared presentation-only state. It is ignored by mark/crop coordinate
   * paths, which retain their transform-free image-relative geometry. */
  inspectionState?: CardInspectionState;
  onInspectionStateChange?: (state: CardInspectionState) => void;
  /** False outside the active Grade stage. Inspection remains interactive,
   * but defect, line, crop, upload and image-delete mutations are unavailable. */
  mutationsEnabled?: boolean;
  /**
   * Destructive/source-image operations are a narrower capability than grading
   * observations. Partner graders may mark defects and measure centering on an
   * admitted working image, but they must never be offered admin-only delete or
   * recrop controls. Defaults to `mutationsEnabled` for the established admin
   * callers so this is an explicit capability split, not a second workflow.
   */
  sourceImageMutationsEnabled?: boolean;
  /** When true, defect markers render but clicks are inert (tooltip explains
   *  why). Used by the post-approval read-only state in the parent's edit-mode
   *  gate so admins can still SEE the defects but can't edit until they click
   *  EDIT GRADE. */
  readOnly?: boolean;
  /** Optional controlled side. When provided, the parent owns the side state
   *  and ImageViewer becomes a controlled component for this prop. Falls back
   *  to internal state if undefined (preserves backward compat). */
  side?: Side;
  /** Hide the FRONT/BACK chip row in the inline (non-fullscreen) tab bar.
   *  Used when the parent renders its own chip row in a different layout
   *  position (e.g. above an absolute-positioning anchor wrapper). The
   *  fullscreen-mode renderTabs is unaffected. */
  omitSideTabs?: boolean;
  /**
   * True when this viewer is portaled into the canonical left rail
   * (`grading-interactive-card-host`), which is a BOUNDED, `overflow-hidden` box.
   *
   * The inline (non-portal) grid layout has no definite height, so the card frame
   * there is capped by a fixed pixel maxHeight. In the rail that constant is wrong:
   * when the host is shorter than it — 1024x768, and any laptop where browser chrome
   * reduces innerHeight — the aspect-ratio frame overflows the host and is CLIPPED,
   * which is the reported "card is cut off at the bottom". In the rail the frame must
   * instead be bounded by its real parent.
   */
  fillHost?: boolean;
  /**
   * Rendered on the SAME ROW as the Front/Back tabs, right-aligned into the space they
   * leave. The canonical certificate preview lives here rather than under the card:
   * beneath it, it consumed rail height the card needed and the owner's screenshot showed
   * the card's bottom edge — the set/rarity/promo/copyright strip graders must read — cut
   * off. In the top row it costs the card nothing, because the tabs row already exists.
   * Rail only; the inline grid never receives it.
   */
  topRowSlot?: ReactNode;
  /** MVGS v2.1 — line measurements drawn in-line with the pin tool. Mark
   *  mode gains a tool palette (Pin | Whitening | Crease); when whitening or
   *  crease is active, click-drag captures a segment. Each commit fires the
   *  matching onChange below with the FULL new array (replace-semantics).
   *  Omitted handlers → that tool option is hidden, mark-mode falls back to
   *  pin-only. The MeasurementTool overlay was retired; this is its
   *  replacement. */
  whiteningLines?: Array<{
    id?: string;
    side: "front" | "back";
    edge: "top" | "right" | "bottom" | "left";
    coveragePct: number;
    start?: { x: number; y: number };
    end?: { x: number; y: number };
    color?: string;
  }>;
  creaseLines?: Array<{
    id: string;
    side: "front" | "back";
    spanPct: number;
    start: { x: number; y: number };
    end: { x: number; y: number };
    color?: string;
  }>;
  onWhiteningLinesChange?: (next: NonNullable<Props["whiteningLines"]>) => void;
  onCreaseLinesChange?: (next: NonNullable<Props["creaseLines"]>) => void;
  /** API base for cert endpoints: '/api/admin' (default) or '/api/grader'. */
  apiBase?: string;
}

// Auto-map legacy `type` strings (from DEFECT_TYPES list or AI-defect
// shapes) to MVGS codes. Used when an existing pin lacks an mvgsCode at
// edit-popover open time. Falls through to null for unmapped types — the
// popover then defaults to WH so something is always selected.
export function mapLegacyTypeToMvgsCode(type: string | undefined | null): MvgsCode | null {
  if (!type) return null;
  const t = String(type).toLowerCase().trim();
  if (t === "whitening") return "WH";
  if (t === "scratch" || t === "scratch (surface)") return "SC";
  if (t === "scratch (gloss)" || t === "scratch (gloss-penetrating)" || t === "holo_scratch" || t === "holo scratch")
    return "SP";
  if (t === "stain") return "ST";
  if (t === "chip" || t === "edge chip") return "CH";
  if (t === "fray" || t === "edge roughness") return "FR";
  if (t === "print line" || t === "print_line") return "PL";
  if (t === "print spot") return "PS";
  if (t === "crease") return "CR";
  if (t === "corner rounding" || t === "corner softness") return "RD";
  if (t === "corner ding" || t === "indentation") return "DG";
  if (t === "silvering" || t === "silvering (holo)") return "SV";
  return null;
}

const SIDES: Side[] = ["front", "back"];

type WorkingEvidenceSource = "working-evidence";

interface WorkingEvidenceAsset {
  url: string;
  source: WorkingEvidenceSource;
}

/**
 * Every normal grading inspection is bound to the native-resolution working evidence. For LiDE
 * capture this is the canonical evidence-derived image the grading workflow uses; `*_original`
 * and `*_display` can be legacy or viewer derivatives and are never interchangeable inspection
 * sources. The immutable TIFF master remains server-side and is deliberately not represented as a
 * browser image URL here.
 *
 * Do not add a fallback here. An unavailable working asset must remain an explicit unavailable
 * state, rather than allowing a grader to mistake a low-resolution derivative for evidence.
 */
function getWorkingEvidenceAsset(urls: ImageUrls, side: Side): WorkingEvidenceAsset | null {
  if (side !== "front" && side !== "back") return null;
  const record = urls as Record<string, string | null | undefined>;
  const url = record[`${side}_working`];
  return url ? { source: "working-evidence", url } : null;
}

function hasAny(urls: ImageUrls, side: Side): boolean {
  const record = urls as Record<string, string | null | undefined>;
  return !!(
    record[`${side}_working`] ||
    record[`${side}_working_cropped`] ||
    record[`${side}_original`] ||
    record[`${side}_cropped`] ||
    record[`${side}_display`]
  );
}

const ZOOM_STEPS = [1, 1.5, 2, 3, 4, 6, 8, 12];
const WORKING_EVIDENCE_MAX_ZOOM = 12;

/**
 * Grading-rail SAFE FIT insets, in CSS pixels, applied symmetrically on each
 * axis so that centring the fitted image cannot spend one edge's allowance on
 * the opposite edge.
 *
 * The vertical inset is the binding requirement: the owner's acceptance bar is
 * a MINIMUM OF 12PX of visible clearance between the rendered source image's
 * bottom and the visible inspection viewport's bottom. 0px, 1px or 2px is not
 * "technically fits" — the grader has to be able to see that the scan ends.
 * 14 is set deliberately above the 12 floor so sub-pixel layout rounding can
 * never bring the measured clearance under the bar.
 *
 * Full visibility of the scan outranks card size. Do not reduce these to make
 * the card larger.
 */
const RAIL_SAFE_INSET_X = 10;
const RAIL_SAFE_INSET_Y = 14;
/** The contractual floor these insets exist to satisfy. */
export const RAIL_MIN_BOTTOM_CLEARANCE_PX = 12;

/**
 * Gap kept between the bottom of the rail's controls and the bottom of the REAL visible
 * viewport, so nothing in the left workstation sits on the very edge of the screen or
 * requires page scrolling to reach.
 */
export const RAIL_VISIBLE_BOTTOM_SAFETY_PX = 14;

/**
 * The card's available height, derived from the REAL VISIBLE VIEWPORT rather than from
 * the container it lives in.
 *
 * Exported pure so the contract can be driven directly: a right pane with a large
 * scrollHeight must not change the answer. The card is in flow, so it inflates its own
 * container; that container sits in a scrollable page, so `clientHeight` can report a
 * box far taller than the physical screen. Measuring the container cannot detect that —
 * the container is the thing being inflated.
 *
 * Every input here is card-INDEPENDENT: the card cannot move its own top (fixed-height
 * header above) and cannot change the controls' height below it.
 */
export function railAvailableHeight(input: {
  /** The measured container height. Applies only when it is the TIGHTER ceiling. */
  containerH: number;
  /** window.visualViewport?.height ?? window.innerHeight */
  visibleH: number;
  /** The card viewport's top, in viewport coordinates. */
  top: number;
  /** Height of the controls row rendered beneath the card. */
  controlsH: number;
}): number {
  const { containerH, visibleH, top, controlsH } = input;
  if (!(visibleH > 0) || !Number.isFinite(visibleH)) return containerH;
  const fromVisible = visibleH - top - controlsH - RAIL_VISIBLE_BOTTOM_SAFETY_PX;
  if (!Number.isFinite(fromVisible)) return containerH;
  return Math.min(containerH, fromVisible);
}

/**
 * THE RATCHET — the single decision that keeps the card from oscillating.
 *
 * Exported as a pure function so the stability contract can be driven over many
 * measurement cycles in a test, rather than asserted from the shape of the source.
 *
 * A committed fit is replaced only when:
 *   - nothing is committed yet, or
 *   - the viewport WIDTH changed. Width is card-independent (the viewport is `min-w-0`
 *     + `overflow-hidden`), so this is the one-way dependency: layout -> width -> fit.
 *   - the available HEIGHT SHRANK. Shrinking must be honoured or the card overflows;
 *     GROWTH is refused, and growth is the only thing the feedback loop can offer.
 *
 * Refusing growth is what makes the loop provably terminating: the card growing can
 * only ever increase the measured height, and an increase is ignored.
 */
export function shouldRecommitRailFit(
  prev: { vw: number; vh: number; h: number } | null,
  next: { vw: number; vh: number }
): boolean {
  if (!prev) return true;
  // Width is the one card-independent input: the viewport is `min-w-0` +
  // `overflow-hidden`, so the card cannot widen the rail. A real width change is
  // always worth refitting for.
  if (Math.abs(prev.vw - next.vw) >= 1) return true;
  // ECHO GUARD — the defect the convergence model caught.
  //
  // Where the host's height is content-driven, the viewport's height IS the card we
  // just committed. Treating that as an external constraint subtracts the safety inset
  // from the card AGAIN on the next cycle, and again on the one after: the model shrank
  // the card by 28px per cycle, 18 times, until width finally bound. That is not a
  // flicker, it is a slow visible shrink — and it is the "shrinking/growing cycles" in
  // the owner's report. A measured height that equals our own committed card height is
  // our own output coming back, not new information.
  if (Math.abs(next.vh - prev.h) <= 2) return false;
  // A genuine shrink must still be honoured, or the card overflows its box. Growth is
  // refused — growth is all the feedback loop can offer, so refusing it terminates.
  return next.vh <= prev.vh - 1;
}

function nextZoomStep(current: number): number {
  for (const s of ZOOM_STEPS) {
    if (s > current + 0.01) return s;
  }
  return ZOOM_STEPS[ZOOM_STEPS.length - 1];
}

function prevZoomStep(current: number): number {
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
    if (ZOOM_STEPS[i] < current - 0.01) return ZOOM_STEPS[i];
  }
  return 1;
}

const PULSE_CSS = `
@keyframes defect-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(212,175,55,0.4); }
  50% { box-shadow: 0 0 0 6px rgba(212,175,55,0); }
}
.defect-ring-pulse { animation: defect-pulse 2s ease-in-out infinite; }
`;

// Custom cursor for mark-defects mode — mirrors the pin marker so the
// admin can preview placement before clicking. 24×24 SVG, hotspot at the
// glyph centre (12, 12). Encoded once at module load.
const PIN_CURSOR_SVG = encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24">' +
    '<circle cx="12" cy="12" r="10" fill="none" stroke="#D4AF37" stroke-width="2"/>' +
    '<circle cx="12" cy="12" r="3" fill="#D4AF37"/>' +
    "</svg>"
);
const PIN_CURSOR = `url("data:image/svg+xml,${PIN_CURSOR_SVG}") 12 12, crosshair`;

export default function ImageViewer({
  urls,
  workingEvidence,
  defects,
  onDefectAdded,
  onDefectsChange,
  highlightId,
  referenceImageUrl,
  centeringFront,
  centeringBack,
  certId,
  onImageDeleted,
  onStartCropUpload,
  onSideChange,
  onZoomChange,
  onModeChange,
  inspectionState,
  onInspectionStateChange,
  mutationsEnabled = true,
  sourceImageMutationsEnabled,
  readOnly,
  side: controlledSide,
  omitSideTabs,
  fillHost = false,
  topRowSlot,
  onOpenCardTool,
  whiteningLines = [],
  creaseLines = [],
  onWhiteningLinesChange,
  onCreaseLinesChange,
  apiBase = "/api/admin",
}: Props) {
  const mayMutateSourceImage = sourceImageMutationsEnabled ?? mutationsEnabled;
  // Inline defect-edit popover anchored to a clicked marker. Null = closed.
  // Stores the defect id rather than the whole defect so we always read fresh
  // values from the live `defects` array (avoids stale closures during edit).
  const [editingDefectId, setEditingDefectId] = useState<number | null>(null);
  // Viewport-space rect of the marker the popover is anchored to. Captured
  // at click time so the popover (which renders via portal into document.body
  // to escape the image container's stacking context + overflow:hidden) can
  // position itself with `position: fixed` against the marker's screen coords.
  const [editingDefectAnchor, setEditingDefectAnchor] = useState<DOMRect | null>(null);
  // Only an actual admin route may offer an image-upload recovery. Partner grading has no
  // equivalent endpoint: it must show the server-owned Canon capture/regeneration instruction,
  // never a control that will fail authorization after the operator has selected a file.
  const mayUploadRecoveryEvidence = apiBase === "/api/admin" || apiBase.startsWith("/api/admin/");
  // Close popover on ESC. Plus a no-op cleanup when popover is closed —
  // the listener bind/unbind is cheap.
  useEffect(() => {
    if (editingDefectId == null) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setEditingDefectId(null);
        setEditingDefectAnchor(null);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [editingDefectId]);
  // Mutator helpers — both go through onDefectsChange. If not wired, marker
  // clicks degrade to no-op (and we'd never have opened the popover anyway
  // because `clickable` falls through to false).
  function updateDefectField<K extends keyof Defect>(id: number, key: K, value: Defect[K]) {
    if (!mutationsEnabled || !onDefectsChange) return;
    onDefectsChange(defects.map((d) => (d.id === id ? { ...d, [key]: value } : d)));
  }
  function deleteDefect(id: number) {
    if (!mutationsEnabled || !onDefectsChange) return;
    onDefectsChange(defects.filter((d) => d.id !== id));
    setEditingDefectId(null);
    setEditingDefectAnchor(null);
  }

  const [internalSide, setSideRaw] = useState<Side>("front");
  // Controlled when `side` prop supplied; otherwise falls back to internal state.
  const side: Side = controlledSide ?? internalSide;
  // The processed variants remain part of the image contract for server-side
  // grading work, but the normal workstation now presents one primary colour
  // inspection view. Removing the filter row gives the card its vertical space
  // back; it does not alter derivative generation, storage, or grading maths.
  const variant: Variant = "original";

  // Pin / overlay rendering reference frame: the IMG element's box. Click
  // coords are read from imgElRef.getBoundingClientRect() (see
  // handleContainerClick / imagePctFromEvent), and pins render at `left: x%,
  // top: y%` of the zoom-pan div — which is `w-full h-full` of the outer's
  // content area, the SAME box the <img> occupies (img is also w-full h-full
  // of the zoom-pan div). So clicks and renders both reference the IMG
  // element box automatically, by CSS, with no measurement state.
  //
  // (Previously a separate imgBox state + ResizeObserver + sized wrapper
  // sat between the img and the pins, introduced to handle a "drift on
  // layout reflow" symptom. That approach raced layout transitions — the
  // measured wrapper could carry stale dims when the operator clicked
  // immediately after entering mark mode, dropping pins at the wrong %.
  // Card Tool has always used the simpler one-element pattern; mark mode
  // now matches.)
  const [showReference, setShowReference] = useState(false);
  const [zoom, setZoomRaw] = useState(1);
  /** Normal inspection mode stores the image-relative focal point as percent.
   * Mark mode still uses its existing native-scroll geometry below. */
  const [pan, setPanRaw] = useState({ x: 50, y: 50 });
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ pointerX: 0, pointerY: 0, focusX: 50, focusY: 50 });
  const [showDefects, setShowDefects] = useState(true);
  const [showCentering, setShowCentering] = useState(false);
  const [markMode, setMarkModeRaw] = useState(false);
  // Pin tap-vs-scroll discrimination: screen coords of the last pointerdown over
  // the card. A pin only drops if the pointer barely moved by the click — a
  // touch scroll-drag fires a synthetic click that otherwise dropped a defect.
  const tapStartRef = useRef<{ x: number; y: number } | null>(null);
  const [fullscreen, setFullscreenRaw] = useState(false);

  // MVGS v2.1 — mark-mode tool palette. `pin` (existing) | `whitening` |
  // `crease`. Pin path is completely untouched when this is "pin"; gate is
  // checked once at click time so non-line-mode behaviour is byte-identical
  // to v2.0. Line tools are only mounted when the matching onChange handler
  // is wired by the parent.
  type MarkTool = "pin" | "whitening" | "crease";
  const [markTool, setMarkTool] = useState<MarkTool>("pin");
  // MVGS v2.1 — currently selected line colour (display-only). Picked in the
  // palette BEFORE drawing; each new whitening/crease line is born with this
  // colour. Change the palette → the NEXT line uses it; already-drawn lines
  // keep their own colour. Stripped at the mvgs-input-builder boundary, so it
  // never reaches the engine.
  const [lineColor, setLineColor] = useState<string>(LINE_COLOUR_PALETTE[0]);
  // In-progress line drawing (image-relative percent coords). Mouse-down
  // captures `lineStart`, mouse-move tracks `lineEnd` for the live preview,
  // mouse-up commits via onWhiteningLinesChange / onCreaseLinesChange.
  const [lineStart, setLineStart] = useState<{ x: number; y: number } | null>(null);
  const [lineEnd, setLineEnd] = useState<{ x: number; y: number } | null>(null);
  const canDrawWhitening = mutationsEnabled && !!onWhiteningLinesChange;
  const canDrawCrease = mutationsEnabled && !!onCreaseLinesChange;

  function maxZoom() {
    if (!markMode) return WORKING_EVIDENCE_MAX_ZOOM;
    return 6;
  }

  const publishInspection = (nextZoom: number, nextPan: { x: number; y: number }) => {
    if (!inspectionState || !onInspectionStateChange || markMode) return;
    onInspectionStateChange(
      updateCardInspectionView(
        inspectionState,
        side as "front" | "back",
        percentFocusToInspectionView(nextZoom, nextPan)
      )
    );
  };

  function commitViewport(nextZoom: number, nextPan: { x: number; y: number }) {
    const boundedPan = {
      x: Math.max(0, Math.min(100, nextPan.x)),
      y: Math.max(0, Math.min(100, nextPan.y)),
    };
    const boundedZoom = Math.min(maxZoom(), Math.max(1, nextZoom));
    setZoomRaw(boundedZoom);
    setPanRaw(boundedPan);
    publishInspection(boundedZoom, boundedPan);
    onZoomChange?.(boundedZoom);
  }

  function setPan(next: { x: number; y: number }) {
    commitViewport(zoom, next);
  }

  function setSide(s: Side) {
    // Only mutate internal state when uncontrolled. Controlled callers
    // own the state — they must call onSideChange's value back into props.
    if (controlledSide === undefined) setSideRaw(s);
    if (inspectionState && onInspectionStateChange && (s === "front" || s === "back")) {
      onInspectionStateChange(normaliseCardInspectionState({ ...inspectionState, side: s }));
    }
    onSideChange?.(s);
  }

  // Side-effects on side change (zoomReset + clear reference view) need to
  // fire on EVERY transition, not just clicks of the internal chip row —
  // otherwise a controlled-side change from the parent's external chips
  // would leave the zoom/reference state stale. Mirrors what the inline
  // chip onClick used to do directly.
  const prevSideRef = useRef<Side>(side);
  useEffect(() => {
    if (prevSideRef.current !== side) {
      prevSideRef.current = side;
      setShowReference(false);
      const saved = inspectionState?.views[side as "front" | "back"];
      const nextZoom = !markMode && saved ? saved.zoom : 1;
      const nextPan = !markMode && saved ? inspectionViewToPercentFocus(saved) : { x: 50, y: 50 };
      setZoomRaw(nextZoom);
      setPanRaw(nextPan);
      onZoomChange?.(nextZoom);
    }
  }, [inspectionState, markMode, side, onZoomChange]);
  useEffect(() => {
    if (!inspectionState || markMode || (side !== "front" && side !== "back")) return;
    const saved = inspectionState.views[side];
    setZoomRaw(saved.zoom);
    setPanRaw(inspectionViewToPercentFocus(saved));
  }, [inspectionState, markMode, side]);
  function setZoom(z: number | ((prev: number) => number)) {
    const requested = typeof z === "function" ? z(zoom) : z;
    commitViewport(requested, pan);
  }
  function setMarkMode(v: boolean) {
    setMarkModeRaw(v);
    onModeChange?.({ fullscreen: fullscreen, markMode: v });
  }
  function setFullscreen(v: boolean) {
    setFullscreenRaw(v);
    onModeChange?.({ fullscreen: v, markMode: markMode });
  }

  useEffect(() => {
    onSideChange?.(inspectionState?.side ?? "front");
  }, []);
  const [manualCropSide, setManualCropSide] = useState<"front" | "back" | null>(null);
  // A signed URL is only a capability to attempt a read. If the browser cannot
  // decode/load it, keep the failure visible and fail closed for this exact URL;
  // never reveal a compact derivative underneath it.
  const [failedWorkingUrl, setFailedWorkingUrl] = useState<string | null>(null);
  useEffect(() => {
    if (mutationsEnabled) return;
    setManualCropSide(null);
    setPickerOpen(false);
    setPendingBatch([]);
    setLineStart(null);
    setLineEnd(null);
    if (markMode) {
      setMarkMode(false);
      setFullscreen(false);
    }
  }, [mutationsEnabled]);
  // Batch defect placement: admin drops multiple pins (each click adds one),
  // then assigns a defect type once for the whole batch via the picker.
  // x/y are image-relative percents; pxX/pxY are viewport-absolute pixels
  // captured at click-time (drive the picker portal anchor — viewport pixels
  // because the image container has a scale() transform which would break
  // position:fixed otherwise). localId is the 1..N display number; real
  // defect ids are assigned in commitBatch.
  type PendingPin = {
    x: number;
    y: number;
    pxX: number;
    pxY: number;
    location: string;
    image_side: string;
    localId: number;
  };
  const [pendingBatch, setPendingBatch] = useState<PendingPin[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerAnchor, setPickerAnchor] = useState<{ pxX: number; pxY: number; xPct: number; yPct: number } | null>(
    null
  );
  // MVGS tier selection inside the picker — defaults to D2 (most common
  // mid-tier) so a single click + type pick can commit the batch.
  const [pickerTier, setPickerTier] = useState<"D1" | "D2" | "D3">("D2");
  const lastClickTimeRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const imgElRef = useRef<HTMLImageElement>(null);

  // ── Mark-mode shrink-wrap state (mirrors manual-card-tool.tsx) ──────────
  // Card Tool's working pattern: img has EXPLICIT pixel dimensions (no
  // object-contain letterbox), the container shrink-wraps the img, pins are
  // direct absolute children of the container. The IMG element box then
  // always equals the visible image area on both sides — no element-box-vs-
  // visible-image mismatch (the bug that left BACK pin placement broken
  // after the b17cc57 fix worked only on FRONT).
  //
  // fitBox = the scrollable area's measured dimensions; baseFit scales the
  // image to fit inside fitBox preserving the image's intrinsic aspect;
  // renderW × renderH = baseFit × zoom drives the img's explicit
  // width/height. At zoom > 1 the img grows beyond fitBox and native scroll
  // on the wrapper handles panning. Inline (non-mark-mode) view keeps its
  // existing aspectRatio + object-contain layout untouched.
  const fitRef = useRef<HTMLDivElement>(null);
  const [fitBox, setFitBox] = useState<{ w: number; h: number } | null>(null);
  const [imgNaturalDims, setImgNaturalDims] = useState<{ w: number; h: number } | null>(null);

  // ── Rail SAFE FIT (owner defect 2026-08-16: the physical card's bottom edge) ──
  //
  // Every previous geometry check measured the FRAME rectangle and reported
  // "clipped = 0" while the owner still could not see the bottom of the scan.
  // Both halves of that contradiction were real, and neither was about the frame:
  //
  //   1. The frame sized itself with `aspectRatio: 5/7` + `maxHeight: 100%` and
  //      the <img> filled its content box exactly (`w-full h-full`). The only
  //      separation was the frame's own `padding: 1.5%` — about 4.5px, which is
  //      padding, not visible clearance. The card ran to the very edge.
  //   2. The frame carried `rounded-[5%]` together with `overflow-hidden`. At a
  //      ~370px-wide card that is an ~18px corner radius cutting into the scan's
  //      lower corners — exactly where the set symbol, card number and copyright
  //      line sit. The image RECTANGLE was inside the frame RECTANGLE the whole
  //      time; the rounded mask removed content anyway, so a rect-vs-rect test
  //      could never see it.
  //
  // The fix is to stop asking CSS to infer the fit. We measure the real
  // remaining-space viewport, read the scan's own natural dimensions, and
  // compute explicit rendered pixels with a guaranteed safety inset — so the
  // <img> itself, not a wrapper, is the fitted authority. Scoped to the grading
  // rail (`fillHost` && !markMode); the inline and public viewers are untouched.
  const railViewportRef = useRef<HTMLDivElement>(null);
  const [railViewport, setRailViewport] = useState<{ w: number; h: number } | null>(null);
  const [railNaturalDims, setRailNaturalDims] = useState<{ w: number; h: number } | null>(null);
  /**
   * Natural dimensions of every SIDE seen this session, keyed by railFitKey.
   *
   * The rail requirement is the widest across all known sides, never the active
   * one — Front and Back are separate scans with their own aspects, and sizing
   * the rail to whichever is showing would shove the workstation sideways on
   * every Front/Back click. These are DECODED SOURCE dimensions, fixed before
   * layout, so reading them never observes a rendered card.
   */
  const railNaturalBySideRef = useRef<Record<string, { w: number; h: number }>>({});
  const [railSidesRevision, setRailSidesRevision] = useState(0);
  const publishRailWidth = usePublishRailWidth();

  // Measure the scrollable fitRef's box on mount + resize. ResizeObserver
  // re-fires whenever the parent flex layout reflows (e.g. toolbar wraps,
  // window resizes). Only meaningful in mark mode — outside mark mode
  // fitRef is unmounted and the effect bails on the null ref.
  useLayoutEffect(() => {
    const el = fitRef.current;
    if (!el) return;
    const measure = () => {
      const w = Math.floor(el.clientWidth);
      const h = Math.floor(el.clientHeight);
      setFitBox((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [markMode]);

  // Re-measure the img's natural dimensions on side / variant change. The
  // onLoad handler on the <img> sets this; null until first load completes.
  // Reset to null on side / variant switch so a stale dim doesn't drive
  // renderW/H for the new image.
  useEffect(() => {
    setImgNaturalDims(null);
    // Same reasoning for the rail: a stale natural size from the previous side
    // would fit the NEW scan to the OLD aspect and could push content off-edge.
    setRailNaturalDims(null);
  }, [side, variant]);

  // baseFit: the image scaled to fit inside fitBox preserving its intrinsic
  // aspect ratio (the math object-contain would do, but expressed as
  // explicit pixel dims so the IMG element box matches the visible image).
  const baseFit =
    fitBox && imgNaturalDims && imgNaturalDims.w > 0 && imgNaturalDims.h > 0
      ? (() => {
          const s = Math.min(fitBox.w / imgNaturalDims.w, fitBox.h / imgNaturalDims.h);
          return { w: imgNaturalDims.w * s, h: imgNaturalDims.h * s };
        })()
      : null;
  // renderW / renderH apply directly to the <img> as width/height. At
  // zoom > 1 the image grows past fitBox; the wrapper's overflow:auto
  // scrolls. No CSS transform in this mode — the math stays
  // transform-free, so getBoundingClientRect and CSS dims line up exactly.
  const renderW = baseFit ? baseFit.w * zoom : null;
  const renderH = baseFit ? baseFit.h * zoom : null;

  // The rail's safe fit applies to the inspection view only. Mark mode already
  // owns its own explicit-pixel fit (fitBox / baseFit above) and must not change.
  const railFitEnabled = fillHost && !markMode;

  // Measure the REAL remaining-space card viewport — the `min-h-0 flex-1` box
  // that sits between the tabs row and the controls row. Its border box is the
  // rectangle the owner sees, so it is also the rectangle clearances are
  // measured against.
  useLayoutEffect(() => {
    const el = railViewportRef.current;
    if (!el) return;
    const measure = () => {
      const w = Math.floor(el.clientWidth);
      const h = Math.floor(el.clientHeight);
      railObserverCountRef.current += 1;
      setRailViewport((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [railFitEnabled, showReference]);

  /**
   * FIT STABILITY — owner P0, staging v492: the card alternated between visible and
   * not-visible, fast enough that the workstation was unusable.
   *
   * The cause was a two-mode limit cycle, and it existed because the fit's OUTPUT could
   * become its own INPUT. The card is in flow inside the measured viewport, so wherever
   * an ancestor's height is content-driven the card's fitted height IS the viewport's
   * height:
   *
   *   no usable height -> fit by width -> card is tall (width x natural aspect)
   *     -> viewport now measures tall -> height "usable" -> fit by height
   *     -> card shrinks -> viewport measures short -> height unusable
   *     -> fit by width -> card is tall again -> ...
   *
   * Each lap re-rendered the card at a different size, and the transient between laps is
   * the disappearance the owner photographed.
   *
   * The cure is a RATCHET, not a debounce. A feedback loop of this shape needs the
   * available height to GROW in response to the card growing; refusing to act on growth
   * makes it provably terminating. A committed fit is therefore replaced only when:
   *
   *   - there is no committed fit for this source yet, or
   *   - the viewport WIDTH changed. Width is card-independent: the viewport is
   *     `min-w-0` + `overflow-hidden`, so the card cannot widen the rail. This is the
   *     one-way dependency (rail layout -> width -> fit -> image).
   *   - the available HEIGHT SHRANK. Shrinking must be honoured or the card would
   *     overflow its box; growth is exactly what closes the loop, so it is ignored.
   *
   * Anything else — a transient zero, an invalid measurement, a sub-pixel jitter, a
   * height increase caused by the card itself — keeps the LAST KNOWN GOOD fit. Once the
   * card is visible it stays visible.
   */
  const railObserverCountRef = useRef(0);
  const railControlsRef = useRef<HTMLDivElement>(null);
  /**
   * A tick that changes whenever the REAL VISIBLE viewport changes, so the fit effect
   * re-runs. The value itself is unused — the measurement is taken live inside the
   * effect, from element rects, at the moment it matters.
   */
  const [visibleViewportTick, setVisibleViewportTick] = useState(0);

  useLayoutEffect(() => {
    if (!railFitEnabled) return;
    const bump = () => setVisibleViewportTick((t) => t + 1);
    const vv = window.visualViewport;
    window.addEventListener("resize", bump);
    vv?.addEventListener("resize", bump);
    vv?.addEventListener("scroll", bump);
    return () => {
      window.removeEventListener("resize", bump);
      vv?.removeEventListener("resize", bump);
      vv?.removeEventListener("scroll", bump);
    };
  }, [railFitEnabled]);
  const railFitRef = useRef<{
    key: string;
    vw: number;
    vh: number;
    w: number;
    h: number;
    mode: "safe-fit" | "width-fit";
    clearanceX: number;
    clearanceY: number;
    revision: number;
  } | null>(null);
  const [railFitRevision, setRailFitRevision] = useState(0);

  /** Last-known-good is per SOURCE. Front's fit must never be reused for Back. */
  const railFitKey = `${side}|${variant}`;

  useLayoutEffect(() => {
    if (!railFitEnabled) return;
    const nat = railNaturalDims;
    const vp = railViewport;
    if (!nat || !vp || nat.w <= 0 || nat.h <= 0) return;
    // An unusable width is never authoritative — keep whatever is already rendered.
    if (vp.w <= RAIL_SAFE_INSET_X * 2) return;

    const prev = railFitRef.current?.key === railFitKey ? railFitRef.current : null;

    /**
     * THE VISIBLE VIEWPORT IS THE CEILING — owner P0, real staging screenshot: roughly
     * half the card was BELOW the bottom of the MacBook screen while every measurement
     * said it fitted.
     *
     * Both statements were true. The card is in flow, so it makes its own container
     * taller; that container is inside a page that can scroll, so `clientHeight` happily
     * reported a box far taller than the physical screen. The card fitted its container
     * and the container ran off the display. Measuring the container can never detect
     * this — the container is the thing being inflated.
     *
     * So the authority is the real visible viewport, and the card is given only what is
     * left of it after the chrome above and the controls below:
     *
     *   available = visibleViewportHeight - cardViewportTop - controlsHeight - safety
     *
     * Every term is card-INDEPENDENT. The card cannot move its own top (the header above
     * is fixed height) and cannot change the controls' height, so this closes the
     * feedback path at the source rather than damping it. `visualViewport` is preferred
     * over `innerHeight` because it excludes browser UI and is correct under pinch-zoom.
     */
    const el = railViewportRef.current;
    const visibleH = window.visualViewport?.height ?? window.innerHeight;
    const availableH = el
      ? railAvailableHeight({
          containerH: vp.h,
          visibleH,
          top: el.getBoundingClientRect().top,
          controlsH: railControlsRef.current?.getBoundingClientRect().height ?? 0,
        })
      : vp.h;

    const heightUsable = availableH > RAIL_SAFE_INSET_Y * 2;
    // Sticky: once this source has been fitted against a real height, never drop back to
    // width-only. Mode flapping was half of the limit cycle.
    const mode: "safe-fit" | "width-fit" = heightUsable || prev?.mode === "safe-fit" ? "safe-fit" : "width-fit";
    const effectiveH = heightUsable ? availableH : (prev?.vh ?? 0);
    if (mode === "safe-fit" && effectiveH <= RAIL_SAFE_INSET_Y * 2) return;

    // The ratchet: ignore growth and sub-pixel jitter, keep the last known good fit.
    if (!shouldRecommitRailFit(prev ? { vw: prev.vw, vh: prev.vh, h: prev.h } : null, { vw: vp.w, vh: effectiveH }))
      return;

    const safeW = vp.w - RAIL_SAFE_INSET_X * 2;
    const safeH = effectiveH - RAIL_SAFE_INSET_Y * 2;
    const widthScale = safeW / nat.w;
    const scale = mode === "safe-fit" ? Math.min(widthScale, safeH / nat.h) : widthScale;
    if (!Number.isFinite(scale) || scale <= 0) return;

    const w = nat.w * scale;
    const h = nat.h * scale;
    railFitRef.current = {
      key: railFitKey,
      vw: vp.w,
      vh: effectiveH,
      w,
      h,
      mode,
      clearanceX: (vp.w - w) / 2,
      clearanceY: mode === "safe-fit" ? (effectiveH - h) / 2 : RAIL_SAFE_INSET_Y,
      revision: (railFitRef.current?.revision ?? 0) + 1,
    };
    setRailFitRevision((r) => r + 1);
  }, [railFitEnabled, railViewport, railNaturalDims, railFitKey, visibleViewportTick]);

  /**
   * PREDICT THE RAIL'S WIDTH — a PASSIVE effect, deliberately separate from the
   * fit above.
   *
   * It must not run inside the fit's `useLayoutEffect`. Publishing there updates
   * the provider synchronously mid-layout, which re-renders the aside (and the
   * portal host inside it) before the browser has settled; the card viewport's
   * ResizeObserver then reports height 0, the fit falls back to width-only mode,
   * and the card blows up to fill the rail. Reproduced on a cold load at
   * 1280x800: card 523x729.6 with the controls stranded at y=899, off-screen.
   * The fit's timing is load-bearing and is left exactly as it was.
   *
   * So the prediction runs AFTER paint, reads the same card-INDEPENDENT inputs
   * for itself, and never perturbs the fit that produced them. Every input is
   * upstream of layout: the visible viewport, the chrome above the card, the
   * chrome below it, and the SOURCE image's decoded aspect. No rendered card box
   * is read, so no card -> rail -> card loop can form.
   */
  useEffect(() => {
    if (!railFitEnabled) return;
    const el = railViewportRef.current;
    if (!el) return;
    const sides = Object.values(railNaturalBySideRef.current);
    if (sides.length === 0) return;
    const visibleH = window.visualViewport?.height ?? window.innerHeight;
    const box = el.getBoundingClientRect();
    const availableH = railAvailableHeight({
      containerH: box.height,
      visibleH,
      top: box.top,
      controlsH: railControlsRef.current?.getBoundingClientRect().height ?? 0,
    });
    const safeCardHeight = availableH - RAIL_SAFE_INSET_Y * 2;
    if (!(safeCardHeight > 0)) return;
    const required = sessionRequiredRailWidth(
      sides.map((d) => ({ naturalWidth: d.w, naturalHeight: d.h })),
      safeCardHeight
    );
    // Keyed on the input set. A genuinely new viewport, or a newly decoded side,
    // may legitimately need a NARROWER rail and must settle once; a narrowing at
    // an UNCHANGED key is the controls-wrap feedback signature, refused by
    // shouldAdoptRailWidth.
    publishRailWidth(`${Math.round(visibleH)}|${sides.length}`, required);
  }, [railFitEnabled, railFitRevision, railSidesRevision, visibleViewportTick, publishRailWidth]);

  // A new source starts with no last-known-good — Front's dimensions must never be
  // reused for Back, which has its own natural aspect.
  useLayoutEffect(() => {
    railFitRef.current = null;
    setRailFitRevision((r) => r + 1);
  }, [railFitKey]);

  /**
   * Height is fitted only when the viewport actually HAS a usable height.
   *
   * If an ancestor's height is content-driven rather than definite, the card is what
   * gives the rail its height — there is no "available height" to fit into, and
   * treating a 0 measurement as authoritative is what strands the image invisible.
   * In that case we fit by WIDTH alone and let the natural aspect decide the height,
   * which is both correct and always visible.
   */
  /**
   * The committed fit. Read from the ref rather than recomputed each render, so a
   * re-render caused by anything else (certificate state, defect edits, zoom) can never
   * resize the card. `railFitRevision` is what makes the ref-read reactive.
   */
  void railFitRevision;
  const railFit = railFitRef.current?.key === railFitKey ? railFitRef.current : null;

  const workingEvidenceAsset = getWorkingEvidenceAsset(urls, side);
  const workingEvidenceStatus = workingEvidence?.[side as "front" | "back"];
  const workingEvidenceLoadFailed = failedWorkingUrl === workingEvidenceAsset?.url;
  // A URL alone is not an admission decision. Requiring the companion server
  // proof prevents stale query data, an older endpoint, or a UI race from
  // presenting an otherwise plausible derivative as verified working evidence.
  const workingEvidenceAvailable =
    Boolean(workingEvidenceAsset) && workingEvidenceStatus?.available === true && !workingEvidenceLoadFailed;
  const currentUrl = workingEvidenceAvailable ? (workingEvidenceAsset?.url ?? null) : null;
  const unavailableReason = workingEvidenceLoadFailed
    ? "The canonical full-resolution working image could not be loaded."
    : (workingEvidenceStatus?.reason ?? `${side.toUpperCase()} cannot be graded from a display derivative.`);
  const unavailableRecovery = workingEvidenceLoadFailed
    ? "Restore the working evidence from the immutable 1200-DPI master, then reload this card."
    : (workingEvidenceStatus?.recovery ?? "Restore the canonical working evidence for this side.");
  const frontWorkingEvidenceAvailable =
    Boolean(getWorkingEvidenceAsset(urls, "front")) && workingEvidence?.front?.available === true;
  const backWorkingEvidenceAvailable =
    Boolean(getWorkingEvidenceAsset(urls, "back")) && workingEvidence?.back?.available === true;
  const sideDefects = defects.filter((d) => d.image_side === side);
  const frontDefectCount = defects.filter((d) => d.image_side === "front").length;
  const backDefectCount = defects.filter((d) => d.image_side === "back").length;

  // Keyboard shortcuts for fullscreen mode. Esc unwinds in order:
  // picker → pending batch → exit. Enter on a non-empty batch opens
  // the type picker. F/B switch sides (skipped while typing in a field).
  useEffect(() => {
    if (!fullscreen) return;
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      const inField = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || (t as any).isContentEditable);
      if (e.key === "Escape") {
        if (pickerOpen) {
          setPickerOpen(false);
          setPickerAnchor(null);
          return;
        }
        if (pendingBatch.length > 0) {
          setPendingBatch([]);
          return;
        }
        setFullscreen(false);
        setMarkMode(false);
      } else if (e.key === "Enter" && !inField && pendingBatch.length > 0 && !pickerOpen) {
        e.preventDefault();
        openTypePicker();
      } else if (!inField && (e.key === "f" || e.key === "F")) setSide("front");
      else if (!inField && (e.key === "b" || e.key === "B")) setSide("back");
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line
  }, [fullscreen, pendingBatch, pickerOpen]);

  function enterMarkMode() {
    if (!mutationsEnabled) return;
    setMarkMode(true);
    setFullscreen(true);
  }

  function exitMarkMode() {
    setFullscreen(false);
    setMarkMode(false);
    cancelBatch();
  }

  // Record the press origin so handleContainerClick can tell a tap from a
  // scroll/pan drag (pin tool only; mirrors the card tool's screen-px threshold).
  function handleMarkPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (mutationsEnabled && markMode && markTool === "pin") tapStartRef.current = { x: e.clientX, y: e.clientY };
  }

  function handleContainerClick(e: React.MouseEvent<HTMLDivElement>) {
    if (dragging) return;
    // Line tools intercept clicks via mousedown/mouseup (see handleMouseDown
    // /handleMouseUp); on click here we just skip so the existing pin path
    // doesn't fire too. lineStart != null = a drag is in progress.
    if (markMode && markTool !== "pin") return;
    if (mutationsEnabled && markMode && imgElRef.current) {
      // Tap vs scroll/pan: if the pointer moved more than 8px (screen) between
      // pointerdown and this click, it was a scroll/pan — not a pin tap. A touch
      // scroll-drag fires a synthetic click; without this it dropped a defect pin.
      const tapStart = tapStartRef.current;
      tapStartRef.current = null;
      if (tapStart && Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y) > 8) return;
      // Double-click shortcut: two clicks within 280ms = "Done" — open the
      // type picker on the current batch instead of dropping a 2nd pin.
      const now = Date.now();
      const isDoubleClick = now - lastClickTimeRef.current < 280;
      lastClickTimeRef.current = now;
      if (isDoubleClick) {
        if (pendingBatch.length > 0) openTypePicker();
        return;
      }
      const imgRect = imgElRef.current.getBoundingClientRect();
      const xPct = ((e.clientX - imgRect.left) / imgRect.width) * 100;
      const yPct = ((e.clientY - imgRect.top) / imgRect.height) * 100;
      const cx = Math.max(0, Math.min(100, xPct));
      const cy = Math.max(0, Math.min(100, yPct));
      const locDesc = locationFromPercent(cx, cy, side);
      setPendingBatch((prev) => [
        ...prev,
        { x: cx, y: cy, pxX: e.clientX, pxY: e.clientY, location: locDesc, image_side: side, localId: prev.length + 1 },
      ]);
      return;
    }
    if (zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1] - 0.01) {
      zoomReset();
    } else {
      const rect = e.currentTarget.getBoundingClientRect();
      commitViewport(nextZoomStep(zoom), {
        x: ((e.clientX - rect.left) / Math.max(1, rect.width)) * 100,
        y: ((e.clientY - rect.top) / Math.max(1, rect.height)) * 100,
      });
    }
  }

  // MVGS v2.1 — line-tool helpers. Image-relative percent coords are read
  // from the live `<img>` rect, identical to the pin path.
  function imagePctFromEvent(e: React.MouseEvent): { x: number; y: number } | null {
    const el = imgElRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100)),
      y: Math.max(0, Math.min(100, ((e.clientY - r.top) / r.height) * 100)),
    };
  }

  function lineMouseDown(e: React.MouseEvent) {
    if (!mutationsEnabled || !markMode) return;
    if (markTool === "pin") return;
    if (markTool === "whitening" && !canDrawWhitening) return;
    if (markTool === "crease" && !canDrawCrease) return;
    e.preventDefault();
    const p = imagePctFromEvent(e);
    if (!p) return;
    setLineStart(p);
    setLineEnd(p);
  }

  function lineMouseMove(e: React.MouseEvent) {
    if (!lineStart) return;
    const p = imagePctFromEvent(e);
    if (p) setLineEnd(p);
  }

  function lineMouseUp() {
    if (!mutationsEnabled) {
      setLineStart(null);
      setLineEnd(null);
      return;
    }
    if (!lineStart || !lineEnd) {
      setLineStart(null);
      setLineEnd(null);
      return;
    }
    // Trivially small click = ignore (operator just clicked, didn't drag).
    const dx = Math.abs(lineEnd.x - lineStart.x);
    const dy = Math.abs(lineEnd.y - lineStart.y);
    if (Math.max(dx, dy) < 2) {
      setLineStart(null);
      setLineEnd(null);
      return;
    }
    if (markTool === "whitening" && side !== "angled" && side !== "closeup" && onWhiteningLinesChange) {
      // Direction-first edge auto-detect (operator can override in the list).
      const edge = detectEdge(lineStart, lineEnd);
      const coveragePct = coverageFromSegment(lineStart, lineEnd, edge);
      const id = `wl-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      // APPEND — multiple whitening lines per (side, edge) are allowed.
      // Three separate whitened patches along the top stay distinct on the
      // card, in the list, individually deletable. The engine boundary in
      // shared/mvgs-input-builder.ts collapses to ONE entry per edge using
      // MAX coverage (worst-line-wins, no compounding) so extra lines don't
      // change the grade.
      const sideKey = side as "front" | "back";
      onWhiteningLinesChange([
        ...whiteningLines,
        { id, side: sideKey, edge, coveragePct, start: lineStart, end: lineEnd, color: lineColor },
      ]);
    } else if (markTool === "crease" && side !== "angled" && side !== "closeup" && onCreaseLinesChange) {
      const spanPct = creaseSpanFromSegment(lineStart, lineEnd);
      const id = `cl-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const sideKey = side as "front" | "back";
      // Crease appends — multiple creases per cert (longest wins in the engine).
      onCreaseLinesChange([
        ...creaseLines,
        { id, side: sideKey, spanPct, start: lineStart, end: lineEnd, color: lineColor },
      ]);
    }
    setLineStart(null);
    setLineEnd(null);
  }

  function handleWheel(e: React.WheelEvent) {
    e.preventDefault(); // prevent page scroll but don't zoom — use buttons instead
  }

  function zoomIn() {
    setZoom((z) => Math.min(maxZoom(), nextZoomStep(z)));
  }
  function zoomOut() {
    setZoom((z) => prevZoomStep(z));
  }
  function zoomReset() {
    commitViewport(1, { x: 50, y: 50 });
  }

  function handleMouseDown(e: React.MouseEvent) {
    // MVGS v2.1 — line tools take priority in mark mode. Pin path keeps
    // the pan/drag behaviour outside mark mode unchanged.
    if (markMode && markTool !== "pin") {
      lineMouseDown(e);
      return;
    }
    // Mark mode never uses the CSS-transform drag-pan — at zoom > 1 the
    // Card-Tool-style native scroll on fitRef handles panning. Activating
    // the custom drag here would set `dragging=true`, which bails out of
    // handleContainerClick → swallows pin-drop clicks. Skip entirely.
    if (markMode) return;
    if (zoom <= 1) return;
    setDragging(true);
    setDragStart({ pointerX: e.clientX, pointerY: e.clientY, focusX: pan.x, focusY: pan.y });
  }

  function handleMouseMove(e: React.MouseEvent) {
    if (lineStart) {
      lineMouseMove(e);
      return;
    }
    if (!dragging) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPan({
      x: dragStart.focusX - ((e.clientX - dragStart.pointerX) / Math.max(1, rect.width)) * 100,
      y: dragStart.focusY - ((e.clientY - dragStart.pointerY) / Math.max(1, rect.height)) * 100,
    });
  }

  function handleMouseUp() {
    if (lineStart) {
      lineMouseUp();
      return;
    }
    setDragging(false);
  }

  function openTypePicker() {
    const last = pendingBatch[pendingBatch.length - 1];
    if (!last) return;
    setPickerAnchor({ pxX: last.pxX, pxY: last.pxY, xPct: last.x, yPct: last.y });
    setPickerOpen(true);
  }

  function commitBatch(opts: { mvgsCode: MvgsCode; label: string; tier: "D1" | "D2" | "D3" }) {
    if (!mutationsEnabled) return;
    let nextId = defects.length > 0 ? Math.max(...defects.map((d) => d.id)) + 1 : 1;
    for (const pin of pendingBatch) {
      // Auto-derive zone from coords + side per the MVGS spec. Admin can
      // hand-edit later via the defect-annotation list if needed.
      const zone = deriveZone({ xPercent: pin.x, yPercent: pin.y, imageSide: pin.image_side });
      onDefectAdded({
        id: nextId++,
        // Legacy fields preserved for backwards compat — readers of d.type /
        // d.severity continue to work.
        type: opts.label,
        severity: "moderate",
        description: "",
        location: pin.location,
        image_side: pin.image_side,
        x_percent: pin.x,
        y_percent: pin.y,
        // MVGS fields — drive the scoring engine.
        mvgsCode: opts.mvgsCode,
        tier: opts.tier,
        zone,
      });
    }
    setPendingBatch([]);
    setPickerOpen(false);
    setPickerAnchor(null);
    setPickerTier("D2");
    // Stay in markMode so admin can start the next batch immediately.
  }

  function cancelBatch() {
    setPendingBatch([]);
    setPickerOpen(false);
    setPickerAnchor(null);
  }

  const transformStyle =
    zoom > 1 ? `scale(${zoom}) translate(${(50 - pan.x) / zoom}%, ${(50 - pan.y) / zoom}%)` : "none";
  const transitionStyle = dragging ? "none" : "transform 0.15s";

  // ── Shared tab bar ──────────────────────────────────────────────────────
  // The chip row (FRONT/BACK + trash) is suppressed when `omitSideTabs` is
  // true — used by the normal-inline grading-panel layout where the parent
  // renders a chip row in its own dedicated location above the absolute-
  // anchor wrapper for TL/T/TR labels. Fullscreen mode forces the chip row
  // ON regardless (its own self-contained layout has no external chip row).
  function renderTabs() {
    const showSideTabs = fullscreen || !omitSideTabs;
    return (
      <div className="space-y-1">
        {showSideTabs && (
          <div className="flex gap-2 overflow-x-auto pb-1">
            {SIDES.map((s) => {
              const count = s === "front" ? frontDefectCount : s === "back" ? backDefectCount : 0;
              const hasImage = hasAny(urls, s);
              return (
                <div key={s} className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => {
                      setSide(s);
                      setShowReference(false);
                      if (!inspectionState) zoomReset();
                    }}
                    disabled={!hasImage}
                    className={`flex-shrink-0 rounded-l px-3 py-2 text-[10px] font-bold uppercase tracking-wider border transition-all ${
                      side === s && !showReference
                        ? "border-[var(--admin-gold)] text-[var(--admin-gold)] bg-[var(--admin-gold)]/10"
                        : hasImage
                          ? "border-[var(--admin-line)] text-[var(--admin-ink-dim)] hover:border-[var(--admin-gold)]/40"
                          : "border-[var(--admin-line)] text-[var(--admin-ink-faint)] cursor-not-allowed"
                    }`}
                  >
                    {s}
                    {count > 0 ? ` (${count})` : ""}
                  </button>
                  {hasImage && certId && !fullscreen && mayMutateSourceImage && (
                    <button
                      type="button"
                      title={`Delete ${s} image`}
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (!confirm(`Delete the ${s} image? You'll need to re-upload before grading.`)) return;
                        try {
                          const r = await fetch(`${apiBase}/certificates/${certId}/images/${s}`, {
                            method: "DELETE",
                            credentials: "include",
                          });
                          if (!r.ok) {
                            const d = await r.json();
                            throw new Error(d.error);
                          }
                          onImageDeleted?.();
                        } catch {}
                      }}
                      className="flex-shrink-0 rounded-r border border-l-0 border-[var(--admin-line)] text-[var(--admin-ink-dim)] hover:text-[var(--admin-red)] hover:border-[var(--admin-red)]/40 px-1.5 py-1 transition-all"
                    >
                      <Trash2 size={10} />
                    </button>
                  )}
                </div>
              );
            })}
            {!fullscreen && referenceImageUrl && (
              <button
                type="button"
                onClick={() => setShowReference((v) => !v)}
                className={`flex-shrink-0 rounded px-3 py-1 text-[10px] font-bold uppercase tracking-wider border transition-all ${showReference ? "border-[var(--admin-gold)] text-[var(--admin-gold)] bg-[var(--admin-gold)]/10" : "border-[var(--admin-line)] text-[var(--admin-ink-dim)] hover:border-[var(--admin-gold)]/40"}`}
              >
                Reference
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  // ── Shared image area ───────────────────────────────────────────────────
  function renderImageArea(maxH: string | number) {
    // The inner "card frame" — the same outer container in both modes, but
    // it switches between aspectRatio-5:7 + object-contain layout (inline
    // view) and Card-Tool-style shrink-wrap with explicit pixel dimensions
    // (mark mode). The mark-mode path eliminates the element-box-vs-visible-
    // image gap that left BACK pins misaligned after b17cc57 — when the img
    // has explicit pixel dims (no object-contain), the IMG element box
    // EQUALS the visible image area on both sides.
    const cardFrame = (
      <div
        ref={containerRef}
        className={`relative select-none ${
          // The decorative 5% corner radius is DROPPED on the grading rail. Paired
          // with overflow-hidden it masks roughly 18px off each corner of a ~370px
          // card — the set symbol, card number and copyright line — while every
          // rectangle-based check still reports the image as fully inside the frame.
          // The grader must inspect the true scan, so the inspection viewport does
          // not crop it decoratively. Every other surface keeps the rounding.
          railFitEnabled ? "" : "rounded-[5%] "
        }${
          markMode
            ? "flex-shrink-0"
            : `overflow-hidden ${zoom > 1 ? (dragging ? "cursor-grabbing" : "cursor-grab") : "cursor-zoom-in"}`
        }`}
        style={
          markMode
            ? // Mark mode: no aspectRatio, no padding — the container
              // shrink-wraps the img's explicit pixel dimensions, so its
              // box equals the visible image area. Pin coord math then
              // aligns on both sides regardless of natural aspect.
              { cursor: PIN_CURSOR }
            : railFit
              ? // RAIL SAFE FIT — the computed result, applied literally, IN FLOW.
                //
                // In flow is not incidental; it is the visibility guarantee. The
                // previous pass positioned this absolutely, which took the card out
                // of flow — and the card is the only thing in the rail with real
                // height. Wherever the host's height is content-driven rather than
                // definite, removing the card from flow collapsed the column to 0
                // and the card disappeared entirely on the real /admin route.
                //
                // `flexShrink: 0` keeps the computed size exact; the viewport's
                // `overflow-hidden` is what stops this explicit size propagating back
                // up as an ancestor's min-content width (a flex item whose overflow
                // is not visible has an automatic minimum size of 0), which is the
                // feedback loop that made an in-flow explicit width oscillate before.
                // `transition: none` is explicit and required. The frame inherits
                // `transition: all` from the global styles, so a refit ANIMATED the
                // card's width and height — a visible pulse on every measurement, and
                // part of what the owner saw as the card moving on its own. Automatic
                // fit must settle instantly; only deliberate user zoom animates.
                { width: railFit.w, height: railFit.h, flexShrink: 0, transition: "none" }
              : railFitEnabled
                ? // Not yet measurable — no viewport, or no natural size yet.
                  //
                  // This is the LAST-KNOWN-GOOD rendering path, deliberately: it is
                  // the sizing the rail shipped with before this work, so the worst
                  // case is the old appearance, never a blank rail. A fallback that
                  // can only be reached when measurement fails must not itself be a
                  // new, unproven layout. minWidth/minHeight are pinned to 0 so it
                  // cannot contribute the scan's natural width upward.
                  {
                    aspectRatio: "5/7",
                    maxWidth: "100%",
                    maxHeight: "100%",
                    minHeight: 0,
                    minWidth: 0,
                  }
                : {
                    aspectRatio: "5/7",
                    maxHeight: maxH,
                    // Flex items default to `min-height: auto`, which would let the
                    // aspect-derived height win and overflow the rail. 0 lets it shrink.
                    minHeight: 0,
                    padding: "1.5%",
                  }
        }
        onPointerDown={handleMarkPointerDown}
        onClick={handleContainerClick}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        data-testid="grading-image-viewport"
        data-coordinate-mode={markMode ? "measurement" : "inspection"}
        data-inspection-side={side}
        data-inspection-source={workingEvidenceAsset?.source ?? "working-evidence-unavailable"}
        data-inspection-zoom={zoom}
        data-inspection-focus-x={pan.x / 100}
        data-inspection-focus-y={pan.y / 100}
        {...(railFitEnabled
          ? {
              // READ-ONLY runtime diagnostics. These report the computed safe fit
              // so acceptance can be checked without inferring geometry from CSS.
              // They describe the rendered <img> box against the visible viewport
              // box — never a wrapper, never padding.
              "data-card-fit-state": railFit ? railFit.mode : "measuring",
              // Stability instrumentation. `fit-revision` counts COMMITTED fits and
              // `observer-count` counts ResizeObserver callbacks: if the two climb
              // together the ratchet has failed and the loop is back.
              "data-card-fit-revision": railFit ? railFit.revision : 0,
              "data-card-observer-count": railObserverCountRef.current,
              "data-card-natural-w": railNaturalDims?.w ?? "",
              "data-card-natural-h": railNaturalDims?.h ?? "",
              "data-card-rendered-w": railFit ? railFit.w.toFixed(1) : "",
              "data-card-rendered-h": railFit ? railFit.h.toFixed(1) : "",
              "data-card-clearance-top": railFit ? railFit.clearanceY.toFixed(1) : "",
              "data-card-clearance-bottom": railFit ? railFit.clearanceY.toFixed(1) : "",
              "data-card-clearance-left": railFit ? railFit.clearanceX.toFixed(1) : "",
              "data-card-clearance-right": railFit ? railFit.clearanceX.toFixed(1) : "",
            }
          : {})}
      >
        {currentUrl ? (
          <div
            className={`relative ${markMode ? "" : `w-full h-full ${markMode ? "" : "overflow-hidden"}`}`}
            style={
              markMode
                ? // Mark mode: no CSS transform on the zoom-pan div — zoom
                  // is applied via renderW/renderH on the img instead, and
                  // native scroll on the fitRef wrapper handles panning.
                  // This removes the transform's coord-space gap entirely.
                  {}
                : { transform: transformStyle, transition: transitionStyle }
            }
          >
            <img
              ref={imgElRef}
              src={currentUrl}
              alt={`${side} full-resolution working evidence`}
              className={markMode ? "block" : "w-full h-full object-contain"}
              style={
                markMode
                  ? // Mark mode: explicit pixel dimensions = visible image
                    // size. No object-contain letterbox, no CSS transform.
                    // IMG element box equals visible image area. Click and
                    // render share that single reference frame on both
                    // sides. While imgNaturalDims / fitBox haven't been
                    // captured yet (first paint), fall back to a maxWidth/
                    // maxHeight intrinsic-sized img so onLoad can fire.
                    renderW != null && renderH != null
                    ? { width: renderW, height: renderH }
                    : {
                        maxWidth: fitBox?.w ?? "100vw",
                        maxHeight: fitBox?.h ?? "85vh",
                        width: "auto",
                        height: "auto",
                      }
                  : undefined
              }
              data-working-evidence="full-resolution"
              data-testid={railFitEnabled ? "grading-card-image" : undefined}
              onLoad={(e) => {
                const w = e.currentTarget.naturalWidth;
                const h = e.currentTarget.naturalHeight;
                // The rail's safe fit is computed from the SCAN's own natural
                // dimensions, not from an assumed 5:7 card ratio — a scan that is
                // not exactly 5:7 is precisely the case where assuming the ratio
                // pushes real card content past the viewport edge.
                if (railFitEnabled) {
                  setRailNaturalDims({ w, h });
                  const known = railNaturalBySideRef.current[railFitKey];
                  if (!known || known.w !== w || known.h !== h) {
                    railNaturalBySideRef.current = { ...railNaturalBySideRef.current, [railFitKey]: { w, h } };
                    setRailSidesRevision((r) => r + 1);
                  }
                }
                if (!markMode) return;
                setImgNaturalDims({ w, h });
              }}
              onError={() => setFailedWorkingUrl(currentUrl)}
              draggable={false}
            />

            {/* Pin / line / centering visuals render as DIRECT absolute
                  children of the zoom-pan div above. The zoom-pan div is
                  `w-full h-full` of the outer's content area, and the <img>
                  is also `w-full h-full` of the zoom-pan div — so the
                  zoom-pan div's box equals the IMG element's box by CSS
                  layout, no measurement needed. Click coords (read from
                  imgElRef.getBoundingClientRect()) and pin renders (`left:
                  x%, top: y%` of the zoom-pan div) share one reference
                  frame automatically. Same pattern as the Card Tool's
                  containerRef approach. */}
            {/* MVGS v2.1 — line overlays. Whitening (yellow default) and
                  crease (cyan default) lines for the current side render here;
                  the in-progress drag preview renders below them so it sits on
                  top while drawing. Colour comes from each line entry's
                  display-only `color` field, defaulting per type. pointer-
                  events:none so clicks still reach the container's handlers. */}
            {(whiteningLines.length > 0 || creaseLines.length > 0 || lineStart) && (
              <svg
                className="absolute inset-0 w-full h-full pointer-events-none"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
              >
                {whiteningLines
                  .filter((l) => l.side === side && l.start && l.end)
                  .map((l, i) => (
                    <g key={`wl-${l.id ?? i}`}>
                      <line
                        x1={l.start!.x}
                        y1={l.start!.y}
                        x2={l.end!.x}
                        y2={l.end!.y}
                        stroke="rgba(0,0,0,0.55)"
                        strokeWidth={3}
                        vectorEffect="non-scaling-stroke"
                      />
                      <line
                        x1={l.start!.x}
                        y1={l.start!.y}
                        x2={l.end!.x}
                        y2={l.end!.y}
                        stroke={l.color ?? "#FFD400"}
                        strokeWidth={1.5}
                        vectorEffect="non-scaling-stroke"
                      />
                    </g>
                  ))}
                {creaseLines
                  .filter((l) => l.side === side)
                  .map((l) => (
                    <g key={`cl-${l.id}`}>
                      <line
                        x1={l.start.x}
                        y1={l.start.y}
                        x2={l.end.x}
                        y2={l.end.y}
                        stroke="rgba(0,0,0,0.55)"
                        strokeWidth={3}
                        vectorEffect="non-scaling-stroke"
                      />
                      <line
                        x1={l.start.x}
                        y1={l.start.y}
                        x2={l.end.x}
                        y2={l.end.y}
                        stroke={l.color ?? "#00CCFF"}
                        strokeWidth={1.5}
                        vectorEffect="non-scaling-stroke"
                      />
                    </g>
                  ))}
                {lineStart && lineEnd && (
                  <line
                    x1={lineStart.x}
                    y1={lineStart.y}
                    x2={lineEnd.x}
                    y2={lineEnd.y}
                    stroke={lineColor}
                    strokeWidth={1.5}
                    vectorEffect="non-scaling-stroke"
                    strokeDasharray="2 2"
                  />
                )}
              </svg>
            )}

            {/* Centering overlay — outer (card edge) + inner (artwork frame) */}
            {showCentering &&
              (() => {
                const cd = side === "front" ? centeringFront : centeringBack;
                if (!cd) return null;
                // Manual frames persist as {left,top,right,bottom}; AI frames as
                // {*_pct}. Normalise both to *_pct so the overlay renders either
                // source — without this, manual-centered certs drew nothing.
                const norm = (f: any) =>
                  f
                    ? {
                        left_pct: f.left_pct ?? f.left,
                        right_pct: f.right_pct ?? f.right,
                        top_pct: f.top_pct ?? f.top,
                        bottom_pct: f.bottom_pct ?? f.bottom,
                      }
                    : null;
                const outer = norm(cd.outerFrame) || { left_pct: 0, right_pct: 100, top_pct: 0, bottom_pct: 100 };
                const inner = norm(cd.innerFrame);
                // Compute geometric centering from outer + inner frame coordinates
                let lPct = 50,
                  rPct = 50,
                  tPct = 50,
                  bPct = 50;
                if (inner) {
                  const leftM = inner.left_pct - outer.left_pct;
                  const rightM = outer.right_pct - inner.right_pct;
                  const topM = inner.top_pct - outer.top_pct;
                  const botM = outer.bottom_pct - inner.bottom_pct;
                  const lrTotal = leftM + rightM;
                  const tbTotal = topM + botM;
                  if (lrTotal > 0) {
                    lPct = Math.round((leftM / lrTotal) * 100);
                    rPct = 100 - lPct;
                  }
                  if (tbTotal > 0) {
                    tPct = Math.round((topM / tbTotal) * 100);
                    bPct = 100 - tPct;
                  }
                }
                // Sanity checks
                let warning = "";
                if (inner) {
                  const innerW = inner.right_pct - inner.left_pct;
                  const innerH = inner.bottom_pct - inner.top_pct;
                  const outerW = outer.right_pct - outer.left_pct;
                  const outerH = outer.bottom_pct - outer.top_pct;
                  const areaRatio = (innerW * innerH) / (outerW * outerH);
                  if (areaRatio < 0.4)
                    warning = "⚠ Inner frame too small — may be measuring art window, not card border";
                  if (Math.abs(lPct - tPct) > 20) warning = "⚠ L/R and T/B differ significantly — verify inner frame";
                }

                // Fallback to AI ratios if no frame coords
                const lr = inner ? [lPct, rPct] : cd.ratioLR?.split("/").map(Number) || [50, 50];
                const tb = inner ? [tPct, bPct] : cd.ratioTB?.split("/").map(Number) || [50, 50];
                const midY = inner ? (inner.top_pct + inner.bottom_pct) / 2 : 50;
                const midX = inner ? (inner.left_pct + inner.right_pct) / 2 : 50;
                return (
                  <svg
                    className="absolute inset-0 w-full h-full pointer-events-none"
                    viewBox="0 0 100 100"
                    preserveAspectRatio="none"
                  >
                    {/* Sanity warning */}
                    {warning && (
                      <text x="50" y="3" textAnchor="middle" fill="#FF6600" fontSize="2.5" fontWeight="bold">
                        {warning}
                      </text>
                    )}
                    {/* Outer frame — solid gold, traces card physical edge */}
                    <rect
                      x={outer.left_pct}
                      y={outer.top_pct}
                      width={outer.right_pct - outer.left_pct}
                      height={outer.bottom_pct - outer.top_pct}
                      fill="none"
                      stroke="#D4AF37"
                      strokeWidth="0.6"
                      opacity="0.7"
                    />
                    {/* Inner frame — dashed gold, traces artwork boundary */}
                    {inner && (
                      <rect
                        x={inner.left_pct}
                        y={inner.top_pct}
                        width={inner.right_pct - inner.left_pct}
                        height={inner.bottom_pct - inner.top_pct}
                        fill="none"
                        stroke="#D4AF37"
                        strokeWidth="0.4"
                        strokeDasharray="1.5,1"
                        opacity="0.8"
                      />
                    )}
                    {/* Measurement lines + computed percentages */}
                    {inner && (
                      <>
                        <line
                          x1={outer.left_pct}
                          y1={midY}
                          x2={inner.left_pct}
                          y2={midY}
                          stroke="#D4AF37"
                          strokeWidth="0.3"
                          opacity="0.6"
                        />
                        <text
                          x={(outer.left_pct + inner.left_pct) / 2}
                          y={midY - 1.5}
                          textAnchor="middle"
                          fill="#D4AF37"
                          fontSize="3"
                          fontWeight="bold"
                          opacity="0.9"
                        >
                          {lr[0]}%
                        </text>
                        <line
                          x1={inner.right_pct}
                          y1={midY}
                          x2={outer.right_pct}
                          y2={midY}
                          stroke="#D4AF37"
                          strokeWidth="0.3"
                          opacity="0.6"
                        />
                        <text
                          x={(inner.right_pct + outer.right_pct) / 2}
                          y={midY - 1.5}
                          textAnchor="middle"
                          fill="#D4AF37"
                          fontSize="3"
                          fontWeight="bold"
                          opacity="0.9"
                        >
                          {lr[1]}%
                        </text>
                        <line
                          x1={midX}
                          y1={outer.top_pct}
                          x2={midX}
                          y2={inner.top_pct}
                          stroke="#D4AF37"
                          strokeWidth="0.3"
                          opacity="0.6"
                        />
                        <text
                          x={midX}
                          y={(outer.top_pct + inner.top_pct) / 2 + 1}
                          textAnchor="middle"
                          fill="#D4AF37"
                          fontSize="3"
                          fontWeight="bold"
                          opacity="0.9"
                        >
                          {tb[0]}%
                        </text>
                        <line
                          x1={midX}
                          y1={inner.bottom_pct}
                          x2={midX}
                          y2={outer.bottom_pct}
                          stroke="#D4AF37"
                          strokeWidth="0.3"
                          opacity="0.6"
                        />
                        <text
                          x={midX}
                          y={(inner.bottom_pct + outer.bottom_pct) / 2 + 1}
                          textAnchor="middle"
                          fill="#D4AF37"
                          fontSize="3"
                          fontWeight="bold"
                          opacity="0.9"
                        >
                          {tb[1]}%
                        </text>
                      </>
                    )}
                  </svg>
                );
              })()}

            {/* Defect ring markers — clickable when not readOnly and an
                onDefectsChange handler exists. Click opens an inline popover
                anchored to the marker for edit / delete. AI markers are also
                editable (they share the defects[] array with admin-placed). */}
            {showDefects &&
              (() => {
                let humanIdx = 0;
                const clickable = mutationsEnabled && !readOnly && !!onDefectsChange;
                return sideDefects.map((d) => {
                  const isAi = !!(d as any)._aiSource || !!(d as any).detected_in;
                  if (!isAi) humanIdx++;
                  const isHL = highlightId === d.id;
                  // Tier-coloured ring: D1=red, D2=orange, D3=green.
                  // AI pins (no tier yet) keep red as a "needs review" cue.
                  // Legacy admin pins with no tier fall back to gold.
                  const col = (() => {
                    if (d.tier === "D1") return "#DC2626"; // red-600
                    if (d.tier === "D2") return "#F59E0B"; // amber-500 (yellow-orange)
                    if (d.tier === "D3") return "#16A34A"; // green-600
                    if (isAi) return "#DC2626";
                    return "#D4AF37"; // gold (legacy)
                  })();
                  const badge = isAi ? "AI" : String(humanIdx);
                  const isEditing = editingDefectId === d.id;
                  // Popover above marker when marker is in lower half; below
                  // when in upper half — keeps marker visible.
                  const popoverAbove = d.y_percent > 50;
                  return (
                    <div
                      key={d.id}
                      className={`absolute ${clickable ? "" : "pointer-events-none"} ${isHL ? "defect-ring-pulse" : ""}`}
                      style={{
                        left: `${d.x_percent}%`,
                        top: `${d.y_percent}%`,
                        transform: "translate(-50%, -50%)",
                        width: 32,
                        height: 32,
                      }}
                    >
                      {/* Marker ring — a button when clickable so keyboard nav
                        + role + aria-label come for free. Falls back to a
                        decorative div when read-only / handler missing.
                        Light fill so the centre dot (drawn separately below)
                        reads clearly against any background image. */}
                      {clickable ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (isEditing) {
                              setEditingDefectId(null);
                              setEditingDefectAnchor(null);
                            } else {
                              // Capture the marker's viewport rect so the
                              // portal'd popover can position itself in fixed
                              // coordinates. currentTarget is the marker button;
                              // its bounding rect matches the visible marker.
                              setEditingDefectAnchor((e.currentTarget as HTMLElement).getBoundingClientRect());
                              setEditingDefectId(d.id);
                            }
                          }}
                          title={`Defect ${badge}: ${d.mvgsCode ?? d.type}${d.tier ? ` (${d.tier})` : ""}`}
                          aria-label={`Defect ${badge}: ${d.mvgsCode ?? d.type}${d.tier ? ` (${d.tier})` : ""}. Click to edit or delete.`}
                          className="w-full h-full rounded-full transition-all cursor-pointer hover:scale-110 focus:outline-none focus:ring-2 focus:ring-[var(--admin-gold)]/60"
                          style={{
                            border: `${isHL || isEditing ? 3 : 2}px solid ${col}`,
                            background: "transparent",
                            boxShadow: isHL || isEditing ? `0 0 8px ${col}80` : "none",
                          }}
                        />
                      ) : (
                        <div
                          className="w-full h-full rounded-full transition-all"
                          title={readOnly ? "Click EDIT GRADE to edit defects" : undefined}
                          style={{
                            border: `${isHL ? 3 : 2}px solid ${col}`,
                            background: "transparent",
                            boxShadow: isHL ? `0 0 8px ${col}80` : "none",
                          }}
                        />
                      )}
                      {/* Centre dot — 4 px filled circle in the tier
                            colour (gold for ungraded pins). Always rendered
                            so the exact click point is visible on every pin.
                            Pointer-events off so the underlying button still
                            receives clicks anywhere inside the ring. */}
                      <span
                        aria-hidden="true"
                        className="absolute pointer-events-none rounded-full"
                        style={{
                          left: "50%",
                          top: "50%",
                          transform: "translate(-50%, -50%)",
                          width: 4,
                          height: 4,
                          background: col,
                        }}
                      />
                      <span
                        className="absolute -top-1 -right-1 text-[8px] font-black px-1 rounded-full leading-none py-0.5 pointer-events-none"
                        style={{ background: col, color: isAi ? "#fff" : "#1A1400" }}
                      >
                        {badge}
                      </span>

                      {/* Inline edit/delete popover */}
                      {isEditing && editingDefectAnchor && (
                        <DefectEditPopover
                          defect={d}
                          badge={badge}
                          anchorAbove={popoverAbove}
                          anchorRect={editingDefectAnchor}
                          onChangeField={(k, v) => updateDefectField(d.id, k, v)}
                          onBulkUpdate={(patch) => {
                            if (!mutationsEnabled || !onDefectsChange) return;
                            onDefectsChange(defects.map((dd) => (dd.id === d.id ? { ...dd, ...patch } : dd)));
                          }}
                          onDelete={() => deleteDefect(d.id)}
                          onClose={() => {
                            setEditingDefectId(null);
                            setEditingDefectAnchor(null);
                          }}
                        />
                      )}
                    </div>
                  );
                });
              })()}

            {/* Pending batch pins — grey numbered markers for the current
                click-batch. Each click in markMode adds a pin here; the Done
                button (or Enter / dbl-click) opens the picker which commits
                all of them at once. Filtered to the visible side. */}
            {pendingBatch
              .filter((p) => p.image_side === side)
              .map((p) => (
                <div
                  key={p.localId}
                  className="absolute pointer-events-none"
                  style={{
                    left: `${p.x}%`,
                    top: `${p.y}%`,
                    transform: "translate(-50%, -50%)",
                    width: 32,
                    height: 32,
                  }}
                >
                  <div className="w-full h-full rounded-full border-2 border-[var(--admin-gold)] bg-transparent" />
                  <span className="absolute -top-1 -right-1 text-[9px] font-black bg-[var(--admin-ink-dim)] text-white px-1 rounded-full leading-none py-0.5">
                    {p.localId}
                  </span>
                </div>
              ))}
          </div>
        ) : certId && mutationsEnabled && mayUploadRecoveryEvidence ? (
          <InlineDropZone
            side={side}
            certId={certId}
            reason={unavailableReason}
            recovery={unavailableRecovery}
            onUploaded={() => onImageDeleted?.()}
          />
        ) : (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-5 text-center"
            data-testid="working-evidence-unavailable"
          >
            <p className="text-sm font-bold text-amber-300">FULL-RESOLUTION EVIDENCE UNAVAILABLE</p>
            <p className="text-xs text-[var(--admin-ink-dim)]">{unavailableReason}</p>
            <p className="text-xs text-[var(--admin-ink-dim)]">{unavailableRecovery}</p>
          </div>
        )}
      </div>
    );

    return (
      <>
        {/* Mark mode wraps the cardFrame in a fit-scroll + safe-center
            scaffold (Card Tool pattern, manual-card-tool.tsx:1099-1131).
            At zoom = 1 the centering keeps the card in the middle of the
            visible area. At zoom > 1, renderW/renderH grow past fitBox
            and the wrapper's overflow:auto provides native scroll for
            panning. Inline (non-mark-mode) renders cardFrame directly —
            its aspectRatio + maxHeight already constrain it. */}
        {markMode ? (
          <div ref={fitRef} className="w-full h-full overflow-auto overscroll-contain">
            <div
              className="min-w-full min-h-full flex"
              style={{ justifyContent: "safe center", alignItems: "safe center" }}
            >
              {cardFrame}
            </div>
          </div>
        ) : fillHost ? (
          /*
           * RAIL FIT (owner defect 2026-08-16: the card's BOTTOM EDGE was still cut off on the
           * real /admin route, hiding the set/rarity/promo/copyright strip graders must read).
           *
           * cardFrame was a DIRECT flex item of the rail root with `aspectRatio: 5/7` and
           * `maxHeight: "100%"`. A percentage max-height resolves against the item's containing
           * block — the ROOT — not against the space left after the shrink-0 tabs and controls.
           * So the frame was allowed to be as tall as the WHOLE rail while only part of it
           * remained, and the host's `overflow-hidden` clipped the difference off the bottom.
           * As a flex item it also had the default `min-height: auto`, so its aspect-derived
           * height stopped it shrinking to fit.
           *
           * THIS element is the visible inspection viewport: the rectangle the card is
           * fitted into, the rectangle every clearance is measured against, and the
           * element the ResizeObserver watches. It deliberately wraps the card frame
           * ALONE. renderImageArea returns a fragment of `frame + zoom toolbar`, so
           * measuring their shared parent would fold the toolbar's width into the card's
           * available space and report a viewport the card never had.
           */
          <div
            ref={railViewportRef}
            // `overflow-hidden` is load-bearing: a flex item whose overflow is not
            // `visible` has an automatic minimum size of 0, which is what stops the
            // card's explicit width propagating upward as an ancestor's min-content
            // width and re-inflating the rail on the next measurement.
            className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden"
            data-testid="grading-card-viewport"
            data-card-viewport-w={railViewport?.w ?? ""}
            data-card-viewport-h={railViewport?.h ?? ""}
            data-card-safe-inset-x={RAIL_SAFE_INSET_X}
            data-card-safe-inset-y={RAIL_SAFE_INSET_Y}
          >
            {cardFrame}
          </div>
        ) : (
          cardFrame
        )}

        {/* Zoom toolbar — sibling of the card frame so it doesn't overlap card art.
          IN THE RAIL it is not rendered here at all: it lives in the top utility row
          beside the Front/Back tabs (see renderZoomPill). Below the card it was a row
          sibling that took ~110px out of the rail's width, and stacked under the card
          it cost height. In a row that already exists it costs the card neither. */}
        {railFitEnabled ? null : <div className="mt-2 flex shrink-0 items-center justify-end">{renderZoomPill()}</div>}
      </>
    );
  }

  /**
   * The zoom control pill. Extracted so the rail can render it in the top utility
   * row while every other layout keeps it where it was.
   */
  function renderZoomPill() {
    return (
      <div className="flex items-center gap-0.5 bg-[var(--admin-panel2)] border border-[var(--admin-line-hard)] rounded-full px-1 py-0.5">
        <button
          type="button"
          aria-label="Zoom out"
          onClick={(e) => {
            e.stopPropagation();
            zoomOut();
          }}
          disabled={zoom <= 1}
          className="h-8 w-8 flex items-center justify-center text-white hover:text-[var(--admin-gold)] disabled:text-[var(--admin-ink-dim)] transition-colors rounded-full"
        >
          <ZoomOut size={14} />
        </button>
        <span className="text-white text-[10px] font-mono w-10 text-center select-none">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          aria-label="Zoom in"
          onClick={(e) => {
            e.stopPropagation();
            zoomIn();
          }}
          disabled={zoom >= maxZoom()}
          className="h-8 w-8 flex items-center justify-center text-white hover:text-[var(--admin-gold)] disabled:text-[var(--admin-ink-dim)] transition-colors rounded-full"
        >
          <ZoomIn size={14} />
        </button>
        {zoom > 1 && (
          <button
            type="button"
            aria-label="Reset zoom"
            onClick={(e) => {
              e.stopPropagation();
              zoomReset();
            }}
            className="h-8 w-8 flex items-center justify-center text-[var(--admin-ink-dim)] hover:text-white transition-colors rounded-full"
          >
            <RotateCcw size={12} />
          </button>
        )}
      </div>
    );
  }

  // ── Fullscreen overlay ──────────────────────────────────────────────────
  if (fullscreen) {
    return (
      <>
        <style>{PULSE_CSS}</style>
        <div className="fixed inset-0 z-50 bg-black/95 flex flex-col">
          {/* Top bar */}
          <div className="flex-shrink-0 px-4 py-3 flex items-center justify-between border-b border-[var(--admin-line-hard)]">
            <div className="flex-1">{renderTabs()}</div>
            <button
              type="button"
              onClick={exitMarkMode}
              className="ml-4 text-[var(--admin-ink-dim)] hover:text-white transition-colors p-1"
            >
              <X size={20} />
            </button>
          </div>

          {/* Main image — fills remaining space */}
          <div className="flex-1 flex items-center justify-center p-4 min-h-0">
            <div className="w-full h-full max-w-[85vh]">{renderImageArea("85vh")}</div>
          </div>

          {/* Dropdown rendered below via Portal — see DropdownPortal at the
              bottom of the fullscreen JSX so it escapes any ancestor
              transform (the image container has transform: scale(...) for
              zoom, which would break position: fixed otherwise). */}

          {/* Bottom toolbar */}
          <div className="flex-shrink-0 px-4 py-3 flex items-center justify-between border-t border-[var(--admin-line-hard)]">
            <div className="flex items-center gap-3">
              {/* MVGS v2.1 tool palette — Pin | Whitening line | Crease line.
                  Pin path is unchanged; the line tools are gated on the
                  parent wiring onWhiteningLinesChange / onCreaseLinesChange. */}
              <div className="flex rounded-lg overflow-hidden border border-[var(--admin-line-hard)] text-[10px] font-bold uppercase">
                <button
                  type="button"
                  onClick={() => setMarkTool("pin")}
                  data-testid="btn-mark-tool-pin"
                  className={`px-3 py-1.5 ${
                    markTool === "pin"
                      ? "bg-[var(--admin-gold)] text-[#1A1400]"
                      : "text-[var(--admin-ink-dim)] hover:bg-[var(--admin-panel2)]"
                  }`}
                >
                  Pin
                </button>
                {canDrawWhitening && (
                  <button
                    type="button"
                    onClick={() => setMarkTool("whitening")}
                    data-testid="btn-mark-tool-whitening"
                    className={`px-3 py-1.5 border-l border-[var(--admin-line-hard)] ${
                      markTool === "whitening"
                        ? "bg-[var(--admin-gold)] text-[#1A1400]"
                        : "text-[var(--admin-ink-dim)] hover:bg-[var(--admin-panel2)]"
                    }`}
                  >
                    Whitening line
                  </button>
                )}
                {canDrawCrease && (
                  <button
                    type="button"
                    onClick={() => setMarkTool("crease")}
                    data-testid="btn-mark-tool-crease"
                    className={`px-3 py-1.5 border-l border-[var(--admin-line-hard)] ${
                      markTool === "crease"
                        ? "bg-[var(--admin-gold)] text-[#1A1400]"
                        : "text-[var(--admin-ink-dim)] hover:bg-[var(--admin-panel2)]"
                    }`}
                  >
                    Crease line
                  </button>
                )}
              </div>
              {/* MVGS v2.1 — line colour selector. Pick BEFORE drawing; the
                  next line is born in this colour. Display-only (stripped at
                  the mvgs-input-builder boundary). Hidden in pin-only mode. */}
              {(canDrawWhitening || canDrawCrease) && (
                <div className="flex items-center gap-1" data-testid="line-colour-palette">
                  {LINE_COLOUR_PALETTE.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setLineColor(c)}
                      title="Line colour (display only — doesn't affect grade)"
                      data-testid={`btn-line-colour-${c.replace("#", "")}`}
                      className={`w-5 h-5 rounded-full border transition-transform ${
                        lineColor === c
                          ? "border-[var(--admin-gold)] ring-2 ring-[var(--admin-gold)] scale-110"
                          : "border-[var(--admin-line-hard)] hover:scale-110"
                      }`}
                      style={{ background: c }}
                    />
                  ))}
                </div>
              )}
              <p className="text-[var(--admin-ink-dim)] text-xs">
                {markTool === "pin"
                  ? `${defects.length} defect${defects.length !== 1 ? "s" : ""} marked · Click → pin, Enter / dbl-click = Done`
                  : markTool === "whitening"
                    ? `${whiteningLines.length} whitening line${whiteningLines.length !== 1 ? "s" : ""} · Click-drag along the edge`
                    : `${creaseLines.length} crease line${creaseLines.length !== 1 ? "s" : ""} · Click-drag across the card`}
              </p>
            </div>
            <div className="flex items-center gap-3">
              {pendingBatch.length > 0 && !pickerOpen && (
                <button
                  type="button"
                  onClick={openTypePicker}
                  className="bg-[var(--admin-gold)] text-[#1A1400] text-xs font-bold uppercase px-5 py-2 rounded-lg hover:bg-[var(--admin-gold-deep)] transition-all border border-[var(--admin-gold-deep)]"
                >
                  Done — Assign Type ({pendingBatch.length})
                </button>
              )}
              <button
                type="button"
                onClick={exitMarkMode}
                className="flex items-center gap-2 bg-gradient-to-r from-[var(--admin-gold)] to-[var(--admin-gold-deep)] text-[#1A1400] text-xs font-bold uppercase px-5 py-2 rounded-lg hover:opacity-90 transition-all"
              >
                Done Marking
              </button>
            </div>
          </div>
        </div>
        {pickerOpen && pickerAnchor && (
          <DefectTypePicker
            anchor={pickerAnchor}
            tier={pickerTier}
            onTierChange={setPickerTier}
            onPick={commitBatch}
            onCancel={cancelBatch}
            pinCount={pendingBatch.length}
          />
        )}
      </>
    );
  }

  // ── Normal (inline) view ────────────────────────────────────────────────
  /*
   * RAIL CONTAINMENT (owner defect 2026-08-16: the certificate preview covered Manual Crop /
   * Recapture / Card Tool).
   *
   * In the bounded rail this root used to be `space-y-2` — plain BLOCK FLOW. The card frame was
   * given maxHeight:100% against an auto-height parent, so it resolved to width x 7/5 and the
   * controls row stacked AFTER it. Their combined height exceeded the rail host, and the host's
   * `overflow-hidden` clipped the controls out of existence — leaving the certificate preview
   * beneath occupying the space where the operator's controls should have been.
   *
   * As a flex column the space is RESERVED rather than competed for: the tabs and the controls row
   * take their intrinsic height (`shrink-0`) and the card takes only what is left (`flex-1
   * min-h-0`). The card shrinks on short viewports instead of pushing controls out of the box, so
   * no control can ever be covered or clipped, at any viewport height, in any preview state.
   *
   * Scoped to `fillHost`: the inline (non-rail) layout keeps `space-y-2` byte-identically.
   */
  return (
    <div className={fillHost ? "flex h-full min-h-0 flex-col gap-1" : "space-y-2"}>
      <style>{PULSE_CSS}</style>

      {fillHost ? (
        /* TOP UTILITY ROW — one compact row that owns every control that is not the
           card: Front/Back and the zoom pill on the left, the ONE live certificate
           preview on the far right. Everything here is `shrink-0`, so the row costs a
           fixed height once and the card takes all the rest. Nothing in this row is
           allowed to sit beside or beneath the card and take space from it. */
        <div className="flex shrink-0 items-center justify-between gap-2" data-testid="grading-top-utility-row">
          {/* LEFT COLUMN — Front/Back with the zoom pill stacked beneath, both left
              aligned. Stacking them turns the header's dead horizontal space into
              usable width for the certificate: side by side they consumed ~260px of a
              373px rail and left the certificate nothing to grow into.

              Controls are shrink-0: they have a fixed intrinsic size and overlap their
              neighbours if allowed to compress. The certificate absorbs the squeeze
              instead — it is the one element here that scales cleanly. */}
          <div className="flex shrink-0 flex-col items-start gap-1">
            <div className="shrink-0">{renderTabs()}</div>
            <div className="shrink-0">{renderZoomPill()}</div>
          </div>
          {topRowSlot ? <div className="flex min-w-0 flex-1 justify-end">{topRowSlot}</div> : null}
        </div>
      ) : (
        renderTabs()
      )}

      {/* Reference comparison */}
      {showReference && referenceImageUrl && (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <p className="text-[var(--admin-ink-dim)] text-[9px] uppercase tracking-widest text-center">
              Your Scan (Front)
            </p>
            <div className="rounded-lg overflow-hidden" style={{ aspectRatio: "5/7" }}>
              {urls.front_working && workingEvidence?.front?.available === true ? (
                <img src={urls.front_working} alt="scan front" className="w-full h-full object-contain" />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <p className="text-[var(--admin-ink-dim)] text-xs">Working evidence unavailable</p>
                </div>
              )}
            </div>
          </div>
          <div className="space-y-1">
            <p className="text-[var(--admin-ink-dim)] text-[9px] uppercase tracking-widest text-center">
              Reference Image
            </p>
            <div
              className="rounded-lg border border-[var(--admin-gold)]/20 overflow-hidden"
              style={{ aspectRatio: "5/7" }}
            >
              <img src={referenceImageUrl} alt="reference" className="w-full h-full object-contain" />
            </div>
          </div>
        </div>
      )}

      {/* Main image (normal size) */}
      {/* In the bounded rail the frame is capped by its real parent ("100%"), never by
          a fixed pixel constant that can exceed the host and get clipped. The inline
          grid keeps 525 because that layout has no definite height to resolve against. */}
      {!showReference &&
        (fillHost ? (
          // THE VISIBLE INSPECTION VIEWPORT. This is the rectangle the owner sees and
          // the rectangle every clearance is measured against — it is measured directly
          // (ResizeObserver on railViewportRef) rather than inferred, and the fitted
          // image is centred inside it with a guaranteed safety inset on every edge.
          // The card region now contains ONLY the card. The zoom controls moved up into
          // the top utility row, so nothing competes with the card for the rail's width
          // (they took ~110px beside it) or for its height (they cost ~36px beneath it).
          // The card gets the entire rail width below the header.
          <div className="flex min-h-0 flex-1 flex-col">{renderImageArea("100%")}</div>
        ) : (
          renderImageArea(525)
        ))}

      {/* Controls row — shrink-0 so it always reserves its own space in the rail. */}
      <div
        ref={railControlsRef}
        className="flex shrink-0 flex-wrap items-center gap-2"
        data-testid="grading-card-controls"
      >
        <p
          className={`text-[9px] font-bold uppercase tracking-widest ${
            workingEvidenceAvailable ? "text-emerald-300" : "text-amber-300"
          }`}
          data-testid="working-evidence-status"
        >
          {workingEvidenceAvailable
            ? `Full-resolution working evidence · ${side}`
            : `Working evidence unavailable · ${side}`}
        </p>
        {/* Side-specific centering/defect tools remain directly available in the
            workstation. A side without canonical working evidence is visibly
            disabled rather than being allowed to use a derivative by accident. */}
        {onOpenCardTool && mutationsEnabled && !readOnly && (
          <>
            {(["front", "back"] as const).map((toolSide) => {
              const available = toolSide === "front" ? frontWorkingEvidenceAvailable : backWorkingEvidenceAvailable;
              return (
                <button
                  key={toolSide}
                  type="button"
                  onClick={() => onOpenCardTool(toolSide)}
                  disabled={!available}
                  title={
                    available
                      ? `Open Card Tool — ${toolSide.toUpperCase()}`
                      : "Working evidence is required before this side's Card Tool can open"
                  }
                  data-testid={`btn-card-tool-${toolSide}`}
                  className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wide px-3.5 py-1.5 rounded border border-[#B8960C] text-[#1A1400] [background:linear-gradient(135deg,#D4AF37_0%,#B8960C_100%)] shadow-[0_2px_8px_rgba(212,175,55,0.35)] transition-all hover:brightness-110 hover:shadow-[0_3px_12px_rgba(212,175,55,0.5)] hover:-translate-y-px active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Card Tool ({toolSide === "front" ? "Front" : "Back"})
                </button>
              );
            })}
          </>
        )}
        <button
          type="button"
          onClick={enterMarkMode}
          disabled={!mutationsEnabled || !!readOnly}
          className="flex items-center gap-1.5 text-[10px] font-bold uppercase px-3 py-1.5 rounded border transition-all border-[var(--admin-gold)]/40 text-[var(--admin-gold-deep)] hover:border-[var(--admin-gold)] hover:bg-[var(--admin-gold)]/10"
        >
          <Maximize2 size={11} />
          Mark Defects
        </button>
        {certId &&
          mayMutateSourceImage &&
          !readOnly &&
          (side === "front" || side === "back") &&
          urls[`${side}_original` as keyof ImageUrls] && (
            <button
              type="button"
              onClick={() => setManualCropSide(side as "front" | "back")}
              className="flex items-center gap-1.5 text-[10px] font-bold uppercase px-3 py-1.5 rounded border transition-all border-[var(--admin-gold)]/40 text-[var(--admin-gold-deep)] hover:border-[var(--admin-gold)] hover:bg-[var(--admin-gold)]/10"
            >
              <Crop size={11} />
              Manual Crop
            </button>
          )}
        <button
          type="button"
          onClick={() => setShowDefects(!showDefects)}
          className="flex items-center gap-1.5 text-[10px] text-[var(--admin-ink-dim)] hover:text-[var(--admin-ink)] border border-[var(--admin-line)] px-3 py-1.5 rounded transition-all hover:border-[var(--admin-gold)]/40"
        >
          {showDefects ? <EyeOff size={11} /> : <Eye size={11} />}
          {showDefects ? "Hide Defects" : "Show Defects"}
        </button>
        {(centeringFront || centeringBack) && (
          <button
            type="button"
            onClick={() => setShowCentering(!showCentering)}
            className={`flex items-center gap-1.5 text-[10px] font-bold uppercase px-3 py-1.5 rounded border transition-all ${showCentering ? "border-[var(--admin-gold)] text-[var(--admin-gold-deep)] bg-[var(--admin-gold)]/10" : "border-[var(--admin-line)] text-[var(--admin-ink-dim)] hover:border-[var(--admin-gold)]/40"}`}
          >
            {showCentering ? "Hide Centering" : "Show Centering"}
          </button>
        )}
      </div>

      {/* Manual Crop modal (lazy-loaded — won't crash if module fails) */}
      {mayMutateSourceImage && manualCropSide && certId && urls[`${manualCropSide}_original` as keyof ImageUrls] && (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-[100] bg-black/95 flex items-center justify-center text-[var(--admin-gold)] text-sm">
              Loading crop tool...
            </div>
          }
        >
          <ManualCrop
            side={manualCropSide}
            certId={certId}
            rawImageUrl={urls[`${manualCropSide}_original` as keyof ImageUrls] as string}
            onDone={() => {
              setManualCropSide(null);
              onImageDeleted?.();
            }}
            onCancel={() => setManualCropSide(null)}
            onStartCropUpload={onStartCropUpload}
            apiBase={apiBase}
          />
        </Suspense>
      )}
    </div>
  );
}

/** Inline recovery for a missing side. It never substitutes the uploaded/display asset for admitted evidence. */
function InlineDropZone({
  side,
  certId,
  reason,
  recovery,
  onUploaded,
}: {
  side: string;
  certId: number;
  reason: string;
  recovery: string;
  onUploaded: () => void;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(f: File) {
    setUploadError(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append(side, f);
      const res = await fetch(`/api/admin/certificates/${certId}/upload-images`, {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error);
      }
      onUploaded();
    } catch {
      setUploadError(`Could not upload ${side}. Please try again or use the stated recovery action.`);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div
      className={`absolute inset-0 flex flex-col items-center justify-center gap-2 cursor-pointer transition-colors ${isDragging ? "bg-[var(--admin-gold)]/10" : ""}`}
      data-testid="working-evidence-unavailable"
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragging(false);
        const f = e.dataTransfer.files[0];
        if (f) handleFile(f);
      }}
      onClick={() => !uploading && inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
        }}
      />
      {uploading ? (
        <>
          <Loader2 size={24} className="text-[var(--admin-gold)] animate-spin" />
          <p className="text-[var(--admin-ink-dim)] text-xs">Uploading {side}…</p>
        </>
      ) : (
        <>
          <p className="text-sm font-bold text-amber-300">FULL-RESOLUTION EVIDENCE UNAVAILABLE</p>
          <p className="max-w-sm px-5 text-center text-xs text-[var(--admin-ink-dim)]">{reason}</p>
          <p className="max-w-sm px-5 text-center text-xs text-[var(--admin-ink-dim)]">{recovery}</p>
          <Upload size={24} className="text-[var(--admin-ink-dim)]" />
          <p className="text-[var(--admin-ink-dim)] text-xs font-bold">Drop new {side} image here</p>
          <p className="text-[var(--admin-ink-dim)] text-[10px]">or click to browse</p>
          {uploadError ? (
            <p className="max-w-sm px-5 text-center text-xs text-red-400" role="alert">
              {uploadError}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function locationFromPercent(x: number, y: number, side: string): string {
  const hLabel = x < 33 ? "left" : x > 66 ? "right" : "centre";
  const vLabel = y < 33 ? "top" : y > 66 ? "bottom" : "middle";
  return `${side.charAt(0).toUpperCase() + side.slice(1)}, ${vLabel}-${hLabel}`;
}

// ── Inline defect edit popover ─────────────────────────────────────────────
// Anchored to the marker via absolute positioning. anchorAbove flips it to
// sit above (when marker is in lower image half) vs below (upper half) so
// the marker stays visible. Click-outside closes via a capture-phase mousedown
// listener; ESC handled by the parent.
function DefectEditPopover({
  defect,
  badge,
  anchorAbove,
  anchorRect,
  onChangeField,
  onBulkUpdate,
  onDelete,
  onClose,
}: {
  defect: Defect;
  badge: string;
  anchorAbove: boolean;
  anchorRect: DOMRect;
  onChangeField: <K extends keyof Defect>(key: K, value: Defect[K]) => void;
  onBulkUpdate: (patch: Partial<Defect>) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // MVGS picker local state — seeded from the pin's existing MVGS fields,
  // falling back to a best-guess mapping of the legacy `type` string (or
  // WH as a last resort so a value is always selected). Default tier D2
  // matches the batch picker's default for new pins.
  const initialCode: MvgsCode = defect.mvgsCode ?? mapLegacyTypeToMvgsCode(defect.type) ?? "WH";
  const initialTier: "D1" | "D2" | "D3" = defect.tier ?? "D2";
  const [localCode, setLocalCode] = useState<MvgsCode>(initialCode);
  const [localTier, setLocalTier] = useState<"D1" | "D2" | "D3">(initialTier);

  function handleDone() {
    // Atomic bulk update — sequential onChangeField calls raced because each
    // read from the same stale closure snapshot, so the last write won and
    // mvgsCode/tier/zone were silently dropped. Single call applies all
    // mutations at once → computeMvgsScore sees all three fields on the
    // next render → subgrades update correctly.
    const label = MVGS_DEFECT_TYPES.find((t) => t.code === localCode)?.label ?? "";
    const zone =
      defect.zone ??
      deriveZone({
        xPercent: defect.x_percent,
        yPercent: defect.y_percent,
        imageSide: defect.image_side,
      });
    onBulkUpdate({
      mvgsCode: localCode,
      tier: localTier,
      zone,
      ...(label ? { type: label } : {}),
    });
    onClose();
  }
  // Click outside closes. mousedown (not click) on capture phase so we beat
  // any synthetic React click that would re-open / interfere.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!ref.current) return;
      if (e.target instanceof Node && !ref.current.contains(e.target)) {
        const t = e.target as HTMLElement;
        if (t.dataset?.testid?.startsWith("edit-tier-")) return;
        onClose();
      }
    }
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [onClose]);

  // Position in viewport-fixed coords against the marker's rect, then portal
  // into document.body. The marker's parent (image container) has
  // `transform: scale(...)` (creates a stacking context) AND `overflow: hidden`
  // — without portaling, the popover would either render below the image OR
  // get clipped off the edge of the visible area. Same pattern as the picker
  // dropdown earlier in this file (~L670).
  //
  // GAP = 20px clears the 32px marker cleanly. Width = 256 (Tailwind w-64).
  // Clamp to viewport edges with 8px padding so the popover never slides
  // off-screen on the right or bottom.
  const GAP = 20;
  const POP_W = 256;
  const POP_H_EST = 360; // upper-bound for flip-decision clamping
  const markerCenterX = anchorRect.left + anchorRect.width / 2;
  const leftRaw = markerCenterX - POP_W / 2;
  const left = Math.max(8, Math.min(window.innerWidth - POP_W - 8, leftRaw));
  const top = anchorAbove
    ? Math.max(8, anchorRect.top - GAP - POP_H_EST)
    : Math.min(window.innerHeight - POP_H_EST - 8, anchorRect.bottom + GAP);

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={`Edit defect ${badge}`}
      className="fixed z-[10000] w-64 bg-[var(--admin-panel)] border border-[var(--admin-gold)]/60 rounded-lg shadow-xl p-3 space-y-2 text-left"
      style={{ left, top }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between">
        <p className="text-[var(--admin-gold)] text-[10px] font-bold uppercase tracking-widest">Defect #{badge}</p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="text-[var(--admin-ink-faint)] hover:text-[var(--admin-ink)] transition-colors"
        >
          <X size={12} />
        </button>
      </div>

      {/* MVGS picker — replaces the old Type + Severity selects. On open we
          seed local state from the pin's existing mvgsCode/tier, falling
          back to a best-guess mapping of the legacy `type` string. Done
          writes mvgsCode + tier + zone (+ syncs the legacy `type` field
          to the MVGS label so the side list keeps a readable label). */}
      <div className="space-y-1.5">
        <label className="text-[var(--admin-ink-dim)] text-[9px] uppercase tracking-wider block">Tier</label>
        <div className="flex gap-1">
          {(["D1", "D2", "D3"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setLocalTier(t)}
              data-testid={`edit-tier-${t}`}
              className={`flex-1 text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded border transition-colors ${
                localTier === t
                  ? "bg-[var(--admin-gold)] text-[#1A1400] border-[var(--admin-gold)]"
                  : "bg-[var(--admin-panel)] text-[var(--admin-ink-dim)] border-[var(--admin-line)] hover:border-[var(--admin-gold)]"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-[var(--admin-ink-dim)] text-[9px] uppercase tracking-wider block">Type (MVGS)</label>
        <select
          value={localCode}
          onChange={(e) => setLocalCode(e.target.value as MvgsCode)}
          data-testid="edit-mvgs-code"
          className="w-full bg-[var(--admin-panel2)] border border-[var(--admin-line)] rounded px-2 py-1 text-xs text-[var(--admin-ink)]"
          autoFocus
        >
          {MVGS_DEFECT_TYPES.map((t) => (
            <option key={t.code} value={t.code}>
              {t.label} ({t.code})
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1.5">
        <label className="text-[var(--admin-ink-dim)] text-[9px] uppercase tracking-wider block">Notes</label>
        <input
          type="text"
          value={defect.description ?? ""}
          onChange={(e) => onChangeField("description", e.target.value)}
          placeholder="Optional"
          className="w-full bg-[var(--admin-panel2)] border border-[var(--admin-line)] rounded px-2 py-1 text-xs text-[var(--admin-ink)]"
        />
      </div>

      <div className="flex items-center justify-between pt-1">
        <button
          type="button"
          onClick={onDelete}
          className="text-[var(--admin-red)] hover:text-[var(--admin-red)] hover:bg-[color-mix(in_srgb,var(--admin-red)_12%,transparent)] text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded transition-colors"
        >
          Delete
        </button>
        <button
          type="button"
          onClick={handleDone}
          className="bg-gradient-to-r from-[var(--admin-gold)] to-[var(--admin-gold-deep)] text-[#1A1400] text-[10px] font-bold uppercase tracking-widest px-3 py-1 rounded hover:opacity-90 transition-opacity"
        >
          Done
        </button>
      </div>
    </div>,
    document.body
  );
}
