import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowRight, Shield, Cpu, MapPin, RefreshCw, CheckCheck, Clock, Zap } from "lucide-react";
import { motion } from "framer-motion";
import NumberFlow from "@number-flow/react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import HeaderV2 from "@/components/v2/header-v2";
import FooterV2 from "@/components/v2/footer-v2";
import AmbientLayer from "@/components/v2/ambient-layer";
import DarkSectionGlow from "@/components/v2/dark-section-glow";
import GradientButton from "@/components/ui/gradient-button";
import { pricingTiers } from "@shared/schema";

const TIER_ICONS: Record<string, { shortName: string; blurb: string; icon: React.ReactNode }> = {
  standard: {
    shortName: "Vault Queue",
    blurb: "No rush. Full grade, NFC chip, registry listing — at the best price per card.",
    icon: <Shield size={20} />,
  },
  priority: {
    shortName: "Standard",
    blurb: "The balanced option: fair turnaround, full report, priority you can feel.",
    icon: <Clock size={20} />,
  },
  express: {
    shortName: "Express",
    blurb: "Back in under a week. For grails, auction deadlines, and holiday hand-offs.",
    icon: <Zap size={20} />,
  },
};

// Bulk discount entry tier (10+ cards = 5% off). Full 10+/25+/50+ ladder
// surfaced on /pricing. Source of truth: bulkDiscountTiers in shared/schema.ts.
const BULK_ENTRY_MULTIPLIER = 0.95;

function PricingSwitch({ onSwitch, className }: { onSwitch: (value: string) => void; className?: string }) {
  const [selected, setSelected] = useState("0");

  const handleSwitch = (value: string) => {
    setSelected(value);
    onSwitch(value);
  };

  return (
    <div className={cn("flex justify-center", className)}>
      <div className="relative z-10 mx-auto flex w-fit rounded-xl bg-[#1a1a1a] border border-[#333] p-1">
        <button
          onClick={() => handleSwitch("0")}
          className={cn(
            "relative z-10 w-fit cursor-pointer h-12 rounded-xl sm:px-6 px-3 sm:py-2 py-1 font-medium transition-colors sm:text-base text-sm",
            selected === "0" ? "text-[#1a1400]" : "text-[#888] hover:text-white"
          )}
        >
          {selected === "0" && (
            <motion.span
              layoutId="home-pricing-switch"
              className="absolute top-0 left-0 h-12 w-full rounded-xl border-2 border-[#B8960C] bg-gradient-to-t from-[#B8960C] via-[#D4AF37] to-[#FFD700]"
              transition={{ type: "spring", stiffness: 500, damping: 30 }}
            />
          )}
          <span className="relative">Per Card</span>
        </button>

        <button
          onClick={() => handleSwitch("1")}
          className={cn(
            "relative z-10 w-fit cursor-pointer h-12 flex-shrink-0 rounded-xl sm:px-6 px-3 sm:py-2 py-1 font-medium transition-colors sm:text-base text-sm",
            selected === "1" ? "text-[#1a1400]" : "text-[#888] hover:text-white"
          )}
        >
          {selected === "1" && (
            <motion.span
              layoutId="home-pricing-switch"
              className="absolute top-0 left-0 h-12 w-full rounded-xl border-2 border-[#B8960C] bg-gradient-to-t from-[#B8960C] via-[#D4AF37] to-[#FFD700]"
              transition={{ type: "spring", stiffness: 500, damping: 30 }}
            />
          )}
          <span className="relative">Bulk</span>
        </button>
      </div>
    </div>
  );
}

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

// ── Animated counter — REMOVED 2026-04-27 ──────────────────────────────────
// The CountUp helper and the homepage stats trio (cards graded / sets
// represented / average grade) were removed in favour of a founding-members
// CTA + 3-step process strip. PSA/Beckett/SGC don't run public counters and
// pre-launch volume undermines trust. Original implementation preserved at
// client/src/archive/home-stats-counters-archived.tsx for restoration.

