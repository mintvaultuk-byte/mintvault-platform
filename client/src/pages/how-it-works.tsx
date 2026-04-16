import { useEffect, useRef } from "react";
import { Link } from "wouter";
import {
  ShoppingCart, Package, Scan, Shield, Truck, ArrowRight, HelpCircle,
} from "lucide-react";
import MintVaultWordmark from "@/components/mintvault-wordmark";
import SeoHead from "@/components/seo-head";

// ── Scroll-reveal hook ────────────────────────────────────────────────────

function useReveal() {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { el.classList.add("is-visible"); obs.disconnect(); } },
      { threshold: 0.12 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  return ref;
}

// ── Step data ─────────────────────────────────────────────────────────────

const steps = [
  {
    num: "01",
    icon: ShoppingCart,
    title: "Choose Your Service",
    body: "Select your grading speed and coverage tier. Vault Queue from £19/card with turnaround from 5 to 40 working days. All tiers include the same precision slab, NFC verification, and Digital Grading Report.",
    cta: { label: "View Pricing →", href: "/pricing" },
    note: null,
  },
  {
    num: "02",
    icon: Package,
    title: "Post Your Cards",
    body: "Place each card in a penny sleeve and semi-rigid card saver. Pack securely in a padded envelope or small box. Post to: MintVault UK, Rochester, Kent. Include your order number inside the package.",
    cta: null,
    note: "Need supplies? Our Submission Kit includes everything you need — £15.",
  },
  {
    num: "03",
    icon: Scan,
    title: "We Grade Your Cards",
    body: "Every card is scanned at 6400 DPI, analysed by our AI-assisted grading system, and professionally assessed by our head grader. We examine centering, corners, edges, and surface condition under magnification. Turnaround times are measured from the day we receive your cards — not when you post them.",
    cta: null,
    note: null,
  },
  {
    num: "04",
    icon: Shield,
    title: "Encapsulation & Quality Check",
    body: "Your card is encased in an archival-quality, UV-protected slab with a tamper-evident NFC chip. The grade label is inscribed — no paper labels that can be swapped. Every slab undergoes a final quality inspection before shipping.",
    cta: null,
    note: null,
  },
  {
    num: "05",
    icon: Truck,
    title: "Delivered Back to You",
    body: "Your graded cards are shipped via fully insured Royal Mail tracked delivery. Scan the QR code or tap the NFC chip to view your full Digital Grading Report — complete with high-res images, subgrade breakdown, defect analysis, and population data. Register ownership with your unique claim code.",
    cta: null,
    note: "Add MintVault Reveal Wrap — receive your slab sealed in gold holographic foil for the ultimate unboxing experience. Free with every order.",
  },
];

// ── Step block ────────────────────────────────────────────────────────────

function StepBlock({ step, index }: { step: typeof steps[number]; index: number }) {
  const ref = useReveal();
  const isEven = index % 2 === 1;
  const Icon = step.icon;

  return (
    <div
      ref={ref}
      className="reveal-target py-14 md:py-20 border-b border-[#E8E4DC] last:border-0"
      style={{ "--delay": `${index * 60}ms` } as React.CSSProperties}
    >
      <div className={`max-w-4xl mx-auto px-6 flex flex-col ${isEven ? "md:flex-row-reverse" : "md:flex-row"} items-center gap-10 md:gap-16`}>

        {/* Number + icon */}
        <div className="flex-shrink-0 flex flex-col items-center gap-2 select-none">
          <span
            className="font-black leading-none text-[clamp(5rem,12vw,8rem)] tracking-tighter"
            style={{ color: "#D4AF37", opacity: 0.18 }}
          >
            {step.num}
          </span>
          <div className="w-12 h-12 rounded-2xl bg-[#FFF9E6] border border-[#D4AF37]/30 flex items-center justify-center -mt-6">
            <Icon size={22} className="text-[#B8960C]" />
          </div>
        </div>

        {/* Content */}
        <div className={`flex-1 ${isEven ? "md:text-right" : ""}`}>
          <p className="text-[#D4AF37] text-xs font-bold uppercase tracking-[0.2em] mb-2">Step {step.num}</p>
          <h2 className="text-2xl md:text-3xl font-black text-[#1A1A1A] mb-4 leading-tight">{step.title}</h2>
          <p className="text-[#555555] text-base leading-relaxed mb-4">{step.body}</p>

          {step.note && (
            <p className="text-[#888888] text-sm italic border-l-2 border-[#D4AF37]/40 pl-3 mb-4">
              {step.note}
            </p>
          )}

          {step.cta && (
            <Link href={step.cta.href}>
              <span className="inline-flex items-center gap-1 text-[#B8960C] font-semibold text-sm hover:text-[#D4AF37] transition-colors">
                {step.cta.label}
              </span>
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function HowItWorksPage() {
  return (
    <>
      <SeoHead
        title="How It Works — Professional Card Grading in 5 Steps | MintVault UK"
        description="Submit your trading cards for professional grading in 5 easy steps. UK-based service from £19/card with NFC-verified slabs, AI-assisted grading, and insured return shipping."
        canonical="/how-it-works"
      />

      {/* Hero */}
      <section className="border-b border-[#E8E4DC] bg-white">
        <div className="max-w-3xl mx-auto px-6 py-16 md:py-24 text-center">
          <div className="flex justify-center mb-10">
            <MintVaultWordmark size="lg" />
          </div>
          <p className="text-[#D4AF37] text-xs font-bold uppercase tracking-[0.25em] mb-4">The Process</p>
          <h1 className="text-4xl md:text-5xl font-black text-[#1A1A1A] mb-6 leading-tight tracking-tight">
            How It Works
          </h1>
          <p className="text-lg md:text-xl text-[#666666] max-w-xl mx-auto leading-relaxed">
            From your collection to a professionally graded, NFC-verified slab — in 5 simple steps.
          </p>
        </div>
      </section>

      {/* Steps */}
      <div className="bg-white">
        {steps.map((step, i) => (
          <StepBlock key={step.num} step={step} index={i} />
        ))}
      </div>

      {/* CTA */}
      <section className="bg-gradient-to-br from-[#1A1400] to-[#2A2000] py-16 md:py-24 px-6">
        <div className="max-w-2xl mx-auto text-center space-y-6">
          <p className="text-[#D4AF37] text-xs font-bold uppercase tracking-[0.25em]">Ready?</p>
          <h2 className="text-3xl md:text-4xl font-black text-white leading-tight">
            Ready to get started?
          </h2>
          <p className="text-[#BBBBBB] text-base">
            Join collectors across the UK who trust MintVault to protect and verify their cards.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center pt-2">
            <Link href="/submit">
              <button className="gold-shimmer flex items-center justify-center gap-2 font-bold text-sm px-8 py-4 rounded-xl">
                Submit Your Cards <ArrowRight size={15} />
              </button>
            </Link>
            <Link href="/guides">
              <button className="flex items-center justify-center gap-2 border border-[#D4AF37]/40 text-[#D4AF37] font-semibold text-sm px-8 py-4 rounded-xl hover:bg-[#D4AF37]/10 transition-all">
                <HelpCircle size={15} /> See Our FAQ
              </button>
            </Link>
          </div>
        </div>
      </section>

      {/* CSS for reveal animation */}
      <style>{`
        .reveal-target {
          opacity: 0;
          transform: translateY(28px);
          transition: opacity 0.55s ease calc(var(--delay, 0ms)), transform 0.55s ease calc(var(--delay, 0ms));
        }
        .reveal-target.is-visible {
          opacity: 1;
          transform: translateY(0);
        }
      `}</style>
    </>
  );
}
