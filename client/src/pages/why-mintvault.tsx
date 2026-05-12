import { Shield, Award, BarChart3, Target, Users, CheckCircle } from "lucide-react";
import { Link } from "wouter";
import SeoHead from "@/components/seo-head";

const sections = [
  {
    id: "why-grade",
    icon: <Shield size={22} className="text-[#3c2f00]" />,
    headline: "Why Grade Your Cards?",
    text: "Professional grading protects your investment, increases buyer confidence, and creates verified market value. MintVault provides independent, consistent grading with MintSeal tamper-evident encapsulation and full online certification lookup.",
    bullets: [
      "Independent multi-point grading system",
      "MintSeal tamper-evident precision slab",
      "Secure online verification",
      "Long-term asset protection",
      "Increased resale confidence",
    ],
  },
  {
    id: "our-labels",
    icon: <Award size={22} className="text-[#3c2f00]" />,
    headline: "Premium MintVault Labels",
    text: "MintVault labels are designed for clarity, security, and prestige. Each label features a unique certificate number and VaultLink QR verification.",
    bullets: [
      "Unique certification number",
      "VaultLink QR verification",
      "Clean professional layout",
      "MintSeal tamper integration",
      "Premium gold-accent finish",
    ],
  },
  {
    id: "grading-scale",
    icon: <Target size={22} className="text-[#3c2f00]" />,
    headline: "MintVault Grading Scale",
    text: "Our grading system evaluates every card across multiple criteria to ensure consistent and transparent scoring.",
    bullets: ["Centering", "Corners", "Edges", "Surface"],
    footer: "Each card receives an overall MintVault grade from 1 to 10, including half grades where applicable.",
  },
  {
    id: "population-report",
    icon: <BarChart3 size={22} className="text-[#3c2f00]" />,
    headline: "Population Reporting",
    text: "MintVault tracks graded cards to provide transparency in scarcity and grading distribution. Our population report shows how many cards have been graded at each level.",
    bullets: [
      "Total graded count",
      "Higher / Same / Lower comparisons",
      "Market transparency",
      "Updated regularly",
    ],
  },
  {
    id: "authority",
    icon: <Users size={22} className="text-[#3c2f00]" />,
    headline: "Built for Collectors. Trusted by Investors.",
    text: "MintVault combines professional grading standards with modern verification technology. Our goal is to provide collectors and investors with confidence, transparency, and long-term value protection.",
    bullets: [],
  },
];

