/**
 * ShareStudio — 20-variant share-image picker for the cert page.
 *
 * Replaces the basic ShareButton. Carousel of AI background variants
 * (arrows + dots), live preview from /api/public/share/:cert/:variant/feed,
 * adjacent-variant preload, and a Download & Share CTA that uses the native
 * share sheet on mobile / download + caption-copy on desktop.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, Copy, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface ShareStudioProps {
  certNumber: string;
  cardName: string;
  grade: number;
  tier: string;
}

interface VariantMeta {
  id: string;
  name: string;
  category: string;
  preview: string;
}

const FALLBACK_VARIANT: VariantMeta = {
  id: "vault-gold",
  name: "Vault · Gold",
  category: "Vault",
  preview: "/api/public/share-bg/vault-gold",
};

export default function ShareStudio({ certNumber, cardName, grade, tier }: ShareStudioProps) {
  const { toast } = useToast();
  const [variants, setVariants] = useState<VariantMeta[]>([]);
  const [variantsError, setVariantsError] = useState(false);
  const [index, setIndex] = useState(0);
  const [caption, setCaption] = useState("");
  const [previewLoading, setPreviewLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const captionRef = useRef("");

  // Load variant catalogue + caption on mount
  useEffect(() => {
    fetch("/api/public/share-variants")
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d.variants) && d.variants.length > 0) setVariants(d.variants);
        else {
          setVariants([FALLBACK_VARIANT]);
          setVariantsError(true);
        }
      })
      .catch(() => {
        setVariants([FALLBACK_VARIANT]);
        setVariantsError(true);
      });

    fetch(`/api/public/share/${certNumber}/caption`)
      .then((r) => r.json())
      .then((d) => {
        const text = d.caption ? `${d.caption}${d.hashtags ? `\n\n${d.hashtags}` : ""}` : "";
        setCaption(text);
        captionRef.current = text;
      })
      .catch(() => {});
  }, [certNumber]);

  const current = variants[index] ?? FALLBACK_VARIANT;
  const feedUrl = (variantId: string) => `/api/public/share/${certNumber}/${variantId}/feed`;

  // Preload adjacent variant previews
  const adjacent = useMemo(() => {
    if (variants.length < 2) return [];
    const prev = variants[(index - 1 + variants.length) % variants.length];
    const next = variants[(index + 1) % variants.length];
    return [prev, next].filter(Boolean);
  }, [variants, index]);

  const go = (delta: number) => {
    if (variants.length === 0) return;
    setPreviewLoading(true);
    setIndex((i) => (i + delta + variants.length) % variants.length);
  };

  const handleDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const res = await fetch(feedUrl(current.id));
      if (!res.ok) throw new Error(`Image ${res.status}`);
      const blob = await res.blob();
      const file = new File([blob], `mintvault-${certNumber}.jpg`, { type: "image/jpeg" });
      const text = captionRef.current;

      // Mobile: native share sheet (image + caption)
      const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
      if (nav.canShare?.({ files: [file] })) {
        await nav.share({ files: [file], title: `${cardName} — MintVault Grade ${grade}`, text });
        return;
      }

      // Desktop: download + copy caption
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `mintvault-${certNumber}.jpg`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      if (text) {
        try {
          await navigator.clipboard.writeText(text);
          toast({ title: "Caption copied!", description: "Image downloaded — caption is on your clipboard." });
        } catch {
          toast({ title: "Image downloaded", description: "Open Instagram → New Post → select the image." });
        }
      } else {
        toast({ title: "Image downloaded" });
      }
    } catch (err) {
      console.warn("[ShareStudio] download failed:", err);
      toast({ title: "Couldn't generate that image", description: "Please try again.", variant: "destructive" });
    } finally {
      setDownloading(false);
    }
  };

  const handleCopyCaption = async () => {
    if (!captionRef.current) return;
    try {
      await navigator.clipboard.writeText(captionRef.current);
      toast({ title: "Copied!" });
    } catch {
      toast({
        title: "Clipboard blocked",
        description: "Your browser blocked clipboard access.",
        variant: "destructive",
      });
    }
  };

  // Dots — max 5 visible, windowed around the current index
  const dotWindow = useMemo(() => {
    const max = 5;
    if (variants.length <= max) return variants.map((_, i) => i);
    let start = Math.max(0, index - 2);
    if (start + max > variants.length) start = variants.length - max;
    return Array.from({ length: max }, (_, i) => start + i);
  }, [variants, index]);

  return (
    <div className="w-full">
      <h3 className="text-[#1A1A1A] text-sm font-bold uppercase tracking-wider mb-3">Share Your Certificate</h3>

      {/* Carousel */}
      <div className="relative">
        <div className="relative w-full aspect-square rounded-xl overflow-hidden bg-[#0A0A0A] border border-[#E8E4DC]">
          {/* Loading skeleton */}
          {previewLoading && (
            <div className="absolute inset-0 bg-gradient-to-br from-[#111] to-[#1a1408] animate-pulse" />
          )}
          <img
            key={current.id}
            src={feedUrl(current.id)}
            alt={`${cardName} — ${current.name}`}
            className="w-full h-full object-cover transition-opacity duration-300"
            style={{ opacity: previewLoading ? 0 : 1 }}
            onLoad={() => setPreviewLoading(false)}
            onError={() => setPreviewLoading(false)}
          />
          {/* Variant name pill — clear feedback when cycling styles */}
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-black/75 backdrop-blur-sm text-white text-xs font-medium px-3 py-1.5 rounded-full pointer-events-none z-10 whitespace-nowrap">
            {current.name}
          </div>
          {/* Hidden adjacent preloads */}
          {adjacent.map((v) => (
            <img key={`pre-${v.id}`} src={feedUrl(v.id)} alt="" className="hidden" aria-hidden />
          ))}
        </div>

        {variants.length > 1 && (
          <>
            <button
              type="button"
              onClick={() => go(-1)}
              aria-label="Previous style"
              className="absolute left-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-black/60 hover:bg-black/80 text-white flex items-center justify-center transition-colors"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button
              type="button"
              onClick={() => go(1)}
              aria-label="Next style"
              className="absolute right-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-black/60 hover:bg-black/80 text-white flex items-center justify-center transition-colors"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </>
        )}
      </div>

      {/* Variant name */}
      <p className="text-center text-[#555] text-sm font-medium mt-3">{current.name}</p>

      {/* Dots */}
      {variants.length > 1 && (
        <div className="flex items-center justify-center gap-2 mt-2">
          {dotWindow.map((i) => (
            <button
              key={i}
              type="button"
              aria-label={`Style ${i + 1}`}
              onClick={() => {
                setPreviewLoading(true);
                setIndex(i);
              }}
              className={`h-2 rounded-full transition-all ${i === index ? "w-5 bg-[#D4AF37]" : "w-2 bg-[#D4AF37]/30"}`}
            />
          ))}
        </div>
      )}

      {variantsError && (
        <p className="text-center text-[#999] text-xs mt-2">Showing the default style — more styles couldn't load.</p>
      )}

      {/* CTAs */}
      <div className="mt-4 space-y-2">
        <button
          type="button"
          onClick={handleDownload}
          disabled={downloading}
          className="w-full flex items-center justify-center gap-2 bg-[#D4AF37] hover:bg-[#B8960C] text-[#1A1400] font-bold text-sm uppercase tracking-wider px-6 py-3 rounded-lg transition-colors disabled:opacity-60"
        >
          {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          Download &amp; Share
        </button>
        <button
          type="button"
          onClick={handleCopyCaption}
          className="w-full flex items-center justify-center gap-2 border border-[#E8E4DC] hover:border-[#D4AF37]/50 text-[#555] text-sm px-6 py-2.5 rounded-lg transition-colors"
        >
          <Copy className="w-3.5 h-3.5" /> Copy Caption
        </button>
      </div>

      {caption && (
        <p className="text-[#999] text-xs mt-3 leading-relaxed line-clamp-3 whitespace-pre-line">{caption}</p>
      )}

      <div className="border-t border-[#E8E4DC] mt-3 pt-3">
        <p className="text-[#B8960C] text-xs text-center">Tag @mintvaultuk to be featured on our community wall</p>
      </div>
    </div>
  );
}
