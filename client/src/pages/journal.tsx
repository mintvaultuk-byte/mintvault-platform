import { useMemo, useState } from "react";
import { Link } from "wouter";
import { ArrowRight } from "lucide-react";
import HeaderV2 from "@/components/v2/header-v2";
import FooterV2 from "@/components/v2/footer-v2";
import SectionEyebrow from "@/components/v2/section-eyebrow";
import { guides } from "@/data/guides";

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export default function JournalV2() {
  const [search, setSearch] = useState("");

  const sorted = useMemo(
    () => [...guides].sort(
      (a, b) => new Date(b.publishedDate).getTime() - new Date(a.publishedDate).getTime()
    ),
    []
  );
  const featured = sorted[0];
  const rest = sorted.slice(1);

  const q = search.trim().toLowerCase();
  const filtered = q
    ? rest.filter(g =>
        g.title.toLowerCase().includes(q) || g.excerpt.toLowerCase().includes(q)
      )
    : rest;

  return (
    <div className="min-h-screen flex flex-col" style={{ backgroundColor: "var(--v2-paper)" }}>
      <HeaderV2 />

      {/* ── SECTION A: HERO ─────────────────────────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-paper)" }}>
        <div className="mx-auto max-w-5xl px-6 pt-12 md:pt-20 pb-10 md:pb-14">
          <p
            className="font-mono-v2 text-[10px] md:text-xs uppercase tracking-[0.25em] mb-6"
            style={{ color: "var(--v2-gold)" }}
          >
            Est. Kent &middot; Journal
          </p>
          <h1
            className="font-display italic font-medium leading-[0.95] mb-6"
            style={{ fontSize: "clamp(2.75rem, 6vw, 4.5rem)", color: "var(--v2-ink)" }}
          >
            Field notes on grading.<br />Written in Kent.
          </h1>
          <p
            className="font-body text-base md:text-lg leading-relaxed max-w-2xl"
            style={{ color: "var(--v2-ink-soft)" }}
          >
            Twenty guides on card condition, grading economics, submission logistics,
            and the MintVault process. Written for collectors, not for search engines.
          </p>
        </div>
      </section>

      {/* ── SECTION B: FEATURED ─────────────────────────────────────── */}
      {featured && (
        <section
          style={{
            backgroundColor: "var(--v2-paper-raised)",
            borderTop: "1px solid var(--v2-line)",
            borderBottom: "1px solid var(--v2-line)",
          }}
        >
          <div className="mx-auto max-w-5xl px-6 py-16 md:py-20">
            <SectionEyebrow numeral="I" label="Featured" className="mb-8" />
            <Link href={`/journal/${featured.slug}`} className="block group cursor-pointer">
              <div className="grid grid-cols-1 md:grid-cols-[1fr_1.6fr] gap-10 md:gap-16 items-center">
                {/* Left: copy */}
                <div>
                  <p className="font-mono-v2 text-[10px] uppercase tracking-widest" style={{ color: "var(--v2-ink-mute)" }}>
                    {formatDate(featured.publishedDate)}
                  </p>
                  <h2
                    className="font-display italic font-medium mt-3 leading-[1.05] group-hover:underline underline-offset-4"
                    style={{ fontSize: "clamp(2rem, 4vw, 3rem)", color: "var(--v2-ink)" }}
                  >
                    {featured.title}
                  </h2>
                  <p
                    className="font-body leading-relaxed mt-4 line-clamp-3"
                    style={{ color: "var(--v2-ink-soft)" }}
                  >
                    {featured.excerpt}
                  </p>
                  <p
                    className="font-mono-v2 text-[10px] uppercase tracking-widest mt-6 inline-flex items-center gap-2"
                    style={{ color: "var(--v2-gold)" }}
                  >
                    Read the guide <ArrowRight size={12} />
                  </p>
                </div>

                {/* Right: editorial visual block */}
                <div
                  className="relative w-full rounded-xl overflow-hidden"
                  style={{
                    backgroundColor: "var(--v2-panel-dark)",
                    border: "1px solid rgba(255,255,255,0.08)",
                    backgroundImage: "radial-gradient(circle at 30% 30%, rgba(212,175,55,0.15), transparent 65%)",
                    paddingBottom: "100%",
                  }}
                >
                  {/* Centered numeral — using grid for more reliable centering than flex */}
                  <div
                    className="absolute inset-0"
                    style={{
                      display: "grid",
                      placeItems: "center",
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        fontFamily: '"Fraunces", Georgia, serif',
                        fontStyle: "italic",
                        fontWeight: 500,
                        fontSize: "clamp(5rem, 14vw, 9rem)",
                        color: "rgba(212, 175, 55, 0.45)",
                        lineHeight: 1,
                        userSelect: "none",
                        pointerEvents: "none",
                      }}
                    >
                      01
                    </span>
                  </div>

                  {/* Bottom-left "FEATURED" label */}
                  <span
                    className="absolute bottom-5 left-5 font-mono-v2"
                    style={{
                      fontSize: "10px",
                      letterSpacing: "0.2em",
                      textTransform: "uppercase",
                      color: "rgba(255,255,255,0.55)",
                      pointerEvents: "none",
                    }}
                  >
                    Featured
                  </span>

                  {/* Top-right subtle marker */}
                  <span
                    className="absolute top-5 right-5 font-mono-v2"
                    style={{
                      fontSize: "9px",
                      letterSpacing: "0.3em",
                      textTransform: "uppercase",
                      color: "rgba(255,255,255,0.3)",
                      pointerEvents: "none",
                    }}
                  >
                    No.01
                  </span>
                </div>
              </div>
            </Link>
          </div>
        </section>
      )}

      {/* ── SECTION C: ARCHIVE ──────────────────────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-paper)" }}>
        <div className="mx-auto max-w-5xl px-6 py-16 md:py-24">
          <SectionEyebrow numeral="II" label="Archive" className="mb-4" />
          <h2
            className="font-display italic font-medium leading-tight"
            style={{ fontSize: "clamp(2rem, 4vw, 3rem)", color: "var(--v2-ink)" }}
          >
            All field notes.
          </h2>
          <p className="font-body leading-relaxed mt-2 mb-10" style={{ color: "var(--v2-ink-soft)" }}>
            Twenty guides, chronological.
          </p>

          <div className="mb-8 max-w-md">
            <input
              type="text"
              placeholder="Search guides…"
              aria-label="Search guides"
              className="w-full px-4 py-3 font-body text-sm outline-none"
              style={{
                border: "1px solid var(--v2-line)",
                backgroundColor: "var(--v2-paper)",
                borderRadius: "8px",
                color: "var(--v2-ink)",
              }}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          {filtered.length === 0 ? (
            <p className="text-center font-mono-v2 text-xs uppercase tracking-widest py-12" style={{ color: "var(--v2-ink-mute)" }}>
              No guides match that search.
            </p>
          ) : (
            <ul className="divide-y" style={{ borderColor: "var(--v2-line-soft)" }}>
              {filtered.map((g) => (
                <li key={g.slug}>
                  <Link
                    href={`/journal/${g.slug}`}
                    className="block py-6 md:py-8 group"
                  >
                    <div className="grid grid-cols-1 md:grid-cols-[140px_1fr_auto] gap-4 md:gap-8 md:items-baseline">
                      <p
                        className="font-mono-v2 text-[10px] uppercase tracking-widest"
                        style={{ color: "var(--v2-ink-mute)" }}
                      >
                        {formatDate(g.publishedDate).toUpperCase()}
                      </p>
                      <div>
                        <h3
                          className="font-display italic leading-snug group-hover:underline underline-offset-4"
                          style={{
                            fontSize: "clamp(1.25rem, 2.5vw, 1.5rem)",
                            color: "var(--v2-ink)",
                          }}
                        >
                          {g.title}
                        </h3>
                        <p
                          className="font-body text-sm mt-2 line-clamp-2 md:line-clamp-1 leading-relaxed"
                          style={{ color: "var(--v2-ink-soft)" }}
                        >
                          {g.excerpt}
                        </p>
                      </div>
                      <p
                        className="hidden md:inline-flex items-center gap-2 font-mono-v2 text-[10px] uppercase tracking-widest"
                        style={{ color: "var(--v2-ink-mute)" }}
                      >
                        Read <ArrowRight size={12} />
                      </p>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <FooterV2 />
    </div>
  );
}
