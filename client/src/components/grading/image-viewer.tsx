import { useState, useRef, useEffect, useLayoutEffect, lazy, Suspense } from "react";
import { cardToolEnabled } from "./card-tool-image-source";
import { createPortal } from "react-dom";
import type { CSSProperties, ReactNode } from "react";
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
  CARD_INSPECTION_MAX_ZOOM,
  CARD_INSPECTION_MIN_ZOOM,
  inspectionViewToPercentFocus,
  normaliseCardInspectionState,
  percentFocusToInspectionView,
  updateCardInspectionView,
  type CardInspectionState,
} from "../grading-workflow/card-inspection-state";
import {
  inspectionPlacement,
  panInspectionFocus,
  zoomInspectionFocusAtPoint,
  type InspectionPlacement,
  type InspectionSize,
} from "./inspection-viewport-geometry";

type Side = "front" | "back" | "angled" | "closeup";
type Variant = "original" | "greyscale" | "highcontrast" | "edgeenhanced" | "inverted";

interface ImageUrls {
  front_original?: string | null;
  front_working?: string | null;
  front_review?: string | null;
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
  back_review?: string | null;
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

interface ReviewEvidenceStatus {
  available: boolean;
  reason: string | null;
  recovery: string | null;
  source: "certificate-bound-image";
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
  /** Admin-review-only authoritative certificate image. Never supplied to normal grader surfaces. */
  reviewEvidence?: Partial<Record<"front" | "back", ReviewEvidenceStatus>>;
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
  /** Shared presentation-only front/back zoom + focus state. It changes only
   * the inspection plane; stored defect, line, centering and crop coordinates
   * remain image-relative and are never rewritten. */
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

type InspectionImageSource = "working-evidence" | "review-evidence";

interface WorkingEvidenceAsset {
  url: string;
  source: InspectionImageSource;
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

function getReviewEvidenceAsset(urls: ImageUrls, side: Side): WorkingEvidenceAsset | null {
  if (side !== "front" && side !== "back") return null;
  const record = urls as Record<string, string | null | undefined>;
  const url = record[`${side}_review`];
  return url ? { source: "review-evidence", url } : null;
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

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 5];

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
export const INSPECTION_SAFE_INSET_X = 10;
export const INSPECTION_SAFE_INSET_Y = 12;
/** The contractual floor these insets exist to satisfy. */
export const RAIL_MIN_BOTTOM_CLEARANCE_PX = 12;

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
  return ZOOM_STEPS[0];
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

export function isInspectionShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      "input, textarea, select, [contenteditable='true'], [role='textbox'], [role='combobox'], [role='listbox'], [role='option']"
    )
  );
}

