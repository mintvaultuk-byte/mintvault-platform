import { Link } from "wouter";
import { ArrowRight } from "lucide-react";
import HeaderV2 from "@/components/v2/header-v2";
import FooterV2 from "@/components/v2/footer-v2";
import SectionEyebrow from "@/components/v2/section-eyebrow";
import HeroSlabFan, { type SlabContent } from "@/components/v2/hero-slab";

// ── Steps (Section I) ──────────────────────────────────────────────────────

const STEPS = [
  {
    number: "01",
    title: "Take or upload a photo",
    body: "Any common image format, up to 20 MB. One photo is enough — no scanner required. Images are analysed in memory and never stored on our servers.",
  },
  {
    number: "02",
    title: "AI assessment in seconds",
    body: "The image is passed to a vision model tuned on MintVault\u2019s grading rubric (centering, corners, edges, surface, weighted by grading importance). Per-subgrade confidence is returned so you know where the model is sure.",
  },
  {
    number: "03",
    title: "Grade range and card identity",
    body: "You get a low-to-high grade range, a most-likely overall grade, and an auto-matched card identity (name, set, year). Use the estimate to decide whether a card is worth submitting for full grading.",
  },
];

// ── What-you-see items (Section II) ────────────────────────────────────────

const RETURNS_ITEMS = [
  { title: "Card identity", body: "Name, set, year, rarity, and a per-field confidence label." },
  { title: "Subgrade breakdown", body: "Centering, corners, edges, surface each scored 1\u201310 with a note explaining the score." },
  { title: "Per-subgrade confidence", body: "Low / medium / high for each axis. Know which subgrades to trust." },
  { title: "Grade range", body: "A low-to-high overall range plus the most-likely grade." },
  { title: "Potential issues & recommendation", body: "Flagged areas (e.g. surface scratching, edge wear) plus a recommendation on whether to submit." },
];

// ── Credit packs (Section III) ─────────────────────────────────────────────

const PACKS = [
  { credits: "5 estimates",   price: "£2",  perUnit: "40p each", featured: false },
  { credits: "15 estimates",  price: "£4",  perUnit: "27p each", featured: false },
  { credits: "100 estimates", price: "£10", perUnit: "10p each", featured: true  },
];

// ── FAQ (Section V) ────────────────────────────────────────────────────────

const FAQS = [
  {
    q: "Is this really free?",
    a: "Yes, one estimate per device per UTC day. After that, credit packs start at \u00a32 for 5 estimates. No subscription, no account.",
  },
  {
    q: "Does uploading my photo store the image?",
    a: "No. Images are analysed in memory and discarded after the response. We keep no copy of your card photo.",
  },
  {
    q: "How accurate is the estimate?",
    a: "Honest answer: it\u2019s a first-look sense-check, not a calibrated prediction. Single-photo pre-grades are less reliable than full scanner-based grading. Treat the subgrades as directional, not definitive.",
  },
  {
    q: "What formats and sizes work?",
    a: "JPEG, PNG, or most common image formats, up to 20 MB. A well-lit, in-focus photo of the front of the card works best. No special scanner needed.",
  },
  {
    q: "Can I use this to detect fakes?",
    a: "No. This estimates condition only. For authenticity, submit the card for full grading and add the Authentication add-on (\u00a315).",
  },
  {
    q: "What if the AI picks the wrong card?",
    a: "Card identity confidence is returned with every estimate. If it\u2019s low, the card might be unusual or the photo unclear. The subgrade breakdown still works independently.",
  },
];

// ── Page ───────────────────────────────────────────────────────────────────

