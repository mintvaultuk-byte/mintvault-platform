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
  /** Server-supplied "this card simply isn't ready yet" wording (HTTP 422). Held
   *  separately from `error` so a routine ungraded card is never presented as a fault. */
  const [notReady, setNotReady] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const urlRef = useRef<string | null>(null);
  const key = JSON.stringify(fields);

  useEffect(() => {
    if (requireExpectedRevision && expectedRevision == null) {
      setLoading(false);
      setError(null);
      setNotReady(null);
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
      setNotReady(null);
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
          // An UNGRADED card is not a failure. The server answers 422 with concise,
          // grader-facing wording ("Not graded yet — the preview appears once a grade
          // is set."), and this panel used to discard it and render the generic
          // "Preview unavailable · Retry" instead. On production 125 of 836
          // certificates are numeric-but-ungraded, so a routine, expected state was
          // being shown to graders as a system fault. Surface the server's own words
          // for that case; every genuine fault keeps the unavailable/Retry control.
          if (res.status === 422 && typeof data.error === "string" && data.error) {
            setNotReady(data.error);
            setLoading(false);
            complete(false);
            return;
          }
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
  }, [
    endpoint,
    expectedRevision,
    key,
    requireExpectedRevision,
    revision,
    onRevisionComplete,
    requestTimeoutMs,
    retryNonce,
  ]);

  // Revoke the last object URL on unmount.
  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    []
  );

  return (
    // 190px (was 230px). The certificate is a print-layout REFERENCE, not the primary
    // object. DISPLAY WIDTH ONLY: server label dimensions, print resolution and the
    // certificate document output are all untouched.
    //
    // RESERVED, STATE-INDEPENDENT HEIGHT — owner evidence 2026-08-16 (MV360, /staff).
    // Two consecutive real screenshots showed the card fully visible while the preview
    // was not ready, then the card's bottom cut off the moment the preview rendered.
    // Cause: this panel's height depended on its STATE. Empty/not-ready occupied almost
    // nothing, so the sibling card slot (`min-h-0 flex-1`) claimed that space and sized
    // the card to it; when the PNG arrived the panel grew, the card slot shrank, and the
    // card — already laid out larger — was clipped by the host's overflow-hidden.
    //
    // Pinning the printed label's own 827x236 ratio makes the box identical in every
    // state (empty, loading, not-ready, error, ready), so the certificate reserves its
    // space BEFORE the card is sized and the card never jumps or clips when the preview
    // resolves. A slightly smaller card that is wholly visible beats a larger one that
    // is cut off.
    <div
      className="mx-auto w-full max-w-[190px]"
      style={{ aspectRatio: "827 / 236" }}
      data-testid="certificate-preview-panel"
      data-preview-state={error ? "error" : notReady ? "not-ready" : url ? "ready" : loading ? "loading" : "empty"}
      data-preview-presentation={url ? "bare-image" : error ? "error" : loading ? "loading" : "empty"}
      data-persistence={persistence}
    >
      {url ? (
        /* The real front slab label (826×236 @300DPI), shown as a bare,
           fixed-ratio visual reference beneath the primary card viewer. */
        <img
          src={url}
          alt="Front certificate preview"
          width={231}
          height={66}
          className="block h-auto w-full object-contain"
          data-testid="certificate-preview-image"
        />
      ) : notReady ? (
        /* Informational, not a fault: the server told us this card has no grade yet.
           Its own concise wording is shown verbatim, with no Retry control — retrying
           cannot help; grading the card is what makes the preview appear. */
        <p
          className="text-center text-[11px] text-[var(--admin-ink-faint)]"
          data-testid="certificate-preview-status"
          aria-live="polite"
        >
          {notReady}
        </p>
      ) : error ? (
        <button
          type="button"
          className="mx-auto block text-[11px] text-rose-300 underline-offset-2 hover:underline"
          data-testid="certificate-preview-status"
          aria-label="Retry certificate preview"
          onClick={() => {
            setError(null);
            setNotReady(null);
            setLoading(true);
            setRetryNonce((nonce) => nonce + 1);
          }}
        >
          Preview unavailable · Retry
        </button>
      ) : (
        loading && (
          <p
            className="text-center text-[11px] text-slate-500"
            data-testid="certificate-preview-status"
            aria-live="polite"
          >
            Preparing preview…
          </p>
        )
      )}
    </div>
  );
}