export default function ImageViewer({
  urls,
  workingEvidence,
  reviewEvidence,
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
  /** Both normal inspection and MARK store an image-relative focal point as percent. */
  const [pan, setPanRaw] = useState({ x: 50, y: 50 });
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ pointerX: 0, pointerY: 0, focusX: 50, focusY: 50 });
  const panDragMovedRef = useRef(false);
  const inspectionViewportRef = useRef<HTMLDivElement>(null);
  const [inspectionViewport, setInspectionViewport] = useState<InspectionSize | null>(null);
  const [imgNaturalDims, setImgNaturalDims] = useState<InspectionSize | null>(null);
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

  const publishInspection = (nextZoom: number, nextPan: { x: number; y: number }) => {
    if (!inspectionState || !onInspectionStateChange || (side !== "front" && side !== "back")) return;
    onInspectionStateChange(
      updateCardInspectionView(
        inspectionState,
        side as "front" | "back",
        percentFocusToInspectionView(nextZoom, nextPan)
      )
    );
  };

  function commitViewport(nextZoom: number, nextPan: { x: number; y: number }) {
    const boundedZoom = Math.min(CARD_INSPECTION_MAX_ZOOM, Math.max(CARD_INSPECTION_MIN_ZOOM, nextZoom));
    const requestedPan =
      boundedZoom <= 1
        ? { x: 50, y: 50 }
        : {
            x: Math.max(0, Math.min(100, nextPan.x)),
            y: Math.max(0, Math.min(100, nextPan.y)),
          };
    const boundedPan =
      inspectionViewport && imgNaturalDims
        ? (() => {
            const placement = inspectionPlacement(
              inspectionViewport,
              imgNaturalDims,
              boundedZoom,
              { x: requestedPan.x / 100, y: requestedPan.y / 100 },
              { x: INSPECTION_SAFE_INSET_X, y: INSPECTION_SAFE_INSET_Y }
            );
            return { x: placement.focus.x * 100, y: placement.focus.y * 100 };
          })()
        : requestedPan;
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
      const nextZoom = saved ? saved.zoom : 1;
      const nextPan = saved ? inspectionViewToPercentFocus(saved) : { x: 50, y: 50 };
      setZoomRaw(nextZoom);
      setPanRaw(nextPan);
      onZoomChange?.(nextZoom);
    }
  }, [inspectionState, side, onZoomChange]);
  useEffect(() => {
    if (!inspectionState || (side !== "front" && side !== "back")) return;
    const saved = inspectionState.views[side];
    setZoomRaw(saved.zoom);
    setPanRaw(inspectionViewToPercentFocus(saved));
  }, [inspectionState, side]);
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

  /**
   * One measured viewport drives both the authoritative inline viewer and MARK
   * DEFECTS. ResizeObserver reports the stable flex box, never the rendered card.
   * Every resize (including browser page zoom changing CSS pixels) recomputes FIT
   * from the current viewport + natural image dimensions, with no previous render
   * in the dependency chain and therefore no ratchet or cumulative shrink.
   */
  useLayoutEffect(() => {
    const el = inspectionViewportRef.current;
    if (!el) return;
    const measure = () => {
      const width = el.clientWidth;
      const height = el.clientHeight;
      if (!(width > 0) || !(height > 0)) return;
      setInspectionViewport((prev) =>
        prev && Math.abs(prev.width - width) < 0.01 && Math.abs(prev.height - height) < 0.01 ? prev : { width, height }
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [fillHost, fullscreen, markMode, showReference]);

  useLayoutEffect(() => {
    const image = imgElRef.current;
    // FRONT and BACK can legitimately resolve to the same already-cached URL
    // (including review fixtures and duplicated captures). React then keeps the
    // same <img> node and the browser emits no second `load` event. Re-read the
    // decoded element synchronously so FIT and every image-relative overlay do
    // not fall back to an unmeasured, letterboxed plane after the side switch.
    if (image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0) {
      setImgNaturalDims({ width: image.naturalWidth, height: image.naturalHeight });
    } else {
      setImgNaturalDims(null);
    }
  }, [side, variant]);

  const fittedPlacement: InspectionPlacement | null =
    inspectionViewport && imgNaturalDims
      ? inspectionPlacement(
          inspectionViewport,
          imgNaturalDims,
          zoom,
          { x: pan.x / 100, y: pan.y / 100 },
          { x: INSPECTION_SAFE_INSET_X, y: INSPECTION_SAFE_INSET_Y }
        )
      : null;

  const workingEvidenceAsset = getWorkingEvidenceAsset(urls, side);
  const workingEvidenceStatus = workingEvidence?.[side as "front" | "back"];
  const workingEvidenceLoadFailed = failedWorkingUrl === workingEvidenceAsset?.url;
  // A URL alone is not an admission decision. Requiring the companion server
  // proof prevents stale query data, an older endpoint, or a UI race from
  // presenting an otherwise plausible derivative as verified working evidence.
  const workingEvidenceAvailable =
    Boolean(workingEvidenceAsset) && workingEvidenceStatus?.available === true && !workingEvidenceLoadFailed;
  const reviewEvidenceAsset = getReviewEvidenceAsset(urls, side);
  const reviewEvidenceStatus = reviewEvidence?.[side as "front" | "back"];
  const reviewEvidenceAvailable =
    !workingEvidenceAvailable && Boolean(reviewEvidenceAsset) && reviewEvidenceStatus?.available === true;
  const inspectionAsset = workingEvidenceAvailable
    ? workingEvidenceAsset
    : reviewEvidenceAvailable
      ? reviewEvidenceAsset
      : null;
  const currentUrl = inspectionAsset?.url ?? null;
  const unavailableReason = reviewEvidenceStatus?.reason
    ? reviewEvidenceStatus.reason
    : workingEvidenceLoadFailed
      ? "The canonical full-resolution working image could not be loaded."
      : (workingEvidenceStatus?.reason ?? `${side.toUpperCase()} cannot be graded from a display derivative.`);
  const unavailableRecovery = reviewEvidenceStatus?.recovery
    ? reviewEvidenceStatus.recovery
    : workingEvidenceLoadFailed
      ? "Restore the working evidence from the immutable 1200-DPI master, then reload this card."
      : (workingEvidenceStatus?.recovery ?? "Restore the canonical working evidence for this side.");
  const frontWorkingEvidenceAvailable =
    Boolean(getWorkingEvidenceAsset(urls, "front")) && workingEvidence?.front?.available === true;
  const backWorkingEvidenceAvailable =
    Boolean(getWorkingEvidenceAsset(urls, "back")) && workingEvidence?.back?.available === true;
  /*
   * The Card Tool enable gate reads the SAME authority the tool itself launches from, so the two
   * can never disagree — that disagreement is exactly the regression this replaces (image visible
   * via the review fallback, tool permanently disabled).
   */
  const frontCardToolAvailable = cardToolEnabled({ side: "front", urls, workingEvidence, reviewEvidence });
  const backCardToolAvailable = cardToolEnabled({ side: "back", urls, workingEvidence, reviewEvidence });
  const sideDefects = defects.filter((d) => d.image_side === side);
  const frontDefectCount = defects.filter((d) => d.image_side === "front").length;
  const backDefectCount = defects.filter((d) => d.image_side === "back").length;

  // Keyboard shortcuts for the active inspection surface. Esc unwinds in order:
  // picker → pending batch → exit. Enter on a non-empty batch opens
  // the type picker. F/B switch sides, D opens MARK, +/- zoom and 0 fits.
  // Form, select-like and editable targets are always excluded.
  useEffect(() => {
    if (!fillHost && !fullscreen) return;
    function onKey(e: KeyboardEvent) {
      if (isInspectionShortcutTarget(e.target)) return;
      // Plain inspection shortcuts must never consume browser/OS chords such
      // as Ctrl/Cmd +/- for page zoom. Shift remains allowed because `+`
      // commonly requires it on physical keyboards.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Escape" && fullscreen) {
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
      } else if (e.key === "Enter" && fullscreen && pendingBatch.length > 0 && !pickerOpen) {
        e.preventDefault();
        openTypePicker();
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        zoomIn();
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoomOut();
      } else if (e.key === "0") {
        e.preventDefault();
        zoomReset();
      } else if (e.key === "f" || e.key === "F") setSide("front");
      else if (e.key === "b" || e.key === "B") setSide("back");
      else if ((e.key === "d" || e.key === "D") && !fullscreen && mutationsEnabled && !readOnly) enterMarkMode();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line
  }, [fillHost, fullscreen, pendingBatch, pickerOpen, mutationsEnabled, readOnly, zoom, pan, side]);

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
    if (dragging || panDragMovedRef.current) {
      panDragMovedRef.current = false;
      return;
    }
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
    if (zoom >= CARD_INSPECTION_MAX_ZOOM - 0.01) {
      zoomReset();
    } else {
      zoomAtClientPoint(nextZoomStep(zoom), e.clientX, e.clientY);
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

  function zoomAtClientPoint(nextZoom: number, clientX: number, clientY: number) {
    const viewportEl = inspectionViewportRef.current;
    if (!viewportEl || !inspectionViewport || !imgNaturalDims) {
      const viewportRect = viewportEl?.getBoundingClientRect();
      const rect =
        viewportRect && viewportRect.width > 0 && viewportRect.height > 0
          ? viewportRect
          : containerRef.current?.getBoundingClientRect();
      commitViewport(
        nextZoom,
        rect && rect.width > 0 && rect.height > 0
          ? {
              x: ((clientX - rect.left) / rect.width) * 100,
              y: ((clientY - rect.top) / rect.height) * 100,
            }
          : pan
      );
      return;
    }
    const rect = viewportEl.getBoundingClientRect();
    const nextFocus = zoomInspectionFocusAtPoint(
      inspectionViewport,
      imgNaturalDims,
      zoom,
      nextZoom,
      { x: pan.x / 100, y: pan.y / 100 },
      { x: clientX - rect.left, y: clientY - rect.top },
      { x: INSPECTION_SAFE_INSET_X, y: INSPECTION_SAFE_INSET_Y }
    );
    commitViewport(nextZoom, { x: nextFocus.x * 100, y: nextFocus.y * 100 });
  }

  function handleWheel(e: WheelEvent) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.002);
      zoomAtClientPoint(
        Math.min(CARD_INSPECTION_MAX_ZOOM, Math.max(CARD_INSPECTION_MIN_ZOOM, zoom * factor)),
        e.clientX,
        e.clientY
      );
      return;
    }
    // Inline wheel/trackpad input remains page scroll. In fullscreen MARK
    // DEFECTS, normal two-finger movement pans only while magnified.
    if (!fullscreen || zoom <= 1 || !inspectionViewport || !imgNaturalDims) return;
    e.preventDefault();
    const nextFocus = panInspectionFocus(
      inspectionViewport,
      imgNaturalDims,
      zoom,
      { x: pan.x / 100, y: pan.y / 100 },
      { x: -e.deltaX, y: -e.deltaY },
      { x: INSPECTION_SAFE_INSET_X, y: INSPECTION_SAFE_INSET_Y }
    );
    commitViewport(zoom, { x: nextFocus.x * 100, y: nextFocus.y * 100 });
  }

  // React delegates wheel handlers passively in supported browsers, which can
  // make preventDefault ineffective and let Ctrl/Cmd+wheel zoom both the card
  // and the browser UI. Bind this inspection-only handler explicitly as
  // non-passive so image zoom and browser page zoom remain separate.
  useLayoutEffect(() => {
    const el = inspectionViewportRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => handleWheel(event);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [fullscreen, imgNaturalDims, inspectionViewport, pan, side, zoom]);

  function zoomIn() {
    setZoom((z) => nextZoomStep(z));
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
    if (zoom <= 1) return;
    panDragMovedRef.current = false;
    setDragging(true);
    setDragStart({ pointerX: e.clientX, pointerY: e.clientY, focusX: pan.x, focusY: pan.y });
  }

  function handleMouseMove(e: React.MouseEvent) {
    if (lineStart) {
      lineMouseMove(e);
      return;
    }
    if (!dragging) return;
    if (Math.hypot(e.clientX - dragStart.pointerX, e.clientY - dragStart.pointerY) > 8) {
      panDragMovedRef.current = true;
    }
    if (!inspectionViewport || !imgNaturalDims) return;
    const nextFocus = panInspectionFocus(
      inspectionViewport,
      imgNaturalDims,
      zoom,
      { x: dragStart.focusX / 100, y: dragStart.focusY / 100 },
      { x: e.clientX - dragStart.pointerX, y: e.clientY - dragStart.pointerY },
      { x: INSPECTION_SAFE_INSET_X, y: INSPECTION_SAFE_INSET_Y }
    );
    setPan({ x: nextFocus.x * 100, y: nextFocus.y * 100 });
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
                    className={`flex-shrink-0 rounded-l text-[10px] font-bold uppercase tracking-wider border transition-all ${
                      fillHost && !fullscreen ? "px-2 py-1" : "px-3 py-2"
                    } ${
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
    const frameStyle: CSSProperties = fittedPlacement
      ? {
          position: "absolute",
          left: fittedPlacement.left,
          top: fittedPlacement.top,
          width: fittedPlacement.width,
          height: fittedPlacement.height,
          transition: "none",
          cursor: markMode && markTool === "pin" ? PIN_CURSOR : undefined,
        }
      : {
          position: "absolute",
          left: INSPECTION_SAFE_INSET_X,
          right: INSPECTION_SAFE_INSET_X,
          top: INSPECTION_SAFE_INSET_Y,
          bottom: INSPECTION_SAFE_INSET_Y,
          cursor: markMode && markTool === "pin" ? PIN_CURSOR : undefined,
        };

    // Image, pins, whitening/crease lines and centering all occupy this exact
    // explicit plane. No object-fit letterbox and no CSS scale transform sits
    // between stored image percentages and the rendered overlay coordinates.
    const cardFrame = (
      <div
        ref={containerRef}
        className={`select-none ${
          markMode
            ? markTool === "pin"
              ? ""
              : "cursor-crosshair"
            : zoom > 1
              ? dragging
                ? "cursor-grabbing"
                : "cursor-grab"
              : "cursor-zoom-in"
        }`}
        style={frameStyle}
        onPointerDown={handleMarkPointerDown}
        onClick={handleContainerClick}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        data-testid="grading-image-viewport"
        data-coordinate-mode={markMode ? "measurement" : "inspection"}
        data-inspection-side={side}
        data-inspection-source={inspectionAsset?.source ?? "working-evidence-unavailable"}
        data-inspection-zoom={zoom}
        data-inspection-focus-x={fittedPlacement?.focus.x ?? pan.x / 100}
        data-inspection-focus-y={fittedPlacement?.focus.y ?? pan.y / 100}
        data-card-fit-state={fittedPlacement ? (zoom === 1 ? "fit" : "magnified") : "measuring"}
        data-card-natural-w={imgNaturalDims?.width ?? ""}
        data-card-natural-h={imgNaturalDims?.height ?? ""}
        data-card-rendered-w={fittedPlacement?.width.toFixed(1) ?? ""}
        data-card-rendered-h={fittedPlacement?.height.toFixed(1) ?? ""}
        data-card-clearance-top={fittedPlacement?.top.toFixed(1) ?? ""}
        data-card-clearance-bottom={
          fittedPlacement && inspectionViewport
            ? (inspectionViewport.height - fittedPlacement.top - fittedPlacement.height).toFixed(1)
            : ""
        }
        data-card-clearance-left={fittedPlacement?.left.toFixed(1) ?? ""}
        data-card-clearance-right={
          fittedPlacement && inspectionViewport
            ? (inspectionViewport.width - fittedPlacement.left - fittedPlacement.width).toFixed(1)
            : ""
        }
      >
        {currentUrl ? (
          <div className="relative h-full w-full" data-testid="grading-coordinate-plane">
            <img
              ref={imgElRef}
              src={currentUrl}
              alt={
                inspectionAsset?.source === "review-evidence"
                  ? `${side} authoritative bound scan image`
                  : `${side} full-resolution working evidence`
              }
              className={`block h-full w-full ${fittedPlacement ? "" : "object-contain"}`}
              data-working-evidence={inspectionAsset?.source === "working-evidence" ? "full-resolution" : undefined}
              data-review-evidence={
                inspectionAsset?.source === "review-evidence" ? "certificate-bound-image" : undefined
              }
              data-testid="grading-card-image"
              onLoad={(e) => {
                setImgNaturalDims({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight });
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
        <div
          ref={inspectionViewportRef}
          className="relative h-full w-full min-h-0 min-w-0 flex-1 overflow-hidden overscroll-contain"
          style={!fillHost && !fullscreen ? { height: maxH } : undefined}
          data-testid="grading-card-viewport"
          data-card-viewport-w={inspectionViewport?.width.toFixed(1) ?? ""}
          data-card-viewport-h={inspectionViewport?.height.toFixed(1) ?? ""}
          data-card-safe-inset-x={INSPECTION_SAFE_INSET_X}
          data-card-safe-inset-y={INSPECTION_SAFE_INSET_Y}
        >
          {cardFrame}
        </div>

        {!fillHost && !fullscreen ? (
          <div className="mt-2 flex shrink-0 items-center justify-end">{renderZoomPill()}</div>
        ) : null}
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
          disabled={zoom <= CARD_INSPECTION_MIN_ZOOM + 0.001}
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
          disabled={zoom >= CARD_INSPECTION_MAX_ZOOM - 0.001}
          className="h-8 w-8 flex items-center justify-center text-white hover:text-[var(--admin-gold)] disabled:text-[var(--admin-ink-dim)] transition-colors rounded-full"
        >
          <ZoomIn size={14} />
        </button>
        <button
          type="button"
          aria-label="Fit to screen / reset zoom"
          onClick={(e) => {
            e.stopPropagation();
            zoomReset();
          }}
          className="flex h-8 items-center gap-1 rounded-full px-2 text-[9px] font-bold text-[var(--admin-ink-dim)] transition-colors hover:text-white"
        >
          <RotateCcw size={11} /> FIT
        </button>
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
          <div className="flex min-h-0 flex-1 items-center justify-center p-4">
            <div className="flex h-full w-full min-h-0 min-w-0">{renderImageArea("85vh")}</div>
          </div>

          {/* Dropdown renders via Portal so the annotation plane can never clip it. */}

          {/* Bottom toolbar is one horizontally scrollable row. Browser UI scaling
              cannot wrap it and feed a new height back into the image viewport. */}
          <div className="flex shrink-0 items-center justify-between gap-4 overflow-x-auto border-t border-[var(--admin-line-hard)] px-4 py-3">
            <div className="flex shrink-0 items-center gap-3">
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
            <div className="flex shrink-0 items-center gap-3">
              {renderZoomPill()}
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
        /* One non-wrapping row owns side, zoom and certificate controls. */
        <div className="flex shrink-0 items-center justify-between gap-2" data-testid="grading-top-utility-row">
          <div className="flex shrink-0 items-center gap-1 overflow-x-auto">
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
          // (ResizeObserver on inspectionViewportRef) rather than inferred, and the fitted
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
        className="flex shrink-0 flex-nowrap items-center gap-2 overflow-x-auto pb-1"
        data-testid="grading-card-controls"
      >
        <p
          className={`shrink-0 text-[9px] font-bold uppercase tracking-widest ${
            currentUrl ? "text-emerald-300" : "text-amber-300"
          }`}
          data-testid="working-evidence-status"
        >
          {workingEvidenceAvailable
            ? `Full-resolution working evidence · ${side}`
            : reviewEvidenceAvailable
              ? `Authoritative review image · ${side}`
              : `Working evidence unavailable · ${side}`}
        </p>
        {/* Side-specific centering/defect tools remain directly available in the
            workstation. A side without canonical working evidence is visibly
            disabled rather than being allowed to use a derivative by accident. */}
        {onOpenCardTool && mutationsEnabled && !readOnly && (
          <>
            {(["front", "back"] as const).map((toolSide) => {
              const available = toolSide === "front" ? frontCardToolAvailable : backCardToolAvailable;
              return (
                <button
                  key={toolSide}
                  type="button"
                  onClick={() => onOpenCardTool(toolSide)}
                  disabled={!available}
                  title={
                    available
                      ? `Open Card Tool — ${toolSide.toUpperCase()}`
                      : "An authorised full-resolution image for this side is required before its Card Tool can open"
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
  // into document.body. The inspection viewport deliberately clips magnified
  // evidence; without portaling, the popover would be clipped at that boundary.
  // Same pattern as the picker dropdown earlier in this file.
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
