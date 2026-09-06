import { adminFetch } from "@/lib/queryClient";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, Download, Image, Loader2, RefreshCw, Search, Sparkles } from "lucide-react";
import {
  SOCIAL_STUDIO_BACKGROUNDS,
  SOCIAL_STUDIO_FORMAT_DIMENSIONS,
  SOCIAL_STUDIO_FORMAT_LABELS,
  buildSocialStudioDownloadFilename,
  buildSocialStudioCaption,
  buildSocialStudioHashtags,
  resolveAutoBackground,
  type SocialStudioBackgroundId,
  type SocialStudioFormat,
} from "@shared/social-studio";
import { useToast } from "@/hooks/use-toast";

interface SocialStudioCard {
  certNumber: string;
  cardName: string;
  setName: string | null;
  setNumber?: string | null;
  cardGame: string | null;
  grade: number | null;
  gradeLabel?: string | null;
  featured?: boolean;
  pinned?: boolean;
  marketingConsent?: boolean;
  submissionReference?: string | null;
  hasImage: boolean;
  autoBackground?: SocialStudioBackgroundId;
  caption?: string;
  hashtags?: string;
}

interface CardsResponse {
  cards: SocialStudioCard[];
}

interface BackgroundResponse {
  backgrounds: Array<{
    id: SocialStudioBackgroundId;
    label: string;
    variant: string | null;
    category: string;
    preview: string | null;
    staticOnly: boolean;
  }>;
}

const FORMATS: SocialStudioFormat[] = ["feed", "story", "reel-cover", "weekly-highlights"];

function formatSubcopy(format: SocialStudioFormat): string {
  if (format === "feed") return "1080 x 1080 image for grid posts.";
  if (format === "story") return "1080 x 1920 image for stories.";
  if (format === "reel-cover") return "Static 1080 x 1920 cover only.";
  return "Download individual branded assets; no stitched video.";
}

async function fetchSocialStudioImage(
  card: SocialStudioCard,
  format: SocialStudioFormat,
  background: SocialStudioBackgroundId
): Promise<Blob> {
  const res = await adminFetch("/api/admin/social-studio/render", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ certNumber: card.certNumber, format, background }),
  });
  if (!res.ok) throw new Error("Download failed");
  return res.blob();
}

async function downloadImage(card: SocialStudioCard, format: SocialStudioFormat, background: SocialStudioBackgroundId) {
  const blob = await fetchSocialStudioImage(card, format, background);
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = buildSocialStudioDownloadFilename(card, format);
  a.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
}

function SocialStudioImage({
  card,
  format,
  background,
  alt,
  className,
}: {
  card: SocialStudioCard;
  format: SocialStudioFormat;
  background: SocialStudioBackgroundId;
  alt: string;
  className: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    setSrc(null);
    setFailed(false);
    fetchSocialStudioImage(card, format, background)
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [card.certNumber, format, background]);

  if (failed) {
    return (
      <div className={`${className} flex items-center justify-center text-center text-xs text-red-200`}>
        Preview failed
      </div>
    );
  }
  if (!src) {
    return (
      <div className={`${className} flex items-center justify-center`}>
        <Loader2 className="h-5 w-5 animate-spin text-[var(--admin-gold-hi)]" />
      </div>
    );
  }
  return <img src={src} alt={alt} className={className} />;
}

