import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowRight, Shield, Cpu, MapPin, RefreshCw } from "lucide-react";
import HeaderV2 from "@/components/v2/header-v2";
import FooterV2 from "@/components/v2/footer-v2";

// ── Types ──────────────────────────────────────────────────────────────────

interface HomepageStats {
  total_graded: number;
  unique_cards: number;
  unique_sets: number;
  avg_grade: number;
  claimed_count: number;
  recent_certs: {
    id: number;
    card_name: string;
    set_name: string;
    grade: string;
    grade_type: string;
    cert_number: string;
    front_image_path: string | null;
  }[];
}

// ── Hero slab ──────────────────────────────────────────────────────────────
// Premium graded-slab visual for hero right column. Per design-system skill
// (Layer B, "Gradient slabs"): no card artwork, generic moody gradient +
// MintVault monogram only. All data live-sourced from /api/v2/homepage-stats.

type RecentCert = HomepageStats["recent_certs"][number];

// 2% fractal noise overlay to break up gradient banding — inline SVG so we
// don't ship a separate asset. `%23` = `#` (URL-encoded for the data URL).
const SLAB_NOISE_SVG =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>\")";

function HeroSlab({
  cert,
  rotation,
  offset,
  zIndex,
}: {
  cert: RecentCert | null;
  rotation: number;
  offset: { x: number; y: number };
  zIndex: number;
}) {
  const certNumber = cert?.cert_number ?? null;
  const hasCardName = !!(cert?.card_name && cert.card_name.trim());
  const cardName = hasCardName ? cert!.card_name : "MintVault";
  const grade = cert?.grade ?? null;
  const gradeLabel = grade ? `MV ${grade}` : null;

  return (
    <div
      className="absolute overflow-hidden transition-shadow duration-300 hover:shadow-[0_20px_40px_-12px_rgba(15,14,11,0.25)]"
      style={{
        // Responsive width per skill spec; aspectRatio drives height.
        ["--slab-width" as any]: "clamp(120px, 40vw, 220px)",
        width: "var(--slab-width)",
        aspectRatio: "0.82",
        borderRadius: "12px",
        border: "1px solid rgba(212, 175, 55, 0.4)",
        backgroundColor: "var(--v2-paper-raised)",
        transform: `rotate(${rotation}deg) translate(${offset.x}px, ${offset.y}px)`,
        zIndex,
      }}
    >
      {/* ─── TOP BAR (~10%) — gold MV[n] pill, top-right ─── */}
      <div
        style={{
          height: "10%",
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          padding: "0 8px",
        }}
      >
        {certNumber && (
          <span
            className="font-mono-v2"
            style={{
              color: "var(--v2-gold-soft)",
              fontSize: "clamp(8px, 2.2vw, 10px)",
              letterSpacing: "0.1em",
              padding: "1px 6px",
              border: "1px solid rgba(212, 175, 55, 0.4)",
              borderRadius: "999px",
              lineHeight: 1,
            }}
          >
            {certNumber}
          </span>
        )}
      </div>

      {/* ─── DISPLAY FIELD (~65%) — gradient + noise + monogram ─── */}
      <div
        style={{
          height: "65%",
          position: "relative",
          background:
            "radial-gradient(circle at top left, var(--v2-slab-gradient-navy) 0%, var(--v2-slab-gradient-petrol) 35%, var(--v2-slab-gradient-teal) 70%, var(--v2-slab-gradient-bronze) 100%)",
        }}
      >
        {/* 2% noise to break gradient banding */}
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage: SLAB_NOISE_SVG,
            opacity: 0.02,
            pointerEvents: "none",
          }}
        />
        {/* Centered monogram — Fraunces italic, ~14% of slab width */}
        <div
          className="absolute inset-0 flex items-center justify-center font-display italic"
          style={{
            color: "rgba(255, 255, 255, 0.12)",
            fontSize: "calc(var(--slab-width) * 0.14)",
            whiteSpace: "nowrap",
            lineHeight: 1,
            userSelect: "none",
          }}
        >
          MintVault
        </div>
      </div>

      {/* ─── BOTTOM BAR (~25%) — card_name, grade, NFC badge ─── */}
      <div
        style={{
          height: "25%",
          padding: "6px 10px",
          backgroundColor: "var(--v2-paper-raised)",
          // Gold hairline divider between display field and bottom bar —
          // v2-gold-soft (#D4AF37) at 30% opacity.
          borderTop: "1px solid rgba(212, 175, 55, 0.3)",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: "4px",
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <span
            className="font-body truncate"
            style={{
              color: "var(--v2-ink)",
              fontSize: "clamp(10px, 2.8vw, 14px)",
              fontWeight: 500,
              minWidth: 0,
            }}
          >
            {cardName}
          </span>
          {gradeLabel && (
            <span
              className="font-mono-v2 shrink-0"
              style={{
                color: "var(--v2-gold)",
                fontSize: "clamp(9px, 2.4vw, 12px)",
                fontWeight: 600,
                lineHeight: 1,
              }}
            >
              {gradeLabel}
            </span>
          )}
        </div>
        {/* NFC badge — desktop only per spec */}
        <div className="hidden md:flex items-center gap-1">
          <span
            aria-hidden="true"
            style={{
              width: "5px",
              height: "5px",
              borderRadius: "999px",
              backgroundColor: "var(--v2-gold)",
              display: "inline-block",
            }}
          />
          <span
            className="font-mono-v2"
            style={{
              color: "var(--v2-ink-mute)",
              fontSize: "9px",
              letterSpacing: "0.05em",
              lineHeight: 1,
            }}
          >
            NFC &middot; Verified
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Animated counter ───────────────────────────────────────────────────────

function CountUp({ end, decimals = 0, duration = 1800 }: { end: number; decimals?: number; duration?: number }) {
  const [value, setValue] = useState(0);
  const ref = useRef<HTMLSpanElement>(null);
  const started = useRef(false);

  useEffect(() => {
    if (!ref.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !started.current) {
          started.current = true;
          const start = performance.now();
          function tick(now: number) {
            const progress = Math.min((now - start) / duration, 1);
            const eased = 1 - Math.pow(1 - progress, 3);
            setValue(eased * end);
            if (progress < 1) requestAnimationFrame(tick);
          }
          requestAnimationFrame(tick);
        }
      },
      { threshold: 0.3 }
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [end, duration]);

  return <span ref={ref}>{value.toFixed(decimals)}</span>;
}

// ── Section fade-in ────────────────────────────────────────────────────────

function FadeIn({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!ref.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setVisible(true); },
      { threshold: 0.1 }
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`transition-all duration-700 ${visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-6"} ${className}`}
    >
      {children}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────

export default function HomeV2() {
  const { data: stats, error: statsError } = useQuery<HomepageStats>({
    queryKey: ["/api/v2/homepage-stats"],
    queryFn: async () => {
      const res = await fetch("/api/v2/homepage-stats");
      if (!res.ok) throw new Error("Stats fetch failed");
      return res.json();
    },
    staleTime: 60_000,
  });

  useEffect(() => {
    if (statsError) console.error("Homepage stats fetch failed:", statsError);
  }, [statsError]);

  const totalGraded = stats?.total_graded ?? 132;
  const uniqueSets = stats?.unique_sets ?? 71;
  const avgGrade = stats?.avg_grade ?? 8.9;
  const recentCerts = stats?.recent_certs ?? [];

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
              Est. Kent &middot; MintVault UK
            </p>
            <h1
              className="font-display italic font-medium leading-[0.95] mb-6"
              style={{ fontSize: "clamp(2.75rem, 6vw, 5rem)", color: "var(--v2-ink)" }}
            >
              The standard for<br />graded collectibles.
            </h1>
            <p
              className="font-body text-base md:text-lg leading-relaxed max-w-xl mb-8"
              style={{ color: "var(--v2-ink-soft)" }}
            >
              AI-powered precision grading with tamper-evident NFC certification.
              Every grade logged, every slab traceable.
            </p>
            <div className="flex flex-wrap items-center gap-3 mb-5">
              <Link
                href="/submit"
                className="inline-flex items-center gap-2 font-body text-sm font-semibold no-underline px-6 py-3 rounded-full transition-all hover:scale-[1.03]"
                style={{ backgroundColor: "var(--v2-ink)", color: "var(--v2-paper)" }}
              >
                Submit a card <ArrowRight size={14} />
              </Link>
              <Link
                href="/tools/estimate"
                className="inline-flex items-center gap-2 font-body text-sm font-semibold no-underline px-6 py-3 rounded-full border transition-all hover:scale-[1.03]"
                style={{ borderColor: "var(--v2-line)", color: "var(--v2-ink-soft)" }}
              >
                Try AI Pre-Grade <ArrowRight size={14} />
              </Link>
            </div>
            <p
              className="font-mono-v2 text-[9px] md:text-[10px] uppercase tracking-wider"
              style={{ color: "var(--v2-ink-mute)" }}
            >
              From &pound;19 &middot; 45 day turnaround &middot; UK return shipping insured
            </p>
          </div>

          {/* Right — slab stack. Live data from /api/v2/homepage-stats → recent_certs.
              Fallback: 3 monogram slabs when API returns 0 rows or errors.
              Container width computed for 220 slab + rotation bbox (~10%) + ±60 offsets. */}
          <div
            className="relative h-[300px] md:h-[500px] flex items-center justify-center mx-auto"
            style={{ width: "min(90vw, 400px)", maxWidth: "none" }}
          >
            {(() => {
              const slots: (RecentCert | null)[] =
                recentCerts.length > 0 ? recentCerts.slice(0, 3) : [null, null, null];
              const rotations = [-8, 4, -2];
              // Wider fan so all 3 slabs have a clear visible area; front/back
              // pair mirrored on x, middle lifted for asymmetry.
              const offsets = [
                { x: -60, y: 24 },
                { x: 0, y: -16 },
                { x: 60, y: 24 },
              ];
              // Newest cert sits on top; supporting slabs behind.
              return slots.map((cert, i) => (
                <HeroSlab
                  key={cert?.id ?? `slot-${i}`}
                  cert={cert}
                  rotation={rotations[i]}
                  offset={offsets[i]}
                  zIndex={slots.length - i}
                />
              ));
            })()}
          </div>
        </div>
      </section>

      {/* ── SECTION B: STATS + PROMISES ──────────────────────────────── */}
      <FadeIn>
        <section style={{ backgroundColor: "var(--v2-paper-raised)" }}>
          <div className="mx-auto max-w-7xl px-6 py-16 md:py-20">
            {/* Stats row */}
            <div className="grid grid-cols-3 gap-6 md:gap-12 mb-12 md:mb-16 text-center">
              {[
                { value: totalGraded, label: "cards graded", decimals: 0 },
                { value: uniqueSets, label: "sets represented", decimals: 0 },
                { value: avgGrade, label: "average grade", decimals: 1 },
              ].map((stat) => (
                <div key={stat.label}>
                  <p className="font-display italic font-medium text-3xl md:text-5xl" style={{ color: "var(--v2-ink)" }}>
                    <CountUp end={stat.value} decimals={stat.decimals} />
                  </p>
                  <p className="font-body text-[10px] md:text-xs uppercase tracking-widest mt-2" style={{ color: "var(--v2-ink-mute)" }}>
                    {stat.label}
                  </p>
                </div>
              ))}
            </div>

            {/* Promises row */}
            <div className="border-t pt-10 md:pt-12 grid grid-cols-2 md:grid-cols-4 gap-6 md:gap-8" style={{ borderColor: "var(--v2-line)" }}>
              {[
                { icon: Shield, title: "Insured in custody", desc: "Up to \u00a37,500 per card cover" },
                { icon: Cpu, title: "NFC-verified", desc: "Every slab links to a live logbook" },
                { icon: MapPin, title: "UK-based", desc: "Graded in Kent \u00b7 shipped across the UK" },
                { icon: RefreshCw, title: "Reholder guarantee", desc: "Free regrade if we make a mistake" },
              ].map(({ icon: Icon, title, desc }) => (
                <div key={title}>
                  <Icon size={18} style={{ color: "var(--v2-gold)" }} className="mb-2" />
                  <p className="font-body text-sm font-semibold mb-1" style={{ color: "var(--v2-ink)" }}>{title}</p>
                  <p className="font-body text-xs" style={{ color: "var(--v2-ink-mute)" }}>{desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
      </FadeIn>

      {/* ── SECTION C: GRADING TIERS (dark) ──────────────────────────── */}
      <FadeIn>
        <section style={{ backgroundColor: "var(--v2-panel-dark)" }}>
          <div className="mx-auto max-w-7xl px-6 py-24 md:py-32">
            <p className="font-mono-v2 text-[10px] uppercase tracking-[0.25em] mb-4" style={{ color: "var(--v2-gold)" }}>
              I &middot; Grading Tiers
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-16 mb-14">
              <h2 className="font-display italic font-medium text-3xl md:text-5xl leading-tight" style={{ color: "#FFFFFF" }}>
                Three tiers.<br /><span className="font-display italic font-normal" style={{ color: "var(--v2-gold-soft)" }}>One standard.</span>
              </h2>
              <p className="font-body text-sm md:text-base leading-relaxed self-end" style={{ color: "rgba(255,255,255,0.6)" }}>
                Every card, regardless of service level, passes the same four-point
                inspection (centering, corners, edges, surface). Tier only changes
                how quickly you see it back.
              </p>
            </div>

            {/* Pricing cards — outlined, narrow, centred */}
            <div className="flex justify-center">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-5 md:gap-6 w-full" style={{ maxWidth: "1080px" }}>
                {[
                  {
                    name: "Vault Queue", price: "19", days: "45 day", featured: false,
                    features: ["Same 4-point grading inspection", "NFC ownership chip", "Registry listing", "Value up to \u00a3500"],
                  },
                  {
                    name: "Standard", price: "25", days: "21 day", featured: true,
                    features: ["Same 4-point grading inspection", "NFC ownership chip", "Registry listing", "Photographic report", "Value up to \u00a32,500"],
                  },
                  {
                    name: "Express", price: "45", days: "5 day", featured: false,
                    features: ["Same 4-point grading inspection", "NFC ownership chip", "Registry listing", "Photographic report", "Priority handling", "Value up to \u00a310,000"],
                  },
                ].map((tier) => (
                  <div
                    key={tier.name}
                    className="relative rounded-xl flex flex-col"
                    style={{
                      padding: "48px 40px",
                      backgroundColor: "transparent",
                      border: tier.featured
                        ? "1px solid rgba(212, 175, 55, 0.6)"
                        : "1px solid rgba(212, 175, 55, 0.25)",
                    }}
                  >
                    {/* MOST CHOSEN floating pill */}
                    {tier.featured && (
                      <span
                        className="absolute left-1/2 -translate-x-1/2 font-mono-v2 text-[9px] uppercase tracking-widest px-4 py-1.5 rounded"
                        style={{
                          top: "-14px",
                          backgroundColor: "var(--v2-gold)",
                          color: "var(--v2-panel-dark)",
                        }}
                      >
                        Most chosen
                      </span>
                    )}

                    {/* Tier name */}
                    <p className="font-body text-xs uppercase tracking-widest mb-5" style={{ color: "rgba(255,255,255,0.4)" }}>
                      {tier.name}
                    </p>

                    {/* Price — Fraunces non-italic, floating pound sign */}
                    <div className="relative mb-1" style={{ lineHeight: 1 }}>
                      <span
                        className="font-display font-semibold absolute"
                        style={{
                          color: "rgba(255,255,255,0.4)",
                          fontSize: "clamp(28px, 3vw, 36px)",
                          top: "4px",
                          left: "-2px",
                          transform: "translateX(-100%)",
                        }}
                      >
                        &pound;
                      </span>
                      <span
                        className="font-display font-semibold"
                        style={{
                          color: "#FFFFFF",
                          fontSize: "clamp(72px, 6vw, 96px)",
                          marginLeft: "20px",
                        }}
                      >
                        {tier.price}
                      </span>
                    </div>

                    {/* Turnaround — mono */}
                    <p
                      className="font-mono-v2 text-[10px] uppercase mb-8"
                      style={{ color: "#888888", letterSpacing: "0.15em" }}
                    >
                      {tier.days} turnaround
                    </p>

                    {/* Feature bullets — em-dash prefix */}
                    <ul className="mb-10 flex-1" style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
                      {tier.features.map((f) => (
                        <li key={f} className="flex items-start gap-3 font-body text-sm" style={{ color: "#E8E4DC" }}>
                          <span className="shrink-0" style={{ color: "var(--v2-gold)" }}>&mdash;</span>
                          {f}
                        </li>
                      ))}
                    </ul>

                    {/* CTA button */}
                    <Link
                      href="/submit"
                      className="inline-flex items-center justify-center gap-2 font-body text-sm font-semibold no-underline px-5 py-3 rounded-full transition-all hover:scale-[1.03] w-full"
                      style={
                        tier.featured
                          ? { backgroundColor: "var(--v2-gold)", color: "var(--v2-panel-dark)" }
                          : { border: "1px solid var(--v2-gold)", color: "var(--v2-gold)" }
                      }
                    >
                      Start a submission <ArrowRight size={14} />
                    </Link>
                  </div>
                ))}
              </div>
            </div>

            <p className="font-body text-xs text-center mt-8" style={{ color: "rgba(255,255,255,0.35)" }}>
              Bulk discounts from 10 cards.
            </p>
          </div>
        </section>
      </FadeIn>

      {/* ── SECTION D: INFRASTRUCTURE ────────────────────────────────── */}
      <FadeIn>
        <section style={{ backgroundColor: "var(--v2-paper)" }}>
          <div className="mx-auto max-w-7xl px-6 py-24 md:py-32">
            <p className="font-mono-v2 text-[10px] uppercase tracking-[0.25em] mb-4" style={{ color: "var(--v2-gold)" }}>
              II &middot; Infrastructure
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-16 mb-14">
              <h2 className="font-display italic font-medium text-3xl md:text-5xl leading-tight" style={{ color: "var(--v2-ink)" }}>
                Three pieces of quiet infrastructure.
              </h2>
              <p className="font-body text-sm md:text-base leading-relaxed self-end" style={{ color: "var(--v2-ink-soft)" }}>
                Grading is the visible part. What makes a MintVault slab worth
                more is what happens around it.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              {/* Card 1 — NFC */}
              <div className="rounded-xl p-6 md:p-8 flex flex-col" style={{ backgroundColor: "var(--v2-panel-dark)" }}>
                <p className="font-mono-v2 text-[9px] uppercase tracking-[0.2em] mb-4" style={{ color: "var(--v2-gold)" }}>
                  01 &middot; NFC Ownership
                </p>
                <h3 className="font-display italic font-medium text-xl md:text-2xl leading-tight mb-4" style={{ color: "#FFFFFF" }}>
                  Every slab knows who owns it.
                </h3>
                <p className="font-body text-xs leading-relaxed mb-6 flex-1" style={{ color: "rgba(255,255,255,0.6)" }}>
                  A sub-millimetre NFC chip inside each slab links to an ownership
                  registry. Tap with any phone &mdash; instantly see provenance, transfer
                  history, and authenticity. Stolen, faked, or altered slabs
                  invalidate on scan.
                </p>
                {/* Radar ring visual */}
                <div className="flex items-center justify-center h-24">
                  <div className="relative w-16 h-16">
                    <div className="absolute inset-0 rounded-full border animate-ping" style={{ borderColor: "var(--v2-gold)", opacity: 0.15, animationDuration: "2s" }} />
                    <div className="absolute inset-2 rounded-full border animate-ping" style={{ borderColor: "var(--v2-gold)", opacity: 0.25, animationDuration: "2s", animationDelay: "0.3s" }} />
                    <div className="absolute inset-4 rounded-full border animate-ping" style={{ borderColor: "var(--v2-gold)", opacity: 0.4, animationDuration: "2s", animationDelay: "0.6s" }} />
                    <div className="absolute inset-[26px] rounded-full" style={{ backgroundColor: "var(--v2-gold)" }} />
                  </div>
                </div>
              </div>

              {/* Card 2 — AI Pre-Grade */}
              <div className="rounded-xl p-6 md:p-8 flex flex-col" style={{ backgroundColor: "var(--v2-paper-raised)", border: "1px solid var(--v2-line)" }}>
                <p className="font-mono-v2 text-[9px] uppercase tracking-[0.2em] mb-4" style={{ color: "var(--v2-gold)" }}>
                  02 &middot; AI Pre-Grade
                </p>
                <h3 className="font-display italic font-medium text-xl md:text-2xl leading-tight mb-4" style={{ color: "var(--v2-ink)" }}>
                  Know your grade before you post.
                </h3>
                <p className="font-body text-xs leading-relaxed mb-6 flex-1" style={{ color: "var(--v2-ink-soft)" }}>
                  Upload two photos. Our centering, corner, edge and surface model
                  returns a likely grade in under 10 seconds. Trained on {stats?.unique_cards ?? 114} unique cards
                  across {uniqueSets} sets. Free.
                </p>
                {/* Mono readout */}
                <div className="rounded-lg p-4 font-mono-v2 text-[10px] leading-relaxed" style={{ backgroundColor: "var(--v2-paper-sunk)", color: "var(--v2-ink-soft)" }}>
                  <p style={{ color: "var(--v2-ink)" }}>1999 Holo Charizard #4</p>
                  <div className="mt-2 space-y-0.5">
                    <div className="flex justify-between"><span>Centering</span><span style={{ color: "var(--v2-ink)" }}>9.5</span></div>
                    <div className="flex justify-between"><span>Corners</span><span style={{ color: "var(--v2-ink)" }}>9.0</span></div>
                    <div className="flex justify-between"><span>Edges</span><span style={{ color: "var(--v2-ink)" }}>9.5</span></div>
                    <div className="flex justify-between"><span>Surface</span><span style={{ color: "var(--v2-ink)" }}>10.0</span></div>
                    <div className="flex justify-between border-t pt-1 mt-1 font-semibold" style={{ borderColor: "var(--v2-line)", color: "var(--v2-gold)" }}>
                      <span>Predicted</span><span>MV 9.5</span>
                    </div>
                  </div>
                </div>
                <Link
                  href="/tools/estimate"
                  className="inline-flex items-center gap-2 font-body text-xs font-semibold no-underline mt-5 transition-colors hover:underline"
                  style={{ color: "var(--v2-gold)" }}
                >
                  Try it now <ArrowRight size={12} />
                </Link>
              </div>

              {/* Card 3 — Vault Club (Silver only at launch) */}
              <div className="rounded-xl p-6 md:p-8 flex flex-col" style={{ backgroundColor: "var(--v2-paper-sunk)", border: "1px solid var(--v2-line-soft)" }}>
                <p className="font-mono-v2 text-[9px] uppercase tracking-[0.2em] mb-4" style={{ color: "var(--v2-gold)" }}>
                  03 &middot; Vault Club
                </p>
                <h3 className="font-display italic font-medium text-xl md:text-2xl leading-tight mb-4" style={{ color: "var(--v2-ink)" }}>
                  Membership for the serious.
                </h3>
                <p className="font-body text-xs leading-relaxed mb-6 flex-1" style={{ color: "var(--v2-ink-soft)" }}>
                  Grading discounts, higher AI Pre-Grade allowance, priority queue,
                  and a reserved username on the public registry.
                </p>
                <div className="space-y-2 mb-5">
                  <div className="flex items-center justify-between font-body text-sm font-semibold" style={{ color: "var(--v2-ink)" }}>
                    <span>Silver</span>
                    <div className="text-right">
                      <span className="font-mono-v2 text-[11px]">&pound;9.99/mo</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between font-body text-xs" style={{ color: "var(--v2-ink-mute)" }}>
                    <span></span>
                    <span className="font-mono-v2 text-[10px]">&pound;99/year</span>
                  </div>
                </div>
                <Link
                  href="/club"
                  className="inline-flex items-center gap-2 font-body text-xs font-semibold no-underline transition-colors hover:underline"
                  style={{ color: "var(--v2-gold)" }}
                >
                  View all benefits <ArrowRight size={12} />
                </Link>
              </div>
            </div>
          </div>
        </section>
      </FadeIn>

      {/* ── SECTION E: POPULATION REGISTRY ───────────────────────────── */}
      <FadeIn>
        <section style={{ backgroundColor: "var(--v2-paper-sunk)" }}>
          <div className="mx-auto max-w-7xl px-6 py-24 md:py-32">
            <p className="font-mono-v2 text-[10px] uppercase tracking-[0.25em] mb-4" style={{ color: "var(--v2-gold)" }}>
              III &middot; Population Registry
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-16 mb-14">
              <h2 className="font-display italic font-medium text-3xl md:text-5xl leading-tight" style={{ color: "var(--v2-ink)" }}>
                The open population record.
              </h2>
              <p className="font-body text-sm md:text-base leading-relaxed self-end" style={{ color: "var(--v2-ink-soft)" }}>
                Every card we grade, visible to the public. Populations, grade
                distributions, last known sale. Collectors deserve to see the market
                they trade in.
              </p>
            </div>

            {/* Ticker strip */}
            {recentCerts.length > 0 && (
              <div className="overflow-hidden mb-10 rounded-lg py-3 px-4" style={{ backgroundColor: "var(--v2-paper-raised)", border: "1px solid var(--v2-line)" }}>
                <div className="flex items-center gap-6 animate-marquee whitespace-nowrap font-mono-v2 text-[10px]" style={{ color: "var(--v2-ink-mute)" }}>
                  {[...recentCerts, ...recentCerts].map((cert, i) => (
                    <span key={i} className="flex items-center gap-2">
                      <span style={{ color: "var(--v2-gold)" }}>{cert.cert_number}</span>
                      <span>&middot;</span>
                      <span>{cert.card_name}</span>
                      <span>&middot;</span>
                      <span style={{ color: "var(--v2-ink)" }}>MV {cert.grade}</span>
                      <span>&middot;</span>
                      <span>{cert.set_name}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Mini table */}
            {recentCerts.length > 0 && (
              <div className="rounded-xl overflow-x-auto" style={{ border: "1px solid var(--v2-line)" }}>
                <table className="w-full text-left">
                  <thead>
                    <tr style={{ backgroundColor: "var(--v2-paper-raised)", borderBottom: "1px solid var(--v2-line)" }}>
                      <th className="font-body text-[10px] uppercase tracking-widest py-3 px-4" style={{ color: "var(--v2-ink-mute)" }}>#</th>
                      <th className="font-body text-[10px] uppercase tracking-widest py-3 px-4" style={{ color: "var(--v2-ink-mute)" }}>Card</th>
                      <th className="font-body text-[10px] uppercase tracking-widest py-3 px-4" style={{ color: "var(--v2-ink-mute)" }}>Grade</th>
                      <th className="font-body text-[10px] uppercase tracking-widest py-3 px-4 hidden md:table-cell" style={{ color: "var(--v2-ink-mute)" }}>Set</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentCerts.map((cert, i) => (
                      <tr key={cert.id} style={{ borderBottom: i < recentCerts.length - 1 ? "1px solid var(--v2-line-soft)" : undefined, backgroundColor: "var(--v2-paper-raised)" }}>
                        <td className="font-mono-v2 text-[10px] py-3 px-4" style={{ color: "var(--v2-gold)" }}>{cert.cert_number}</td>
                        <td className="font-body text-sm py-3 px-4" style={{ color: "var(--v2-ink)" }}>{cert.card_name}</td>
                        <td className="font-mono-v2 text-sm font-semibold py-3 px-4" style={{ color: "var(--v2-ink)" }}>{cert.grade}</td>
                        <td className="font-body text-xs py-3 px-4 hidden md:table-cell" style={{ color: "var(--v2-ink-mute)" }}>{cert.set_name}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="mt-8 text-center">
              <Link
                href="/population"
                className="inline-flex items-center gap-2 font-body text-sm font-semibold no-underline px-6 py-3 rounded-full border transition-all hover:scale-[1.03]"
                style={{ borderColor: "var(--v2-line)", color: "var(--v2-ink-soft)" }}
              >
                Browse the full registry <ArrowRight size={14} />
              </Link>
            </div>
          </div>
        </section>
      </FadeIn>

      {/* ── SECTION F: FINAL CTA (dark) ──────────────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-panel-dark)" }}>
        <div className="mx-auto max-w-3xl px-6 py-24 md:py-32 text-center">
          <p className="font-mono-v2 text-[10px] uppercase tracking-[0.25em] mb-4" style={{ color: "var(--v2-gold)" }}>
            IV &middot; Submit
          </p>
          <h2 className="font-display italic font-medium text-3xl md:text-5xl leading-tight mb-6" style={{ color: "#FFFFFF" }}>
            Submit a card.<br />See yourself on the registry.
          </h2>
          <p className="font-body text-sm md:text-base mb-10" style={{ color: "rgba(255,255,255,0.5)" }}>
            From &pound;19. UK-based. Insured in transit and in custody.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3 mb-6">
            <Link
              href="/submit"
              className="inline-flex items-center gap-2 font-body text-sm font-semibold no-underline px-7 py-3 rounded-full transition-all hover:scale-[1.03]"
              style={{ backgroundColor: "var(--v2-gold)", color: "var(--v2-panel-dark)" }}
            >
              Submit a card <ArrowRight size={14} />
            </Link>
            <Link
              href="/tools/estimate"
              className="inline-flex items-center gap-2 font-body text-sm font-semibold no-underline px-7 py-3 rounded-full border transition-all hover:scale-[1.03]"
              style={{ borderColor: "rgba(255,255,255,0.2)", color: "rgba(255,255,255,0.7)" }}
            >
              Try AI Pre-Grade (free) <ArrowRight size={14} />
            </Link>
          </div>
          <p className="font-mono-v2 text-[9px] uppercase tracking-widest" style={{ color: "var(--v2-gold)" }}>
            No login required for pre-grade &middot; Submission in 3 minutes
          </p>
        </div>
      </section>

      <FooterV2 />
    </div>
  );
}
