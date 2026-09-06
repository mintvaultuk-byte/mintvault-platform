import { Link } from "wouter";
import SeoHead from "@/components/seo-head";
import BreadcrumbNav, { breadcrumbSchema } from "@/components/breadcrumb-nav";
import FaqSection, { faqSchema } from "@/components/faq-section";
import CtaSection from "@/components/cta-section";
import { ArrowRight } from "lucide-react";

const breadcrumbs = [
  { label: "Home", href: "/" },
  { label: "Card Grading Cost UK" },
];

const faqs = [
  {
    question: "How much does card grading cost in the UK?",
    answer: "See the current pricing page for available grading services, prices and turnaround. Your submission quote confirms applicable discounts, insurance, return shipping and the total before payment.",
  },
  {
    question: "Are there bulk discounts for card grading?",
    // keep in sync with bulkDiscountTiers (shared/schema.ts); serialised into faqSchema JSON-LD (Google-indexed).
    answer: "Yes. MintVault offers bulk discounts for submissions of 10 or more cards. Discounts are applied automatically: 5% off for 10–24 cards, 7.5% off for 25–49 cards, and 10% off for 50+ cards.",
  },
  {
    question: "What is included in the grading cost?",
    answer: "Compare current service features on the pricing page. Your submission quote separately confirms grading, applicable discounts, insurance, return shipping and the total before payment.",
  },
  {
    question: "Is UK card grading cheaper than PSA or BGS?",
    answer: "Compare complete current quotes, including grading, shipping, insurance, currency conversion and any applicable import charges. Overseas examples are illustrative rather than current provider prices or tax advice.",
  },
  {
    question: "What is the minimum value card worth grading?",
    answer: "Compare the current submission quote with your card’s realistic market value and your reasons for grading. A grade or resale gain is not guaranteed. See the current pricing page for fees and available services.",
  },
];

const schema = [
  breadcrumbSchema(breadcrumbs),
  {
    "@context": "https://schema.org",
    "@type": "Service",
    name: "Card Grading Cost UK",
    provider: { "@type": "Organization", name: "MintVault UK", url: "https://mintvaultuk.com" },
    description: "Compare current MintVault UK grading prices and service options. Your quote confirms grading, discounts, insurance and shipping before payment.",
    areaServed: "United Kingdom",
    serviceType: "Trading Card Grading",
  },
  faqSchema(faqs),
];

export default function CardGradingCostUk() {
  return (
    <div className="max-w-5xl mx-auto px-4 py-10 no-text-shadow">
      <SeoHead
        title="Card Grading Cost UK | How Much Does Card Grading Cost? | MintVault"
        description="How much does card grading cost in the UK? Compare current MintVault services, prices, discounts, insurance and return shipping."
        canonical="https://mintvaultuk.com/card-grading-cost-uk"
        ogImage="https://mintvaultuk.com/images/collector-lifestyle.webp"
        schema={schema}
      />

      <div className="max-w-3xl mx-auto">
        <BreadcrumbNav items={breadcrumbs} />

        <h1 className="text-3xl md:text-4xl font-bold text-white tracking-wide mb-6" data-testid="text-h1-cost">
          Card Grading Cost UK
        </h1>

        <p className="text-[#d4d4d4] text-base leading-relaxed mb-4">
          Compare current MintVault grading services and their features. Your submission quote confirms the grading fee, applicable discounts, insurance, return shipping and total before payment.
        </p>

        <p className="text-[#d4d4d4] text-sm leading-relaxed mb-8">
          Unlike sending cards abroad, MintVault's UK pricing means no international shipping costs, no customs duties, and no import VAT. What you see is what you pay.
        </p>

        <section className="mb-10" data-testid="section-cost-tiers">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">Grading Tiers & Pricing</h2>
          <div className="space-y-3">
            <Link href="/pricing" className="block px-4 py-3 text-[#D4AF37] hover:underline">
              View current grading prices and turnaround →
            </Link>
          </div>
          <p className="text-[#d4d4d4] text-sm mt-3">
            Your quote confirms insurance and return shipping before payment. <Link href="/pricing" className="text-[#D4AF37] hover:underline">View full pricing & bulk discounts</Link>.
          </p>
        </section>

        <section className="mb-10" data-testid="section-cost-included">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">Grading and Return Service</h2>
          <div className="space-y-2">
            {[
              "Professional grade assessment on a 1–10 scale",
              "Tamper-evident precision slab with embedded NFC chip",
              "Unique certificate number, verifiable online at any time",
              "Claim code to register verified ownership in the MintVault registry",
              "Return shipping and insurance based on declared value, separately confirmed in your quote",
            ].map((item) => (
              <div key={item} className="flex items-start gap-2 text-[#d4d4d4] text-sm">
                <span className="text-[#D4AF37] mt-0.5 shrink-0">✓</span>
                <span>{item}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="mb-10" data-testid="section-cost-vs-overseas">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">True Cost: UK vs Overseas Grading</h2>
          <p className="text-[#d4d4d4] text-sm leading-relaxed mb-4">
            When UK collectors send cards to overseas graders, the advertised grade fee is only part of the cost. This is an illustrative budgeting example for 10 cards, not current provider prices or tax advice. Check current quotes and applicable import requirements.
          </p>
          <div className="border border-[#D4AF37]/20 bg-[#0a0e1a]/85 backdrop-blur-sm rounded-lg p-4 space-y-2 text-sm mb-4">
            {[
              ["Grading fee (10 cards @ ~$25)", "~£200"],
              ["International tracked shipping (outbound)", "~£30"],
              ["Return shipping from US", "~£35"],
              ["Illustrative customs-charge allowance (if applicable)", "~£15"],
              ["Illustrative import-tax allowance (if applicable)", "~£45"],
              ["Total estimated cost", "~£325"],
            ].map(([label, value], i) => (
              <div key={label} className={`flex justify-between ${i === 5 ? "pt-2 border-t border-[#D4AF37]/20 font-semibold text-white" : "text-[#d4d4d4]"}`}>
                <span>{label}</span>
                <span className={i === 5 ? "text-[#D4AF37]" : ""}>{value}</span>
              </div>
            ))}
          </div>
          <p className="text-[#d4d4d4] text-sm leading-relaxed">
            For MintVault, use the <Link href="/pricing" className="text-[#D4AF37] hover:underline">current pricing page</Link> and your submission quote to compare grading, eligible discounts, insurance and return shipping. Add your outbound postage to compare the complete cost.
          </p>
        </section>

        <FaqSection faqs={faqs} title="Card Grading Cost — FAQs" />

        <div className="mt-10">
          <CtaSection title="Compare Current Grading Prices" subtitle="Your submission quote confirms the service, discounts, insurance and shipping before payment." />
        </div>

        <section className="mt-10">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              { href: "/pricing", label: "Full Pricing Page" },
              { href: "/best-card-grading-uk", label: "Best Card Grading UK" },
              { href: "/psa-alternative-uk", label: "PSA Alternative UK" },
              { href: "/card-grading-service-uk", label: "Card Grading Service UK" },
            ].map((link) => (
              <Link key={link.href} href={link.href}>
                <span className="flex items-center gap-2 border border-[#D4AF37]/45 bg-[#0a0e1a]/70 backdrop-blur-sm rounded px-4 py-2.5 text-[#D4AF37] text-sm hover:border-[#D4AF37]/70 hover:bg-[#0a0e1a]/85 transition-all cursor-pointer">
                  <ArrowRight size={14} /> {link.label}
                </span>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
