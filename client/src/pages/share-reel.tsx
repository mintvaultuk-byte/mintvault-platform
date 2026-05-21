/**
 * /share/reel/:date/:certNumber — public, shareable view of one card from
 * a weekly highlight reel. Designed for social previews (Open Graph meta
 * tags injected at runtime; for proper crawler-side OG you'd need an SSR
 * stub but most platforms render JS-injected meta for share previews
 * sufficiently well).
 */

import { useEffect } from "react";
import { Link, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";

interface ShareCard {
  date: string;
  certNumber: string;
  grade: number | null;
  cardName: string | null;
  videoUrl: string;
  caption: string;
}

function fmtGrade(g: number | null): string {
  if (g == null) return "—";
  return g % 1 === 0 ? String(Math.trunc(g)) : String(g);
}

function injectMeta(name: string, content: string) {
  if (!content) return;
  // property= for OG, name= for twitter. Try both keys defensively.
  for (const attr of ["property", "name"]) {
    const sel = `meta[${attr}="${name}"]`;
    let tag = document.head.querySelector<HTMLMetaElement>(sel);
    if (!tag) {
      tag = document.createElement("meta");
      tag.setAttribute(attr, name);
      document.head.appendChild(tag);
    }
    tag.setAttribute("content", content);
  }
}

export default function ShareReelPage() {
  const params = useParams<{ date: string; certNumber: string }>();
  const date = params.date;
  const certNumber = params.certNumber;

  const { data, isLoading, error } = useQuery<ShareCard>({
    queryKey: ["/api/reels/", date, certNumber],
    queryFn: async () => {
      const r = await fetch(`/api/reels/${encodeURIComponent(date)}/${encodeURIComponent(certNumber)}`);
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    },
    enabled: !!date && !!certNumber,
  });

  useEffect(() => {
    if (!data) return;
    const title = `${data.cardName ?? data.certNumber} — graded ${fmtGrade(data.grade)} · MintVault`;
    const desc = `Featured in MintVault's weekly highlight reel.${data.caption ? ` ${data.caption}` : ""}`;
    document.title = title;
    injectMeta("og:title", title);
    injectMeta("og:description", desc);
    injectMeta("og:type", "video.other");
    injectMeta("og:video", data.videoUrl);
    injectMeta("twitter:card", "player");
    injectMeta("twitter:title", title);
    injectMeta("twitter:description", desc);
  }, [data]);

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#ccc] px-4 py-12">
      <div className="max-w-2xl mx-auto">
        <header className="mb-6 text-center">
          <Link href="/" className="text-[#D4AF37] tracking-widest font-black text-xl">MINTVAULT UK</Link>
        </header>

        {isLoading && <p className="text-[#888] text-center">Loading…</p>}
        {error && <p className="text-red-700 text-center">Card not found in this reel.</p>}

        {data && (
          <article className="bg-[#111] border border-[#D4AF37] rounded-lg overflow-hidden">
            <video
              src={data.videoUrl}
              controls
              autoPlay
              playsInline
              preload="auto"
              className="w-full aspect-square bg-black object-cover"
            />
            <div className="p-5">
              <h1 className="text-lg font-bold text-[#D4AF37]">
                {data.cardName ?? data.certNumber}
              </h1>
              <p className="mt-1 text-sm text-[#aaa]">
                Certificate <span className="font-mono">{data.certNumber}</span>
                {data.grade != null && <> · grade <strong className="text-[#D4AF37]">{fmtGrade(data.grade)}</strong></>}
              </p>
              {data.caption && (
                <p className="mt-3 text-sm text-[#888] italic">{data.caption}</p>
              )}
              <div className="mt-5 flex flex-col sm:flex-row gap-2">
                <Link href={`/cert/${data.certNumber}`}
                  className="text-center text-sm font-bold uppercase tracking-wider px-4 py-2.5 rounded-lg bg-gradient-to-r from-[#D4AF37] to-[#B8960C] text-[#1A1400] hover:opacity-90">
                  View Certificate
                </Link>
                <Link href="/submit"
                  className="text-center text-sm font-bold uppercase tracking-wider px-4 py-2.5 rounded-lg bg-white/5 border border-[#D4AF37] text-[#D4AF37] hover:bg-white/10">
                  Submit Your Card
                </Link>
              </div>
            </div>
          </article>
        )}

        <footer className="mt-10 text-center text-xs text-[#666]">
          <Link href="/reels" className="hover:text-[#D4AF37]">More highlights</Link>
        </footer>
      </div>
    </div>
  );
}
