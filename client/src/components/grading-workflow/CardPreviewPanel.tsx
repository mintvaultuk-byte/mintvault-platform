/**
 * Read-only card viewer for the Card + Rarity stages.
 *
 * A plain <img> fed by (a) the object URL of a just-uploaded file, or (b) the
 * existing signed display URLs from GET /api/admin/certificates/:id/images
 * (front_display / back_display). Front/Back tabs, mouse-wheel zoom, fit-to-
 * screen, reset, and a full-screen modal. Deliberately NOT the grading tool:
 * no coordinates, no click-to-grade, no crop/centering writes, no protected
 * components — zooming here is a pure CSS transform on a preview image and
 * never touches the workstation's coordinate system.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ZoomIn, ZoomOut, Maximize2, Minimize2, RotateCcw } from "lucide-react";

interface ImagesResponse {
  urls?: Record<string, string | null>;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

export function CardPreviewPanel({
  certificateId,
  frontFile,
  backFile,
}: {
  certificateId: number | null;
  frontFile?: File | null;
  backFile?: File | null;
}) {
  const [side, setSide] = useState<"front" | "back">("front");
  const [zoom, setZoom] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);

  const { data } = useQuery<ImagesResponse>({
    queryKey: [`/api/admin/certificates/${certificateId}/images`],
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

  // Reset zoom whenever the shown image changes or fullscreen toggles.
  useEffect(() => setZoom(1), [side, url, fullscreen]);

  // Close fullscreen on Escape.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFullscreen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  const wheelZoom = (e: React.WheelEvent) => {
    if (!url) return;
    e.preventDefault();
    setZoom((z) => clampZoom(z + (e.deltaY < 0 ? 0.25 : -0.25)));
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
      onWheel={wheelZoom}
      tabIndex={0}
      role="group"
      aria-label="Card preview — space toggles front and back"
      onKeyDown={(e) => {
        // Space toggles front/back — only while focus is inside the preview.
        if (e.key === " " || e.code === "Space") {
          e.preventDefault();
          setSide((s) => (s === "front" ? "back" : "front"));
        }
      }}
      className={`relative overflow-hidden rounded outline-none focus-visible:ring-1 focus-visible:ring-[var(--admin-gold)]/50 ${big ? "h-[80vh] w-full bg-black/60" : "max-h-[52vh]"}`}
      data-testid="card-preview-viewport"
    >
      {url ? (
        <img
          src={url}
          alt={`Card ${side}`}
          style={{ transform: `scale(${zoom})`, transition: "transform 0.08s ease-out" }}
          className={`mx-auto w-auto max-w-full origin-center rounded object-contain ${big ? "max-h-[80vh]" : "max-h-[52vh]"} ${zoom > 1 ? "cursor-grab" : ""}`}
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
    <div className="mb-1.5 flex items-center justify-between gap-2">
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
        <ControlButton onClick={() => setZoom((z) => clampZoom(z - 0.25))} label="Zoom out" disabled={!url || zoom <= MIN_ZOOM}>
          <ZoomOut size={14} />
        </ControlButton>
        <span className="w-8 text-center text-[10px] tabular-nums text-[var(--admin-ink-faint)]" data-testid="card-preview-zoom">
          {Math.round(zoom * 100)}%
        </span>
        <ControlButton onClick={() => setZoom((z) => clampZoom(z + 0.25))} label="Zoom in" disabled={!url || zoom >= MAX_ZOOM}>
          <ZoomIn size={14} />
        </ControlButton>
        <ControlButton onClick={() => setZoom(1)} label="Fit to screen / reset zoom" disabled={!url}>
          <RotateCcw size={13} />
        </ControlButton>
        <ControlButton onClick={() => setFullscreen(true)} label="Full-screen preview" disabled={!url}>
          <Maximize2 size={13} />
        </ControlButton>
      </div>
    </div>
  );

  return (
    <div className="rounded-lg border border-[var(--admin-gold)]/15 bg-black/20 p-2" data-testid="card-preview-panel">
      {toolbar}
      {imageArea(false)}
      <p className="mt-1 text-center text-[9px] text-[var(--admin-ink-faint)]">Scroll to zoom · read-only reference</p>

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
