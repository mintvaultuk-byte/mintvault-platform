import { Shield, Award, BarChart3, Target, Users, CheckCircle } from "lucide-react";
import { Link } from "wouter";
import SeoHead from "@/components/seo-head";

const sections = [
  {
    id: "why-grade",
    icon: <Shield size={22} className="text-[#3c2f00]" />,
    headline: "Why Grade Your Cards?",
    text: "Professional grading protects your investment, increases buyer confidence, and creates verified market value. MintVault provides independent, consistent grading with secure tamper-evident encapsulation and full online certification lookup.",
    bullets: [
      "Independent multi-point grading system",
      "Tamper-evident precision slab",
      "Secure online verification",
      "Long-term asset protection",
      "Increased resale confidence",
    ],
  },
  {
    id: "our-labels",
    icon: <Award size={22} className="text-[#3c2f00]" />,
    headline: "Premium MintVault Labels",
    text: "MintVault labels are designed for clarity, security, and prestige. Each label features a unique certificate number, QR verification, and anti-counterfeit design elements.",
    bullets: [
      "Unique certification number",
      "QR code verification",
      "Clean professional layout",
      "Anti-tamper slab integration",
      "Premium gold-accent finish",
    ],
  },
  {
    id: "grading-scale",
    icon: <Target size={22} className="text-[#3c2f00]" />,
    headline: "MintVault Grading Scale",
    text: "Our grading system evaluates every card across multiple criteria to ensure consistent and transparent scoring.",
    bullets: ["Centering", "Corners", "Edges", "Surface"],
    footer: "Each card receives individual subgrades and an overall MintVault grade from 1 to 10, including half grades where applicable.",
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
    <div className="bg-[#131313] text-[#e5e2e1] overflow-x-hidden">
      <SeoHead
        title="Why MintVault | UK Trading Card Grading"
        description="Discover why MintVault is the UK's most trusted card grading service. Independent grading, NFC-enabled slabs, QR authentication, and insured return shipping."
        canonical="https://mintvaultuk.com/why-mintvault"
      />

      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <section className="relative flex flex-col items-center justify-center px-6 pt-20 pb-16 overflow-hidden">
        <div className="absolute top-0 -left-1/4 w-[500px] h-[400px] bg-[#f2ca50]/8 blur-[120px] rounded-full pointer-events-none" />
        <div className="absolute bottom-0 -right-1/4 w-[400px] h-[300px] bg-[#d4af37]/6 blur-[120px] rounded-full pointer-events-none" />

        <div className="max-w-3xl w-full text-center relative z-10">
          <div className="inline-flex items-center gap-2 px-4 py-1 rounded-full border border-[#f2ca50]/20 bg-[#f2ca50]/5 mb-8">
            <CheckCircle size={14} className="text-[#f2ca50]" />
            <span className="text-[#f2ca50] text-[10px] uppercase tracking-[0.2em] font-bold">Our Standards</span>
          </div>

          <h1
            className="text-5xl md:text-6xl font-black tracking-tighter text-[#e5e2e1] mb-6 leading-none"
            data-testid="text-why-title"
          >
            WHY <span className="text-[#f2ca50]">MINTVAULT</span>
          </h1>

          <p className="text-[#e5e2e1]/60 max-w-xl mx-auto text-base md:text-lg" data-testid="text-why-subtitle">
            Professional grading, premium encapsulation, and trusted verification — built for UK collectors.
          </p>
        </div>
      </section>

      {/* ── Sections ─────────────────────────────────────────────────── */}
      <section className="px-6 pb-24">
        <div className="max-w-3xl mx-auto space-y-4">
          {sections.map((section) => (
            <div
              key={section.id}
              id={section.id}
              className="bg-[#1c1b1b] rounded-2xl p-8 border border-transparent hover:border-[#f2ca50]/15 transition-all duration-500"
              data-testid={`section-${section.id}`}
            >
              <div className="flex items-start gap-5 mb-5">
                <div
                  className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0"
                  style={{ background: "linear-gradient(135deg,#f2ca50 0%,#d4af37 100%)" }}
                >
                  {section.icon}
                </div>
                <h2
                  className="text-xl md:text-2xl font-black tracking-tighter uppercase text-[#e5e2e1] pt-1.5"
                  data-testid={`text-heading-${section.id}`}
                >
                  {section.headline}
                </h2>
              </div>

              <p className="text-[#e5e2e1]/60 leading-relaxed mb-5 ml-16" data-testid={`text-body-${section.id}`}>
                {section.text}
              </p>

              {section.bullets.length > 0 && (
                <ul className="space-y-2 mb-4 ml-16">
                  {section.bullets.map((bullet, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#f2ca50] flex-shrink-0" />
                      <span className="text-[#e5e2e1]/80 text-sm" data-testid={`text-bullet-${section.id}-${i}`}>
                        {bullet}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {section.footer && (
                <p
                  className="text-[#e5e2e1]/40 text-sm italic border-t border-[#f2ca50]/10 pt-4 mt-4 ml-16"
                  data-testid={`text-footer-${section.id}`}
                >
                  {section.footer}
                </p>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* ── Bottom CTA ───────────────────────────────────────────────── */}
      <section className="px-6 pb-24">
        <div
          className="max-w-3xl mx-auto rounded-3xl p-10 flex flex-col md:flex-row items-center justify-between gap-6"
          style={{ background: "linear-gradient(135deg,#f2ca50 0%,#d4af37 100%)" }}
        >
          <div className="text-[#3c2f00] text-center md:text-left">
            <h3 className="text-2xl font-black tracking-tighter uppercase mb-1">Ready to Grade?</h3>
            <p className="font-medium opacity-80">Start your submission today. Fast UK turnaround.</p>
          </div>
          <Link href="/submit">
            <button className="bg-[#3c2f00] text-[#f2ca50] px-8 py-4 rounded-xl font-black uppercase tracking-widest text-sm active:scale-95 transition-transform whitespace-nowrap">
              Submit Cards
            </button>
          </Link>
        </div>
      </section>
    </div>
  );
}
