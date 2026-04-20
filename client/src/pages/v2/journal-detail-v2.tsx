import { useMemo } from "react";
import { Link, useParams } from "wouter";
import { ArrowLeft, ArrowRight } from "lucide-react";
import HeaderV2 from "@/components/v2/header-v2";
import FooterV2 from "@/components/v2/footer-v2";
import SectionEyebrow from "@/components/v2/section-eyebrow";
import { guides, getGuideBySlug, type Guide } from "@/data/guides";

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

// Remove v1-palette class attributes from body HTML and rewrite v1 `/guides/`
// hrefs to `/v2-journal/`. Then inject stable IDs onto H2 tags so anchors work.
function sanitizeBody(html: string): string {
  return html
    .replace(/\sclass="[^"]*"/gi, "")
    .replace(/href="\/guides\/([^"]+)"/gi, 'href="/v2-journal/$1"')
    .replace(/<h2([^>]*)>(.*?)<\/h2>/gi, (_match, attrs, content) => {
      const text = String(content).replace(/<[^>]*>/g, "");
      const id = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      return `<h2${attrs} id="${id}">${content}</h2>`;
    });
}

// Published-date-adjacent: closest N by |publishedDate delta|, excluding self.
function getDateAdjacent(slug: string, count = 3): Guide[] {
  const current = guides.find(g => g.slug === slug);
  if (!current) return [];
  const currentMs = new Date(current.publishedDate).getTime();
  return guides
    .filter(g => g.slug !== slug)
    .map(g => ({ g, delta: Math.abs(new Date(g.publishedDate).getTime() - currentMs) }))
    .sort((a, b) => a.delta - b.delta)
    .slice(0, count)
    .map(x => x.g);
}

const PROSE_CSS = `
  .mv-prose h2 {
    font-family: "Fraunces", Georgia, serif;
    font-style: italic;
    font-weight: 500;
    font-size: clamp(1.5rem, 3vw, 2rem);
    line-height: 1.15;
    color: var(--v2-ink);
    margin-top: 2.5rem;
    margin-bottom: 1rem;
  }
  .mv-prose h2:first-child { margin-top: 0; }
  .mv-prose h3 {
    font-family: "Fraunces", Georgia, serif;
    font-style: italic;
    font-weight: 500;
    font-size: 1.25rem;
    line-height: 1.25;
    color: var(--v2-ink);
    margin-top: 2rem;
    margin-bottom: 0.75rem;
  }
  .mv-prose p {
    font-family: "Geist Variable", "Geist", system-ui, sans-serif;
    font-size: 1rem;
    line-height: 1.75;
    color: var(--v2-ink-soft);
    margin-bottom: 1.25rem;
  }
  .mv-prose p:last-child { margin-bottom: 0; }
  .mv-prose ul, .mv-prose ol {
    margin: 1.25rem 0;
    padding-left: 1.5rem;
    color: var(--v2-ink-soft);
    font-family: "Geist Variable", "Geist", system-ui, sans-serif;
    font-size: 1rem;
    line-height: 1.75;
  }
  .mv-prose li { margin-bottom: 0.5rem; }
  .mv-prose a {
    color: var(--v2-gold);
    text-decoration: underline;
    text-underline-offset: 3px;
    text-decoration-thickness: 1px;
    transition: opacity 0.15s;
  }
  .mv-prose a:hover { opacity: 0.7; }
  .mv-prose strong { color: var(--v2-ink); font-weight: 600; }
  .mv-prose em { font-style: italic; }
  .mv-prose blockquote {
    border-left: 2px solid var(--v2-gold-soft);
    padding-left: 1.25rem;
    margin: 1.5rem 0;
    font-style: italic;
    color: var(--v2-ink);
  }
  .mv-prose code {
    font-family: var(--v2-font-mono), monospace;
    font-size: 0.875em;
    background: var(--v2-paper-raised);
    padding: 0.125rem 0.375rem;
    border-radius: 3px;
    color: var(--v2-ink);
  }
`;

