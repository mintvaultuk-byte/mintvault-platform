/**
 * Read-only card viewer for the Card Details stage.
 *
 * A plain <img> fed by (a) the object URL of a just-uploaded file, or (b) the
 * existing signed evidence URLs from GET /api/admin/certificates/:id/images
 * (front_working / back_working only). A compact display derivative is never
 * substituted for workstation inspection evidence.
 * Front/Back tabs, button-only zoom (+/−/Fit),
 * click-and-drag panning while zoomed, and a full-screen modal. The mouse wheel
 * is NOT captured — it scrolls the page/panel normally. Deliberately NOT the
 * grading tool: no grading coordinates, no click-to-grade, no crop/centering
 * writes, no protected imports — zoom + pan are a pure CSS transform (translate +
 * scale) on a preview image and never touch the workstation's coordinate system.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ZoomIn, ZoomOut, Maximize2, Minimize2, RotateCcw } from "lucide-react";
import {
  CARD_INSPECTION_MAX_ZOOM,
  CARD_INSPECTION_MIN_ZOOM,
  normaliseCardInspectionState,
  updateCardInspectionView,
  type CardInspectionState,
} from "./card-inspection-state";

interface ImagesResponse {
  urls?: Record<string, string | null>;
  workingEvidence?: Partial<
    Record<"front" | "back", { available: boolean; reason: string | null; recovery: string | null }>
  >;
  reviewEvidence?: Partial<
    Record<"front" | "back", { available: boolean; reason: string | null; recovery: string | null }>
  >;
}

// The read-only preview consumes the same 50–500% presentation-state range as
// the authoritative inspection viewport. Buttons move by 75 percentage points;
// ordinary wheel input remains page/panel scroll on this secondary surface.
const MIN_ZOOM = CARD_INSPECTION_MIN_ZOOM;
const MAX_ZOOM = CARD_INSPECTION_MAX_ZOOM;
const ZOOM_STEP = 0.75;
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

export function CardPreviewPanel({
  certificateId,
  frontFile,
  backFile,
  fill = false,
  apiBase = "/api/admin",
  inspectionState,
  onInspectionStateChange,
}: {
  certificateId: number | null;
  frontFile?: File | null;
  backFile?: File | null;
  /** When true, the panel fills its parent's height and the card contain-fits
      that height (the Card Details workstation aside). Default false keeps the
      capped thumbnail size used by the Review-stage summary. */
  fill?: boolean;
  /** Cert-scoped API base for the images query. Defaults to /api/admin (the
      admin certificate editor). Staff/grader/review shells pass their own base
      (/api/grader, /api/admin/grade-review) so the preview loads role-scoped
      signed URLs — and shares GradingPanel's images cache key. */
  apiBase?: string;
  /** Required: the canonical workstation owns inspection state above all
      stages, so the rail can never create a competing per-viewer state. */
  inspectionState: CardInspectionState;
  onInspectionStateChange: (state: CardInspectionState) => void;
}) {
  const currentInspection = normaliseCardInspectionState(inspectionState);
  const side = currentInspection.side;
  const view = currentInspection.views[side];
  const zoom = view.zoom;
  const commitInspection = (next: CardInspectionState) => {
    const normalised = normaliseCardInspectionState(next);
    onInspectionStateChange(normalised);
  };
  const setSide = (nextSide: "front" | "back") => commitInspection({ ...currentInspection, side: nextSide });
  const setView = (patch: Partial<typeof view>) =>
    commitInspection(updateCardInspectionView(currentInspection, side, patch));
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ sx: number; sy: number; focusX: number; focusY: number } | null>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [fullscreen, setFullscreen] = useState(false);

  const { data } = useQuery<ImagesResponse>({
    queryKey: [`${apiBase}/certificates/${certificateId}/images`],
    enabled: certificateId != null,
    staleTime: 5 * 60 * 1000,
  });

  const frontObjectUrl = useMemo(() => (frontFile ? URL.createObjectURL(frontFile) : null), [frontFile]);
  const backObjectUrl = useMemo(() => (backFile ? URL.createObjectURL(backFile) : null), [backFile]);
  useEffect(
    () => () => {
      if (frontObjectUrl) URL.revokeObjectURL(frontObjectUrl);
      if (backObjectUrl) URL.revokeObjectURL(backObjectUrl);
    },
    [frontObjectUrl, backObjectUrl]
  );

  // A signed URL is insufficient proof on its own. The server must have
  // admitted this side against the immutable 1200-DPI master in the same
  // response, otherwise the details/review surface fails visibly closed.
  const frontUrl =
    frontObjectUrl ??
    (data?.workingEvidence?.front?.available === true ? (data.urls?.front_working ?? null) : null) ??
    (data?.reviewEvidence?.front?.available === true ? (data.urls?.front_review ?? null) : null);
  const backUrl =
    backObjectUrl ??
    (data?.workingEvidence?.back?.available === true ? (data.urls?.back_working ?? null) : null) ??
    (data?.reviewEvidence?.back?.available === true ? (data.urls?.back_review ?? null) : null);
  const url = side === "front" ? frontUrl : backUrl;
  const unavailableReason =
    data?.reviewEvidence?.[side]?.reason ??
    data?.workingEvidence?.[side]?.reason ??
    `${side.toUpperCase()} cannot be inspected from a display derivative.`;
  const unavailableRecovery =
    data?.reviewEvidence?.[side]?.recovery ??
    data?.workingEvidence?.[side]?.recovery ??
    "Restore canonical full-resolution working evidence for this side.";

  // Reset only when an already-loaded image is actually replaced. Initial load,
  // side switches and fullscreen preserve workstation-owned inspection state.
  const previousUrlsRef = useRef({ front: frontUrl, back: backUrl });
  useEffect(() => {
    const previous = previousUrlsRef.current[side];
    previousUrlsRef.current[side] = url;
    if (previous && url && previous !== url) setView({ zoom: 1, focusX: 0.5, focusY: 0.5 });
    // setView is intentionally excluded: image identity alone owns this reset.
  }, [side, url]);

  // Close fullscreen on Escape.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFullscreen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  // Mouse wheel is intentionally NOT handled here — the wheel scrolls the page /
  // panel normally. Zoom is only via the +/−/Reset(Fit)/Fullscreen buttons.

  // Drag-to-pan (only meaningful when zoomed in). Pure pixel translation of the
  // preview image; never reads/writes any grading position.
  const startDrag = (e: React.MouseEvent) => {
    if (zoom <= 1) return;
    e.preventDefault();
    dragRef.current = { sx: e.clientX, sy: e.clientY, focusX: view.focusX, focusY: view.focusY };
    setDragging(true);
  };
  const onDrag = (e: React.MouseEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const image = imageRef.current;
    if (!image) return;
    setView({
      focusX: d.focusX - (e.clientX - d.sx) / Math.max(1, image.offsetWidth),
      focusY: d.focusY - (e.clientY - d.sy) / Math.max(1, image.offsetHeight),
    });
  };
  const endDrag = () => {
    dragRef.current = null;
    setDragging(false);
  };

  // Button zoom (centred). Returning to 1× re-centres.
  const stepZoom = (delta: number) => {
    const nextZoom = clampZoom(zoom + delta);
    if (nextZoom <= 1) {
      setView({ zoom: 1, focusX: 0.5, focusY: 0.5 });
      return;
    }
    setView({ zoom: nextZoom });
  };
  const resetView = () => {
    setView({ zoom: 1, focusX: 0.5, focusY: 0.5 });
  };

  const ControlButton = ({
    onClick,
    label,
    children,
    disabled,
  }: {
    onClick: () => void;
    label: string;
    children: React.ReactNode;
    disabled?: boolean;
  }) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex h-6 w-6 items-center justify-center rounded text-[var(--admin-gold)]/60 hover:bg-[var(--admin-gold)]/10 hover:text-[var(--admin-gold)] disabled:opacity-30 disabled:cursor-not-allowed"
    >
      {children}
    </button>
  );

  const imageArea = (big: boolean) => (
    <div
      onMouseDown={startDrag}
      onMouseMove={onDrag}
      onMouseUp={endDrag}
      onMouseLeave={endDrag}
      tabIndex={0}
      role="group"
      aria-label="Card preview — zoom with the buttons, drag to pan when zoomed, space toggles front and back"
      onKeyDown={(e) => {
        // Space toggles front/back — only while focus is inside the preview.
        if (e.key === " " || e.code === "Space") {
          e.preventDefault();
          setSide(side === "front" ? "back" : "front");
        }
      }}
      className={`relative overflow-hidden rounded outline-none focus-visible:ring-1 focus-visible:ring-[var(--admin-gold)]/50 ${
        zoom > 1 ? (dragging ? "cursor-grabbing" : "cursor-grab") : ""
      } ${big ? "flex h-[80vh] w-full items-center justify-center bg-black/60" : fill ? "flex min-h-0 flex-1 items-center justify-center" : "max-h-[40vh]"}`}
      data-testid="card-preview-viewport"
      data-inspection-side={side}
      data-inspection-zoom={zoom}
      data-inspection-focus-x={view.focusX}
      data-inspection-focus-y={view.focusY}
    >
      {url ? (
        <img
          ref={imageRef}
          src={url}
          alt={`Card ${side}`}
          style={{
            transform:
              zoom !== 1
                ? `scale(${zoom}) translate(${((0.5 - view.focusX) * 100) / zoom}%, ${((0.5 - view.focusY) * 100) / zoom}%)`
                : "none",
            transition: dragging ? "none" : "transform 0.1s ease-out",
          }}
          className={`mx-auto w-auto max-w-full origin-center rounded object-contain ${big ? "max-h-[80vh]" : fill ? "max-h-full" : "max-h-[40vh]"}`}
          data-testid="card-preview-image"
          draggable={false}
        />
      ) : (
        <div className="flex h-40 flex-col items-center justify-center gap-1 px-4 text-center text-[11px] text-[var(--admin-ink-faint)]">
          <p className="font-bold text-amber-300">FULL-RESOLUTION EVIDENCE UNAVAILABLE</p>
          <p>{unavailableReason}</p>
          <p>{unavailableRecovery}</p>
        </div>
      )}
    </div>
  );

  // mb-1 (4px) not mb-1.5: owner evidence 2026-08-16 showed the gap between the
  // Front/Back controls and the card was eating card height. Every pixel removed
  // here is a pixel the card-fit box gains.
  const toolbar = (
    <div className="mb-1 flex shrink-0 items-center justify-between gap-2">
      <div className="flex gap-1">
        {(["front", "back"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSide(s)}
            data-testid={`card-preview-${s}`}
            className={`px-2 py-[3px] rounded text-[9px] font-bold uppercase tracking-wider transition-colors ${
              side === s
                ? "bg-[var(--admin-gold)] text-[#1A1400]"
                : "text-[var(--admin-gold)]/60 hover:text-[var(--admin-gold)] border border-[var(--admin-gold)]/20"
            }`}
          >
            {s}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-0.5">
        <ControlButton onClick={() => stepZoom(-ZOOM_STEP)} label="Zoom out" disabled={!url || zoom <= MIN_ZOOM}>
          <ZoomOut size={14} />
        </ControlButton>
        <span
          className="w-8 text-center text-[10px] tabular-nums text-[var(--admin-ink-faint)]"
          data-testid="card-preview-zoom"
        >
          {Math.round(zoom * 100)}%
        </span>
        <ControlButton onClick={() => stepZoom(ZOOM_STEP)} label="Zoom in" disabled={!url || zoom >= MAX_ZOOM}>
          <ZoomIn size={14} />
        </ControlButton>
        <ControlButton onClick={resetView} label="Fit to screen / reset zoom" disabled={!url}>
          <RotateCcw size={13} />
        </ControlButton>
        <ControlButton onClick={() => setFullscreen(true)} label="Full-screen preview" disabled={!url}>
          <Maximize2 size={13} />
        </ControlButton>
      </div>
    </div>
  );

  return (
    <div
      className={`${fill ? "flex h-full min-h-0 flex-col " : ""}rounded-lg border border-[var(--admin-gold)]/15 bg-black/20 p-2`}
      data-testid="card-preview-panel"
    >
      {toolbar}
      {imageArea(false)}
      <p className="mt-1 shrink-0 text-center text-[9px] text-[var(--admin-ink-faint)]">
        Zoom with the buttons · drag to pan when zoomed · read-only reference
      </p>

      {fullscreen && (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-black/90 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Card full-screen preview"
          data-testid="card-preview-fullscreen"
        >
          <div className="mb-2 flex items-center justify-between">
            {toolbar}
            <button
              type="button"
              onClick={() => setFullscreen(false)}
              aria-label="Close full-screen preview"
              title="Close (Esc)"
              className="flex h-7 items-center gap-1 rounded border border-[var(--admin-gold)]/30 px-2 text-[11px] text-[var(--admin-gold)] hover:bg-[var(--admin-gold)]/10"
            >
              <Minimize2 size={13} /> Close
            </button>
          </div>
          <div className="flex flex-1 items-center justify-center">{imageArea(true)}</div>
        </div>
      )}
    </div>
  );
}
