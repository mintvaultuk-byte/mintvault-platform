/**
 * Read-only card viewer for the Card + Rarity stages.
 *
 * A plain <img> fed by (a) the object URL of a just-uploaded file, or (b) the
 * existing signed display URLs from GET /api/admin/certificates/:id/images
 * (front_display / back_display). Front/Back tabs, button-only zoom (+/−/Fit),
 * click-and-drag panning while zoomed, and a full-screen modal. The mouse wheel
 * is NOT captured — it scrolls the page/panel normally. Deliberately NOT the
 * grading tool: no grading coordinates, no click-to-grade, no crop/centering
 * writes, no protected imports — zoom + pan are a pure CSS transform (translate +
 * scale) on a preview image and never touch the workstation's coordinate system.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ZoomIn, ZoomOut, Maximize2, Minimize2, RotateCcw } from "lucide-react";

interface ImagesResponse {
  urls?: Record<string, string | null>;
}

// Button-only zoom levels: 100% → 175% → 250% → 325% → 400% (75 percentage
// points per click), max 400%, min 100%. Zoom is ONLY driven by the +/− and
// Reset buttons — never the mouse wheel (the wheel scrolls the page/panel).
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.75;
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

export function CardPreviewPanel({
  certificateId,
  frontFile,
  backFile,
  fill = false,
  apiBase = "/api/admin",
}: {
  certificateId: number | null;
  frontFile?: File | null;
  backFile?: File | null;
  /** When true, the panel fills its parent's height and the card contain-fits
      that height (the Card/Rarity workstation aside). Default false keeps the
      capped thumbnail size used by the Review-stage summary. */
  fill?: boolean;
  /** Cert-scoped API base for the images query. Defaults to /api/admin (the
      admin certificate editor). Staff/grader/review shells pass their own base
      (/api/grader, /api/admin/grade-review) so the preview loads role-scoped
      signed URLs — and shares GradingPanel's images cache key. */
  apiBase?: string;
}) {
  const [side, setSide] = useState<"front" | "back">("front");
  const [zoom, setZoom] = useState(1);
  // Pan offset in CSS pixels (translate applied before scale). {0,0} = centred.
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ sx: number; sy: number; px: number; py: number } | null>(null);
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
    [frontObjectUrl, backObjectUrl],
  );

  const frontUrl = frontObjectUrl ?? data?.urls?.front_display ?? null;
  const backUrl = backObjectUrl ?? data?.urls?.back_display ?? null;
  const url = side === "front" ? frontUrl : backUrl;

  // Reset zoom + pan whenever the shown image changes or fullscreen toggles.
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [side, url, fullscreen]);

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
    dragRef.current = { sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y };
    setDragging(true);
  };
  const onDrag = (e: React.MouseEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setPan({ x: d.px + (e.clientX - d.sx), y: d.py + (e.clientY - d.sy) });
  };
  const endDrag = () => {
    dragRef.current = null;
    setDragging(false);
  };

  // Button zoom (centred). Returning to 1× re-centres.
  const stepZoom = (delta: number) => {
    const nextZoom = clampZoom(zoom + delta);
    if (nextZoom <= 1) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
      return;
    }
    setZoom(nextZoom);
  };
  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const ControlButton = ({ onClick, label, children, disabled }: { onClick: () => void; label: string; children: React.ReactNode; disabled?: boolean }) => (
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
          setSide((s) => (s === "front" ? "back" : "front"));
        }
      }}
      className={`relative overflow-hidden rounded outline-none focus-visible:ring-1 focus-visible:ring-[var(--admin-gold)]/50 ${
        zoom > 1 ? (dragging ? "cursor-grabbing" : "cursor-grab") : ""
      } ${big ? "flex h-[80vh] w-full items-center justify-center bg-black/60" : fill ? "flex min-h-0 flex-1 items-center justify-center" : "max-h-[40vh]"}`}
      data-testid="card-preview-viewport"
    >
      {url ? (
        <img
          src={url}
          alt={`Card ${side}`}
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transition: dragging ? "none" : "transform 0.1s ease-out",
          }}
          className={`mx-auto w-auto max-w-full origin-center rounded object-contain ${big ? "max-h-[80vh]" : fill ? "max-h-full" : "max-h-[40vh]"}`}
          data-testid="card-preview-image"
          draggable={false}
        />
      ) : (
        <div className="flex h-40 items-center justify-center text-center text-[11px] text-[var(--admin-ink-faint)]">
          {side === "front" ? "No front image yet — upload one in the grading workstation." : "No back image yet."}
        </div>
      )}
    </div>
  );

  const toolbar = (
    <div className="mb-1.5 flex shrink-0 items-center justify-between gap-2">
      <div className="flex gap-1">
        {(["front", "back"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSide(s)}
            data-testid={`card-preview-${s}`}
            className={`px-2.5 py-1 rounded text-[10px] font-bold uppercase tracking-wider transition-colors ${
              side === s ? "bg-[var(--admin-gold)] text-[#1A1400]" : "text-[var(--admin-gold)]/60 hover:text-[var(--admin-gold)] border border-[var(--admin-gold)]/20"
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
        <span className="w-8 text-center text-[10px] tabular-nums text-[var(--admin-ink-faint)]" data-testid="card-preview-zoom">
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
    <div className={`${fill ? "flex h-full min-h-0 flex-col " : ""}rounded-lg border border-[var(--admin-gold)]/15 bg-black/20 p-2`} data-testid="card-preview-panel">
      {toolbar}
      {imageArea(false)}
      <p className="mt-1 shrink-0 text-center text-[9px] text-[var(--admin-ink-faint)]">Zoom with the buttons · drag to pan when zoomed · read-only reference</p>

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
