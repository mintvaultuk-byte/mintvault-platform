/**
 * ShareStudio — share-image picker for the cert page.
 *
 * 56 AI background variants across 5 categories (Vault, Cosmic, Elements,
 * Weather, Nature). Category tab strip → thumbnail grid within the category
 * → large 1:1 preview from /api/public/share/:cert/:variant/feed. Download &
 * Share uses the native share sheet on mobile / download + caption-copy on
 * desktop.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Copy, Loader2 } from "lucide-react";
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

export default function ShareStudio({ certNumber, cardName, grade }: ShareStudioProps) {
  const { toast } = useToast();
  const [variants, setVariants] = useState<VariantMeta[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [variantsError, setVariantsError] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState("Vault");
  const [selectedId, setSelectedId] = useState("vault-gold");
  const [caption, setCaption] = useState("");
  const [downloading, setDownloading] = useState(false);
  const captionRef = useRef("");

  // Load variant catalogue + caption on mount
  useEffect(() => {
    fetch("/api/public/share-variants")
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d.variants) && d.variants.length > 0) {
          setVariants(d.variants);
          const cats: string[] =
            Array.isArray(d.categories) && d.categories.length
              ? d.categories
              : [...new Set(d.variants.map((v: VariantMeta) => v.category))];
          setCategories(cats);
          setSelectedCategory(cats[0] ?? "Vault");
          setSelectedId(d.variants[0].id);
        } else {
          setVariants([FALLBACK_VARIANT]);
          setCategories(["Vault"]);
          setVariantsError(true);
        }
      })
      .catch(() => {
        setVariants([FALLBACK_VARIANT]);
        setCategories(["Vault"]);
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

  const inCategory = useMemo(
    () => variants.filter((v) => v.category === selectedCategory),
    [variants, selectedCategory]
  );
  const current = variants.find((v) => v.id === selectedId) ?? FALLBACK_VARIANT;

  const feedUrl = (variantId: string) =>
    `/api/public/share/${certNumber}/${variantId}/feed?v=${encodeURIComponent(variantId)}`;

  const selectVariant = (id: string) => {
    if (id === selectedId) return;
    setSelectedId(id);
  };

  const selectCategory = (cat: string) => {
    setSelectedCategory(cat);
    const first = variants.find((v) => v.category === cat);
    if (first) selectVariant(first.id);
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

      // Only use the native share sheet when the browser can actually share
      // THIS file. Desktop Chrome exposes navigator.share but rejects files —
      // gating on canShare({ files }) makes it fall through to the download.
      const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
      if (typeof nav.share === "function" && nav.canShare && nav.canShare({ files: [file] })) {
        await nav.share({ files: [file], title: `${cardName} — MintVault Grade ${grade}`, text });
        return;
      }

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

  return (
    <div className="w-full">
      <h3 className="text-[#1A1A1A] text-sm font-bold uppercase tracking-wider mb-3">Share Your Certificate</h3>

      {/* Category tabs */}
      {categories.length > 1 && (
        <div className="flex gap-1 overflow-x-auto pb-2 -mx-1 px-1 mb-3">
          {categories.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => selectCategory(cat)}
              className={`shrink-0 px-3 py-1.5 text-xs font-medium whitespace-nowrap border-b-2 transition-colors ${
                selectedCategory === cat
                  ? "border-[#D4AF37] text-[#1A1A1A]"
                  : "border-transparent text-[#999] hover:text-[#555]"
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      )}

      {/* Large preview — single persistent img (no key, so it never remounts).
          On variant change the browser keeps showing the previous frame until
          the new src decodes, then swaps — no black gap, no skeleton re-flash. */}
      <div className="relative w-full aspect-square rounded-xl overflow-hidden bg-[#0A0A0A] border border-[#E8E4DC] mb-3">
        <img
          src={feedUrl(current.id)}
          alt={`${cardName} — ${current.name}`}
          className="w-full h-full object-cover transition-opacity duration-200"
        />
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-black/75 backdrop-blur-sm text-white text-xs font-medium px-3 py-1.5 rounded-full pointer-events-none z-10 whitespace-nowrap">
          {current.name}
        </div>
      </div>

      {/* Thumbnail grid (within category) */}
      <div className="grid grid-cols-4 gap-2 mb-4">
        {inCategory.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => selectVariant(v.id)}
            aria-label={v.name}
            className={`aspect-square rounded-lg overflow-hidden bg-[#0A0A0A] transition-all ${
              v.id === selectedId ? "ring-2 ring-[#D4AF37]" : "ring-1 ring-[#E8E4DC] hover:ring-[#D4AF37]/50"
            }`}
          >
            <img src={v.preview} alt={v.name} className="w-full h-full object-cover" loading="lazy" />
          </button>
        ))}
      </div>

      {variantsError && (
        <p className="text-center text-[#999] text-xs mb-3">Showing the default style — more styles couldn't load.</p>
      )}

      {/* CTAs */}
      <div className="space-y-2">
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
