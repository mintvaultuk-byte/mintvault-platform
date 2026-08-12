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

export interface CertificatePreviewFields {
  // When set, the server starts the preview from this saved cert's real grade /
  // subgrade / defect columns so the black-label (Pristine) preview matches print.
  certificateId?: number | null;
  /** The real certificate number, so the preview's cert-number strip matches the
   *  printed label instead of the "MV-PREVIEW" placeholder. */
  certId?: string;
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

export function CertificatePreviewPanel({
  fields,
  endpoint = "/api/admin/certificates/label/preview",
  /**
   * Truthfulness of the caption (hostile-review MEDIUM).
   *
   * The panel renders CURRENT IN-MEMORY form values, which may not be what is
   * stored. Saying "this is exactly what will print" is only true once those
   * values are persisted, so the caption is driven by state rather than
   * hard-coded:
   *   • "unsaved"   — there are edits not yet persisted (the default, and the
   *                   normal state while a grader types).
   *   • "saved"     — the rendered values match what was last persisted.
   *   • "conflict"  — a concurrent edit was rejected, so what is on screen is
   *                   NOT authoritative and must not be presented as such.
   */
  persistence = "unsaved",
  revision = 0,
  expectedRevision,
  requireExpectedRevision = false,
  onRevisionComplete,
  requestTimeoutMs = 12_000,
}: {
  fields: CertificatePreviewFields;
  /** Server-authorised role endpoint. The endpoint, never UI visibility, owns
   *  certificate/assignment/tenant access control. */
  endpoint?: string;
  persistence?: "unsaved" | "saved" | "conflict";
  /** Increments after an authoritative grade save so saved grade/subgrades are re-read. */
  revision?: number;
  /**
   * Server-authoritative grading revision the caller expects this label to
   * represent. It is deliberately distinct from `revision`, which is only a
   * local request sequence used to restart the effect.
   */
  expectedRevision?: number | null;
  /** Existing-record canonical previews wait for hydration rather than sending
   * an unbound request before the server-issued revision is known. */
  requireExpectedRevision?: boolean;
  /** Acknowledges only the request started for this exact revision. */
  onRevisionComplete?: (
    revision: number,
    ok: boolean,
    fingerprint: string,
    authoritativeRevision?: number | null
  ) => void;
  /** Bounded independently of the workstation barrier so a hung fetch is aborted. */
  requestTimeoutMs?: number;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);
  const key = JSON.stringify(fields);

  useEffect(() => {
    if (requireExpectedRevision && expectedRevision == null) {
      setLoading(false);
      setError(null);
      return;
    }
    // Fingerprint certificate-facing fields only. `expectedRevision` is a
    // concurrency precondition, not printable content, so the workstation can
    // independently prove both the displayed payload and persisted revision.
    const requestFingerprint = key;
    const controller = new AbortController();
    let completed = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const complete = (ok: boolean, authoritativeRevision: number | null = null) => {
      if (completed) return;
      completed = true;
      // Preserve the legacy three-argument acknowledgement for ordinary live
      // previews. The fourth value is only meaningful for a prepared,
      // revision-bound Review preview.
      if (expectedRevision == null) {
        onRevisionComplete?.(revision, ok, requestFingerprint);
      } else {
        onRevisionComplete?.(revision, ok, requestFingerprint, authoritativeRevision);
      }
    };
    const timer = setTimeout(async () => {
      setLoading(true);
      setError(null);
      timeout = setTimeout(() => {
        controller.abort(new Error("Certificate preview timed out."));
        setError("Certificate preview timed out.");
        setLoading(false);
        complete(false);
      }, requestTimeoutMs);
      try {
        const body = expectedRevision == null ? fields : { ...fields, expectedRevision };
        const res = await fetch(endpoint, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `Certificate preview failed (${res.status})`);
        }
        const headerRevision = res.headers.get("X-MintVault-Review-Revision");
        const authoritativeRevision =
          headerRevision != null && /^\d+$/.test(headerRevision) ? Number(headerRevision) : null;
        if (
          expectedRevision != null &&
          (!Number.isSafeInteger(authoritativeRevision) || authoritativeRevision !== expectedRevision)
        ) {
          throw new Error("Certificate preview did not acknowledge the saved review revision.");
        }
        const blob = await res.blob();
        if (completed) return;
        const next = URL.createObjectURL(blob);
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = next;
        setUrl(next);
        complete(true, authoritativeRevision);
      } catch (err) {
        if (!completed) {
          setError(err instanceof Error ? err.message : "Preview unavailable.");
          complete(false);
        }
      } finally {
        if (timeout) clearTimeout(timeout);
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 350);
    return () => {
      clearTimeout(timer);
      if (timeout) clearTimeout(timeout);
      controller.abort();
      // Supersession/unmount is a terminal failure for THIS exact revision.
      // Without this acknowledgement, the workstation waiter never settles.
      complete(false);
    };
  }, [endpoint, expectedRevision, key, requireExpectedRevision, revision, onRevisionComplete, requestTimeoutMs]);

  // Revoke the last object URL on unmount.
  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    []
  );

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-1.5" data-testid="certificate-preview-panel">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Live certificate preview
        </span>
        {loading && <span className="text-[10px] text-amber-400">rendering…</span>}
      </div>
      {/*
       * COMPACT, FIXED-ASPECT INSPECTION FRAME (owner repair 2026-08-12).
       *
       * The image used to be a bare `w-full` with no ceiling, so in the 40% left
       * rail it rendered ~500px wide. At the label's real 826x236 ratio that is
       * ~145px tall before chrome, and because the rail stacks the card on
       * `flex-1` against this panel on `shrink-0`, every one of those pixels was
       * taken FROM the card — the preview visually crowded out the thing the
       * reviewer is actually inspecting.
       *
       * Two fixes, both display-only:
       *   1. `max-w-[360px]` caps it at a thumbnail. This is an inspection
       *      glance (name / set / grade / cert number / composition), not an
       *      editing surface, so it does not need rail width.
       *   2. The frame owns the height via `aspect-[826/236]` and every state
       *      renders INSIDE it. Previously the empty state was a short line of
       *      text and the loaded state was a tall image, so the panel jumped and
       *      shoved the card upward the moment the render arrived.
       *
       * 826/236 is read from PX_W/PX_H in server/labels.ts. It is the display
       * box only — the printed label, its dimensions and its renderer are
       * untouched.
       */}
      <div
        className="mx-auto grid aspect-[826/236] w-full max-w-[360px] place-items-center overflow-hidden rounded border border-slate-800 bg-slate-950/40"
        data-testid="certificate-preview-frame"
      >
        {error ? (
          <p className="px-2 text-center text-[11px] text-slate-500">{error}</p>
        ) : url ? (
          // The real front slab label (826×236 @300DPI) — read-only, matches print.
          <img
            src={url}
            alt="Front certificate preview"
            className="h-full w-full bg-white object-contain"
            data-testid="certificate-preview-image"
          />
        ) : (
          <p className="px-2 text-center text-[11px] text-slate-500">
            {loading ? "Preparing preview…" : "Preview will appear here."}
          </p>
        )}
      </div>
      {/* Never claim persisted truth for unsaved state. The panel stays READ-ONLY
          in every case — it renders an image and persists nothing. */}
      <p
        className={`mx-auto mt-1 max-w-[360px] text-[10px] ${persistence === "conflict" ? "text-amber-400" : "text-slate-500"}`}
        data-testid="certificate-preview-caption"
        data-persistence={persistence}
      >
        {persistence === "saved"
          ? "Read-only — saved. This is how the certificate will print."
          : persistence === "conflict"
            ? "Read-only — NOT saved. This certificate was changed elsewhere; refresh before trusting this preview."
            : "Live unsaved preview — this is how the current details will print once saved."}
      </p>
    </div>
  );
}
