/**
 * ShareButton — Instagram share actions for the public cert page.
 *
 * "Share on Instagram" downloads the 1080×1080 feed image and copies the
 * caption+hashtags to the clipboard in one tap; "Share as Story" does the
 * same with the 1080×1920 story render; "Copy Caption" is caption-only.
 * Images come from /api/public/share/:cert/{feed|story} (server-rendered,
 * R2-cached).
 */
import { useState } from "react";

interface ShareButtonProps {
  certNumber: string;
  cardName: string;
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function fetchCaption(certNumber: string): Promise<string | null> {
  try {
    const r = await fetch(`/api/public/share/${certNumber}/caption`);
    if (!r.ok) return null;
    const j = (await r.json()) as { caption: string; hashtags: string };
    return `${j.caption}\n\n${j.hashtags}`;
  } catch {
    return null;
  }
}

export default function ShareButton({ certNumber, cardName }: ShareButtonProps) {
  const [loading, setLoading] = useState<"feed" | "story" | null>(null);
  const [copied, setCopied] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function shareImage(format: "feed" | "story") {
    if (loading) return;
    setLoading(format);
    setError(null);
    setDownloaded(false);
    try {
      const [imageRes, captionText] = await Promise.all([
        fetch(`/api/public/share/${certNumber}/${format}`),
        fetchCaption(certNumber),
      ]);
      if (!imageRes.ok) throw new Error(`Image generation failed (${imageRes.status})`);
      const blob = await imageRes.blob();
      triggerDownload(blob, `MintVault-${certNumber}-certified.jpg`);
      if (captionText) {
        try {
          await navigator.clipboard.writeText(captionText);
        } catch {
          /* clipboard may be blocked — download still succeeded */
        }
      }
      setDownloaded(true);
      setTimeout(() => setDownloaded(false), 5000);
    } catch (err) {
      console.warn("[ShareButton] share failed:", err);
      setError("Couldn't generate the share image. Please try again.");
    } finally {
      setLoading(null);
    }
  }

  async function copyCaption() {
    setError(null);
    const text = await fetchCaption(certNumber);
    if (!text) {
      setError("Couldn't load the caption. Please try again.");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Clipboard blocked by the browser.");
    }
  }

  const spinner = (
    <span
      aria-hidden
      style={{
        width: 14,
        height: 14,
        borderRadius: "50%",
        border: "2px solid rgba(12,12,10,0.3)",
        borderTopColor: "#0c0c0a",
        display: "inline-block",
        animation: "mv-share-spin 0.8s linear infinite",
      }}
    />
  );

  return (
    <div style={{ width: "100%" }}>
      <style>{`@keyframes mv-share-spin { to { transform: rotate(360deg) } }`}</style>

      {/* Primary: feed image */}
      <button
        type="button"
        onClick={() => shareImage("feed")}
        disabled={loading !== null}
        aria-label={`Share ${cardName} on Instagram`}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          background: "#D4AF37",
          color: "#0c0c0a",
          fontWeight: 700,
          fontSize: 15,
          border: "none",
          borderRadius: 8,
          padding: "14px 24px",
          cursor: loading ? "wait" : "pointer",
          opacity: loading && loading !== "feed" ? 0.6 : 1,
        }}
      >
        {loading === "feed" ? (
          spinner
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <rect x="2" y="2" width="20" height="20" rx="5" />
            <circle cx="12" cy="12" r="4.5" />
            <circle cx="17.5" cy="6.5" r="1.2" fill="currentColor" stroke="none" />
          </svg>
        )}
        {downloaded ? "Image downloaded + caption copied!" : "Share on Instagram"}
      </button>

      {/* Secondary row */}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button
          type="button"
          onClick={() => shareImage("story")}
          disabled={loading !== null}
          style={{
            flex: 1,
            background: "transparent",
            border: "1px solid rgba(0,0,0,0.15)",
            color: "rgba(0,0,0,0.6)",
            borderRadius: 8,
            padding: "10px 16px",
            fontSize: 13,
            cursor: loading ? "wait" : "pointer",
          }}
        >
          {loading === "story" ? "Preparing…" : "Share as Story"}
        </button>
        <button
          type="button"
          onClick={copyCaption}
          style={{
            flex: 1,
            background: "transparent",
            border: "1px solid rgba(0,0,0,0.15)",
            color: "rgba(0,0,0,0.6)",
            borderRadius: 8,
            padding: "10px 16px",
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          {copied ? "Copied!" : "Copy Caption"}
        </button>
      </div>

      {error && (
        <p style={{ fontSize: 12, color: "#ef4444", marginTop: 8, marginBottom: 0 }} role="alert">
          {error}
        </p>
      )}

      <p style={{ fontSize: 11, color: "rgba(0,0,0,0.4)", lineHeight: 1.5, marginTop: 10, marginBottom: 0 }}>
        Image downloads to your camera roll. Open Instagram → New Post → select the image. Caption is already copied.
      </p>
    </div>
  );
}
