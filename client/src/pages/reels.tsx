/**
 * /reels — public archive of weekly grade-highlight reels.
 *
 * No auth, no PII. Reads /api/reels which only returns cert numbers,
 * grades, card names, and signed Segmind video URLs for cards that had a
 * successful generation. Stale Segmind URLs (>24h) will fail to play —
 * that's a known limitation, public viewers see the fallback poster.
 */

import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";

interface PublicReelCard {
  certNumber: string;
  grade: number | null;
  cardName: string | null;
  videoUrl: string;
}
interface PublicReel {
  date: string;
  generatedAt: string;
  caption: string;
  cardCount: number;
  successCount: number;
  thumbnailKey: string | null;
  cards: PublicReelCard[];
}

function fmtGrade(g: number | null): string {
  if (g == null) return "—";
  return g % 1 === 0 ? String(Math.trunc(g)) : String(g);
}
function fmtDate(s: string): string {
  try { return new Date(s).toLocaleDateString("en-GB", { dateStyle: "medium" }); }
  catch { return s; }
}

export default function ReelsPage() {
  const { data, isLoading } = useQuery<{ reels: PublicReel[] }>({
    queryKey: ["/api/reels"],
    queryFn: async () => (await fetch("/api/reels")).json(),
  });
  const reels = data?.reels ?? [];

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#ccc] px-4 py-12">
      <div className="max-w-5xl mx-auto">
        <header className="mb-10">
          <h1 className="text-2xl md:text-3xl font-black text-[#D4AF37] tracking-widest">WEEKLY HIGHLIGHTS</h1>
          <p className="mt-2 text-sm text-[#888]">
            Cinematic reveals of recently graded cards from the MintVault vault.
          </p>
        </header>

        {isLoading && <p className="text-[#888]">Loading…</p>}
        {!isLoading && reels.length === 0 && (
          <p className="text-[#888]">No reels published yet. Check back soon.</p>
        )}

        <div className="space-y-12">
          {reels.map((reel) => {
            const top = reel.cards[0];
            return (
              <section key={reel.date} className="border-t border-[#222] pt-8">
                <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
                  <h2 className="text-lg font-bold text-[#D4AF37]">{fmtDate(reel.generatedAt)}</h2>
                  <span className="text-xs uppercase tracking-widest text-[#666]">
                    {reel.cards.length} card{reel.cards.length === 1 ? "" : "s"}
                  </span>
                </div>
                {reel.caption && (
                  <p className="text-sm text-[#aaa] mb-4 italic">{reel.caption}</p>
                )}
                {top && (
                  <p className="text-xs text-[#888] mb-4">
                    Top card: <strong className="text-[#ccc]">{top.cardName ?? top.certNumber}</strong>
                    {top.grade != null && <> · grade <strong className="text-[#D4AF37]">{fmtGrade(top.grade)}</strong></>}
                  </p>
                )}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {reel.cards.map((c) => (
                    <article key={`${reel.date}-${c.certNumber}`}
                      className="bg-[#111] border border-[#D4AF3733] rounded-lg overflow-hidden">
                      <video
                        src={c.videoUrl}
                        controls
                        preload="none"
                        className="w-full aspect-square bg-black object-cover"
                      />
                      <div className="px-3 py-2 flex items-center justify-between text-xs">
                        <Link href={`/cert/${c.certNumber}`}
                          className="font-mono text-[#D4AF37] hover:underline">
                          {c.certNumber}
                        </Link>
                        <span className="text-[#aaa]">grade {fmtGrade(c.grade)}</span>
                      </div>
                      {c.cardName && (
                        <p className="px-3 pb-2 text-[11px] text-[#888] truncate">{c.cardName}</p>
                      )}
                    </article>
                  ))}
                </div>
              </section>
            );
          })}
        </div>

        <footer className="mt-16 text-center text-xs text-[#666]">
          <Link href="/submit" className="text-[#D4AF37] hover:underline">Submit your card</Link>
          {" · "}
          <Link href="/" className="hover:text-[#D4AF37]">Home</Link>
        </footer>
      </div>
    </div>
  );
}
