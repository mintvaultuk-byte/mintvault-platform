/**
 * Live FRONT certificate preview (read-only).
 *
 * Shows the REAL printed front slab label for the current, unsaved workstation
 * values by POSTing them to /api/admin/certificates/label/preview, which renders
 * with the SAME server pipeline (generateLabelPNG) used for printing — so what
 * the grader sees here is exactly what will print. No client-side re-rendering,
 * no approximation. Debounced so typing doesn't hammer the endpoint.
 *
 * This panel never writes anything; it only reflects the fields passed in.
 */
import { useEffect, useRef, useState } from "react";
import { apiRequest } from "@/lib/queryClient";

export interface CertificatePreviewFields {
  // When set, the server starts the preview from this saved cert's real grade /
  // subgrade / defect columns so the black-label (Pristine) preview matches print.
  certificateId?: number | null;
  cardName?: string;
  setName?: string;
  year?: string;
  cardNumber?: string;
  gradeType?: string;
  gradeOverall?: number | string | null;
  variant?: string;
  variantOther?: string;
  rarity?: string;
  rarityOther?: string;
  labelType?: string;
  language?: string;
  // Structured-variant codes — sent so the server derives the ONE consolidated
  // variant line (structuredVariantVersion 2) and the preview matches print 1:1.
  rarityCode?: string;
  finishVariant?: string;
  promoType?: string;
  subsetName?: string;
  era?: string;
  // Optional grading fields — let the black/white (Pristine) label match print.
  gradeCentering?: number | null;
  gradeCorners?: number | null;
  gradeEdges?: number | null;
  gradeSurface?: number | null;
}

export function CertificatePreviewPanel({ fields }: { fields: CertificatePreviewFields }) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);
  const key = JSON.stringify(fields);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await apiRequest("POST", "/api/admin/certificates/label/preview", fields);
        const blob = await res.blob();
        if (cancelled) return;
        const next = URL.createObjectURL(blob);
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = next;
        setUrl(next);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Preview unavailable.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key]);

  // Revoke the last object URL on unmount.
  useEffect(() => () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
  }, []);

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-2" data-testid="certificate-preview-panel">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Live certificate preview</span>
        {loading && <span className="text-[10px] text-amber-400">rendering…</span>}
      </div>
      {error ? (
        <p className="py-4 text-center text-xs text-slate-500">{error}</p>
      ) : url ? (
        // The real front slab label (826×236 @300DPI) — read-only, matches print.
        <img src={url} alt="Front certificate preview" className="w-full rounded border border-slate-800 bg-white" data-testid="certificate-preview-image" />
      ) : (
        <p className="py-4 text-center text-xs text-slate-500">Preview will appear here.</p>
      )}
      <p className="mt-1 text-[10px] text-slate-500">Read-only — this is exactly what will print.</p>
    </div>
  );
}