export default function JournalDetailV2() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug || "";
  const guide = getGuideBySlug(slug);

  const sanitizedBody = useMemo(
    () => (guide ? sanitizeBody(guide.body) : ""),
    [guide]
  );
  const related = useMemo(() => (guide ? getDateAdjacent(guide.slug) : []), [guide]);

  // ── 404 fallback ──
  if (!guide) {
    return (
      <div className="min-h-screen flex flex-col" style={{ backgroundColor: "var(--v2-paper)" }}>
        <HeaderV2 />
        <section style={{ backgroundColor: "var(--v2-paper)" }}>
          <div className="mx-auto max-w-2xl px-6 py-32 text-center">
            <h1
              className="font-display italic"
              style={{ fontSize: "clamp(2rem, 4vw, 2.75rem)", color: "var(--v2-ink)" }}
            >
              Guide not found.
            </h1>
            <p className="font-body mt-4" style={{ color: "var(--v2-ink-soft)" }}>
              The piece you&rsquo;re looking for doesn&rsquo;t exist or has been moved.
            </p>
            <Link
              href="/v2-journal"
              className="inline-flex items-center gap-2 font-body text-sm font-semibold no-underline px-6 py-3 rounded-full mt-8 transition-all hover:scale-[1.03]"
              style={{ backgroundColor: "var(--v2-gold)", color: "var(--v2-panel-dark)" }}
            >
              Back to journal <ArrowRight size={14} />
            </Link>
          </div>
        </section>
        <FooterV2 />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ backgroundColor: "var(--v2-paper)" }}>
      <style>{PROSE_CSS}</style>
      <HeaderV2 />

      {/* ── SECTION A: BACK LINK ───────────────────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-paper)" }}>
        <div className="mx-auto max-w-3xl px-6 pt-8 md:pt-12">
          <Link
            href="/v2-journal"
            className="inline-flex items-center gap-2 font-mono-v2 text-[10px] uppercase tracking-widest"
            style={{ color: "var(--v2-ink-mute)" }}
          >
            <ArrowLeft size={12} /> All field notes
          </Link>
        </div>
      </section>

      {/* ── SECTION B: HEADER ──────────────────────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-paper)" }}>
        <div className="mx-auto max-w-3xl px-6 pt-6 md:pt-8 pb-10">
          <p
            className="font-mono-v2 text-[10px] uppercase tracking-[0.25em]"
            style={{ color: "var(--v2-gold)" }}
          >
            Journal &middot; {formatDate(guide.publishedDate)}
          </p>
          <h1
            className="font-display italic font-medium mt-4 leading-[1.02]"
            style={{ fontSize: "clamp(2.25rem, 5vw, 3.75rem)", color: "var(--v2-ink)" }}
          >
            {guide.title}
          </h1>
          <p
            className="font-body text-base md:text-lg leading-relaxed mt-5 max-w-xl"
            style={{ color: "var(--v2-ink-soft)" }}
          >
            {guide.excerpt}
          </p>
          <div
            className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 font-mono-v2 text-[10px] uppercase tracking-widest"
            style={{ color: "var(--v2-ink-mute)" }}
          >
            <span>By {guide.author}</span>
            <span aria-hidden="true">&middot;</span>
            <span>
              {guide.updatedDate
                ? `Updated ${formatDate(guide.updatedDate)}`
                : `Published ${formatDate(guide.publishedDate)}`}
            </span>
          </div>
        </div>
      </section>

      {/* ── SECTION C: BODY ────────────────────────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-paper)" }}>
        <div className="mx-auto max-w-3xl px-6 pb-16 md:pb-24">
          <article
            className="mv-prose"
            dangerouslySetInnerHTML={{ __html: sanitizedBody }}
          />
        </div>
      </section>

      {/* ── SECTION D: RELATED ─────────────────────────────────────── */}
      {related.length > 0 && (
        <section
          style={{
            backgroundColor: "var(--v2-paper-raised)",
            borderTop: "1px solid var(--v2-line)",
          }}
        >
          <div className="mx-auto max-w-5xl px-6 py-16 md:py-24">
            <SectionEyebrow numeral="II" label="Also in the journal" className="mb-4" />
            <h2
              className="font-display italic leading-tight mb-10"
              style={{ fontSize: "clamp(1.5rem, 3vw, 2rem)", color: "var(--v2-ink)" }}
            >
              Nearby in time.
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {related.map((r) => (
                <Link
                  key={r.slug}
                  href={`/v2-journal/${r.slug}`}
                  className="block p-6 rounded-xl transition-all hover:scale-[1.015] group"
                  style={{
                    backgroundColor: "var(--v2-paper)",
                    border: "1px solid var(--v2-line)",
                  }}
                >
                  <p
                    className="font-mono-v2 text-[10px] uppercase tracking-widest"
                    style={{ color: "var(--v2-ink-mute)" }}
                  >
                    {formatDate(r.publishedDate).toUpperCase()}
                  </p>
                  <h3
                    className="font-display italic mt-3 leading-snug group-hover:underline underline-offset-4"
                    style={{ fontSize: "1.125rem", color: "var(--v2-ink)" }}
                  >
                    {r.title}
                  </h3>
                  <p
                    className="font-body text-sm mt-2 line-clamp-2 leading-relaxed"
                    style={{ color: "var(--v2-ink-soft)" }}
                  >
                    {r.excerpt}
                  </p>
                  <p
                    className="mt-4 inline-flex items-center gap-2 font-mono-v2 text-[10px] uppercase tracking-widest"
                    style={{ color: "var(--v2-gold)" }}
                  >
                    Read <ArrowRight size={12} />
                  </p>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}

      <FooterV2 />
    </div>
  );
}
