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
    <div
      className="mx-auto w-full max-w-[280px] rounded-lg border border-slate-700 bg-slate-900/60 p-1.5"
      data-testid="certificate-preview-panel"
      data-preview-state={error ? "error" : url ? "ready" : loading ? "loading" : "empty"}
    >
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Live label preview
        </span>
        {loading && <span className="text-[10px] text-amber-400">rendering…</span>}
      </div>
      {url ? (
        <div
          className="overflow-hidden rounded border border-slate-800 bg-slate-950/40"
          data-testid="certificate-preview-frame"
        >
          {/* The real front slab label (826×236 @300DPI), displayed at its
              natural aspect ratio in a compact inspection thumbnail. */}
          <img
            src={url}
            alt="Front certificate preview"
            className="block h-auto w-full bg-white object-contain"
            data-testid="certificate-preview-image"
          />
        </div>
      ) : (
        <p
          className={`rounded border border-slate-800 px-2 py-1.5 text-center text-[11px] ${error ? "text-rose-300" : "text-slate-500"}`}
          data-testid="certificate-preview-status"
        >
          {error ?? (loading ? "Preparing preview…" : "Preview unavailable / preparing…")}
        </p>
      )}
      {/* Never claim persisted truth for unsaved state. The panel stays READ-ONLY
          in every case — it renders an image and persists nothing. */}
      <p
        className={`mt-1 text-[10px] ${persistence === "conflict" ? "text-amber-400" : "text-slate-500"}`}
        data-testid="certificate-preview-caption"
        data-persistence={persistence}
      >
        {persistence === "saved"
          ? "Saved review · authoritative print preview."
          : persistence === "conflict"
            ? "Not authoritative — refresh before trusting this preview."
            : "Save a grade to prepare Review."}
      </p>
    </div>
  );
}