// ── Founding members CTA + 3-step process strip ────────────────────────────
// Renders side-by-side on md+ screens, stacked on mobile. CTA posts to
// /api/v2/waitlist; success/error states inline. The 3-step strip uses the
// same Fraunces display + sans body conventions as the rest of section B.

const PROCESS_STEPS: { num: string; title: string; desc: string }[] = [
  { num: "01", title: "Submit", desc: "Send your card insured to our UK grading facility." },
  { num: "02", title: "Grade", desc: "Our team grades, photographs, and slabs your card." },
  { num: "03", title: "Track", desc: "Every slab links to a live logbook with NFC." },
];

function FoundingMembersStrip() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<{ kind: "idle" | "success" | "error"; message?: string }>({ kind: "idle" });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const trimmed = email.trim();
    if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setStatus({ kind: "error", message: "Please enter a valid email address." });
      return;
    }
    setSubmitting(true);
    setStatus({ kind: "idle" });
    try {
      const res = await fetch("/api/v2/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed }),
      });
      if (!res.ok) {
        if (res.status === 429) {
          setStatus({ kind: "error", message: "Too many attempts from this device. Please try again later." });
        } else {
          const body = await res.json().catch(() => ({}));
          setStatus({ kind: "error", message: body?.error || "We couldn't add you right now. Please try again." });
        }
        return;
      }
      setEmail("");
      setStatus({ kind: "success", message: "You're on the list — we'll be in touch." });
    } catch {
      setStatus({ kind: "error", message: "Network error. Please try again." });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid md:grid-cols-2 gap-8 md:gap-12 mb-12 md:mb-16 items-start">
      {/* Block A — Founding Members CTA */}
      <div>
        <p className="font-body text-[10px] md:text-xs uppercase tracking-widest mb-3" style={{ color: "#ffffff" }}>
          Founding members &middot; Limited cohort
        </p>
        <h3
          className="font-display italic font-medium text-2xl md:text-3xl leading-tight mb-3"
          style={{ color: "var(--v2-ink)" }}
        >
          Founding member submissions now open
        </h3>
        <p className="font-body text-sm md:text-base leading-relaxed mb-5" style={{ color: "var(--v2-ink-soft)" }}>
          Join the first cohort of UK collectors grading with MintVault.
        </p>
        <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-2" data-testid="form-waitlist">
          <input
            type="email"
            inputMode="email"
            autoComplete="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (status.kind !== "idle") setStatus({ kind: "idle" });
            }}
            placeholder="you@email.com"
            disabled={submitting}
            data-testid="input-waitlist-email"
            className="flex-1 font-body text-sm px-4 py-3 rounded-md border focus:outline-none focus:ring-2"
            style={{
              borderColor: "var(--v2-line)",
              backgroundColor: "var(--v2-paper)",
              color: "var(--v2-ink)",
            }}
            maxLength={254}
            required
          />
          <GradientButton
            as="button"
            type="submit"
            height="44px"
            disabled={submitting || !email.trim()}
            data-testid="button-waitlist-submit"
            className="gradient-btn-filled"
          >
            {submitting ? "Joining…" : "Join the waitlist"}
          </GradientButton>
        </form>
        {status.kind === "success" && (
          <p className="mt-3 font-body text-sm" style={{ color: "var(--v2-gold)" }} data-testid="text-waitlist-success">
            {status.message}
          </p>
        )}
        {status.kind === "error" && (
          <p className="mt-3 font-body text-sm" style={{ color: "#B23B3B" }} data-testid="text-waitlist-error">
            {status.message}
          </p>
        )}
      </div>

      {/* Block B — 3-step process strip */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-5 sm:gap-6">
        {PROCESS_STEPS.map((step) => (
          <div key={step.num} data-testid={`process-step-${step.num}`}>
            <div className="flex items-baseline gap-3 mb-2">
              <span className="font-mono-v2 text-xs tracking-widest" style={{ color: "#ffffff" }}>
                {step.num}
              </span>
              <span className="font-display italic font-medium text-base md:text-lg" style={{ color: "var(--v2-ink)" }}>
                {step.title}
              </span>
            </div>
            <p className="font-body text-xs md:text-sm leading-relaxed" style={{ color: "var(--v2-ink-soft)" }}>
              {step.desc}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Section fade-in ────────────────────────────────────────────────────────

function FadeIn({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!ref.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setVisible(true);
      },
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

  // totalGraded + avgGrade removed with the stats trio (2026-04-27).
  // uniqueSets stays — still consumed below in the AI-grade copy line.
  const uniqueSets = stats?.unique_sets ?? 71;
  const [isBulk, setIsBulk] = useState(false);
  const togglePricingPeriod = (value: string) => setIsBulk(Number.parseInt(value) === 1);
  const recentCerts = stats?.recent_certs ?? [];

  return (
    <div className="min-h-screen flex flex-col relative vault-page">
      <AmbientLayer />
      <HeaderV2 />

      {/* ── SECTION A: HERO ──────────────────────────────────────────── */}
      <section className="relative vault-hero-section">
        <div className="mx-auto max-w-3xl px-6 pt-10 pb-20 md:pt-16 md:pb-32 text-center">
          <p
            className="font-mono-v2 text-sm md:text-base font-semibold uppercase tracking-[0.25em] no-text-shadow mb-6"
            style={{ color: "#D4AF37" }}
          >
            Est. Kent &middot; MintVault UK
          </p>
          <h1
            className="font-display font-medium leading-[0.95] mb-6"
            style={{ fontSize: "clamp(2.75rem, 6vw, 5rem)", color: "var(--v2-ink)" }}
          >
            The standard for
            <br />
            graded collectibles.
          </h1>
          <p
            className="font-body text-lg md:text-xl leading-relaxed max-w-xl mx-auto mb-8"
            style={{ color: "var(--v2-ink-soft)" }}
          >
            AI-powered precision grading with NFC-linked certification. Every grade logged, every slab traceable.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-4 mb-5">
            <Link href="/submit" className="no-underline">
              <GradientButton height="44px" className="gradient-btn-filled">
                Submit a card <ArrowRight size={14} />
              </GradientButton>
            </Link>
            <Link href="/tools/estimate" className="no-underline">
              <GradientButton height="44px">
                Try AI Pre-Grade <ArrowRight size={14} />
              </GradientButton>
            </Link>
          </div>
          <p
            className="font-mono-v2 text-xs md:text-sm uppercase tracking-wider"
            style={{ color: "var(--v2-ink-mute)" }}
          >
            From &pound;19 &middot; 40 day turnaround &middot; UK return shipping insured
          </p>
        </div>
      </section>

      {/* ── SECTION B: STATS + PROMISES ──────────────────────────────── */}
      <FadeIn>
        <section className="frost-paper-raised">
          <div className="mx-auto max-w-7xl px-6 py-16 md:py-20">
            {/* Founding members CTA + 3-step process strip
                Replaces the original stats trio (2026-04-27). */}
            <FoundingMembersStrip />

            {/* Promises row */}
            <div
              className="border-t pt-10 md:pt-12 grid grid-cols-2 md:grid-cols-3 gap-6 md:gap-8"
              style={{ borderColor: "var(--v2-line)" }}
            >
              {[
                { icon: Cpu, title: "NFC-tracked", desc: "Every slab links to a live logbook" },
                { icon: MapPin, title: "UK-based", desc: "Graded in Kent \u00b7 shipped across the UK" },
                {
                  icon: RefreshCw,
                  title: "Ownership tracked",
                  desc: "Each transfer recorded with a new reference number",
                },
              ].map(({ icon: Icon, title, desc }) => (
                <div key={title}>
                  <Icon size={18} style={{ color: "var(--v2-gold)" }} className="mb-2" />
                  <p className="font-body text-sm font-semibold mb-1" style={{ color: "var(--v2-ink)" }}>
                    {title}
                  </p>
                  <p className="font-body text-xs" style={{ color: "var(--v2-ink-mute)" }}>
                    {desc}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>
      </FadeIn>

      {/* ── SECTION C: GRADING TIERS (dark) ──────────────────────────── */}
      <FadeIn>
        <section className="frost-panel-dark" style={{ position: "relative", overflow: "hidden" }}>
          <DarkSectionGlow />
          <div className="mx-auto max-w-7xl px-6 py-24 md:py-32" style={{ position: "relative", zIndex: 1 }}>
            <p
              className="font-mono-v2 text-xs md:text-sm uppercase tracking-[0.25em] no-text-shadow mb-4"
              style={{ color: "#D4AF37" }}
            >
              I &middot; Grading Tiers
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-16 mb-14">
              <h2
                className="font-display italic font-medium text-3xl md:text-5xl leading-tight"
                style={{ color: "#FFFFFF" }}
              >
                Three tiers.
                <br />
                <span className="font-display italic font-normal" style={{ color: "var(--v2-gold)" }}>
                  One standard.
                </span>
              </h2>
              <p className="font-body text-sm md:text-base leading-relaxed self-end" style={{ color: "#ffffff" }}>
                Every card, regardless of service level, passes the same four-point inspection (centering, corners,
                edges, surface). Tier only changes how quickly you see it back.
              </p>
            </div>

            <PricingSwitch onSwitch={togglePricingPeriod} className="mb-10" />

            <div className="flex justify-center">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-5 md:gap-6 w-full" style={{ maxWidth: "1080px" }}>
                {pricingTiers.map((tier) => {
                  const d = TIER_ICONS[tier.id];
                  const price = tier.pricePerCard / 100;
                  const bulkPrice = Math.round(price * BULK_ENTRY_MULTIPLIER * 100) / 100;
                  const days = tier.turnaroundDays ?? 0;
                  const featured = tier.id === "priority";

                  return (
                    <Card
                      key={tier.id}
                      className={cn(
                        "relative border h-full flex flex-col transition-all duration-300",
                        featured
                          ? "ring-2 ring-[#D4AF37] bg-[#171510] border-[#D4AF37]/50 md:scale-105 md:-my-4 z-10 shadow-[0_0_30px_rgba(212,175,55,0.3),0_0_60px_rgba(212,175,55,0.15)]"
                          : "bg-[#0f0e0b] border-[#333]"
                      )}
                    >
                      {featured && (
                        <span className="absolute -top-5 left-1/2 -translate-x-1/2 z-20 bg-gradient-to-r from-[#B8960C] to-[#D4AF37] text-[#1a1400] px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider whitespace-nowrap no-text-shadow shadow-[0_0_12px_rgba(212,175,55,0.6),0_0_24px_rgba(212,175,55,0.3)]">
                          Most chosen
                        </span>
                      )}
                      <CardHeader className="text-left">
                        <div className="flex items-center gap-3 mb-2">
                          <div className="w-10 h-10 rounded-xl bg-[#1a1400] border border-[#D4AF37]/20 flex items-center justify-center text-[#D4AF37]">
                            {d.icon}
                          </div>
                          <h3 className="xl:text-3xl md:text-2xl text-3xl font-semibold text-white">{d.shortName}</h3>
                        </div>
                        <p className="xl:text-sm md:text-xs text-sm text-[#888] mb-4">{d.blurb}</p>
                        <div className="flex items-baseline gap-1">
                          <span className="text-4xl font-semibold text-white">
                            £
                            <NumberFlow value={isBulk ? bulkPrice : price} className="text-4xl font-semibold" />
                          </span>
                          <span className="text-[#888] ml-1">/ card</span>
                        </div>
                        <p className="text-xs text-[#666] mt-1">{days} working day turnaround</p>
                      </CardHeader>

                      <CardContent className="pt-0 flex flex-col flex-1">
                        <div className="space-y-3 pt-4 border-t border-[#333] mb-6 flex-1">
                          <h4 className="text-xs font-bold uppercase tracking-wider text-[#D4AF37] mb-3">
                            What&rsquo;s included
                          </h4>
                          <ul className="space-y-2.5">
                            {tier.features.map((feature) => (
                              <li key={feature} className="flex items-center">
                                <span className="h-5 w-5 rounded-full border border-[#D4AF37]/40 grid place-content-center mr-3 flex-shrink-0">
                                  <CheckCheck className="h-3 w-3 text-[#D4AF37]" />
                                </span>
                                <span className="text-sm text-[#ccc]">{feature}</span>
                              </li>
                            ))}
                          </ul>
                        </div>

                        <Link href="/submit" className="no-underline block">
                          <GradientButton height="52px" className="w-full">
                            Start a submission <ArrowRight size={14} />
                          </GradientButton>
                        </Link>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </div>

            {/* Bulk-discount tiers table — mirrors /pricing. Only visible
                when the toggle is in Bulk mode (same isBulk state that
                drives the per-card prices on the cards). */}
            {isBulk && (
              <div className="mt-12 max-w-3xl mx-auto">
                <p
                  className="font-mono-v2 text-[10px] md:text-xs uppercase tracking-[0.3em] no-text-shadow mb-3 text-center"
                  style={{ color: "#D4AF37" }}
                >
                  Bulk discount tiers
                </p>
                <div className="overflow-x-auto rounded-xl border border-[#333] bg-[#0f0e0b]">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[#333]">
                        <th className="text-left py-3 px-4 text-[10px] uppercase tracking-widest font-bold text-[#D4AF37]">
                          Cards
                        </th>
                        <th className="text-right py-3 px-4 text-[10px] uppercase tracking-widest font-bold text-[#D4AF37]">
                          Vault Queue
                        </th>
                        <th className="text-right py-3 px-4 text-[10px] uppercase tracking-widest font-bold text-[#D4AF37]">
                          Standard
                        </th>
                        <th className="text-right py-3 px-4 text-[10px] uppercase tracking-widest font-bold text-[#D4AF37]">
                          Express
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        { qty: "10+", off: "5% off",   vq: "£18.05", st: "£23.75", ex: "£42.75" },
                        { qty: "25+", off: "7.5% off", vq: "£17.58", st: "£23.13", ex: "£41.63" },
                        { qty: "50+", off: "10% off",  vq: "£17.10", st: "£22.50", ex: "£40.50" },
                      ].map((row) => (
                        <tr key={row.qty} className="border-b border-[#222] last:border-b-0">
                          <td className="py-3 px-4">
                            <div className="text-white font-semibold">{row.qty}</div>
                            <div className="text-[#666] text-[10px] uppercase tracking-wider">{row.off}</div>
                          </td>
                          <td className="py-3 px-4 text-right font-mono text-[#ccc]">{row.vq}</td>
                          <td className="py-3 px-4 text-right font-mono text-[#ccc]">{row.st}</td>
                          <td className="py-3 px-4 text-right font-mono text-[#ccc]">{row.ex}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="font-body text-xs md:text-sm text-center mt-3" style={{ color: "var(--v2-ink-mute)" }}>
                  Vault Club and bulk discounts are mutually exclusive — the higher discount applies.
                  Pristine 10P upgrade is excluded from bulk pricing.
                </p>
              </div>
            )}

            {!isBulk && (
              <p className="font-body text-xs text-center mt-8" style={{ color: "#ffffff" }}>
                Bulk discounts from 10 cards.
              </p>
            )}
          </div>
        </section>
      </FadeIn>

      {/* ── SECTION D: INFRASTRUCTURE ────────────────────────────────── */}
      <FadeIn>
        <section className="frost-paper">
          <div className="mx-auto max-w-7xl px-6 py-24 md:py-32">
            <p
              className="font-mono-v2 text-xs md:text-sm uppercase tracking-[0.25em] no-text-shadow mb-4"
              style={{ color: "#D4AF37" }}
            >
              II &middot; Infrastructure
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-16 mb-14">
              <h2
                className="font-display italic font-medium text-3xl md:text-5xl leading-tight"
                style={{ color: "var(--v2-ink)" }}
              >
                Three pieces of quiet infrastructure.
              </h2>
              <p
                className="font-body text-sm md:text-base leading-relaxed self-end"
                style={{ color: "var(--v2-ink-soft)" }}
              >
                Grading is the visible part. What makes a MintVault slab worth more is what happens around it.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              {/* Card 1 — NFC */}
              <div className="rounded-xl p-6 md:p-8 flex flex-col" style={{ backgroundColor: "var(--v2-panel-dark)" }}>
                <p
                  className="font-mono-v2 text-[9px] uppercase tracking-[0.2em] mb-4"
                  style={{ color: "var(--v2-gold)" }}
                >
                  01 &middot; NFC Ownership
                </p>
                <h3
                  className="font-display italic font-medium text-xl md:text-2xl leading-tight mb-4"
                  style={{ color: "#FFFFFF" }}
                >
                  Every slab knows who owns it.
                </h3>
                <p className="font-body text-xs leading-relaxed mb-6 flex-1" style={{ color: "#ffffff" }}>
                  A sub-millimetre NFC chip inside each slab links to an ownership registry. Tap with any phone &mdash;
                  instantly see provenance and transfer history. Slabs reported stolen flag publicly on the cert page.
                </p>
                {/* Radar ring visual */}
                <div className="flex items-center justify-center h-24">
                  <div className="relative w-16 h-16">
                    <div
                      className="absolute inset-0 rounded-full border animate-ping"
                      style={{ borderColor: "var(--v2-gold)", opacity: 0.15, animationDuration: "2s" }}
                    />
                    <div
                      className="absolute inset-2 rounded-full border animate-ping"
                      style={{
                        borderColor: "var(--v2-gold)",
                        opacity: 0.25,
                        animationDuration: "2s",
                        animationDelay: "0.3s",
                      }}
                    />
                    <div
                      className="absolute inset-4 rounded-full border animate-ping"
                      style={{
                        borderColor: "var(--v2-gold)",
                        opacity: 0.4,
                        animationDuration: "2s",
                        animationDelay: "0.6s",
                      }}
                    />
                    <div className="absolute inset-[26px] rounded-full" style={{ backgroundColor: "var(--v2-gold)" }} />
                  </div>
                </div>
              </div>

              {/* Card 2 — AI Pre-Grade */}
              <div
                className="rounded-xl p-6 md:p-8 flex flex-col"
                style={{ backgroundColor: "var(--v2-paper-raised)", border: "1px solid var(--v2-line)" }}
              >
                <p
                  className="font-mono-v2 text-[9px] uppercase tracking-[0.2em] mb-4"
                  style={{ color: "var(--v2-gold)" }}
                >
                  02 &middot; AI Pre-Grade
                </p>
                <h3
                  className="font-display italic font-medium text-xl md:text-2xl leading-tight mb-4"
                  style={{ color: "var(--v2-ink)" }}
                >
                  Know your grade before you post.
                </h3>
                <p className="font-body text-xs leading-relaxed mb-6 flex-1" style={{ color: "var(--v2-ink-soft)" }}>
                  Upload two photos. Our centering, corner, edge and surface model returns a likely grade in under 10
                  seconds. Trained on {stats?.unique_cards ?? 114} unique cards across {uniqueSets} sets. Free.
                </p>
                {/* Mono readout */}
                <div
                  className="rounded-lg p-4 font-mono-v2 text-[10px] leading-relaxed"
                  style={{ backgroundColor: "var(--v2-paper-sunk)", color: "var(--v2-ink-soft)" }}
                >
                  <p style={{ color: "var(--v2-ink)" }}>1999 Holo Charizard #4</p>
                  <div className="mt-2 space-y-0.5">
                    <div className="flex justify-between">
                      <span>Centering</span>
                      <span style={{ color: "var(--v2-ink)" }}>10</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Corners</span>
                      <span style={{ color: "var(--v2-ink)" }}>9</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Edges</span>
                      <span style={{ color: "var(--v2-ink)" }}>10</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Surface</span>
                      <span style={{ color: "var(--v2-ink)" }}>10</span>
                    </div>
                    <div
                      className="flex justify-between border-t pt-1 mt-1 font-semibold"
                      style={{ borderColor: "var(--v2-line)", color: "var(--v2-gold)" }}
                    >
                      <span>Predicted</span>
                      <span>MV 9</span>
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
              <div
                className="rounded-xl p-6 md:p-8 flex flex-col"
                style={{ backgroundColor: "var(--v2-paper-sunk)", border: "1px solid var(--v2-line-soft)" }}
              >
                <p
                  className="font-mono-v2 text-[9px] uppercase tracking-[0.2em] mb-4"
                  style={{ color: "var(--v2-gold)" }}
                >
                  03 &middot; Vault Club
                </p>
                <h3
                  className="font-display italic font-medium text-xl md:text-2xl leading-tight mb-4"
                  style={{ color: "var(--v2-ink)" }}
                >
                  Membership for the serious.
                </h3>
                <p className="font-body text-xs leading-relaxed mb-6 flex-1" style={{ color: "var(--v2-ink-soft)" }}>
                  Grading discounts, higher AI Pre-Grade allowance, priority queue, and a reserved username on the
                  public registry.
                </p>
                <div className="space-y-2 mb-5">
                  <div
                    className="flex items-center justify-between font-body text-sm font-semibold"
                    style={{ color: "var(--v2-ink)" }}
                  >
                    <span>Silver</span>
                    <div className="text-right">
                      <span className="font-mono-v2 text-[11px]">&pound;9.99/mo</span>
                    </div>
                  </div>
                  <div
                    className="flex items-center justify-between font-body text-xs"
                    style={{ color: "var(--v2-ink-mute)" }}
                  >
                    <span></span>
                    <span className="font-mono-v2 text-[10px]">&pound;99/year</span>
                  </div>
                </div>
                <Link
                  href="/vault-club"
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
        <section className="frost-paper-sunk">
          <div className="mx-auto max-w-7xl px-6 py-24 md:py-32">
            <p
              className="font-mono-v2 text-xs md:text-sm uppercase tracking-[0.25em] no-text-shadow mb-4"
              style={{ color: "#D4AF37" }}
            >
              III &middot; Population Registry
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-16 mb-14">
              <h2
                className="font-display italic font-medium text-3xl md:text-5xl leading-tight"
                style={{ color: "var(--v2-ink)" }}
              >
                The open population record.
              </h2>
              <p
                className="font-body text-sm md:text-base leading-relaxed self-end"
                style={{ color: "var(--v2-ink-soft)" }}
              >
                Every card we grade, visible to the public. Populations, grade distributions, last known sale.
                Collectors deserve to see the market they trade in.
              </p>
            </div>

            {/* Ticker strip */}
            {recentCerts.length > 0 && (
              <div
                className="overflow-hidden mb-10 rounded-lg py-3 px-4"
                style={{ backgroundColor: "var(--v2-paper-raised)", border: "1px solid var(--v2-line)" }}
              >
                <div
                  className="flex items-center gap-6 animate-marquee whitespace-nowrap font-mono-v2 text-[10px]"
                  style={{ color: "var(--v2-ink-mute)" }}
                >
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
                      <th
                        className="font-body text-[10px] uppercase tracking-widest py-3 px-4"
                        style={{ color: "var(--v2-ink-mute)" }}
                      >
                        #
                      </th>
                      <th
                        className="font-body text-[10px] uppercase tracking-widest py-3 px-4"
                        style={{ color: "var(--v2-ink-mute)" }}
                      >
                        Card
                      </th>
                      <th
                        className="font-body text-[10px] uppercase tracking-widest py-3 px-4"
                        style={{ color: "var(--v2-ink-mute)" }}
                      >
                        Grade
                      </th>
                      <th
                        className="font-body text-[10px] uppercase tracking-widest py-3 px-4 hidden md:table-cell"
                        style={{ color: "var(--v2-ink-mute)" }}
                      >
                        Set
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentCerts.map((cert, i) => (
                      <tr
                        key={cert.id}
                        style={{
                          borderBottom: i < recentCerts.length - 1 ? "1px solid var(--v2-line-soft)" : undefined,
                          backgroundColor: "var(--v2-paper-raised)",
                        }}
                      >
                        <td className="font-mono-v2 text-[10px] py-3 px-4" style={{ color: "var(--v2-gold)" }}>
                          {cert.cert_number}
                        </td>
                        <td className="font-body text-sm py-3 px-4" style={{ color: "var(--v2-ink)" }}>
                          {cert.card_name}
                        </td>
                        <td className="font-mono-v2 text-sm font-semibold py-3 px-4" style={{ color: "var(--v2-ink)" }}>
                          {cert.grade}
                        </td>
                        <td
                          className="font-body text-xs py-3 px-4 hidden md:table-cell"
                          style={{ color: "var(--v2-ink-mute)" }}
                        >
                          {cert.set_name}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="mt-8 text-center">
              <Link href="/registry" className="no-underline">
                <GradientButton className="gradient-btn-filled">
                  Browse the full registry <ArrowRight size={14} />
                </GradientButton>
              </Link>
            </div>
          </div>
        </section>
      </FadeIn>

      {/* ── SECTION F: FINAL CTA (dark) ──────────────────────────────── */}
      <section
        className="frost-panel-dark"
        style={{
          position: "relative",
          overflow: "hidden",
        }}
      >
        <DarkSectionGlow />
        <div className="mx-auto max-w-3xl px-6 py-24 md:py-32 text-center" style={{ position: "relative", zIndex: 1 }}>
          <p
            className="font-mono-v2 text-xs md:text-sm uppercase tracking-[0.25em] no-text-shadow mb-4"
            style={{ color: "#D4AF37" }}
          >
            IV &middot; Submit
          </p>
          <h2
            className="font-display italic font-medium text-3xl md:text-5xl leading-tight mb-6"
            style={{ color: "#FFFFFF" }}
          >
            Submit a card.
            <br />
            See yourself on the registry.
          </h2>
          <p className="font-body text-sm md:text-base mb-10" style={{ color: "#ffffff" }}>
            From &pound;19. UK-based. Insured in transit.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-4 mb-6">
            <Link href="/submit" className="no-underline">
              <GradientButton height="44px" className="gradient-btn-filled">
                Submit a card <ArrowRight size={14} />
              </GradientButton>
            </Link>
            <Link href="/tools/estimate" className="no-underline">
              <GradientButton height="44px">
                Try AI Pre-Grade (free) <ArrowRight size={14} />
              </GradientButton>
            </Link>
          </div>
          <p className="font-mono-v2 text-xs md:text-sm uppercase tracking-widest" style={{ color: "#ffffff" }}>
            No login required for pre-grade &middot; Submission in 3 minutes
          </p>
        </div>
      </section>

      <FooterV2 />
    </div>
  );
}
