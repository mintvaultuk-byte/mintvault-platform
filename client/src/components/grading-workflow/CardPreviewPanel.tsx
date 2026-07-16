/**
 * Read-only card preview for the Card + Rarity stages.
 *
 * A plain <img> fed by (a) the object URL of a just-uploaded file, or (b) the
 * existing signed display URLs from GET /api/admin/certificates/:id/images
 * (front_display / back_display). Front/Back tabs, fit-to-panel, and an
 * open-full-size action. Deliberately NOT the grading tool: no coordinates,
 * no click-to-grade, no crop/centering writes, no protected components.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

interface ImagesResponse {
  urls?: Record<string, string | null>;
}

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

  // Signed display URLs for an existing certificate (1h expiry server-side).
  const { data } = useQuery<ImagesResponse>({
    queryKey: [`/api/admin/certificates/${certificateId}/images`],
    enabled: certificateId != null,
    staleTime: 5 * 60 * 1000,
  });

  // Object URLs for freshly-uploaded files (new certs before save).
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

  return (
    <div className="rounded-lg border border-[var(--admin-gold)]/15 bg-black/20 p-2" data-testid="card-preview-panel">
      <div className="mb-1.5 flex items-center justify-between">
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
        {url && (
          <button
            type="button"
            onClick={() => window.open(url, "_blank", "noopener")}
            data-testid="card-preview-open-full"
            className="text-[10px] text-[var(--admin-gold)]/50 underline hover:text-[var(--admin-gold)]"
            title="Open the full-size image in a new tab"
          >
            View full size
          </button>
        )}
      </div>
      {url ? (
        // Plain read-only image — identification reference only.
        <img
          src={url}
          alt={`Card ${side}`}
          className="mx-auto max-h-[52vh] w-auto max-w-full rounded object-contain"
          data-testid="card-preview-image"
        />
      ) : (
        <div className="flex h-40 items-center justify-center text-center text-[11px] text-[var(--admin-ink-faint)]">
          {side === "front" ? "No front image yet — upload one in the grading workstation." : "No back image yet."}
        </div>
      )}
    </div>
  );
}