export default function AdminSocialStudioPage() {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [selectedCerts, setSelectedCerts] = useState<string[]>([]);
  const [format, setFormat] = useState<SocialStudioFormat>("feed");
  const [background, setBackground] = useState<SocialStudioBackgroundId>("auto");
  const [caption, setCaption] = useState("");
  const [hashtags, setHashtags] = useState("");
  const [downloading, setDownloading] = useState(false);

  const cardsQ = useQuery<CardsResponse>({
    queryKey: ["/api/admin/social-studio/certificates", search],
    queryFn: async () => {
      const qs = search.trim() ? `?q=${encodeURIComponent(search.trim())}` : "";
      const res = await adminFetch(`/api/admin/social-studio/certificates${qs}`, { credentials: "include" });
      if (!res.ok) throw new Error("Unable to load Social Studio cards");
      return res.json();
    },
  });

  const backgroundsQ = useQuery<BackgroundResponse>({
    queryKey: ["/api/admin/social-studio/backgrounds"],
    queryFn: async () => {
      const res = await adminFetch("/api/admin/social-studio/backgrounds", { credentials: "include" });
      if (!res.ok) throw new Error("Unable to load Social Studio backgrounds");
      return res.json();
    },
  });

  const cards = cardsQ.data?.cards ?? [];
  const backgrounds =
    backgroundsQ.data?.backgrounds ??
    SOCIAL_STUDIO_BACKGROUNDS.map((bg) => ({
      ...bg,
      preview: null,
      staticOnly: true,
    }));
  const selectedCards = useMemo(
    () =>
      selectedCerts.map((cert) => cards.find((card) => card.certNumber === cert)).filter(Boolean) as SocialStudioCard[],
    [cards, selectedCerts]
  );
  const primaryCard = selectedCards[0] ?? null;
  const effectiveBackground = primaryCard && background === "auto" ? resolveAutoBackground(primaryCard) : background;

  useEffect(() => {
    if (!primaryCard) {
      setCaption("");
      setHashtags("");
      return;
    }
    setCaption(primaryCard.caption || buildSocialStudioCaption(primaryCard));
    setHashtags(primaryCard.hashtags || buildSocialStudioHashtags(primaryCard));
  }, [primaryCard?.certNumber]);

  const toggleCard = (card: SocialStudioCard) => {
    setSelectedCerts((current) => {
      if (current.includes(card.certNumber)) return current.filter((cert) => cert !== card.certNumber);
      return format === "weekly-highlights" ? [...current, card.certNumber].slice(0, 8) : [card.certNumber];
    });
  };

  const resetCaption = () => {
    if (!primaryCard) return;
    setCaption(primaryCard.caption || buildSocialStudioCaption(primaryCard));
    setHashtags(primaryCard.hashtags || buildSocialStudioHashtags(primaryCard));
  };

  const copyCaption = async () => {
    const text = [caption.trim(), hashtags.trim()].filter(Boolean).join("\n\n");
    if (!text) return;
    await navigator.clipboard.writeText(text);
    toast({ title: "Caption copied" });
  };

  const downloadCurrent = async () => {
    if (!primaryCard) return;
    setDownloading(true);
    try {
      if (format === "weekly-highlights") {
        for (const card of selectedCards) {
          await downloadImage(card, "weekly-highlights", background);
        }
      } else {
        await downloadImage(primaryCard, format, background);
      }
      toast({ title: "Download ready", description: "Caption remains editable and copyable." });
    } catch {
      toast({ title: "Download failed", description: "Please try again.", variant: "destructive" });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="admin-root min-h-screen">
      <div className="mx-auto max-w-7xl px-4 py-6 lg:px-8">
        <header className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.22em] text-[var(--admin-gold-hi)]">MintVault</p>
            <h1 className="text-3xl font-black text-[var(--admin-ink)]">Social Studio</h1>
            <p className="mt-1 max-w-3xl text-sm text-[var(--admin-ink-dim)]">
              Create premium feed posts, stories, static reel covers and weekly highlight asset packs. Download-first,
              static-only, with no publishing or AI provider calls.
            </p>
          </div>
          <a
            href="/admin/weekly-reel"
            className="inline-flex items-center justify-center rounded border border-[var(--admin-line)] px-3 py-2 text-xs font-semibold text-[var(--admin-ink-dim)] hover:border-[var(--admin-gold)]"
          >
            Advanced Reel Pipeline
          </a>
        </header>

        <div className="grid gap-6 lg:grid-cols-[420px_minmax(0,1fr)]">
          <section className="space-y-4">
            <div className="rounded-lg border border-[var(--admin-line)] bg-[var(--admin-panel)] p-4">
              <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-[var(--admin-ink-faint)]">
                Step 1 - Choose Card
              </h2>
              <label className="relative block">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--admin-ink-faint)]" />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search cert, card, set or submission"
                  className="h-10 w-full rounded border border-[var(--admin-line-hard)] bg-[var(--admin-panel2)] pl-9 pr-3 text-sm text-[var(--admin-ink)] outline-none focus:border-[var(--admin-gold)]"
                />
              </label>
              <div className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">
                {cardsQ.isLoading && (
                  <div className="flex items-center gap-2 text-sm text-[var(--admin-ink-dim)]">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading graded cards
                  </div>
                )}
                {cardsQ.isError && (
                  <p className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                    Unable to load eligible cards.
                  </p>
                )}
                {!cardsQ.isLoading && !cardsQ.isError && cards.length === 0 && (
                  <p className="rounded border border-[var(--admin-line)] bg-[var(--admin-panel2)] px-3 py-2 text-sm text-[var(--admin-ink-dim)]">
                    No graded cards with finished images are available.
                  </p>
                )}
                {cards.map((card) => {
                  const selected = selectedCerts.includes(card.certNumber);
                  return (
                    <button
                      key={card.certNumber}
                      type="button"
                      onClick={() => toggleCard(card)}
                      className={`w-full rounded border p-3 text-left transition ${
                        selected
                          ? "border-[var(--admin-gold)] bg-[var(--admin-panel3)]"
                          : "border-[var(--admin-line)] bg-[var(--admin-panel2)] hover:border-[var(--admin-gold)]"
                      }`}
                    >
                      <span className="flex items-center justify-between gap-3">
                        <span>
                          <span className="block text-sm font-bold text-[var(--admin-ink)]">{card.cardName}</span>
                          <span className="block text-xs text-[var(--admin-ink-dim)]">
                            {card.certNumber} {card.setName ? `- ${card.setName}` : ""}{" "}
                            {card.submissionReference ? `- ${card.submissionReference}` : ""}
                          </span>
                        </span>
                        <span className="text-right text-xs font-bold text-[var(--admin-gold-hi)]">
                          {card.grade ?? "Grade"}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="rounded-lg border border-[var(--admin-line)] bg-[var(--admin-panel)] p-4">
              <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-[var(--admin-ink-faint)]">
                Step 2 - Choose Format
              </h2>
              <div className="grid grid-cols-2 gap-2">
                {FORMATS.map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => {
                      setFormat(item);
                      if (item !== "weekly-highlights" && selectedCerts.length > 1)
                        setSelectedCerts(selectedCerts.slice(0, 1));
                    }}
                    className={`rounded border p-3 text-left ${
                      format === item
                        ? "border-[var(--admin-gold)] bg-[var(--admin-panel3)]"
                        : "border-[var(--admin-line)] bg-[var(--admin-panel2)]"
                    }`}
                  >
                    <span className="block text-sm font-bold text-[var(--admin-ink)]">
                      {SOCIAL_STUDIO_FORMAT_LABELS[item]}
                    </span>
                    <span className="mt-1 block text-xs text-[var(--admin-ink-dim)]">{formatSubcopy(item)}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-[var(--admin-line)] bg-[var(--admin-panel)] p-4">
              <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-[var(--admin-ink-faint)]">
                Step 3 - Choose Background
              </h2>
              <div className="grid grid-cols-3 gap-2">
                {backgrounds.map((bg) => {
                  const selected = background === bg.id;
                  return (
                    <button
                      key={bg.id}
                      type="button"
                      onClick={() => setBackground(bg.id)}
                      className={`overflow-hidden rounded border text-left ${
                        selected ? "border-[var(--admin-gold)]" : "border-[var(--admin-line)]"
                      }`}
                    >
                      <span className="block aspect-square bg-[var(--admin-panel2)]">
                        {bg.preview ? (
                          <img src={bg.preview} alt="" className="h-full w-full object-cover" loading="lazy" />
                        ) : (
                          <span className="flex h-full items-center justify-center">
                            <Sparkles className="h-6 w-6 text-[var(--admin-gold-hi)]" />
                          </span>
                        )}
                      </span>
                      <span className="block truncate px-2 py-1.5 text-xs font-semibold text-[var(--admin-ink)]">
                        {bg.label}
                      </span>
                    </button>
                  );
                })}
              </div>
              {primaryCard && (
                <p className="mt-2 text-xs text-[var(--admin-ink-dim)]">
                  Auto selected: <strong>{effectiveBackground}</strong>. Manual selection only changes this export.
                </p>
              )}
            </div>

            <div className="rounded-lg border border-[var(--admin-line)] bg-[var(--admin-panel)] p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-bold uppercase tracking-wide text-[var(--admin-ink-faint)]">
                  Step 4 - Caption
                </h2>
                <button
                  type="button"
                  onClick={resetCaption}
                  disabled={!primaryCard}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--admin-ink-dim)] disabled:opacity-40"
                >
                  <RefreshCw className="h-3 w-3" /> Reset Caption
                </button>
              </div>
              <textarea
                value={caption}
                onChange={(event) => setCaption(event.target.value)}
                disabled={!primaryCard}
                rows={7}
                className="w-full rounded border border-[var(--admin-line-hard)] bg-[var(--admin-panel2)] p-3 text-sm text-[var(--admin-ink)] outline-none focus:border-[var(--admin-gold)] disabled:opacity-50"
                placeholder="Select a card to create a caption."
              />
              <textarea
                value={hashtags}
                onChange={(event) => setHashtags(event.target.value)}
                disabled={!primaryCard}
                rows={3}
                className="mt-2 w-full rounded border border-[var(--admin-line-hard)] bg-[var(--admin-panel2)] p-3 text-sm text-[var(--admin-ink)] outline-none focus:border-[var(--admin-gold)] disabled:opacity-50"
                placeholder="#MintVault #TradingCards"
              />
            </div>
          </section>

          <section className="lg:sticky lg:top-4 lg:self-start">
            <div className="rounded-lg border border-[var(--admin-line)] bg-[var(--admin-panel)] p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-bold uppercase tracking-wide text-[var(--admin-ink-faint)]">
                    Step 5 - Preview & Download
                  </h2>
                  <p className="text-xs text-[var(--admin-ink-dim)]">
                    {SOCIAL_STUDIO_FORMAT_LABELS[format]} - {SOCIAL_STUDIO_FORMAT_DIMENSIONS[format].width} x{" "}
                    {SOCIAL_STUDIO_FORMAT_DIMENSIONS[format].height}
                  </p>
                </div>
                <div className="rounded border border-[var(--admin-line)] px-2 py-1 text-xs text-[var(--admin-green)]">
                  Static-only
                </div>
              </div>

              {!primaryCard ? (
                <div className="flex min-h-[420px] items-center justify-center rounded border border-dashed border-[var(--admin-line)] bg-[var(--admin-panel2)] text-center">
                  <div>
                    <Image className="mx-auto mb-3 h-10 w-10 text-[var(--admin-ink-faint)]" />
                    <p className="text-sm font-semibold text-[var(--admin-ink)]">Select a graded card to begin.</p>
                    <p className="mt-1 text-xs text-[var(--admin-ink-dim)]">
                      No customer card is selected automatically.
                    </p>
                  </div>
                </div>
              ) : format === "weekly-highlights" ? (
                <div className="grid grid-cols-2 gap-3">
                  {selectedCards.map((card) => (
                    <div key={card.certNumber} className="rounded border border-[var(--admin-line)] bg-black/40 p-2">
                      <SocialStudioImage
                        card={card}
                        format="weekly-highlights"
                        background={background}
                        alt={`${card.cardName} weekly highlight asset`}
                        className="aspect-square w-full rounded object-cover"
                      />
                      <p className="mt-2 truncate text-xs font-semibold text-[var(--admin-ink)]">{card.certNumber}</p>
                    </div>
                  ))}
                  {selectedCards.length === 0 && (
                    <p className="col-span-2 rounded border border-[var(--admin-line)] p-4 text-sm text-[var(--admin-ink-dim)]">
                      Select cards for the highlights pack.
                    </p>
                  )}
                </div>
              ) : (
                <div className="mx-auto max-w-[520px]">
                  <SocialStudioImage
                    card={primaryCard}
                    format={format}
                    background={background}
                    alt={`${primaryCard.cardName} ${SOCIAL_STUDIO_FORMAT_LABELS[format]} preview`}
                    className={`w-full rounded border border-[var(--admin-line)] bg-black object-cover ${
                      format === "feed" ? "aspect-square" : "aspect-[9/16]"
                    }`}
                  />
                </div>
              )}

              {format === "weekly-highlights" && (
                <p className="mt-3 rounded border border-[var(--admin-line)] bg-[var(--admin-panel2)] px-3 py-2 text-xs text-[var(--admin-ink-dim)]">
                  Weekly Highlights Pack downloads individual branded assets. It does not create one stitched weekly
                  reel.
                </p>
              )}

              <div className="sticky bottom-0 -mx-4 mt-4 flex flex-col gap-2 border-t border-[var(--admin-line)] bg-[var(--admin-panel)] px-4 py-4 sm:flex-row">
                <button
                  type="button"
                  onClick={downloadCurrent}
                  disabled={!primaryCard || downloading}
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded bg-[var(--admin-gold)] px-4 py-3 text-sm font-bold text-black disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                  Download {SOCIAL_STUDIO_FORMAT_LABELS[format]}
                </button>
                <button
                  type="button"
                  onClick={copyCaption}
                  disabled={!primaryCard || (!caption.trim() && !hashtags.trim())}
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded border border-[var(--admin-line-hard)] px-4 py-3 text-sm font-bold text-[var(--admin-ink)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Copy className="h-4 w-4" /> Copy Caption
                </button>
              </div>

              <div className="mt-3 grid gap-2 text-xs text-[var(--admin-ink-dim)] sm:grid-cols-3">
                <span className="inline-flex items-center gap-1">
                  <Check className="h-3 w-3 text-[var(--admin-green)]" /> No publishing
                </span>
                <span className="inline-flex items-center gap-1">
                  <Check className="h-3 w-3 text-[var(--admin-green)]" /> No AI generation
                </span>
                <span className="inline-flex items-center gap-1">
                  <Check className="h-3 w-3 text-[var(--admin-green)]" /> No provider credits
                </span>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
