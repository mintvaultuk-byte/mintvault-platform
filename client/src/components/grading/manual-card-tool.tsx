import { useState, useRef, useEffect, useLayoutEffect } from "react";
import {
  Loader2,
  Crop,
  X,
  Check,
  Undo2,
  ZoomIn,
  ZoomOut,
  Maximize,
  Target,
  RotateCcw,
  Minus,
  Plus,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { type Point } from "./crop-geometry";
import { detectCardBounds, boundsToOuterEdges } from "./crop-tools";
import {
  computeCardTool,
  cropBoxForEdges,
  edgesToRect,
  outerEdgesToBboxQuad,
  routePlacement,
  nextPass,
  axisLockInner,
  type CardToolMode,
} from "./card-tool-geometry";
import { type CenteringResult } from "./manual-centering";
import { deriveZone, LINE_COLOUR_PALETTE, type Defect, type MvgsCode } from "./defect-annotation";
import { detectEdge, coverageFromSegment, creaseSpanFromSegment } from "./measurement-math";
import DefectTypePicker, { type DefectPickerAnchor, type DefectTier } from "./defect-type-picker";

interface Props {
  side: "front" | "back";
  certId: number;
  /** RAW original image URL. Display the raw (not the cropped) so /recrop —
   *  which rotates the raw first then crops — never double-rotates. */
  rawImageUrl: string;
  /** Called after a successful compute (recrop ± centering) so the panel can
   *  refresh the images + grading queries. */
  onDone: () => void;
  onCancel: () => void;
  /** In full mode, fired with the centering result so the panel updates its
   *  L/R, T/B, outer/inner and method state (same shape as ManualCentering). */
  onCentering?: (result: CenteringResult) => void;
  /** Wired by the grading panel — same handler image-viewer's mark mode uses.
   *  Pushes each committed defect into the panel's defects state, which the
   *  panel's debounced auto-save (PUT /grade) picks up. Omitting it disables
   *  the defects phase: the tool reverts to closing immediately on Compute. */
  onDefectAdded?: (defect: Defect) => void;
  /** Pre-existing defects for THIS side — already on the cert (from prior
   *  marking sessions or AI auto-detect promotion). Drawn under the cursor
   *  so the operator can see what's already pinned and avoid duplicates.
   *  Numbering for new pins starts at max(existing.id) + 1. */
  existingDefects?: Defect[];
  /** MVGS v2.1 — line measurements drawn inside the defects phase, alongside
   *  the pin tool. Same shape as image-viewer's line props. Omitted handlers
   *  → that tool option is hidden; defects phase falls back to pin-only. */
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
  /** Background crop-upload owner (lives in the panel so the upload + retry
   *  survive this tool closing, and so the panel's Approve gate can block on
   *  it). Called with the /recrop body; resolves the fresh display URL on
   *  success (for the seamless <img> swap) or undefined on final failure.
   *  When provided alongside onDefectAdded, Compute transitions to the defects
   *  phase INSTANTLY against a local crop preview while this runs in the
   *  background. Absent → the legacy synchronous (await /recrop) path. */
  onStartCropUpload?: (payload: RecropPayload) => Promise<string | undefined>;
  /** Panel-owned crop-sync status for THIS side, surfaced as a chip in the
   *  defects banner. */
  cropSyncStatus?: "idle" | "pending" | "synced" | "failed";
  /** Re-runs THIS side's failed crop upload; resolves the display URL on success. */
  onRetryCrop?: () => Promise<string | undefined>;
  /** Phase to open in. "defects" jumps straight to defect-marking on an
   *  existing crop (centering already saved + crop image present), skipping the
   *  8-dot capture. Defaults to "capture". */
  initialPhase?: "capture" | "defects";
  /** When opening directly in "defects", the already-cropped display image URL
   *  to load as the defects-phase <img> (no /recrop re-run needed). */
  existingCroppedUrl?: string;
  /** API base for cert endpoints: '/api/admin' (default) or '/api/grader'. */
  apiBase?: string;
  /** Current grading token, owned by the parent panel so card-tool saves join
   *  the same optimistic-concurrency stream as draft autosaves. */
  getExpectedGradingVersion?: () => number | null;
  onGradingVersionSaved?: (version: unknown) => void;
  onGradingConflict?: (status: number, data: any) => boolean;
}

/** Body of POST /api/admin/certificates/:id/recrop. */
export interface RecropPayload {
  side: "front" | "back";
  left_pct: number;
  top_pct: number;
  width_pct: number;
  height_pct: number;
  rotation_deg: number;
  quad: ReturnType<typeof outerEdgesToBboxQuad>;
}

// Points are captured clockwise, one SIDE at a time. Index → short label.
const SIDE_LABELS = ["T", "R", "B", "L"] as const;
// Plain-English side names for the guidance banner (index → name).
const SIDE_NAMES = ["TOP", "RIGHT", "BOTTOM", "LEFT"] as const;
// Near-miss grab radius (screen px) — POST-PLACEMENT ONLY. A click within this
// of an already-placed dot grabs the nearest dot for fine-tune dragging. During
// placement (any of the 8 still missing) the grab path is disabled entirely so
// adjacent placement (e.g. top-outer + top-inner on the same vertical line)
// never gets diverted into a drag.
const GRAB_PX = 40;
// Touch tap-vs-scroll discrimination (iPad). A finger that moves more than this
// many SCREEN px between touchstart and touchend was a scroll/pan, not a tap, so
// it must NOT drop a centering dot or a defect pin. Matches image-viewer.tsx's
// 8px pin threshold. Touch only — mouse/trackpad placement is unaffected.
const TAP_MOVE_PX = 8;
// Zoom — 1× = fit-to-area (whole card visible). Max raised well past native
// pixel density so the operator can place crosshairs precisely on the border
// line. Viewport-center anchored so the user keeps looking at the same content
// across zoom changes. Capture math is dimensionless (% of containerRef rect)
// so it stays accurate at any zoom.
const MIN_ZOOM = 1;
const MAX_ZOOM = 16;
const ZOOM_STEP = 1.5;
// Rotate / straighten (deskew) bounds — the SINGLE source of the clamp, shared
// by the slider AND the ± steppers so they can never use a different limit. The
// slider's own step stays 0.5; the steppers nudge a finer 0.1° (readout is
// toFixed(1)).
const ROTATION_MIN = -15;
const ROTATION_MAX = 15;
const ROTATION_STEP_FINE = 0.1;
// Thin mat margin (0–100 units) added around the outer bbox before cropping, so
// a deskew rotation doesn't clip the card corners.
const CROP_MARGIN_PCT = 1.0;
// Line-colour palette — switches the crosshair markers, cursor reticle, full-
// length alignment guides, banner chip, edge-rect strokes and count labels.
// All pass-coloured indicators move together so the operator can dial the
// crosshair into something that reads on grey/silver/foil/holo cards where
// the brand gold/green disappears. Two shades per entry so outer vs inner
// retains a colour distinction (the brighter saturated tone for OUTER edges,
// a lighter same-hue for INNER). The brand surfaces (mode toggle, Compute
// button, "clear" link hovers, subgrade text colour) are deliberately NOT
// driven by this palette — they stay MintVault gold regardless of pick.
type LinePalette = { id: string; label: string; outer: string; inner: string };
const LINE_PALETTES: LinePalette[] = [
  { id: "default", label: "Default — gold / green", outer: "#D4AF37", inner: "#16A34A" },
  { id: "magenta", label: "Magenta — high contrast on grey/silver", outer: "#FF00AA", inner: "#FF66CC" },
  { id: "cyan", label: "Cyan — high contrast on yellow holos", outer: "#00CCFF", inner: "#66E5FF" },
  { id: "lime", label: "Lime — high contrast on dark / red cards", outer: "#00FF66", inner: "#CCFF66" },
  { id: "red", label: "Red — high contrast on cyan / blue / silver", outer: "#FF2A2A", inner: "#FF8888" },
  { id: "white", label: "White — high contrast on dark / holo art", outer: "#FFFFFF", inner: "#AEB4BC" },
];

export const CENTERING_GUIDE_VISUALS = {
  crosshairHaloStrokeWidth: 2.25,
  crosshairColorStrokeWidth: 1.25,
  centroidStrokeWidth: 1.2,
  placedHaloStrokeWidth: 3.5,
  placedColorStrokeWidth: 2,
  railHaloStrokeWidth: 4,
  railColorStrokeWidth: 2.25,
  liveHaloStrokeWidth: 3.75,
  liveColorStrokeWidth: 2.25,
  haloStroke: "rgba(0,0,0,0.72)",
  lightOutlineStroke: "rgba(255,255,255,0.82)",
} as const;

type DotPass = "outer" | "inner";

function clamp(v: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, v));
}

function centroid(pts: Point[]): Point {
  if (pts.length === 0) return { x: 50, y: 50 };
  const sx = pts.reduce((s, p) => s + p.x, 0);
  const sy = pts.reduce((s, p) => s + p.y, 0);
  return { x: sx / pts.length, y: sy / pts.length };
}

/**
 * Two-tone crosshair marker: a dark halo underlay (contrast on light
 * cards) plus a coloured "+" with an open centre and ring (contrast on dark
 * cards). Shared by every placed dot AND the live cursor reticle so they read
 * as one family. No solid fill — the artwork and the exact centre stay visible.
 */
function Crosshair({ color }: { color: string }) {
  return (
    <svg className="absolute inset-0 pointer-events-none" width={44} height={44} viewBox="0 0 44 44" aria-hidden="true">
      <g fill="none" strokeLinecap="round">
        <g stroke={CENTERING_GUIDE_VISUALS.haloStroke} strokeWidth={CENTERING_GUIDE_VISUALS.crosshairHaloStrokeWidth}>
          <line x1={22} y1={15} x2={22} y2={19} />
          <line x1={22} y1={25} x2={22} y2={29} />
          <line x1={15} y1={22} x2={19} y2={22} />
          <line x1={25} y1={22} x2={29} y2={22} />
          <circle cx={22} cy={22} r={2} />
        </g>
        <g
          stroke={CENTERING_GUIDE_VISUALS.lightOutlineStroke}
          strokeWidth={CENTERING_GUIDE_VISUALS.crosshairColorStrokeWidth + 0.7}
        >
          <line x1={22} y1={15} x2={22} y2={19} />
          <line x1={22} y1={25} x2={22} y2={29} />
          <line x1={15} y1={22} x2={19} y2={22} />
          <line x1={25} y1={22} x2={29} y2={22} />
          <circle cx={22} cy={22} r={2} />
        </g>
        <g stroke={color} strokeWidth={CENTERING_GUIDE_VISUALS.crosshairColorStrokeWidth}>
          <line x1={22} y1={15} x2={22} y2={19} />
          <line x1={22} y1={25} x2={22} y2={29} />
          <line x1={15} y1={22} x2={19} y2={22} />
          <line x1={25} y1={22} x2={29} y2={22} />
          <circle cx={22} cy={22} r={2} />
        </g>
      </g>
    </svg>
  );
}

/**
 * Mini card-shape map showing WHICH side is active (so the operator doesn't have
 * to decode T/R/B/L). The active side glows a thick line in the current pass
 * colour (gold = placing OUTER, green = placing INNER); already-measured sides
 * are solid grey; pending sides are faint. `activeSide` is -1 when every point
 * is down. Side order matches SIDE_LABELS: [TOP, RIGHT, BOTTOM, LEFT].
 */
function SideDiagram({
  activeSide,
  activeColor,
  outerCount,
  innerCount,
  mode,
}: {
  activeSide: number;
  // Driven by the parent so the diagram follows the user-selected line palette.
  activeColor: string;
  outerCount: number;
  innerCount: number;
  mode: CardToolMode;
}) {
  // Edge endpoints on the mini card body (x6 y6 w44 h66 → right 50, bottom 72),
  // in [TOP, RIGHT, BOTTOM, LEFT] order to match the capture sequence.
  const EDGES = [
    { x1: 12, y1: 6, x2: 44, y2: 6 }, // TOP
    { x1: 50, y1: 12, x2: 50, y2: 66 }, // RIGHT
    { x1: 12, y1: 72, x2: 44, y2: 72 }, // BOTTOM
    { x1: 6, y1: 12, x2: 6, y2: 66 }, // LEFT
  ];
  return (
    <svg width={40} height={56} viewBox="0 0 56 78" className="flex-shrink-0" aria-hidden="true">
      {/* Card body + faint inner frame */}
      <rect x={6} y={6} width={44} height={66} rx={4} fill="#F7F7F5" stroke="#C9C5BD" strokeWidth={2} />
      <rect x={14} y={14} width={28} height={50} rx={2} fill="none" stroke="#E2DED6" strokeWidth={1.25} />
      {EDGES.map((e, i) => {
        const done = mode === "outer-only" ? i < outerCount : i < innerCount;
        const isActive = i === activeSide;
        return (
          <line
            key={i}
            x1={e.x1}
            y1={e.y1}
            x2={e.x2}
            y2={e.y2}
            stroke={isActive ? activeColor : done ? "#9CA3AF" : "#D8D4CC"}
            strokeWidth={isActive ? 5 : done ? 4 : 2.5}
            strokeLinecap="round"
          />
        );
      })}
    </svg>
  );
}