export default function AiPreGradeV2() {
  return (
    <div className="min-h-screen flex flex-col" style={{ backgroundColor: "var(--v2-paper)" }}>
      <HeaderV2 />

      {/* ── SECTION A: HERO ──────────────────────────────────────────── */}
      <section className="relative">
        <div className="mx-auto max-w-7xl px-6 pt-10 pb-20 md:pt-16 md:pb-32 grid grid-cols-1 md:grid-cols-[1.4fr_1fr] gap-12 md:gap-16 items-center">
          {/* Left — copy */}
          <div>
            <p
              className="font-mono-v2 text-[10px] md:text-xs uppercase tracking-[0.25em] mb-6"
              style={{ color: "var(--v2-gold)" }}
            >
              Est. Kent &middot; AI Pre-Grade
            </p>
            <h1
              className="font-display italic font-medium leading-[0.95] mb-6"
              style={{ fontSize: "clamp(2.75rem, 6vw, 5rem)", color: "var(--v2-ink)" }}
            >
              A quick<br />second opinion.
            </h1>
            <p
              className="font-body text-base md:text-lg leading-relaxed max-w-xl mb-8"
              style={{ color: "var(--v2-ink-soft)" }}
            >
              Upload one photo. Get a subgrade breakdown, card identity, and a grade range
              in seconds. Free first estimate, no account needed, credit packs from &pound;2.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Link
                href="/v2-tools/estimate"
                className="inline-flex items-center gap-2 font-body text-sm font-semibold no-underline px-6 py-3 rounded-full transition-all hover:scale-[1.03]"
                style={{ backgroundColor: "var(--v2-gold)", color: "var(--v2-panel-dark)" }}
              >
                Try it free <ArrowRight size={14} />
              </Link>
              <Link
                href="/v2-pricing"
                className="inline-flex items-center gap-2 font-body text-sm font-semibold no-underline px-6 py-3 rounded-full border transition-all hover:scale-[1.03]"
                style={{ borderColor: "var(--v2-line)", color: "var(--v2-ink-soft)" }}
              >
                See pricing <ArrowRight size={14} />
              </Link>
            </div>

            {/* Price strip — Bloomberg-style data row. Mirrors Section III PACKS config. */}
            <div
              className="flex flex-col md:flex-row md:items-end gap-3 md:gap-0 py-4 mt-5 mb-5"
              style={{
                borderTop: "1px solid var(--v2-line-soft)",
                borderBottom: "1px solid var(--v2-line-soft)",
              }}
            >
              {PACKS.map((p, i) => (
                <div
                  key={p.credits}
                  className="flex-1 flex flex-col gap-1"
                  style={i > 0 ? { borderLeft: undefined } : undefined}
                >
                  <div
                    className="md:pl-6"
                    style={
                      // Vertical divider between items on md+ only, skipping the first item.
                      i > 0
                        ? { borderLeft: "1px solid var(--v2-line-soft)" }
                        : undefined
                    }
                  >
                    {p.featured && (
                      <p
                        className="font-mono-v2 text-[8px] uppercase tracking-widest mb-1"
                        style={{ color: "var(--v2-gold)" }}
                      >
                        Best
                      </p>
                    )}
                    <p
                      className="font-mono-v2 text-[9px] uppercase tracking-widest"
                      style={{ color: "var(--v2-ink-mute)" }}
                    >
                      {p.credits}
                    </p>
                    <p
                      className="font-display font-semibold leading-none mt-1"
                      style={{
                        fontSize: "clamp(1.25rem, 2vw, 1.5rem)",
                        color: p.featured ? "var(--v2-gold)" : "var(--v2-ink)",
                      }}
                    >
                      {p.price}
                    </p>
                    <p
                      className="font-mono-v2 text-[10px] uppercase mt-1"
                      style={{ color: "var(--v2-ink-soft)" }}
                    >
                      {p.perUnit}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            <p
              className="font-mono-v2 text-[9px] md:text-[10px] uppercase tracking-wider"
              style={{ color: "var(--v2-ink-mute)" }}
            >
              From 10p per estimate &middot; First one free &middot; No account needed
            </p>
          </div>

          {/* Right — capability slab fan */}
          {(() => {
            const slabs: [SlabContent, SlabContent, SlabContent] = [
              {
                topBadge: "SUBGRADES",
                mainLabel: "\u00d74 scores",
                rightLabel: "1\u201310",
                footnote: "CENTERING \u00b7 CORNERS \u00b7 EDGES \u00b7 SURFACE",
                key: "subgrades",
              },
              {
                topBadge: "GRADE RANGE",
                mainLabel: "Low\u2013High",
                rightLabel: "+ likely",
                footnote: "WITH CONFIDENCE",
                key: "range",
              },
              {
                topBadge: "CARD ID",
                mainLabel: "Auto-match",
                rightLabel: "AI lookup",
                footnote: "NAME \u00b7 SET \u00b7 YEAR",
                key: "id",
              },
            ];
            return <HeroSlabFan slabs={slabs} />;
          })()}
        </div>
      </section>

      {/* ── SECTION I: HOW IT WORKS (dark) ───────────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-panel-dark)" }}>
        <div className="mx-auto max-w-7xl px-6 py-24 md:py-32">
          <SectionEyebrow numeral="I" label="How It Works" className="mb-4" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-16 mb-16">
            <h2 className="font-display italic font-medium text-3xl md:text-5xl leading-tight" style={{ color: "#FFFFFF" }}>
              One photo.<br />
              <span className="font-display italic font-normal" style={{ color: "var(--v2-gold-soft)" }}>Four subgrades.</span>
            </h2>
            <p className="font-body text-sm md:text-base leading-relaxed self-end" style={{ color: "rgba(255,255,255,0.6)" }}>
              Take a photo or upload one. Our AI analyses centering, corners, edges, and
              surface separately and returns a subgrade breakdown plus a grade range.
              It&rsquo;s a sense-check, not a definitive grade.
            </p>
          </div>

          <div className="max-w-4xl">
            {STEPS.map((s, i) => (
              <div
                key={s.number}
                className="grid grid-cols-[auto_1fr] gap-6 md:gap-10 py-8 md:py-10"
                style={{
                  borderTop: i === 0 ? "1px solid rgba(255,255,255,0.1)" : undefined,
                  borderBottom: "1px solid rgba(255,255,255,0.1)",
                }}
              >
                <p
                  className="font-display italic font-medium leading-none"
                  style={{ color: "rgba(212, 175, 55, 0.35)", fontSize: "clamp(2rem, 4vw, 3rem)" }}
                >
                  {s.number}
                </p>
                <div>
                  <h3 className="font-display italic font-medium text-xl md:text-2xl leading-snug mb-3" style={{ color: "#FFFFFF" }}>
                    {s.title}
                  </h3>
                  <p className="font-body text-sm md:text-base leading-relaxed max-w-xl" style={{ color: "rgba(255,255,255,0.6)" }}>
                    {s.body}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── SECTION II: WHAT YOU SEE ─────────────────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-paper)" }}>
        <div className="mx-auto max-w-5xl px-6 py-24 md:py-32">
          <SectionEyebrow numeral="II" label="What You See" className="mb-4" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-16 mb-14">
            <h2 className="font-display italic font-medium text-3xl md:text-5xl leading-tight" style={{ color: "var(--v2-ink)" }}>
              The full breakdown.
            </h2>
            <p className="font-body text-sm md:text-base leading-relaxed self-end" style={{ color: "var(--v2-ink-soft)" }}>
              Every estimate returns the same shape of data, regardless of free or paid.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-8">
            {RETURNS_ITEMS.map((item, i) => (
              <div
                key={item.title}
                style={{
                  borderTop: i === 0 || i === 1 ? "1px solid var(--v2-line)" : undefined,
                  borderBottom: "1px solid var(--v2-line)",
                  paddingTop: "20px",
                  paddingBottom: "20px",
                }}
              >
                <h3 className="font-display italic font-medium text-lg md:text-xl mb-2" style={{ color: "var(--v2-ink)" }}>
                  {item.title}
                </h3>
                <p className="font-body text-sm leading-relaxed" style={{ color: "var(--v2-ink-soft)" }}>
                  {item.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── SECTION III: FREE & PAID ─────────────────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-paper-raised)" }}>
        <div className="mx-auto max-w-4xl px-6 py-24 md:py-32">
          <SectionEyebrow numeral="III" label="Pricing" className="mb-4" />
          <h2 className="font-display italic font-medium text-3xl md:text-5xl leading-tight mb-12" style={{ color: "var(--v2-ink)" }}>
            Try one free.<br />Buy more for less.
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {/* Free card */}
            <div className="rounded-xl p-8" style={{ backgroundColor: "var(--v2-paper)", border: "1px solid var(--v2-line)" }}>
              <p className="font-mono-v2 text-[10px] uppercase tracking-widest mb-4" style={{ color: "var(--v2-ink-mute)" }}>
                Free
              </p>
              <div className="flex items-baseline gap-2 mb-2">
                <span className="font-display font-semibold" style={{ color: "var(--v2-ink)", fontSize: "clamp(48px, 5vw, 64px)", lineHeight: 1 }}>
                  1
                </span>
                <span className="font-body text-sm" style={{ color: "var(--v2-ink-mute)" }}>estimate / day</span>
              </div>
              <p className="font-body text-sm mb-6" style={{ color: "var(--v2-ink-soft)" }}>
                No account. No email. Just upload and go.
              </p>
              <p className="font-mono-v2 text-[10px] uppercase tracking-widest" style={{ color: "var(--v2-ink-mute)" }}>
                Perfect for a one-off sense-check.
              </p>
            </div>

            {/* Credit packs card */}
            <div className="relative rounded-xl p-8" style={{ backgroundColor: "var(--v2-paper)", border: "1px solid var(--v2-gold-soft)" }}>
              <span
                className="absolute left-1/2 -translate-x-1/2 font-mono-v2 text-[9px] uppercase tracking-widest px-4 py-1.5 rounded whitespace-nowrap"
                style={{ top: "-14px", backgroundColor: "var(--v2-gold)", color: "var(--v2-panel-dark)" }}
              >
                Most chosen
              </span>
              <p className="font-mono-v2 text-[10px] uppercase tracking-widest mb-4" style={{ color: "var(--v2-gold)" }}>
                Credit packs
              </p>
              <div className="space-y-3 mb-6">
                {PACKS.map((p) => (
                  <div key={p.credits} className="flex items-center justify-between pb-2" style={{ borderBottom: "1px solid var(--v2-line-soft)" }}>
                    <span className="font-body text-sm" style={{ color: "var(--v2-ink)" }}>{p.credits}</span>
                    <div className="text-right">
                      <span className="font-mono-v2 text-sm font-semibold" style={{ color: "var(--v2-ink)" }}>{p.price}</span>
                      <span className="font-mono-v2 text-[10px] ml-2" style={{ color: "var(--v2-ink-mute)" }}>{p.perUnit}</span>
                    </div>
                  </div>
                ))}
              </div>
              <p className="font-body text-sm" style={{ color: "var(--v2-ink-soft)" }}>
                Credits never expire. Pay by card, no subscription.
              </p>
            </div>
          </div>

          <p className="font-mono-v2 text-[10px] uppercase tracking-widest mt-10 text-center" style={{ color: "var(--v2-gold)" }}>
            Vault Club Silver members will get 100 credits every month when the club reopens.
          </p>
          <p className="font-body text-xs text-center mt-2" style={{ color: "var(--v2-ink-mute)" }}>
            <Link href="/v2-vault-club" className="hover:underline" style={{ color: "var(--v2-ink-soft)" }}>
              See Vault Club
            </Link>
          </p>
        </div>
      </section>

      {/* ── SECTION IV: HONEST LIMITS ────────────────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-paper)" }}>
        <div className="mx-auto max-w-4xl px-6 py-24 md:py-32">
          <SectionEyebrow numeral="IV" label="Honesty" className="mb-4" />
          <h2 className="font-display italic font-medium text-3xl md:text-5xl leading-tight mb-12" style={{ color: "var(--v2-ink)" }}>
            What this isn&rsquo;t.
          </h2>

          <div className="space-y-8">
            <div>
              <h3 className="font-display italic font-medium text-xl md:text-2xl leading-snug mb-3" style={{ color: "var(--v2-ink)" }}>
                Not a definitive grade.
              </h3>
              <p className="font-body text-sm md:text-base leading-relaxed" style={{ color: "var(--v2-ink-soft)" }}>
                This is an AI-assisted first-look estimate from a single photo. Full
                MintVault grading uses a high-resolution scanner, multiple image variants
                (greyscale, high-contrast, angled), and physical inspection under
                magnification. The estimate is a sense-check, not a grade.
              </p>
            </div>
            <div>
              <h3 className="font-display italic font-medium text-xl md:text-2xl leading-snug mb-3" style={{ color: "var(--v2-ink)" }}>
                Not a counterfeit or authenticity check.
              </h3>
              <p className="font-body text-sm md:text-base leading-relaxed" style={{ color: "var(--v2-ink-soft)" }}>
                This tool estimates condition. It does not detect counterfeits, fakes, or
                reprints. For authenticity, add the Authentication service to a full
                grading submission.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── SECTION V: FAQ ───────────────────────────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-paper-raised)" }}>
        <div className="mx-auto max-w-4xl px-6 py-24 md:py-32">
          <SectionEyebrow numeral="V" label="FAQ" className="mb-4" />
          <h2 className="font-display italic font-medium text-3xl md:text-5xl leading-tight mb-12" style={{ color: "var(--v2-ink)" }}>
            Pre-grade questions.
          </h2>

          <div className="space-y-10">
            {FAQS.map((item) => (
              <div key={item.q}>
                <h3 className="font-display italic font-medium text-xl md:text-2xl leading-snug mb-3" style={{ color: "var(--v2-ink)" }}>
                  {item.q}
                </h3>
                <p className="font-body text-sm md:text-base leading-relaxed" style={{ color: "var(--v2-ink-soft)" }}>
                  {item.a}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── SECTION VI: FINAL CTA (dark) ─────────────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-panel-dark)" }}>
        <div className="mx-auto max-w-3xl px-6 py-24 md:py-32 text-center">
          <SectionEyebrow numeral="VI" label="Try it" className="mb-4" />
          <h2 className="font-display italic font-medium text-3xl md:text-5xl leading-tight mb-6" style={{ color: "#FFFFFF" }}>
            One photo.<br />One grade range.<br />Zero friction.
          </h2>
          <p className="font-body text-sm md:text-base mb-10" style={{ color: "rgba(255,255,255,0.5)" }}>
            First estimate is free. Credit packs start at &pound;2. Full grading starts at
            &pound;19 when you&rsquo;re ready.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3 mb-6">
            <Link
              href="/v2-tools/estimate"
              className="inline-flex items-center gap-2 font-body text-sm font-semibold no-underline px-7 py-3 rounded-full transition-all hover:scale-[1.03]"
              style={{ backgroundColor: "var(--v2-gold)", color: "var(--v2-panel-dark)" }}
            >
              Try it free <ArrowRight size={14} />
            </Link>
            <Link
              href="/v2-pricing"
              className="inline-flex items-center gap-2 font-body text-sm font-semibold no-underline px-7 py-3 rounded-full border transition-all hover:scale-[1.03]"
              style={{ borderColor: "rgba(255,255,255,0.2)", color: "rgba(255,255,255,0.7)" }}
            >
              See full grading pricing <ArrowRight size={14} />
            </Link>
          </div>
        </div>
      </section>

      <FooterV2 />
    </div>
  );
}