export default function WhyMintVaultPage() {
  return (
    <div className="bg-white text-[#1A1A1A] overflow-x-hidden">
      <SeoHead
        title="Why MintVault | UK Trading Card Grading"
        description="Discover why MintVault is the UK's most trusted card grading service. Independent grading, VaultLock NFC slabs, VaultLink QR authentication, and insured return shipping."
        canonical="https://mintvaultuk.com/why-mintvault"
      />

      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <section className="relative flex flex-col items-center justify-center px-6 pt-20 pb-16 overflow-hidden">
        <div className="absolute top-0 -left-1/4 w-[500px] h-[400px] bg-[#D4AF37]/8 blur-[120px] rounded-full pointer-events-none" />
        <div className="absolute bottom-0 -right-1/4 w-[400px] h-[300px] bg-[#d4af37]/6 blur-[120px] rounded-full pointer-events-none" />

        <div className="max-w-3xl w-full text-center relative z-10">
          <div className="inline-flex items-center gap-2 px-4 py-1 rounded-full border border-[#D4AF37]/20 bg-[#FFF9E6] mb-8">
            <CheckCircle size={14} className="text-[#D4AF37]" />
            <span className="text-[#D4AF37] text-[10px] uppercase tracking-[0.2em] font-bold">Our Standards</span>
          </div>

          <h1
            className="text-5xl md:text-6xl font-black tracking-tighter text-[#1A1A1A] mb-6 leading-none"
            data-testid="text-why-title"
          >
            WHY <span className="gold-shimmer-text">MINTVAULT</span>
          </h1>

          <p className="text-[#666666] max-w-xl mx-auto text-base md:text-lg" data-testid="text-why-subtitle">
            Professional grading, premium encapsulation, and trusted verification — built for UK collectors.
          </p>
        </div>
      </section>

      {/* ── Sections ─────────────────────────────────────────────────── */}
      <section className="px-6 pb-24 bg-[#FAFAF8]">
        <div className="max-w-3xl mx-auto space-y-4">
          {sections.map((section, i) => (
            <div
              key={section.id}
              id={section.id}
              className="glass-card rounded-3xl p-8 reveal-on-scroll"
              data-delay={String(Math.min(i + 1, 4))}
              data-testid={`section-${section.id}`}
            >
              <div className="flex items-start gap-5 mb-5">
                <div
                  className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0"
                  style={{ background: "linear-gradient(135deg,#D4AF37 0%,#B8960C 100%)" }}
                >
                  {section.icon}
                </div>
                <h2
                  className="text-xl md:text-2xl font-black tracking-tighter uppercase text-[#1A1A1A] pt-1.5"
                  data-testid={`text-heading-${section.id}`}
                >
                  {section.headline}
                </h2>
              </div>

              <p className="text-[#666666] leading-relaxed mb-5 ml-16" data-testid={`text-body-${section.id}`}>
                {section.text}
              </p>

              {section.bullets.length > 0 && (
                <ul className="space-y-2 mb-4 ml-16">
                  {section.bullets.map((bullet, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#D4AF37] flex-shrink-0" />
                      <span className="text-[#1A1A1A] text-sm" data-testid={`text-bullet-${section.id}-${i}`}>
                        {bullet}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {section.id === "grading-scale" && (
                <div className="ml-16 mb-5">
                  <div className="flex items-end gap-1 mb-2">
                    {[1,2,3,4,5,6,7,8,9,10].map((grade) => {
                      const pct = grade / 10;
                      // Interpolate red(220,38,38) → amber(217,119,6) → gold(212,175,55)
                      const r = grade <= 5
                        ? Math.round(220 - (220-217) * ((grade-1)/4))
                        : Math.round(217 + (212-217) * ((grade-5)/5));
                      const g = grade <= 5
                        ? Math.round(38 + (119-38) * ((grade-1)/4))
                        : Math.round(119 + (175-119) * ((grade-5)/5));
                      const b = grade <= 5
                        ? Math.round(38 + (6-38) * ((grade-1)/4))
                        : Math.round(6 + (55-6) * ((grade-5)/5));
                      return (
                        <div key={grade} className="flex-1 flex flex-col items-center gap-1">
                          <div
                            style={{
                              height: `${20 + pct * 32}px`,
                              background: `rgb(${r},${g},${b})`,
                              opacity: 0.75 + pct * 0.25,
                              borderRadius: "3px 3px 0 0",
                            }}
                          />
                          <span className="text-[9px] text-[#999999] font-mono">{grade}</span>
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex justify-between text-[9px] text-[#999999] tracking-wider uppercase">
                    <span>Poor</span>
                    <span>Gem Mint</span>
                  </div>
                </div>
              )}

              {section.footer && (
                <p
                  className="text-[#999999] text-sm italic border-t border-[#E8E4DC] pt-4 mt-4 ml-16"
                  data-testid={`text-footer-${section.id}`}
                >
                  {section.footer}
                </p>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* ── Meet the Founder ─────────────────────────────────────────── */}
      <section className="px-6 pb-16">
        <div className="max-w-3xl mx-auto">
          <div className="border-l-4 border-[#D4AF37] pl-6 py-2 reveal-on-scroll" data-testid="section-founder">
            <h2 className="text-xl font-black tracking-tight text-[#1A1A1A] uppercase mb-4">Meet the Founder</h2>
            <p className="text-[#444444] text-sm leading-relaxed mb-3">
              <span className="font-semibold text-[#1A1A1A]">Cornelius Oliver</span> founded MintVault after years as a collector frustrated by slow, expensive, and US-centric grading options. His goal was simple: build the grading service he always wished existed — fast UK turnarounds, transparent pricing, and certificates collectors could actually trust.
            </p>
            <p className="text-[#444444] text-sm leading-relaxed mb-3">
              MintVault is built on a single principle: we don't buy or sell cards. That means no conflict of interest, no grade inflation to protect our own inventory, and no hidden incentives. You get an honest grade every time.
            </p>
            <p className="text-[#666666] text-xs italic">
              "I built MintVault because collectors deserve a service that works for them — not against them."
              <span className="not-italic font-semibold text-[#B8960C] ml-1">— Cornelius Oliver, Founder</span>
            </p>
          </div>
        </div>
      </section>

      {/* ── Bottom CTA ───────────────────────────────────────────────── */}
      <section className="px-6 pb-24">
        <div
          className="max-w-3xl mx-auto rounded-3xl p-10 flex flex-col md:flex-row items-center justify-between gap-6"
          style={{ background: "linear-gradient(135deg,#D4AF37 0%,#B8960C 100%)" }}
        >
          <div className="text-[#3c2f00] text-center md:text-left">
            <h3 className="text-2xl font-black tracking-tighter uppercase mb-1">Ready to Grade?</h3>
            <p className="font-medium opacity-80">Start your submission today. Fast UK turnaround.</p>
          </div>
          <Link href="/submit">
            <button className="bg-[#3c2f00] text-[#D4AF37] px-8 py-4 rounded-xl font-black uppercase tracking-widest text-sm active:scale-95 transition-transform whitespace-nowrap">
              Submit Cards
            </button>
          </Link>
        </div>
      </section>
    </div>
  );
}