export default function ManualCardTool({
  side,
  certId,
  rawImageUrl,
  onDone,
  onCancel,
  onCentering,
  onDefectAdded,
  existingDefects,
  whiteningLines = [],
  creaseLines = [],
  onWhiteningLinesChange,
  onCreaseLinesChange,
  onStartCropUpload,
  cropSyncStatus = "idle",
  onRetryCrop,
  initialPhase = "capture",
  existingCroppedUrl,
  apiBase = "/api/admin",
  getExpectedGradingVersion,
  onGradingVersionSaved,
  onGradingConflict,
}: Props) {
  const [mode, setMode] = useState<CardToolMode>("full");
  const [outerPts, setOuterPts] = useState<Point[]>([]);
  const [innerPts, setInnerPts] = useState<Point[]>([]);
  // Deskew override in degrees. 0 = auto-derive from the 4 outer dots. A
  // non-zero value overrides the auto angle (it does NOT rotate the captured
  // image, so capturing stays free of getBoundingClientRect AABB distortion).
  const [rotation, setRotation] = useState(0);
  const [imgDims, setImgDims] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [saving, setSaving] = useState(false);
  const [detecting, setDetecting] = useState(false);
  // Crosshair / reticle / guide colour palette — session-scoped (React state,
  // no localStorage per spec). Default = brand gold/green; swatch picker in
  // the floating panel lets the operator switch to high-contrast hues for
  // grey/silver/foil/holo cards. Outer keeps a saturated tone, inner a lighter
  // same-hue so outer vs inner stay distinguishable on every palette.
  const [paletteId, setPaletteId] = useState<string>("default");
  // Phase machine — "capture" (the 8-dot flow, unchanged) followed by an
  // optional "defects" phase that engages automatically after Compute saves
  // the crop + centering. The defects phase reuses the same fullscreen
  // overlay, zoom, scroll-pan, crosshair, and colour picker; only the click
  // handler + banner change. Cancelling out of defects doesn't lose anything
  // — the crop and centering are already durably saved by handleCompute.
  // No `onDefectAdded` prop → phase stays "capture" forever and the tool
  // closes on Compute as it did pre-merge.
  // Opens in `initialPhase`: "defects" when the panel knows this side already
  // has a crop (skip the 8-dot capture entirely), else "capture".
  const [phase, setPhase] = useState<"capture" | "defects">(initialPhase);
  // After Compute: the cache-busted signed URL of the freshly-cropped display
  // image, returned by /recrop's response. Becomes the <img src> for the
  // defects phase so the operator marks pins on the new crop (not the raw).
  // When opening directly in defects, seeded from the existing crop URL.
  const [croppedDisplayUrl, setCroppedDisplayUrl] = useState<string | null>(
    initialPhase === "defects" && existingCroppedUrl ? existingCroppedUrl : null
  );
  // Optimistic local crop preview shown the instant Compute fires, while the
  // real crop uploads to R2 in the background. Geometry mirrors the server's
  // rotate(deskew)+rectangular-extract exactly (in natural pixels) so defect
  // pins — which are frame-relative percentages — land identically once the
  // R2 image swaps in. Cleared back to null once croppedDisplayUrl arrives.
  const [localPreview, setLocalPreview] = useState<null | {
    rawW: number;
    rawH: number;
    d: number; // deskew degrees (server rotates the raw by this first)
    RW: number; // rotated-expanded raw width  (natural px)
    RH: number; // rotated-expanded raw height (natural px)
    cl: number; // crop left in rotated-expanded space (natural px)
    ct: number; // crop top
    cw: number; // crop width
    ch: number; // crop height
  }>(null);
  // Defect-marking batch state (mirrors image-viewer.tsx's pendingBatch +
  // pickerOpen + pickerAnchor + pickerTier shape so behaviour stays identical
  // across both call sites). Each click in the defects phase drops a pin
  // into `defectBatch`; double-click or Enter opens the shared picker;
  // commit assigns the chosen MVGS code + tier to the whole batch and fires
  // `onDefectAdded` per pin — same callback the panel wires to image-viewer.
  type DefectPin = { x: number; y: number; pxX: number; pxY: number };
  const [defectBatch, setDefectBatch] = useState<DefectPin[]>([]);
  const [defectPickerOpen, setDefectPickerOpen] = useState(false);
  const [defectPickerAnchor, setDefectPickerAnchor] = useState<DefectPickerAnchor | null>(null);
  const [defectPickerTier, setDefectPickerTier] = useState<DefectTier>("D2");
  // MVGS v2.1 — defects-phase tool palette + line drawing. Same shape as
  // image-viewer.tsx; the pin path stays byte-identical when markTool === "pin".
  type MarkTool = "pin" | "whitening" | "crease";
  const [markTool, setMarkTool] = useState<MarkTool>("pin");
  // MVGS v2.1 — selected line colour (display-only). Picked in the palette
  // BEFORE drawing; each new line is born with it. Stripped at the
  // mvgs-input-builder boundary — never reaches the engine.
  const [lineColor, setLineColor] = useState<string>(LINE_COLOUR_PALETTE[0]);
  const [lineStart, setLineStart] = useState<{ x: number; y: number } | null>(null);
  const [lineEnd, setLineEnd] = useState<{ x: number; y: number } | null>(null);
  const canDrawWhitening = !!onWhiteningLinesChange;
  const canDrawCrease = !!onCreaseLinesChange;
  // Local mirror of just-committed defects, used to render their pins inside
  // the tool. Parent state is the source of truth via onDefectAdded — the
  // panel's auto-save then persists. This mirror exists because the parent's
  // updated defects don't flow back into the overlay (the panel is hidden
  // beneath this fixed-inset overlay), so without it the operator would not
  // see pins they just committed. Seeded from props.existingDefects.
  // Seeded immediately when opening directly in defects so prior pins for this
  // side are visible without a Compute (handleCompute seeds it on the normal
  // capture→defects path).
  const [committedDefects, setCommittedDefects] = useState<Defect[]>(
    initialPhase === "defects" ? (existingDefects ?? []).filter((d) => d.image_side === side) : []
  );
  const lastDefectClickAtRef = useRef<number>(0);
  // Cursor position in % while hovering the image in placement mode; drives the
  // live targeting reticle. Null when not hovering / not placing.
  const [hover, setHover] = useState<Point | null>(null);
  const [drag, setDrag] = useState<null | {
    pass: DotPass;
    index: number;
    startMouse: Point;
    startPts: Point[];
    // Outer partner to axis-lock against while dragging an INNER dot. Captured
    // at drag start because the drag effect's deps are [drag] only and can't
    // read live outerPts. Null for outer dots (they drag freely).
    lockOuter: Point | null;
  }>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Available image-area box (px) the card is scaled to fit, so the whole card
  // — all four corners incl. the TOP edge — is visible below the banner without
  // scrolling. Measured from the image-area; purely presentational (the capture
  // math reads the rendered box at click time and is unaffected by this).
  const fitRef = useRef<HTMLDivElement>(null);
  const [fitBox, setFitBox] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const lastTouchAtRef = useRef<number>(0);
  // Pending single-finger touch gesture (iPad). Set on a one-finger touchstart
  // over a placement target; the mark is only committed on touchend IF the finger
  // stayed within TAP_MOVE_PX and no second finger ever landed. A second finger
  // (multi) or movement past the threshold (moved) turns it into a pan/zoom/scroll
  // that places nothing. `kind` selects which placement to commit on a clean tap.
  const touchTapRef = useRef<{
    x: number;
    y: number;
    kind: "defect" | "place";
    multi: boolean;
    moved: boolean;
  } | null>(null);
  const { toast } = useToast();

  // Zoom anchored at viewport centre — keep the content under the centre of
  // the scroll viewport fixed across the transition. Scroll position is set
  // in rAF after React commits the new size.
  function zoomBy(factor: number) {
    const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
    if (newZoom === zoom) return;
    const el = fitRef.current;
    if (!el) {
      setZoom(newZoom);
      return;
    }
    const cx = el.scrollLeft + el.clientWidth / 2;
    const cy = el.scrollTop + el.clientHeight / 2;
    const ratio = newZoom / zoom;
    setZoom(newZoom);
    requestAnimationFrame(() => {
      const e2 = fitRef.current;
      if (!e2) return;
      e2.scrollLeft = cx * ratio - e2.clientWidth / 2;
      e2.scrollTop = cy * ratio - e2.clientHeight / 2;
    });
  }
  function zoomInBtn() {
    zoomBy(ZOOM_STEP);
  }
  function zoomOutBtn() {
    zoomBy(1 / ZOOM_STEP);
  }
  function zoomFit() {
    if (zoom === 1) return;
    zoomBy(1 / zoom);
  }

  // ± steppers for the Rotate / straighten slider — they write the SAME
  // `rotation` state the slider uses (no separate path). Functional updater so
  // there's no stale-closure on rotation. Math.round(...*10)/10 kills float
  // drift (0.1 + 0.2 = 0.30000000000000004) so the toFixed(1) readout stays
  // clean AND the rotation_deg sent to /recrop is exact. Clamped to the shared
  // ROTATION_MIN/MAX. (0 is the "auto from dots" sentinel — clamping naturally
  // re-enters it when stepping lands back on 0.0; no special-casing needed.)
  function nudgeRotation(delta: number) {
    setRotation((r) => {
      const next = Math.round((r + delta) * 10) / 10;
      return Math.max(ROTATION_MIN, Math.min(ROTATION_MAX, next));
    });
  }

  // Side-by-side capture: work clockwise TOP → RIGHT → BOTTOM → LEFT, placing
  // this side's OUTER then its INNER before moving on. The next click's pass is
  // decided by parity (arrays level → OUTER, outer one ahead → INNER). The
  // arrays end ordered [TOP,RIGHT,BOTTOM,LEFT], read by the edge geometry. Once
  // both are full, clicks become near-miss grabs.
  const activePass: DotPass = nextPass(mode, outerPts, innerPts);
  const activeArr = activePass === "outer" ? outerPts : innerPts;
  const outerReady = outerPts.length === 4;
  const innerReady = innerPts.length === 4;
  const canCompute = outerReady && (mode === "outer-only" || innerReady);
  // Still placing points in the active pass → show the cursor reticle + guides.
  const placing = activeArr.length < 4;
  // Resolved palette (default-safe). Drives every pass-coloured line element
  // — crosshair markers, cursor reticle, live cursor sniper guides, per-
  // placed-point guides, banner chip, side diagram, edge rectangles, and the
  // Outer/Inner count labels in the controls row.
  const palette = LINE_PALETTES.find((p) => p.id === paletteId) ?? LINE_PALETTES[0];
  const activeColor = activePass === "outer" ? palette.outer : palette.inner;
  // Guidance: total points down, target, and the side index (0..3) we're on.
  const totalPlaced = outerPts.length + innerPts.length;
  const target = mode === "outer-only" ? 4 : 8;
  const activeSide = mode === "outer-only" ? outerPts.length : Math.floor(totalPlaced / 2);
  // During INNER placement the next dot is axis-locked to its outer partner: we
  // draw a solid rail through that outer point and snap the reticle + cursor
  // guides onto it so the lock is visible before the click. Null otherwise.
  const innerLockOuter =
    placing && mode === "full" && activePass === "inner" ? (outerPts[innerPts.length] ?? null) : null;
  // Where the inner dot will actually land (snapped to the rail). Reticle +
  // cursor guides read this so the preview matches the locked placement.
  const lockedHover = hover && innerLockOuter ? axisLockInner(innerPts.length, innerLockOuter, hover) : hover;
  // Large step prompt shown in the guidance banner (replaces the old 10px text).
  // In the defects phase the prompt changes to defect-marking guidance.
  const bannerText =
    phase === "defects"
      ? defectBatch.length > 0
        ? `Mark defects — ${defectBatch.length} pin${defectBatch.length === 1 ? "" : "s"} placed. Double-click or press Enter to label.`
        : "Mark defects — click the image to drop pins. Place multiple, then double-click or Enter to label them all."
      : canCompute
        ? "Ready — drag any dot to fine-tune, then Compute"
        : activePass === "outer"
          ? `Side ${activeSide + 1} of 4 — ${SIDE_NAMES[activeSide]}. Click the OUTER edge (card edge).`
          : `Side ${activeSide + 1} of 4 — ${SIDE_NAMES[activeSide]}. Click the INNER edge (border meets artwork).`;

  // Screen (client) px → image % (0–100) in the card's UNROTATED source frame.
  // During capture the stage container is visually rotated by `rotation`° about
  // its centre (STEP 2); to store dots in source coordinates we INVERSE-rotate
  // the click about that SAME centre. At rotation 0 (or in defects, where no
  // capture rotation is applied) this is the original direct mapping. Returns
  // UNCLAMPED % — callers clamp where appropriate. Zoom/pan stay handled by the
  // live getBoundingClientRect read, unchanged.
  function screenToImagePct(clientX: number, clientY: number): Point | null {
    const el = containerRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (rotation === 0 || phase !== "capture") {
      return { x: ((clientX - r.left) / r.width) * 100, y: ((clientY - r.top) / r.height) * 100 };
    }
    // Rotated stage: getBoundingClientRect returns the AABB of the rotated box,
    // whose centre is the rotation-invariant stage centre (= the CSS
    // transform-origin). Inverse-rotate the click about it by -rotation in
    // SCREEN px using the UNROTATED on-screen size, then to %. offsetWidth/Height
    // are read live and are transform-INDEPENDENT (they ignore the rotate), so
    // they give the true unrotated size with zero stale-closure risk and always
    // reflect the current zoom. Rotating in px (not %) avoids aspect distortion
    // on a non-square card. This is the exact inverse of rotate(rotation°), so a
    // stored dot re-renders precisely under the cursor.
    const W = el.offsetWidth;
    const H = el.offsetHeight;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const rad = (rotation * Math.PI) / 180;
    const sx = clientX - cx;
    const sy = clientY - cy;
    const ux = sx * Math.cos(rad) + sy * Math.sin(rad); // R(-rotation) · (sx,sy)
    const uy = -sx * Math.sin(rad) + sy * Math.cos(rad);
    return { x: ((ux + W / 2) / W) * 100, y: ((uy + H / 2) / H) * 100 };
  }

  function toPct(e: MouseEvent | React.MouseEvent): Point | null {
    const p = screenToImagePct(e.clientX, e.clientY);
    return p ? { x: clamp(p.x), y: clamp(p.y) } : null;
  }

  // FORWARD-rotate an image-% point to its on-screen % position within the
  // (un-rotated) stage box — the EXACT inverse of screenToImagePct's −rotation
  // map (R(+rotation) in px about the centre, so non-square aspect is handled).
  // Used to anchor the LEVEL guide overlay: the card image + dots live in the
  // rotated stage, but the alignment guides render screen-level, so a guide that
  // must pass through a card-space point (a placed dot, the centroid, the cursor)
  // is drawn through this forward-rotated screen position instead. Identity when
  // there's no capture rotation (rotation 0 / defects / size not yet known), so
  // the guides render byte-identically to before in those cases.
  function imagePctToScreenPct(p: Point): Point {
    if (rotation === 0 || phase !== "capture" || !renderW || !renderH) return p;
    const W = renderW;
    const H = renderH;
    const ux = (p.x / 100 - 0.5) * W;
    const uy = (p.y / 100 - 0.5) * H;
    const rad = (rotation * Math.PI) / 180;
    const sx = ux * Math.cos(rad) - uy * Math.sin(rad); // R(+rotation) · (ux,uy)
    const sy = ux * Math.sin(rad) + uy * Math.cos(rad);
    return { x: (sx / W + 0.5) * 100, y: (sy / H + 0.5) * 100 };
  }

  function placePoint(pt: Point) {
    // Axis-lock the INNER point to its outer partner (placed first this side) so
    // the pair differs only on the measurement axis. No-op for the centering
    // math — edgesToRect already reads one axis per point — it just snaps the
    // dot onto the rail the math uses. Outer points stay free.
    let p = pt;
    if (mode === "full" && nextPass(mode, outerPts, innerPts) === "inner") {
      p = axisLockInner(innerPts.length, outerPts[innerPts.length], pt);
    }
    // Route by corner-by-corner parity. routePlacement returns the unchanged
    // array by reference, so the matching setState bails out (no extra render).
    const next = routePlacement(mode, outerPts, innerPts, p);
    setOuterPts(next.outer);
    setInnerPts(next.inner);
  }

  // Per-point undo: pop the most recently placed dot, reversing the capture
  // sequence. Mid-corner (outer ahead of inner) the last point was an OUTER;
  // when the corner is complete (arrays level, >0) the last was an INNER.
  function undoLast() {
    if (mode === "outer-only") {
      if (outerPts.length > 0) setOuterPts(outerPts.slice(0, -1));
      return;
    }
    if (outerPts.length > innerPts.length) setOuterPts(outerPts.slice(0, -1));
    else if (innerPts.length > 0) setInnerPts(innerPts.slice(0, -1));
  }

  /** All placed dots (with pass + index) for near-miss grab tests. */
  function allDots(): { pass: DotPass; index: number; p: Point }[] {
    const list: { pass: DotPass; index: number; p: Point }[] = outerPts.map((p, i) => ({ pass: "outer", index: i, p }));
    if (mode !== "outer-only") innerPts.forEach((p, i) => list.push({ pass: "inner", index: i, p }));
    return list;
  }

  function nearestDot(clientX: number, clientY: number): { pass: DotPass; index: number } | null {
    const el = containerRef.current;
    if (!el) return null;
    // Map the click into the card frame (rotation-aware), then measure distance
    // to each dot there. Rotation is an isometry, so card-frame distance equals
    // true on-screen distance — GRAB_PX stays a screen-px threshold.
    const cp = screenToImagePct(clientX, clientY);
    if (!cp) return null;
    // %→screen-px scale = the UNROTATED card size. At rotation 0 that's exactly
    // the live rect (byte-identical to the old grab math); when rotated the rect
    // is the AABB, so use renderW/H (the true unrotated on-screen size).
    const rotated = rotation !== 0 && phase === "capture";
    const r = el.getBoundingClientRect();
    const W = rotated ? el.offsetWidth : r.width;
    const H = rotated ? el.offsetHeight : r.height;
    let best: { pass: DotPass; index: number } | null = null;
    let bestD = Infinity;
    for (const c of allDots()) {
      const d = Math.hypot(((cp.x - c.p.x) / 100) * W, ((cp.y - c.p.y) / 100) * H);
      if (d < bestD) {
        bestD = d;
        best = { pass: c.pass, index: c.index };
      }
    }
    return best && bestD <= GRAB_PX ? best : null;
  }

  function startDotDrag(pass: DotPass, index: number, clientX: number, clientY: number) {
    const startPts = (pass === "outer" ? outerPts : innerPts).map((p) => ({ ...p }));
    // Inner dots stay axis-locked to their outer partner (same [TOP,RIGHT,
    // BOTTOM,LEFT] slot) while dragging — capture it now for the drag effect.
    const lockOuter = pass === "inner" && mode === "full" ? (outerPts[index] ?? null) : null;
    setDrag({ pass, index, startMouse: { x: clientX, y: clientY }, startPts, lockOuter });
  }

  // Container press: in the capture phase, place the next dot (or grab a
  // nearby dot for fine-tune drag). In the defects phase, route to the
  // pin handler or the line-drawing tool depending on markTool.
  function onContainerMouseDown(e: React.MouseEvent) {
    if (Date.now() - lastTouchAtRef.current < 500) return; // ignore synthetic touch
    if (phase === "defects") {
      if (markTool !== "pin") {
        // MVGS v2.1 line draw — capture start at mouse-down.
        const pt = toPct(e);
        if (pt) {
          setLineStart(pt);
          setLineEnd(pt);
        }
        return;
      }
      onDefectAreaClick(e);
      return;
    }
    if (activeArr.length < 4) {
      const pt = toPct(e);
      if (pt) placePoint(pt);
      return;
    }
    const hit = nearestDot(e.clientX, e.clientY);
    if (hit) {
      e.preventDefault();
      startDotDrag(hit.pass, hit.index, e.clientX, e.clientY);
    }
  }

  // Track the cursor for the live targeting reticle — placement mode AND
  // defects phase (so the operator gets a precise crosshair when dropping
  // defect pins too). Never while dragging.
  function onContainerMouseMove(e: React.MouseEvent) {
    if (drag) {
      if (hover) setHover(null);
      return;
    }
    if (phase === "defects") {
      if (lineStart) {
        const pt = toPct(e);
        if (pt) setLineEnd(pt);
        return;
      }
      setHover(toPct(e));
      return;
    }
    if (!placing) {
      if (hover) setHover(null);
      return;
    }
    setHover(toPct(e));
  }

  // MVGS v2.1 — commit the in-progress line on mouse-up.
  function onContainerMouseUp() {
    if (!lineStart || !lineEnd) {
      setLineStart(null);
      setLineEnd(null);
      return;
    }
    const dx = Math.abs(lineEnd.x - lineStart.x);
    const dy = Math.abs(lineEnd.y - lineStart.y);
    if (Math.max(dx, dy) < 2) {
      setLineStart(null);
      setLineEnd(null);
      return;
    }
    if (markTool === "whitening" && onWhiteningLinesChange) {
      const edge = detectEdge(lineStart, lineEnd);
      const coveragePct = coverageFromSegment(lineStart, lineEnd, edge);
      const id = `wl-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      // APPEND — multiple whitening lines per (side, edge) are allowed.
      // The engine boundary in mvgs-input-builder collapses to ONE entry
      // per edge using MAX coverage (worst-line-wins, no compounding).
      onWhiteningLinesChange([
        ...whiteningLines,
        { id, side, edge, coveragePct, start: lineStart, end: lineEnd, color: lineColor },
      ]);
    } else if (markTool === "crease" && onCreaseLinesChange) {
      const spanPct = creaseSpanFromSegment(lineStart, lineEnd);
      const id = `cl-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      onCreaseLinesChange([...creaseLines, { id, side, spanPct, start: lineStart, end: lineEnd, color: lineColor }]);
    }
    setLineStart(null);
    setLineEnd(null);
  }
  function onContainerMouseLeave() {
    if (hover) setHover(null);
  }

  // iPad touch entry. Two distinct gestures share this canvas:
  //   • TWO+ fingers  → pan / pinch-zoom the scroll viewport. Place NOTHING, and
  //     cancel any pending tap or in-progress dot drag so the gesture pans freely.
  //   • ONE finger    → a *candidate* tap. We do NOT place on touchstart; we record
  //     the start point and decide on touchend (see onContainerTouchEnd) whether it
  //     was a genuine tap (stayed within TAP_MOVE_PX, single finger throughout) or a
  //     scroll/drag (place nothing). This kills the "every touch drops a mark" bug
  //     for BOTH the centering dots and the defect pins.
  // Direct presses on an already-placed dot's 44px hit area (onDotTouchStart) still
  // start a deliberate fine-tune drag — that path is unchanged for a single finger.
  function onContainerTouchStart(e: React.TouchEvent) {
    lastTouchAtRef.current = Date.now();
    if (e.touches.length >= 2) {
      // Multi-finger → navigation gesture. Abandon any pending tap and release a
      // live dot drag so native pan / pinch-zoom takes over.
      touchTapRef.current = null;
      if (drag) setDrag(null);
      return;
    }
    const t = e.touches[0];
    if (!t) return;
    if (phase === "defects") {
      touchTapRef.current = { x: t.clientX, y: t.clientY, kind: "defect", multi: false, moved: false };
      return;
    }
    if (activeArr.length < 4) {
      touchTapRef.current = { x: t.clientX, y: t.clientY, kind: "place", multi: false, moved: false };
      return;
    }
    // All four dots of the active pass are down → near-dot grab is a deliberate
    // single-finger fine-tune drag (unchanged).
    const hit = nearestDot(t.clientX, t.clientY);
    if (hit) startDotDrag(hit.pass, hit.index, t.clientX, t.clientY);
  }

  // Track the candidate tap. A second finger, or movement past the threshold,
  // disqualifies it (it's a pan/zoom/scroll, not a tap). We never preventDefault
  // here, so the native scroll viewport keeps panning/zooming as normal.
  function onContainerTouchMove(e: React.TouchEvent) {
    const tap = touchTapRef.current;
    if (!tap) return;
    if (e.touches.length >= 2) {
      tap.multi = true;
      return;
    }
    const t = e.touches[0];
    if (!t) return;
    if (Math.hypot(t.clientX - tap.x, t.clientY - tap.y) > TAP_MOVE_PX) tap.moved = true;
  }

  // Commit the mark only for a clean single-finger tap. Anything else — a second
  // finger ever landed, the finger moved past TAP_MOVE_PX, or a finger is still
  // down — was navigation, so place nothing.
  function onContainerTouchEnd(e: React.TouchEvent) {
    const tap = touchTapRef.current;
    touchTapRef.current = null;
    lastTouchAtRef.current = Date.now(); // keep the synthetic-mouse guard window warm
    if (!tap) return;
    if (tap.multi || tap.moved) return;
    if (e.touches.length > 0) return; // another finger still down → not a clean tap
    if (tap.kind === "defect") {
      commitDefectTap(tap.x, tap.y);
      return;
    }
    // kind === "place" → next centering dot
    const pt = toPct({ clientX: tap.x, clientY: tap.y } as MouseEvent);
    if (pt) placePoint(pt);
  }

  // Direct press on a dot's hit area — always a drag (stopPropagation so the
  // container handler doesn't also place/grab).
  function onDotMouseDown(pass: DotPass, index: number, e: React.MouseEvent) {
    if (Date.now() - lastTouchAtRef.current < 500) return;
    e.stopPropagation();
    e.preventDefault();
    startDotDrag(pass, index, e.clientX, e.clientY);
  }

  function onDotTouchStart(pass: DotPass, index: number, e: React.TouchEvent) {
    // Two fingers → let the event bubble to the container so native pan/pinch-zoom
    // takes over instead of grabbing this dot for a drag.
    if (e.touches.length >= 2) return;
    e.stopPropagation();
    lastTouchAtRef.current = Date.now();
    const t = e.touches[0];
    if (!t) return;
    startDotDrag(pass, index, t.clientX, t.clientY);
  }

  useEffect(() => {
    if (!drag) return;
    function applyDelta(clientX: number, clientY: number) {
      // Convert BOTH endpoints through the rotation-aware mapping, so a drag
      // while the stage is rotated moves the dot along the CARD's axes (not the
      // screen's). UNCLAMPED so only the final position clamps, matching the
      // prior edge behaviour. At rotation 0 this reduces to the original
      // screen-delta-as-% mapping.
      const cur = screenToImagePct(clientX, clientY);
      const st = screenToImagePct(drag!.startMouse.x, drag!.startMouse.y);
      if (!cur || !st) return;
      const dx = cur.x - st.x;
      const dy = cur.y - st.y;
      const next = drag!.startPts.map((p) => ({ ...p }));
      const base = drag!.startPts[drag!.index];
      let moved = { x: clamp(base.x + dx), y: clamp(base.y + dy) };
      // Inner dots slide only along the measurement axis — re-lock the cross-axis
      // to the outer partner captured at drag start (same rule as placement).
      if (drag!.lockOuter) moved = axisLockInner(drag!.index, drag!.lockOuter, moved);
      next[drag!.index] = moved;
      if (drag!.pass === "outer") setOuterPts(next);
      else setInnerPts(next);
    }
    function onMove(e: MouseEvent) {
      applyDelta(e.clientX, e.clientY);
    }
    function onTouchMove(e: TouchEvent) {
      if (e.touches.length === 0) return;
      e.preventDefault();
      const t = e.touches[0];
      applyDelta(t.clientX, t.clientY);
    }
    function onUp() {
      setDrag(null);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onUp);
    window.addEventListener("touchcancel", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onUp);
      window.removeEventListener("touchcancel", onUp);
    };
    // rotation/phase are read (via screenToImagePct) inside applyDelta, so the
    // drag listeners must re-bind if they change — prevents a stale-closure
    // coordinate frame if the slider moves mid-drag. (The unrotated size is read
    // live from offsetWidth, so it never goes stale and needs no dep.)
  }, [drag, rotation, phase]);

  // Measure the available image-area box; re-measure on resize / chrome reflow
  // (e.g. the banner or controls wrapping). The card image is capped to this box
  // so it always fits fully — no scrolling the top corner under the banner.
  // Layout only; capture/geometry untouched.
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
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement) return;
      // ── Defects phase ─────────────────────────────────────────────────
      // Escape unwinds in order: open picker → pending batch → close tool.
      // Enter on a non-empty batch opens the picker (matches image-viewer
      // mark mode behaviour at image-viewer.tsx:319-336).
      if (phase === "defects") {
        if (e.key === "Escape") {
          if (defectPickerOpen) {
            cancelDefectBatch();
            return;
          }
          if (defectBatch.length > 0) {
            setDefectBatch([]);
            return;
          }
          onDone();
          return;
        }
        if (e.key === "Enter" && defectBatch.length > 0 && !defectPickerOpen) {
          e.preventDefault();
          openDefectPicker();
          return;
        }
        if (e.key === "+" || e.key === "=") {
          e.preventDefault();
          zoomInBtn();
        } else if (e.key === "-" || e.key === "_") {
          e.preventDefault();
          zoomOutBtn();
        } else if (e.key === "0") {
          e.preventDefault();
          zoomFit();
        }
        return;
      }
      // ── Capture phase (unchanged) ─────────────────────────────────────
      if (e.key === "Escape") onCancel();
      else if (e.key === "Enter" && canCompute && !saving) handleCompute();
      else if ((e.key === "Backspace" || e.key === "Delete") && outerPts.length + innerPts.length > 0) {
        e.preventDefault();
        undoLast();
      } else if (e.key === "a" || e.key === "A") {
        e.preventDefault();
        if (!detecting) handleAutoDetect();
      } else if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        resetAll();
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        zoomInBtn();
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoomOutBtn();
      } else if (e.key === "0") {
        e.preventDefault();
        zoomFit();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line
  }, [outerPts, innerPts, mode, rotation, canCompute, saving, zoom, phase, defectBatch, defectPickerOpen, detecting]);

  // Defensive guard against losing placed-but-uncomputed dots to an
  // accidental browser-back (trackpad swipe, Cmd+Left, etc.) or tab close.
  // overscroll-contain on the scroll viewport stops the swipe from
  // navigating in the first place; this is the belt to that braces, covering
  // any other navigation source (back button, link click, refresh). Only
  // fires in capture phase with at least one dot down — defects phase has
  // already persisted the crop + centering, so navigating away there only
  // loses an in-progress defect batch (which is a smaller risk and not in
  // this fix's scope per spec). Modern browsers show their own confirmation
  // text; the empty returnValue is the canonical activation incantation.
  useEffect(() => {
    const hasUncomputed = phase === "capture" && outerPts.length + innerPts.length > 0;
    if (!hasUncomputed) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [phase, outerPts.length, innerPts.length]);

  function clearOuter() {
    setOuterPts([]);
  }
  function clearInner() {
    setInnerPts([]);
  }
  function setModeSafe(m: CardToolMode) {
    setMode(m);
    if (m === "outer-only") setInnerPts([]);
  }

  // Full reset — wipe both dot passes + the deskew override back to a clean
  // capture (the Card Tool counterpart to Manual Crop's Reset / R). Distinct
  // from the per-pass "clear" links, which drop only one pass.
  function resetAll() {
    setOuterPts([]);
    setInnerPts([]);
    setRotation(0);
    setHover(null);
    setDrag(null);
  }

  // Auto-Detect the card edges on the server (shared with Manual Crop) and seat
  // the four OUTER dots on the detected bounds, in [TOP,RIGHT,BOTTOM,LEFT]
  // order. The operator then places the inner dots and fine-tunes. The detected
  // box is axis-aligned, so the auto deskew starts at 0. Inner dots are cleared
  // so the side-by-side capture resumes cleanly from the inner pass.
  async function handleAutoDetect() {
    setDetecting(true);
    try {
      const bounds = await detectCardBounds(certId, side, apiBase);
      if (bounds) {
        setOuterPts(boundsToOuterEdges(bounds));
        setInnerPts([]);
        setHover(null);
        setDrag(null);
        toast({ title: "Card detected — outer edges fitted. Place the inner dots, then Compute." });
      } else {
        toast({
          title: "Auto-detect failed",
          description: "Place the outer dots manually.",
          variant: "destructive",
        });
      }
    } catch (e: any) {
      toast({ title: "Auto-detect error", description: e.message, variant: "destructive" });
    } finally {
      setDetecting(false);
    }
  }

  async function handleCompute() {
    if (!outerReady) {
      toast({ title: "Place all 4 outer corners first", variant: "destructive" });
      return;
    }
    if (mode === "full" && !innerReady) {
      toast({ title: "Place all 4 inner corners (or switch to Outer-only)", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const outerQuad = outerEdgesToBboxQuad(outerPts);
      const { crop, deskewDeg, centering } = computeCardTool(
        mode,
        outerPts,
        mode === "full" ? innerPts : null,
        side,
        rotation,
        CROP_MARGIN_PCT,
        imgDims.w,
        imgDims.h
      );

      const cropPayload: RecropPayload = {
        side,
        left_pct: crop.left_pct,
        top_pct: crop.top_pct,
        width_pct: crop.width_pct,
        height_pct: crop.height_pct,
        rotation_deg: deskewDeg,
        quad: outerQuad,
      };

      // Fire centering — cheap (pure math + tiny JSONB writes), no R2/sharp.
      // In the optimistic path it runs in parallel and wires its result when it
      // lands; in the legacy path it's awaited inline (below).
      const sendCentering = async () => {
        if (!(mode === "full" && centering)) return;
        const expectedVersion = getExpectedGradingVersion?.();
        if (!Number.isSafeInteger(expectedVersion) || (expectedVersion as number) < 1) {
          throw new Error("The grading version is not loaded yet. Reload this certificate before saving.");
        }
        const cenRes = await fetch(`${apiBase}/certificates/${certId}/manual-centering`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ side, outer: centering.outer, inner: centering.inner, expectedVersion }),
        });
        const cenJson = await cenRes.json().catch(() => ({}));
        if (!cenRes.ok) {
          if (onGradingConflict?.(cenRes.status, cenJson)) throw new Error("A newer grading draft exists.");
          throw new Error(cenJson.error || "Centering save failed");
        }
        onGradingVersionSaved?.(cenJson.gradingVersion);
        onCentering?.({
          side,
          outer: centering.outer,
          inner: centering.inner,
          leftRight: centering.lr,
          topBottom: centering.tb,
          subgrade: centering.subgrade,
        });
      };

      const deskewNote = Math.abs(deskewDeg) > 0.1 ? `, deskew ${deskewDeg.toFixed(1)}°` : "";
      const doneToast = () =>
        toast({
          title:
            mode === "full" && centering
              ? `${side}: cropped + centered ${centering.lr} / ${centering.tb} → grade ${centering.subgrade}${deskewNote}`
              : `${side}: cropped${deskewNote}`,
        });

      // ── OPTIMISTIC PATH ────────────────────────────────────────────────
      // Defects phase exists (onDefectAdded) AND the panel owns the upload
      // (onStartCropUpload): transition to defect-marking INSTANTLY against a
      // local crop preview, and let /recrop upload to R2 in the background.
      if (onDefectAdded && onStartCropUpload) {
        // Geometry of the server crop in NATURAL pixels (rotate-expand then
        // rectangular extract — the same operation /recrop performs). Used to
        // render the CSS preview; pins are %-of-frame so they're invariant to
        // which image fills the frame.
        const rawW = imgDims.w;
        const rawH = imgDims.h;
        const rad = (deskewDeg * Math.PI) / 180;
        const RW = Math.abs(rawW * Math.cos(rad)) + Math.abs(rawH * Math.sin(rad));
        const RH = Math.abs(rawW * Math.sin(rad)) + Math.abs(rawH * Math.cos(rad));
        const cl = (RW * crop.left_pct) / 100;
        const ct = (RH * crop.top_pct) / 100;
        const cw = (RW * crop.width_pct) / 100;
        const ch = (RH * crop.height_pct) / 100;

        setLocalPreview({ rawW, rawH, d: deskewDeg, RW, RH, cl, ct, cw, ch });
        setCroppedDisplayUrl(null);
        // Drive the fit/zoom math off the crop's aspect so the frame size (and
        // therefore pin percentages) match the R2 crop that swaps in later.
        setImgDims({ w: Math.max(1, Math.round(cw)), h: Math.max(1, Math.round(ch)) });
        setHover(null);
        setDrag(null);
        setCommittedDefects((existingDefects ?? []).filter((d) => d.image_side === side));
        setPhase("defects");

        // Background: centering (parallel, non-blocking) + crop upload (panel-
        // owned, retried, gates approval). On upload success, swap the <img>
        // from the local preview to the R2 display URL — seamless, identical
        // framing. On failure the panel surfaces it and blocks approval.
        sendCentering().catch((e) =>
          toast({ title: "Centering save failed", description: e.message, variant: "destructive" })
        );
        onStartCropUpload(cropPayload).then((url) => {
          if (url) setCroppedDisplayUrl(url);
        });
        doneToast();
        return;
      }

      // ── LEGACY SYNCHRONOUS PATH (no defects phase / no upload owner) ─────
      const cropRes = await fetch(`${apiBase}/certificates/${certId}/recrop`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cropPayload),
      });
      const cropJson = await cropRes.json();
      if (!cropRes.ok) throw new Error(cropJson.error || "Recrop failed");

      await sendCentering();
      doneToast();

      if (onDefectAdded && typeof cropJson.displayUrl === "string" && cropJson.displayUrl.length > 0) {
        setCroppedDisplayUrl(cropJson.displayUrl);
        setHover(null);
        setDrag(null);
        setCommittedDefects((existingDefects ?? []).filter((d) => d.image_side === side));
        setPhase("defects");
      } else {
        onDone();
      }
    } catch (e: any) {
      toast({ title: "Card tool failed", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  // ── Defect-marking phase handlers ─────────────────────────────────────────
  // Click flow mirrors image-viewer.tsx mark mode for behavioural parity:
  // single click → pin into batch; double-click within 280ms → open picker;
  // commit → onDefectAdded per pin (panel auto-save), clear batch.
  function locationFromPercent(x: number, y: number): string {
    // Short human-readable region tag — parity with image-viewer.tsx.
    const vert = y < 33 ? "top" : y > 66 ? "bottom" : "middle";
    const horiz = x < 33 ? "left" : x > 66 ? "right" : "centre";
    return `${vert} ${horiz}`;
  }
  // Shared defect-commit for a single screen point. Used by the desktop mouse
  // click (onDefectAreaClick) AND the iPad single-finger tap (onContainerTouchEnd)
  // so both surfaces get identical double-tap-opens-picker / single-tap-pins
  // behaviour. Coordinates are raw screen px (clientX/clientY).
  function commitDefectTap(clientX: number, clientY: number) {
    if (phase !== "defects") return;
    const now = Date.now();
    const isDouble = now - lastDefectClickAtRef.current < 280;
    lastDefectClickAtRef.current = now;
    if (isDouble && defectBatch.length > 0) {
      openDefectPicker();
      return;
    }
    const el = containerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = clamp(((clientX - r.left) / r.width) * 100);
    const y = clamp(((clientY - r.top) / r.height) * 100);
    setDefectBatch((prev) => [...prev, { x, y, pxX: clientX, pxY: clientY }]);
  }
  function onDefectAreaClick(e: React.MouseEvent) {
    commitDefectTap(e.clientX, e.clientY);
  }
  function openDefectPicker() {
    const last = defectBatch[defectBatch.length - 1];
    if (!last) return;
    setDefectPickerAnchor({ pxX: last.pxX, pxY: last.pxY, xPct: last.x, yPct: last.y });
    setDefectPickerOpen(true);
  }
  function cancelDefectBatch() {
    setDefectBatch([]);
    setDefectPickerOpen(false);
    setDefectPickerAnchor(null);
  }
  function commitDefectBatch(opts: { mvgsCode: MvgsCode; label: string; tier: DefectTier }) {
    // Numbering continues from the highest existing id so legacy pins keep
    // their identity. Mirrors image-viewer.tsx:425.
    let nextId = [...committedDefects].reduce((m, d) => Math.max(m, d.id), 0) + 1 || 1;
    for (const pin of defectBatch) {
      const zone = deriveZone({ xPercent: pin.x, yPercent: pin.y, imageSide: side });
      const defect: Defect = {
        id: nextId++,
        type: opts.label,
        severity: "moderate",
        description: "",
        location: locationFromPercent(pin.x, pin.y),
        image_side: side,
        x_percent: pin.x,
        y_percent: pin.y,
        mvgsCode: opts.mvgsCode,
        tier: opts.tier,
        zone,
      };
      onDefectAdded?.(defect);
      setCommittedDefects((prev) => [...prev, defect]);
    }
    setDefectBatch([]);
    setDefectPickerOpen(false);
    setDefectPickerAnchor(null);
    setDefectPickerTier("D2");
  }

  // Image render size — at zoom=1 the image is "contained" within fitBox
  // (whole card visible, current behaviour); at zoom>1 it grows by `zoom×`
  // and the scroll viewport scrolls. Null until both fitBox + imgDims are
  // known; the <img> falls back to viewport CSS caps in that initial window.
  const baseFit =
    fitBox && imgDims.w > 0 && imgDims.h > 0
      ? (() => {
          const s = Math.min(fitBox.w / imgDims.w, fitBox.h / imgDims.h);
          return { w: imgDims.w * s, h: imgDims.h * s };
        })()
      : null;
  const renderW = baseFit ? baseFit.w * zoom : null;
  const renderH = baseFit ? baseFit.h * zoom : null;

  // Live preview geometry (only meaningful once outer is placed).
  const previewCrop = outerReady ? cropBoxForEdges(outerPts, CROP_MARGIN_PCT) : null;
  const outerCentroid = outerReady ? centroid(outerPts) : null;
  // Edge rectangles drawn once a pass's four points are all down.
  const outerEdgeRect = outerReady ? edgesToRect(outerPts) : null;
  const innerEdgeRect = mode === "full" && innerReady ? edgesToRect(innerPts) : null;
  const previewCentering =
    mode === "full" && outerReady && innerReady
      ? computeCardTool("full", outerPts, innerPts, side, rotation, CROP_MARGIN_PCT, imgDims.w, imgDims.h).centering
      : null;

  function renderDots(pts: Point[], pass: DotPass, color: string) {
    return pts.map((p, i) => (
      <div
        key={`${pass}-${i}`}
        style={{
          position: "absolute",
          left: `${p.x}%`,
          top: `${p.y}%`,
          zIndex: 30,
          // Placement-vs-grab separation. While any of the 8 points is still
          // missing, the dot hit area is click-through so a click adjacent to
          // an existing dot (e.g. inner-top just below outer-top on the same
          // vertical line) places the next point at the click location — it
          // never gets diverted into a drag. Once all 8 are down, hit areas
          // re-arm and drag-to-fine-tune is available.
          pointerEvents: placing ? "none" : "auto",
        }}
      >
        {/* Invisible 44px hit target (Apple HIG / Material min touch size).
            Handlers are nulled during placement to remove the listener entirely
            — belt-and-braces alongside the parent's pointer-events:none. */}
        <div
          className={placing ? "" : "cursor-grab active:cursor-grabbing touch-none"}
          style={{ width: 44, height: 44, transform: "translate(-50%, -50%)", position: "relative" }}
          onMouseDown={placing ? undefined : (e) => onDotMouseDown(pass, i, e)}
          onTouchStart={placing ? undefined : (e) => onDotTouchStart(pass, i, e)}
        >
          {/* Visible crosshair marker (shared with the cursor reticle). Thin
              "+" with an open centre so the exact captured pixel stays visible;
              the ~44px hit area above is unchanged. */}
          <Crosshair color={color} />
          <span
            className="absolute -top-3 left-1/2 -translate-x-1/2 text-[8px] font-bold pointer-events-none select-none"
            style={{ color }}
          >
            {SIDE_LABELS[i]}
          </span>
        </div>
      </div>
    ));
  }

  return (
    <div className="fixed inset-0 z-[100] bg-[var(--admin-panel2)] flex flex-col select-none">
      {/* Top bar */}
      <div className="flex-shrink-0 px-2 py-1 sm:px-4 sm:py-1.5 flex items-center justify-between border-b border-[var(--admin-line)]">
        <div>
          <p className="text-[var(--admin-gold)] text-xs font-bold uppercase tracking-widest flex items-center gap-2">
            <Crop size={14} /> Card Tool — {side}
          </p>
          <p className="text-[var(--admin-ink-dim)] text-[10px]">
            <span style={{ color: palette.outer }}>●</span> Outer = card edge &middot;{" "}
            <span style={{ color: palette.inner }}>●</span> Inner = border → artwork
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Mode toggle — capture phase only (8-dot vs outer-only is for the
              centering capture, not relevant once we've moved on to defects). */}
          {phase === "capture" && (
            <div className="flex rounded-lg overflow-hidden border border-[var(--admin-line)] text-[10px] font-bold uppercase">
              <button
                type="button"
                onClick={() => setModeSafe("full")}
                className={`px-2 py-1 ${mode === "full" ? "bg-[var(--admin-gold)] text-[#1A1400]" : "text-[var(--admin-ink-dim)] hover:bg-[var(--admin-panel3)]"}`}
              >
                8-Dot
              </button>
              <button
                type="button"
                onClick={() => setModeSafe("outer-only")}
                className={`px-2 py-1 ${mode === "outer-only" ? "bg-[var(--admin-gold)] text-[#1A1400]" : "text-[var(--admin-ink-dim)] hover:bg-[var(--admin-panel3)]"}`}
              >
                Outer-only
              </button>
            </div>
          )}
          {phase === "defects" && (
            <span className="text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded bg-[color-mix(in_srgb,var(--admin-red)_12%,transparent)] text-[var(--admin-red)] border border-[color-mix(in_srgb,var(--admin-red)_40%,transparent)]">
              Defects
            </span>
          )}
          <button
            type="button"
            onClick={phase === "defects" ? onDone : onCancel}
            className="text-[var(--admin-ink-dim)] hover:text-[var(--admin-ink)] p-1"
            title={phase === "defects" ? "Done — close" : "Cancel"}
          >
            <X size={20} />
          </button>
        </div>
      </div>

      {/* Guidance banner — corner map + large step prompt + progress + undo.
          Replaces the old 10px instruction so the next action is unmissable.
          Defects phase swaps the side diagram for a target icon, the chip
          + step prompt for defect-marking guidance, and the per-point undo
          for a cancel-batch button. */}
      <div className="flex-shrink-0 px-2 py-1 sm:px-4 sm:py-1.5 border-b border-[var(--admin-line)] bg-[var(--admin-panel)] flex items-center gap-2 sm:gap-3">
        {phase === "capture" ? (
          <SideDiagram
            activeSide={canCompute ? -1 : activeSide}
            activeColor={activeColor}
            outerCount={outerPts.length}
            innerCount={innerPts.length}
            mode={mode}
          />
        ) : (
          <div
            className="flex-shrink-0 w-8 h-8 rounded-full bg-[color-mix(in_srgb,var(--admin-red)_12%,transparent)] border border-[color-mix(in_srgb,var(--admin-red)_40%,transparent)] flex items-center justify-center text-[var(--admin-red)]"
            aria-hidden="true"
          >
            <Target size={16} />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {phase === "capture" && !canCompute && (
              <span
                className="text-[10px] sm:text-xs font-black uppercase tracking-wide px-2 py-0.5 rounded"
                style={{ background: activeColor, color: activePass === "outer" ? "#1A1400" : "#FFFFFF" }}
              >
                {activePass === "outer" ? "Outer" : "Inner"}
              </span>
            )}
            <p className="text-[var(--admin-ink)] text-xs sm:text-sm font-extrabold leading-tight">{bannerText}</p>
            {phase === "defects" && cropSyncStatus !== "idle" && (
              <span className="flex items-center gap-1.5 text-[10px] sm:text-xs font-bold uppercase tracking-wide">
                {cropSyncStatus === "pending" && (
                  <span className="flex items-center gap-1 text-[var(--admin-gold)]">
                    <Loader2 size={12} className="animate-spin" /> Crop syncing…
                  </span>
                )}
                {cropSyncStatus === "synced" && (
                  <span className="flex items-center gap-1 text-[var(--admin-green)]">
                    <Check size={12} /> Crop saved
                  </span>
                )}
                {cropSyncStatus === "failed" && (
                  <span className="flex items-center gap-1.5 text-[var(--admin-red)]">
                    Crop upload failed
                    {onRetryCrop && (
                      <button
                        type="button"
                        onClick={() => {
                          onRetryCrop().then((url) => {
                            if (url) setCroppedDisplayUrl(url);
                          });
                        }}
                        className="underline hover:no-underline"
                      >
                        Retry
                      </button>
                    )}
                  </span>
                )}
              </span>
            )}
          </div>
          {phase === "capture" ? (
            <p className="text-[var(--admin-ink-faint)] text-[11px] sm:text-xs mt-0.5 font-mono">
              {totalPlaced} of {target} points placed
            </p>
          ) : (
            <p className="text-[var(--admin-ink-faint)] text-[11px] sm:text-xs mt-0.5 font-mono">
              {committedDefects.length} committed &middot; {defectBatch.length} pending
            </p>
          )}
        </div>
        {phase === "capture" ? (
          <button
            type="button"
            onClick={undoLast}
            disabled={totalPlaced === 0}
            title="Undo last point (Backspace)"
            className="flex-shrink-0 flex items-center gap-1 border border-[var(--admin-line)] text-[var(--admin-ink-dim)] text-[11px] sm:text-xs px-2.5 py-1.5 rounded-lg hover:bg-[var(--admin-panel3)] hover:text-[var(--admin-ink)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Undo2 size={13} /> Undo
          </button>
        ) : (
          <div className="flex-shrink-0 flex items-center gap-2">
            {/* Escape hatch — re-place the 8 dots and re-Compute centering/crop
                for this side. Available throughout the defects phase (e.g. when
                opened straight to defects on an existing crop). */}
            <button
              type="button"
              onClick={() => {
                setPhase("capture");
                setLocalPreview(null);
                setDefectBatch([]);
                setHover(null);
                setDrag(null);
              }}
              title="Re-do centering — place the 8 dots and Compute again"
              className="flex items-center gap-1 border border-[var(--admin-line)] text-[var(--admin-ink-dim)] text-[11px] sm:text-xs px-2.5 py-1.5 rounded-lg hover:bg-[var(--admin-panel3)] hover:text-[var(--admin-ink)]"
            >
              <Crop size={13} /> Redo centering
            </button>
            <button
              type="button"
              onClick={() => setDefectBatch([])}
              disabled={defectBatch.length === 0}
              title="Clear pending pins (Esc)"
              className="flex items-center gap-1 border border-[var(--admin-line)] text-[var(--admin-ink-dim)] text-[11px] sm:text-xs px-2.5 py-1.5 rounded-lg hover:bg-[var(--admin-panel3)] hover:text-[var(--admin-ink)] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Undo2 size={13} /> Clear pins
            </button>
          </div>
        )}
      </div>

      {/* Image area — the card is scaled to FIT this measured box (fitRef) at
          zoom=1 so all four corners, incl. the TOP edge, are visible below the
          banner without scrolling. At zoom>1 the image grows beyond fitRef and
          the scroll viewport (fitRef) shows scrollbars; the inner middle div
          enforces min-w-full/min-h-full so the container stays centred when
          smaller than the viewport ("safe centre" pattern, scroll-safe). */}
      <div className="flex-1 min-h-0 p-0 sm:p-4 overflow-hidden relative">
        {/* overscroll-contain stops a horizontal trackpad/touch swipe at the
            scroll boundary from propagating to the browser's history-back
            gesture (Chrome + Safari respect this on the scroller). Without
            it, the operator swiping left to reach the card's left edge at
            high zoom navigates away from /admin and loses all placed dots
            (component state). Combined with the beforeunload guard above
            for defensive coverage on any other navigation source. */}
        <div ref={fitRef} className="w-full h-full overflow-auto overscroll-contain">
          {/* Wrapper centres the card when it FITS the viewport, but falls
              back to start-aligned when it OVERFLOWS. Without the `safe`
              keyword, `justify-content: center` on an overflowing flex item
              pushes the start of the item past the container's content box,
              making the left/top portion of the content unreachable by
              scroll (the scroll range becomes [0, overflow] but the
              leftmost content sits at NEGATIVE scroll coordinates that
              don't exist). At zoom > 1 the operator could not pan to the
              card's left edge — and the back-gesture fired because there
              was nothing left for the scroller to consume. `safe center`
              fixes both: at zoom 1 centre, at zoom > 1 start-align, so
              the left edge is at scrollLeft 0 and reachable. Tailwind
              doesn't expose `safe` keywords through utility classes in
              our version, so it's an inline style. */}
          <div
            className="min-w-full min-h-full flex"
            style={{ justifyContent: "safe center", alignItems: "safe center" }}
          >
            {/* Stage wrapper — NOT rotated. Shrink-wraps the capture container so
                the screen-level guide overlay (a sibling, below) shares the exact
                same box + centre as the rotated stage without inheriting its
                rotation. The alignment guide must stay level to the viewport while
                the card rotates under it (Cornelius: "stay straight and centred
                with the panel, not the card"). */}
            <div className="relative flex-shrink-0">
              {/* Capture container — shrink-wraps the (scaled) image, so its box
                == the visible card. Dots are absolute children (same box). */}
              <div
                ref={containerRef}
                className="relative rounded-lg bg-[var(--admin-panel2)] flex-shrink-0"
                // STEP 2 — live straighten preview. Rotating the STAGE CONTAINER
                // (not the <img> alone) rotates the card image, the SVG crop/edge
                // overlay AND the 8 dots together as one layer about the centre,
                // so placed dots stay glued to the card and relative geometry is
                // preserved. Capture phase only (defects shows the already-
                // straightened crop). The pointer→image mapping inverse-rotates
                // about this same centre, so clicks/drags land in source coords.
                style={
                  phase === "capture" && rotation !== 0
                    ? { transform: `rotate(${rotation}deg)`, transformOrigin: "center center" }
                    : undefined
                }
                onMouseDown={onContainerMouseDown}
                onMouseMove={onContainerMouseMove}
                onMouseLeave={() => {
                  onContainerMouseUp();
                  onContainerMouseLeave();
                }}
                onMouseUp={onContainerMouseUp}
                onTouchStart={onContainerTouchStart}
                onTouchMove={onContainerTouchMove}
                onTouchEnd={onContainerTouchEnd}
                onTouchCancel={() => {
                  // OS took the gesture (scroll/zoom) → abandon the candidate tap.
                  touchTapRef.current = null;
                }}
              >
                {phase === "defects" && localPreview && !croppedDisplayUrl ? (
                  // ── Optimistic local crop preview ──────────────────────────
                  // A CSS-only reconstruction of the server crop (rotate-expand
                  // the already-loaded raw <img>, then clip to the crop rect in
                  // an overflow:hidden frame). Display-only — no canvas, so no
                  // CORS taint. The frame is sized exactly like the R2 crop will
                  // be (renderW × renderH, driven by the crop aspect we fed into
                  // imgDims), so when croppedDisplayUrl arrives and this swaps to
                  // the <img> below, nothing shifts — and defect pins, being
                  // %-of-frame, stay pinned to the same spot.
                  <div
                    className="block cursor-crosshair"
                    style={{
                      width: renderW ?? localPreview.cw,
                      height: renderH ?? localPreview.ch,
                      position: "relative",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        position: "absolute",
                        width: localPreview.RW,
                        height: localPreview.RH,
                        transformOrigin: "0 0",
                        // scale natural-crop px → on-screen px, then shift the
                        // crop rect's top-left to the frame origin.
                        transform: `scale(${(renderW ?? localPreview.cw) / localPreview.cw}) translate(${-localPreview.cl}px, ${-localPreview.ct}px)`,
                      }}
                    >
                      <img
                        src={rawImageUrl}
                        alt={`${side} cropped preview`}
                        draggable={false}
                        style={{
                          position: "absolute",
                          // Centre the raw image inside the rotated-expanded box,
                          // then rotate by the same deskew /recrop applies — this
                          // reproduces sharp's rotate-with-expand exactly.
                          left: (localPreview.RW - localPreview.rawW) / 2,
                          top: (localPreview.RH - localPreview.rawH) / 2,
                          width: localPreview.rawW,
                          height: localPreview.rawH,
                          transform: `rotate(${localPreview.d}deg)`,
                          transformOrigin: "center center",
                        }}
                      />
                    </div>
                  </div>
                ) : (
                  <img
                    // In defects phase, swap to the freshly-cropped display image
                    // returned by /recrop. imgDims re-measures via onLoad so
                    // coordinate capture stays accurate against the new image's
                    // natural pixels (same aspect as the preview → no pin shift).
                    src={phase === "defects" && croppedDisplayUrl ? croppedDisplayUrl : rawImageUrl}
                    alt={`${side} ${phase === "defects" ? "cropped" : "raw"}`}
                    className="block cursor-crosshair"
                    style={
                      renderW != null && renderH != null
                        ? { width: renderW, height: renderH }
                        : { maxWidth: fitBox?.w ?? "100vw", maxHeight: fitBox?.h ?? "80vh", width: "auto" }
                    }
                    draggable={false}
                    onLoad={(e) => setImgDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
                  />
                )}

                {/* Non-interactive overlay: crop box, quads, crosshair. preserve-
                AspectRatio="none" is safe here — pointer-events:none, never
                hit-tested. Capture-phase only — defects phase replaces these
                visuals with pin markers and skips the crop/edge geometry. */}
                {phase === "capture" && (
                  <svg
                    className="absolute inset-0 w-full h-full"
                    viewBox="0 0 100 100"
                    preserveAspectRatio="none"
                    style={{ pointerEvents: "none", zIndex: 10 }}
                  >
                    {/* Crop box preview (outer bbox + margin) */}
                    {previewCrop && (
                      <rect
                        x={previewCrop.left_pct}
                        y={previewCrop.top_pct}
                        width={previewCrop.width_pct}
                        height={previewCrop.height_pct}
                        fill="none"
                        stroke="#1A1A1A"
                        strokeWidth="0.25"
                        strokeDasharray="1,0.8"
                        opacity="0.4"
                      />
                    )}
                    {/* Outer edge rectangle — the card-edge bounds (left = LEFT-outer
                  x, right = RIGHT-outer x, top = TOP-outer y, bottom = BOTTOM-
                  outer y), drawn once all four outer edge points are down. */}
                    {outerEdgeRect && (
                      <rect
                        x={outerEdgeRect.left}
                        y={outerEdgeRect.top}
                        width={outerEdgeRect.right - outerEdgeRect.left}
                        height={outerEdgeRect.bottom - outerEdgeRect.top}
                        fill="none"
                        stroke={palette.outer}
                        strokeWidth="0.4"
                        opacity="0.9"
                      />
                    )}
                    {/* Inner edge rectangle — the border→artwork bounds (full mode). */}
                    {mode === "full" && innerEdgeRect && (
                      <rect
                        x={innerEdgeRect.left}
                        y={innerEdgeRect.top}
                        width={innerEdgeRect.right - innerEdgeRect.left}
                        height={innerEdgeRect.bottom - innerEdgeRect.top}
                        fill="none"
                        stroke={palette.inner}
                        strokeWidth="0.4"
                        opacity="0.9"
                      />
                    )}
                    {/* The alignment GUIDES (outer-centroid crosshair, per-placed-
                      point rails, inner locked-axis rail and the live cursor
                      sniper guides) used to live HERE, inside the rotated stage,
                      which tilted them with the card. They now render screen-level
                      in the sibling overlay below (see "LEVEL guide overlay"),
                      anchored via imagePctToScreenPct so they still pass through
                      the same card points while staying horizontal/vertical. The
                      crop box + edge rectangles stay here: they trace the card and
                      must rotate with it. */}
                  </svg>
                )}

                {/* Hit-tested dots — HTML, %-positioned against the SAME box as the
                capture container. Capture phase only; defects phase replaces
                these with defect pins below. */}
                {phase === "capture" && renderDots(outerPts, "outer", palette.outer)}
                {phase === "capture" && mode === "full" && renderDots(innerPts, "inner", palette.inner)}

                {/* ── Defect pins (defects phase) ─────────────────────────────
                  Both committed and pending pins render as TRANSPARENT rings
                  so the defect underneath stays visible. Visual parity with
                  image-viewer.tsx's marker pattern (see :770-873): tier-
                  coloured outline + 4 px centre dot + small numbered badge
                  offset above-right. The ring carries a 1 px dark halo
                  (boxShadow) so it reads on both light and dark card areas —
                  same approach the 8-dot crosshair markers use. The hit area
                  is the surrounding container (44 px range stays in tact);
                  only the VISIBLE marker is see-through. pointer-events:none
                  so clicks fall through to the defect-area handler (drop next
                  pin / open picker on double-click). */}
                {phase === "defects" && (
                  <>
                    {/* MVGS v2.1 — whitening + crease line overlays (current
                      side only) plus in-progress drag preview. pointer-events
                      :none so the drawing handlers receive clicks. */}
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
                    {committedDefects.map((d) => {
                      // Tier-coloured ring, matching image-viewer.tsx:785-791
                      // — D1 red / D2 amber / D3 green. Undefined-tier pins
                      // (legacy or AI-promoted without classification) fall back
                      // to red as a "needs review" cue.
                      const col = d.tier === "D2" ? "#F59E0B" : d.tier === "D3" ? "#16A34A" : "#DC2626";
                      return (
                        <div
                          key={`committed-${d.id}`}
                          className="absolute pointer-events-none"
                          style={{
                            left: `${d.x_percent}%`,
                            top: `${d.y_percent}%`,
                            transform: "translate(-50%, -50%)",
                            width: 28,
                            height: 28,
                            zIndex: 28,
                          }}
                          aria-hidden="true"
                        >
                          <div
                            className="w-full h-full rounded-full"
                            style={{
                              border: `2px solid ${col}`,
                              background: "transparent",
                              boxShadow: "0 0 0 1px rgba(0,0,0,0.45)",
                            }}
                          />
                          {/* Centre dot — 4 px in the tier colour so the exact
                            captured pixel stays identifiable through the
                            otherwise-empty ring. */}
                          <span
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
                          {/* Number badge sits OUTSIDE the ring (above-right) so
                            it doesn't cover the defect pixel. Coloured fill +
                            dark halo for legibility on every card. */}
                          <span
                            className="absolute -top-1 -right-1 text-[9px] font-black px-1 rounded-full leading-none py-0.5 pointer-events-none"
                            style={{
                              background: col,
                              color: "#fff",
                              boxShadow: "0 0 0 1px rgba(0,0,0,0.5), 0 1px 2px rgba(0,0,0,0.3)",
                            }}
                          >
                            {d.id}
                          </span>
                        </div>
                      );
                    })}
                    {defectBatch.map((p, i) => (
                      <div
                        key={`batch-${i}`}
                        className="absolute pointer-events-none"
                        style={{
                          left: `${p.x}%`,
                          top: `${p.y}%`,
                          transform: "translate(-50%, -50%)",
                          width: 28,
                          height: 28,
                          zIndex: 29,
                        }}
                        aria-hidden="true"
                      >
                        {/* Pending pins use a dashed gold ring (still untiered)
                          + the same transparent centre so the defect under the
                          pin is visible BEFORE it's even labelled. */}
                        <div
                          className="w-full h-full rounded-full"
                          style={{
                            border: "2px dashed #D4AF37",
                            background: "transparent",
                            boxShadow: "0 0 0 1px rgba(0,0,0,0.45)",
                          }}
                        />
                        <span
                          className="absolute pointer-events-none rounded-full"
                          style={{
                            left: "50%",
                            top: "50%",
                            transform: "translate(-50%, -50%)",
                            width: 4,
                            height: 4,
                            background: "#D4AF37",
                          }}
                        />
                        <span
                          className="absolute -top-1 -right-1 text-[9px] font-black px-1 rounded-full leading-none py-0.5 pointer-events-none"
                          style={{
                            background: "#D4AF37",
                            color: "#1A1400",
                            boxShadow: "0 0 0 1px rgba(0,0,0,0.5), 0 1px 2px rgba(0,0,0,0.3)",
                          }}
                        >
                          {i + 1}
                        </span>
                      </div>
                    ))}
                  </>
                )}
              </div>

              {/* ── LEVEL guide overlay — sibling of the rotated stage ───────────
                Renders the alignment guides in screen/viewport space so they stay
                horizontal/vertical while the card rotates underneath. Each guide
                is anchored through a card-space point forward-rotated to screen
                via imagePctToScreenPct, so it still passes through the right
                dot / centroid / cursor but never tilts. Same viewBox +
                preserveAspectRatio + non-scaling strokes as the in-stage overlay,
                so at rotation 0 (imagePctToScreenPct = identity) it's visually
                identical to before. Capture phase only. */}
              {phase === "capture" && (
                <svg
                  className="absolute inset-0 w-full h-full"
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                  style={{ pointerEvents: "none", zIndex: 20 }}
                >
                  {/* Crosshair at outer centroid */}
                  {outerCentroid &&
                    (() => {
                      const c = imagePctToScreenPct(outerCentroid);
                      return (
                        <g stroke="#D4AF37" strokeWidth={CENTERING_GUIDE_VISUALS.centroidStrokeWidth} opacity="0.72">
                          <line x1={0} y1={c.y} x2={100} y2={c.y} />
                          <line x1={c.x} y1={0} x2={c.x} y2={100} />
                        </g>
                      );
                    })()}
                  {/* Full-length guides through each placed point in the ACTIVE pass. */}
                  {placing &&
                    activeArr.map((p0, i) => {
                      const p = imagePctToScreenPct(p0);
                      return (
                        <g key={`pguide-${activePass}-${i}`} strokeDasharray="4,4">
                          <g stroke={CENTERING_GUIDE_VISUALS.haloStroke}>
                            <line
                              x1={0}
                              y1={p.y}
                              x2={100}
                              y2={p.y}
                              strokeWidth={CENTERING_GUIDE_VISUALS.placedHaloStrokeWidth}
                              vectorEffect="non-scaling-stroke"
                            />
                            <line
                              x1={p.x}
                              y1={0}
                              x2={p.x}
                              y2={100}
                              strokeWidth={CENTERING_GUIDE_VISUALS.placedHaloStrokeWidth}
                              vectorEffect="non-scaling-stroke"
                            />
                          </g>
                          <g stroke={CENTERING_GUIDE_VISUALS.lightOutlineStroke} opacity={0.9}>
                            <line
                              x1={0}
                              y1={p.y}
                              x2={100}
                              y2={p.y}
                              strokeWidth={CENTERING_GUIDE_VISUALS.placedColorStrokeWidth + 0.7}
                              vectorEffect="non-scaling-stroke"
                            />
                            <line
                              x1={p.x}
                              y1={0}
                              x2={p.x}
                              y2={100}
                              strokeWidth={CENTERING_GUIDE_VISUALS.placedColorStrokeWidth + 0.7}
                              vectorEffect="non-scaling-stroke"
                            />
                          </g>
                          <g stroke={activeColor} opacity={0.78}>
                            <line
                              x1={0}
                              y1={p.y}
                              x2={100}
                              y2={p.y}
                              strokeWidth={CENTERING_GUIDE_VISUALS.placedColorStrokeWidth}
                              vectorEffect="non-scaling-stroke"
                            />
                            <line
                              x1={p.x}
                              y1={0}
                              x2={p.x}
                              y2={100}
                              strokeWidth={CENTERING_GUIDE_VISUALS.placedColorStrokeWidth}
                              vectorEffect="non-scaling-stroke"
                            />
                          </g>
                        </g>
                      );
                    })}
                  {/* Locked-axis rail through the outer point (inner placement). */}
                  {innerLockOuter &&
                    (() => {
                      const o = imagePctToScreenPct(innerLockOuter);
                      return innerPts.length % 2 === 0 ? (
                        <g>
                          <line
                            x1={o.x}
                            y1={0}
                            x2={o.x}
                            y2={100}
                            stroke={CENTERING_GUIDE_VISUALS.haloStroke}
                            strokeWidth={CENTERING_GUIDE_VISUALS.railHaloStrokeWidth}
                            vectorEffect="non-scaling-stroke"
                          />
                          <line
                            x1={o.x}
                            y1={0}
                            x2={o.x}
                            y2={100}
                            stroke={CENTERING_GUIDE_VISUALS.lightOutlineStroke}
                            strokeWidth={CENTERING_GUIDE_VISUALS.railColorStrokeWidth + 0.7}
                            vectorEffect="non-scaling-stroke"
                          />
                          <line
                            x1={o.x}
                            y1={0}
                            x2={o.x}
                            y2={100}
                            stroke={palette.inner}
                            strokeWidth={CENTERING_GUIDE_VISUALS.railColorStrokeWidth}
                            vectorEffect="non-scaling-stroke"
                          />
                        </g>
                      ) : (
                        <g>
                          <line
                            x1={0}
                            y1={o.y}
                            x2={100}
                            y2={o.y}
                            stroke={CENTERING_GUIDE_VISUALS.haloStroke}
                            strokeWidth={CENTERING_GUIDE_VISUALS.railHaloStrokeWidth}
                            vectorEffect="non-scaling-stroke"
                          />
                          <line
                            x1={0}
                            y1={o.y}
                            x2={100}
                            y2={o.y}
                            stroke={CENTERING_GUIDE_VISUALS.lightOutlineStroke}
                            strokeWidth={CENTERING_GUIDE_VISUALS.railColorStrokeWidth + 0.7}
                            vectorEffect="non-scaling-stroke"
                          />
                          <line
                            x1={0}
                            y1={o.y}
                            x2={100}
                            y2={o.y}
                            stroke={palette.inner}
                            strokeWidth={CENTERING_GUIDE_VISUALS.railColorStrokeWidth}
                            vectorEffect="non-scaling-stroke"
                          />
                        </g>
                      );
                    })()}
                  {/* Live cursor sniper guides through the (snapped) cursor. */}
                  {placing &&
                    lockedHover &&
                    !drag &&
                    (() => {
                      const h = imagePctToScreenPct(lockedHover);
                      return (
                        <g strokeDasharray="5,4">
                          <g stroke={CENTERING_GUIDE_VISUALS.haloStroke}>
                            <line
                              x1={0}
                              y1={h.y}
                              x2={100}
                              y2={h.y}
                              strokeWidth={CENTERING_GUIDE_VISUALS.liveHaloStrokeWidth}
                              vectorEffect="non-scaling-stroke"
                            />
                            <line
                              x1={h.x}
                              y1={0}
                              x2={h.x}
                              y2={100}
                              strokeWidth={CENTERING_GUIDE_VISUALS.liveHaloStrokeWidth}
                              vectorEffect="non-scaling-stroke"
                            />
                          </g>
                          <g stroke={CENTERING_GUIDE_VISUALS.lightOutlineStroke} opacity={0.9}>
                            <line
                              x1={0}
                              y1={h.y}
                              x2={100}
                              y2={h.y}
                              strokeWidth={CENTERING_GUIDE_VISUALS.liveColorStrokeWidth + 0.7}
                              vectorEffect="non-scaling-stroke"
                            />
                            <line
                              x1={h.x}
                              y1={0}
                              x2={h.x}
                              y2={100}
                              strokeWidth={CENTERING_GUIDE_VISUALS.liveColorStrokeWidth + 0.7}
                              vectorEffect="non-scaling-stroke"
                            />
                          </g>
                          <g stroke={activeColor} opacity={0.9}>
                            <line
                              x1={0}
                              y1={h.y}
                              x2={100}
                              y2={h.y}
                              strokeWidth={CENTERING_GUIDE_VISUALS.liveColorStrokeWidth}
                              vectorEffect="non-scaling-stroke"
                            />
                            <line
                              x1={h.x}
                              y1={0}
                              x2={h.x}
                              y2={100}
                              strokeWidth={CENTERING_GUIDE_VISUALS.liveColorStrokeWidth}
                              vectorEffect="non-scaling-stroke"
                            />
                          </g>
                        </g>
                      );
                    })()}
                </svg>
              )}

              {/* Live targeting reticle — SCREEN-LEVEL (sibling of the stage), so the
                crosshair stays upright while the card rotates. Follows the cursor
                in placement AND defects; anchored via imagePctToScreenPct (identity
                at rotation 0 / defects). pointer-events:none so clicks fall through
                to the capture container. */}
              {((placing && phase === "capture") || phase === "defects") &&
                lockedHover &&
                !drag &&
                (() => {
                  const h = imagePctToScreenPct(lockedHover);
                  return (
                    <div
                      className="absolute pointer-events-none"
                      style={{ left: `${h.x}%`, top: `${h.y}%`, zIndex: 25 }}
                      aria-hidden="true"
                    >
                      <div style={{ position: "relative", width: 44, height: 44, transform: "translate(-50%, -50%)" }}>
                        <Crosshair color={phase === "defects" ? palette.outer : activeColor} />
                      </div>
                    </div>
                  );
                })()}
            </div>
          </div>
        </div>
        {/* Floating zoom panel — anchored to the image area, NOT inside the
            scroll viewport, so it stays in place while the user pans. The
            capture math uses getBoundingClientRect on containerRef, so % coords
            stay accurate at any zoom; the visual crosshair stays 44px on
            screen and gets relatively smaller on the bigger image — exactly
            what's needed to drop a dot on a single border pixel. */}
        <div className="absolute top-2 right-2 sm:top-2 sm:right-2 z-40 flex flex-col items-stretch gap-1 bg-[var(--admin-panel)]/95 backdrop-blur-sm rounded-lg border border-[var(--admin-line)] shadow-md p-1">
          <button
            type="button"
            onClick={zoomInBtn}
            disabled={zoom >= MAX_ZOOM}
            title="Zoom in (+)"
            className="p-1.5 rounded hover:bg-[var(--admin-panel3)] disabled:opacity-30 disabled:cursor-not-allowed text-[var(--admin-ink)]"
          >
            <ZoomIn size={16} />
          </button>
          <button
            type="button"
            onClick={zoomOutBtn}
            disabled={zoom <= MIN_ZOOM}
            title="Zoom out (-)"
            className="p-1.5 rounded hover:bg-[var(--admin-panel3)] disabled:opacity-30 disabled:cursor-not-allowed text-[var(--admin-ink)]"
          >
            <ZoomOut size={16} />
          </button>
          <button
            type="button"
            onClick={zoomFit}
            disabled={zoom === 1}
            title="Fit to area (0)"
            className="p-1.5 rounded hover:bg-[var(--admin-panel3)] disabled:opacity-30 disabled:cursor-not-allowed text-[var(--admin-ink)]"
          >
            <Maximize size={16} />
          </button>
          <span className="text-[9px] font-mono text-[var(--admin-ink-dim)] text-center pt-0.5 border-t border-[var(--admin-line)]">
            {Math.round(zoom * 100)}%
          </span>
          {/* Line-colour swatch picker — switches the crosshair, reticle, and
              guide colours for contrast against the card under the lens (e.g.
              magenta on grey/silver, cyan on yellow holos). Selected swatch is
              ring-highlighted. State is React-only (no localStorage) per spec.
              The default swatch shows the brand gold/green split so the
              "default" pick is visually distinct from the single-hue options. */}
          <div className="border-t border-[var(--admin-line)] pt-1 flex flex-col gap-1">
            {LINE_PALETTES.map((p) => {
              const selected = paletteId === p.id;
              const bg =
                p.id === "default" ? `linear-gradient(135deg, ${p.outer} 0 50%, ${p.inner} 50% 100%)` : p.outer;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPaletteId(p.id)}
                  title={p.label}
                  aria-label={p.label}
                  aria-pressed={selected}
                  className={`w-6 h-6 rounded-full mx-auto transition-shadow ${
                    selected
                      ? "ring-2 ring-[var(--admin-gold)] ring-offset-2 ring-offset-[var(--admin-panel)]"
                      : "ring-1 ring-[var(--admin-line-hard)] hover:ring-[var(--admin-ink-faint)]"
                  }`}
                  style={{ background: bg }}
                />
              );
            })}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="flex-shrink-0 px-2 py-1 sm:px-4 sm:py-1.5 border-t border-[var(--admin-line)] space-y-1.5 sm:space-y-2">
        {phase === "capture" ? (
          <>
            {/* Row 0: quick actions — Auto-Detect + full Reset (parity with Manual Crop) */}
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={handleAutoDetect}
                disabled={detecting}
                className="flex items-center gap-1.5 text-[var(--admin-gold)] text-xs border border-[var(--admin-gold)]/30 px-2 py-1 sm:px-3 sm:py-1.5 rounded-lg hover:bg-[var(--admin-gold)]/10 disabled:opacity-50 transition-colors"
              >
                {detecting ? <Loader2 size={12} className="animate-spin" /> : <Target size={12} />}
                {detecting ? "Detecting..." : "Auto-Detect"}{" "}
                <span className="text-[var(--admin-ink-dim)] text-[9px]">A</span>
              </button>
              <button
                type="button"
                onClick={resetAll}
                disabled={totalPlaced === 0 && rotation === 0}
                className="flex items-center gap-1 text-[var(--admin-ink-dim)] text-xs border border-[var(--admin-line)] px-2 py-1 sm:px-3 sm:py-1.5 rounded-lg hover:bg-[var(--admin-panel3)] hover:text-[var(--admin-ink)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <RotateCcw size={12} /> Reset <span className="text-[var(--admin-ink-dim)] text-[9px]">R</span>
              </button>
            </div>

            {/* Row 1: dot status + clear + live readout */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-mono" style={{ color: palette.outer }}>
                Outer {outerPts.length}/4
              </span>
              {outerPts.length > 0 && (
                <button
                  type="button"
                  onClick={clearOuter}
                  className="text-[10px] text-[var(--admin-ink-dim)] hover:text-[var(--admin-gold)] underline"
                >
                  clear
                </button>
              )}
              {mode === "full" && (
                <>
                  <span className="text-xs font-mono ml-2" style={{ color: palette.inner }}>
                    Inner {innerPts.length}/4
                  </span>
                  {innerPts.length > 0 && (
                    <button
                      type="button"
                      onClick={clearInner}
                      className="text-[10px] text-[var(--admin-ink-dim)] hover:text-[var(--admin-green)] underline"
                    >
                      clear
                    </button>
                  )}
                </>
              )}
              <div className="flex-1" />
              {previewCentering && (
                <span className="text-xs font-mono text-[var(--admin-ink-dim)]">
                  {previewCentering.lr} L/R &middot; {previewCentering.tb} T/B →{" "}
                  <span
                    className={`font-black ${previewCentering.subgrade >= 9 ? "text-[var(--admin-gold)]" : previewCentering.subgrade >= 7 ? "text-[var(--admin-green)]" : "text-[var(--admin-amber)]"}`}
                  >
                    {previewCentering.subgrade}
                  </span>
                </span>
              )}
            </div>

            {/* Row 2: rotate / straighten (deskew override) */}
            <div className="flex items-center gap-2 text-xs">
              <span className="text-[var(--admin-ink)] font-semibold flex items-center gap-1">
                <RotateCcw size={12} /> Rotate / straighten
              </span>
              <button
                type="button"
                onClick={() => nudgeRotation(-ROTATION_STEP_FINE)}
                disabled={rotation <= ROTATION_MIN}
                aria-label="Rotate −0.1°"
                title="Rotate −0.1°"
                className="p-1.5 rounded border border-[var(--admin-line)] hover:bg-[var(--admin-panel3)] hover:text-[var(--admin-gold)] disabled:opacity-30 disabled:cursor-not-allowed text-[var(--admin-ink)]"
              >
                <Minus size={14} />
              </button>
              <input
                type="range"
                min={ROTATION_MIN}
                max={ROTATION_MAX}
                step="0.5"
                value={rotation}
                onChange={(e) => setRotation(Number(e.target.value))}
                className="flex-1 max-w-[240px] accent-[var(--admin-gold)]"
              />
              <button
                type="button"
                onClick={() => nudgeRotation(+ROTATION_STEP_FINE)}
                disabled={rotation >= ROTATION_MAX}
                aria-label="Rotate +0.1°"
                title="Rotate +0.1°"
                className="p-1.5 rounded border border-[var(--admin-line)] hover:bg-[var(--admin-panel3)] hover:text-[var(--admin-gold)] disabled:opacity-30 disabled:cursor-not-allowed text-[var(--admin-ink)]"
              >
                <Plus size={14} />
              </button>
              <span className="text-[var(--admin-gold)] font-mono w-14 text-right">{rotation.toFixed(1)}°</span>
              <span className="text-[var(--admin-ink-faint)] text-[10px]">
                {rotation === 0 ? "(auto from dots)" : "(manual)"}
              </span>
              {rotation !== 0 && (
                <button
                  type="button"
                  onClick={() => setRotation(0)}
                  className="text-[10px] text-[var(--admin-ink-dim)] hover:text-[var(--admin-gold)] underline"
                >
                  auto
                </button>
              )}
            </div>

            {/* Row 3: cancel + compute */}
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={onCancel}
                className="border border-[var(--admin-line)] text-[var(--admin-ink-dim)] text-xs px-3 py-1.5 sm:px-4 sm:py-2 rounded-lg hover:bg-[var(--admin-panel3)]"
              >
                Cancel <span className="text-[var(--admin-ink-dim)] text-[9px]">Esc</span>
              </button>
              <button
                type="button"
                onClick={handleCompute}
                disabled={saving || !canCompute}
                className="flex items-center gap-2 bg-gradient-to-r from-[var(--admin-gold)] to-[var(--admin-gold-deep)] text-[#1A1400] text-xs font-bold uppercase px-6 py-2.5 rounded-lg hover:opacity-90 disabled:opacity-40"
              >
                {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                {saving ? "Applying..." : mode === "full" ? "Compute crop + centering" : "Compute crop"}
                <span className="text-[#1A1400]/50 text-[9px] normal-case">↵</span>
              </button>
            </div>
          </>
        ) : (
          // ── Defects phase ──────────────────────────────────────────────
          // Single row: defects summary on the left, Label-batch + Done on
          // the right. Crop + centering are already saved (durably), so the
          // bar shows what the operator has done in this session and how to
          // finish. Label-batch is a click target equivalent to double-click
          // / Enter, kept visible so the affordance is obvious.
          <div className="flex flex-col gap-2">
            {/* MVGS v2.1 tool palette — Pin | Whitening | Crease. Pin path
                is unchanged when markTool === "pin". */}
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2 flex-wrap">
                <div className="flex rounded-lg overflow-hidden border border-[var(--admin-line)] text-[10px] font-bold uppercase">
                  <button
                    type="button"
                    onClick={() => setMarkTool("pin")}
                    data-testid="btn-mark-tool-pin"
                    className={`px-3 py-1.5 ${markTool === "pin" ? "bg-[var(--admin-gold)] text-[#1A1400]" : "text-[var(--admin-ink-dim)] hover:bg-[var(--admin-panel3)]"}`}
                  >
                    Pin
                  </button>
                  {canDrawWhitening && (
                    <button
                      type="button"
                      onClick={() => setMarkTool("whitening")}
                      data-testid="btn-mark-tool-whitening"
                      className={`px-3 py-1.5 border-l border-[var(--admin-line)] ${markTool === "whitening" ? "bg-[var(--admin-gold)] text-[#1A1400]" : "text-[var(--admin-ink-dim)] hover:bg-[var(--admin-panel3)]"}`}
                    >
                      Whitening
                    </button>
                  )}
                  {canDrawCrease && (
                    <button
                      type="button"
                      onClick={() => setMarkTool("crease")}
                      data-testid="btn-mark-tool-crease"
                      className={`px-3 py-1.5 border-l border-[var(--admin-line)] ${markTool === "crease" ? "bg-[var(--admin-gold)] text-[#1A1400]" : "text-[var(--admin-ink-dim)] hover:bg-[var(--admin-panel3)]"}`}
                    >
                      Crease
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
                            : "border-[var(--admin-line)] hover:scale-110"
                        }`}
                        style={{ background: c }}
                      />
                    ))}
                  </div>
                )}
              </div>
              <span className="text-[var(--admin-ink-faint)] text-[10px]">
                {markTool === "pin"
                  ? "Click to pin · double-click or ↵ to label · Esc to discard"
                  : markTool === "whitening"
                    ? `${whiteningLines.filter((l) => l.side === side).length} on this side · click-drag along the edge`
                    : `${creaseLines.filter((l) => l.side === side).length} on this side · click-drag across the card`}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2 text-xs">
                <span className="text-[var(--admin-ink)] font-mono">
                  Defects: <strong>{committedDefects.length}</strong>
                </span>
                {defectBatch.length > 0 && (
                  <span className="text-[var(--admin-gold)] font-mono">+{defectBatch.length} pending</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={openDefectPicker}
                  disabled={defectBatch.length === 0}
                  className="border border-[var(--admin-line)] text-[var(--admin-ink)] text-xs px-3 py-1.5 sm:px-4 sm:py-2 rounded-lg hover:bg-[var(--admin-panel3)] disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Label batch ({defectBatch.length})
                </button>
                <button
                  type="button"
                  onClick={onDone}
                  className="flex items-center gap-2 bg-gradient-to-r from-[var(--admin-gold)] to-[var(--admin-gold-deep)] text-[#1A1400] text-xs font-bold uppercase px-6 py-2.5 rounded-lg hover:opacity-90"
                >
                  <Check size={13} />
                  Done
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Shared defect picker portal — rendered at root so it escapes the
          overlay's stacking context. Only mounted when a batch is awaiting
          a label. Same component image-viewer mark mode uses. */}
      {phase === "defects" && defectPickerOpen && defectPickerAnchor && (
        <DefectTypePicker
          anchor={defectPickerAnchor}
          tier={defectPickerTier}
          onTierChange={setDefectPickerTier}
          onPick={commitDefectBatch}
          onCancel={cancelDefectBatch}
          pinCount={defectBatch.length}
        />
      )}
    </div>
  );
}
