import { Shield, Award, BarChart3, Target, Users } from "lucide-react";

const sections = [
  {
    id: "why-grade",
    icon: <Shield size={28} />,
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
    icon: <Award size={28} />,
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
    icon: <Target size={28} />,
    headline: "MintVault Grading Scale",
    text: "Our grading system evaluates every card across multiple criteria to ensure consistent and transparent scoring.",
    bullets: [
      "Centering",
      "Corners",
      "Edges",
      "Surface",
    ],
    footer: "Each card receives individual subgrades and an overall MintVault grade from 1 to 10, including half grades where applicable.",
  },
  {
    id: "population-report",
    icon: <BarChart3 size={28} />,
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
    icon: <Users size={28} />,
    headline: "Built for Collectors. Trusted by Investors.",
    text: "MintVault combines professional grading standards with modern verification technology. Our goal is to provide collectors and investors with confidence, transparency, and long-term value protection.",
    bullets: [],
  },
];

export default function WhyMintVaultPage() {
  return (
    <div className="px-4 py-12 max-w-3xl mx-auto">
      <h1
        className="text-3xl md:text-4xl font-bold text-[#D4AF37] tracking-widest text-center mb-4 glow-gold"
        data-testid="text-why-title"
      >
        WHY MINTVAULT
      </h1>
      <p className="text-gray-400 text-center mb-12 max-w-xl mx-auto" data-testid="text-why-subtitle">
        Professional grading, premium encapsulation, and trusted verification — built for UK collectors.
      </p>

      <div className="space-y-12">
        {sections.map((section) => (
          <section
            key={section.id}
            id={section.id}
            className="border border-[#D4AF37]/20 rounded-lg p-6 md:p-8"
            data-testid={`section-${section.id}`}
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 border border-[#D4AF37]/40 rounded-lg flex items-center justify-center text-[#D4AF37] shrink-0">
                {section.icon}
              </div>
              <h2
                className="text-xl md:text-2xl font-bold text-[#D4AF37] tracking-wide glow-gold-sm"
                data-testid={`text-heading-${section.id}`}
              >
                {section.headline}
              </h2>
            </div>

            <p className="text-gray-300 leading-relaxed mb-5" data-testid={`text-body-${section.id}`}>
              {section.text}
            </p>

            {section.bullets.length > 0 && (
              <ul className="space-y-2 mb-4">
                {section.bullets.map((bullet, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className="text-[#D4AF37] mt-0.5">•</span>
                    <span className="text-[#D4AF37]/90 text-sm" data-testid={`text-bullet-${section.id}-${i}`}>
                      {bullet}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {section.footer && (
              <p className="text-gray-400 text-sm italic border-t border-[#D4AF37]/10 pt-4 mt-4" data-testid={`text-footer-${section.id}`}>
                {section.footer}
              </p>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
