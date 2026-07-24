/**
 * Live FRONT-label preview for the Review stage.
 *
 * Renders the certificate's printed front label by POSTing the grader's *draft*
 * field values to `/api/admin/label-preview`, which runs the SAME server-side
 * `generateLabelPNG()` renderer that produces the physical label. There is NO
 * second renderer here — this component only displays the PNG the real renderer
 * returns, so the preview always matches the printed output 1:1.
 *
 * It re-fetches (debounced) whenever any label-relevant field changes — card
 * name, set, rarity, finish, promo, grade, certificate number — so the grader
 * sees exactly what will print, live, without having to save first. Click the
 * preview to enlarge it.
 *
 * Pure presentation + a read-only render call: holds no certificate state,
 * mutates nothing, and never saves.
 */
import { useEffect, useRef, useState } from "react";
import { Loader2, Maximize2, CheckCircle2, AlertTriangle } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

/** The label-relevant draft fields fed to the real renderer. Mirrors the
 *  subset of the certificate save payload that affects the FRONT label. */
export interface LabelPreviewValues {
  certificateId: number | null;
  certId?: string | null;
  cardGame?: string;
  cardName?: string;
  setName?: string;
  cardNumber?: string;
  year?: string;
  language?: string;
  variant?: string;
  variantOther?: string;
  rarity?: string;
  rarityOther?: string;
  rarityCode?: string;
  finishVariant?: string;
  promoType?: string;
  subsetName?: string;
  era?: string;
  gradeType?: string;
  gradeOverall?: string;
}

function toBody(v: LabelPreviewValues): Record<string, unknown> {
  return {
    certificateId: v.certificateId,
    certId: v.certId ?? undefined,
    cardGame: v.cardGame,
    cardName: v.cardName,
    setName: v.setName,
    cardNumber: v.cardNumber,
    year: v.year,
    language: v.language,
    variant: v.variant,
    variantOther: v.variantOther,
    rarity: v.rarity,
    rarityOther: v.rarityOther,
    rarityCode: v.rarityCode,
    finishVariant: v.finishVariant,
    promoType: v.promoType,
    subsetName: v.subsetName,
    era: v.era,
    gradeType: v.gradeType,
    gradeOverall: v.gradeOverall,
  };
}

export function LabelPreview({
  values,
  dirty,
  active = true,
}: {
  values: LabelPreviewValues;
  dirty: boolean;
  /** Only fetch when the Review stage is actually visible. The workstation keeps
   *  all stages mounted (hidden-not-unmounted), so without this the preview would
   *  render on the server on every field edit during Card/Rarity/Grade too. */
  active?: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enlarged, setEnlarged] = useState(false);
  const urlRef = useRef<string | null>(null);

  // Re-render whenever any label-relevant field changes. Serialise the body so
  // the effect only re-runs on a real content change, and debounce so typing
  // doesn't fire a request per keystroke.
  const key = JSON.stringify(toBody(values));

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const controller = new AbortController();
    const t = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/admin/label-preview", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: key,
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`Preview failed (${res.status})`);
        const blob = await res.blob();
        if (cancelled) return;
        const objUrl = URL.createObjectURL(blob);
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = objUrl;
        setUrl(objUrl);
      } catch (e) {
        if (cancelled || (e instanceof Error && e.name === "AbortError")) return;
        setError(e instanceof Error ? e.message : "Preview failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 450);
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(t);
    };
  }, [key, active]);

  // Revoke the last object URL on unmount.
  useEffect(() => {
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  return (
    <div className="rounded-lg border border-[var(--admin-gold)]/15 bg-[var(--admin-gold)]/[0.02] p-2.5" data-testid="label-preview">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-widest text-[var(--admin-gold)]/70">Certificate Preview</span>
        <span className="text-[9px] uppercase tracking-wider text-[var(--admin-ink-faint)]">Front label</span>
      </div>

      <button
        type="button"
        onClick={() => url && setEnlarged(true)}
        disabled={!url}
        className="group relative block w-full overflow-hidden rounded-md border border-[var(--admin-line)] bg-black/20"
        data-testid="button-enlarge-label-preview"
        title="Click to enlarge"
      >
        {/* 827×236 front label aspect ratio (~3.5:1) reserved so layout doesn't jump. */}
        <div className="relative w-full" style={{ aspectRatio: "827 / 236" }}>
          {url && (
            <img src={url} alt="Front certificate label preview" className="absolute inset-0 h-full w-full object-contain" />
          )}
          {!url && !error && (
            <div className="absolute inset-0 flex items-center justify-center text-[11px] text-[var(--admin-ink-faint)]">
              {loading ? "Rendering preview…" : "No preview"}
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex items-center justify-center px-3 text-center text-[11px] text-[var(--admin-red)]">
              {error}
            </div>
          )}
          {loading && url && (
            <div className="absolute right-1.5 top-1.5 rounded-full bg-black/50 p-1">
              <Loader2 size={12} className="animate-spin text-white" />
            </div>
          )}
          {url && (
            <div className="pointer-events-none absolute bottom-1.5 right-1.5 rounded bg-black/50 p-1 opacity-0 transition-opacity group-hover:opacity-100">
              <Maximize2 size={12} className="text-white" />
            </div>
          )}
        </div>
      </button>

      {/* Label confidence — does the preview match what is already printed? */}
      <div className="mt-1.5 flex items-center gap-1.5 text-[11px]" data-testid="label-confidence">
        {dirty ? (
          <span className="flex items-center gap-1.5 text-[var(--admin-amber)]">
            <AlertTriangle size={12} /> Unsaved changes — save to update the printed label
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-[var(--admin-green)]">
            <CheckCircle2 size={12} /> Matches printed label
          </span>
        )}
      </div>

      <Dialog open={enlarged} onOpenChange={setEnlarged}>
        <DialogContent className="max-w-4xl">
          <DialogTitle className="text-sm">Certificate front label preview</DialogTitle>
          {url && (
            <img src={url} alt="Enlarged front certificate label preview" className="w-full rounded-md border border-[var(--admin-line)]" />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
