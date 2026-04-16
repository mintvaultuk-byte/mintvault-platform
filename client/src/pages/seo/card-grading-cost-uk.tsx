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
    answer: "MintVault UK grading starts from £19 per card for the Vault Queue tier (40 working day turnaround). Standard is £25 (15 working days) and Express is £45 (5 working days). All prices include fully insured return shipping.",
  },
  {
    question: "Are there bulk discounts for card grading?",
    answer: "Yes. MintVault offers bulk discounts for submissions of 10 or more cards. Discounts are applied automatically: 5% off for 10–24 cards, 10% off for 25–49 cards, and 15% off for 50+ cards.",
  },
  {
    question: "What is included in the grading cost?",
    answer: "Every MintVault grading fee includes the professional grade assessment, a tamper-evident precision slab with an NFC chip, a unique online-verifiable certificate, and fully insured return shipping based on declared card value. There are no hidden fees.",
  },
  {
    question: "Is UK card grading cheaper than PSA or BGS?",
    answer: "For UK collectors, MintVault is significantly more cost-effective than PSA or BGS when you factor in international tracked shipping (£20–£40 each way), customs duties (typically 5–12% on declared value), and import VAT on return. MintVault's all-inclusive UK pricing makes the true cost far lower.",
  },
  {
    question: "What is the minimum value card worth grading?",
    answer: "As a general rule, a card should have a raw market value at least 3–4× the grading cost to make financial sense. At £19 Vault Queue tier, cards worth £60+ in near-mint condition are typically good candidates. High-grade results can multiply value significantly beyond this threshold.",
  },
];

const schema = [
  breadcrumbSchema(breadcrumbs),
  {
    "@context": "https://schema.org",
    "@type": "Service",
    name: "Card Grading Cost UK",
    provider: { "@type": "Organization", name: "MintVault UK", url: "https://mintvaultuk.com" },
    description: "Transparent card grading pricing in the UK. MintVault UK grading from £19 per card, all-inclusive with insured return shipping.",
    areaServed: "United Kingdom",
    serviceType: "Trading Card Grading",
  },
  faqSchema(faqs),
];

export default function CardGradingCostUk() {
  return (
    <div className="px-4 py-10">
      <SeoHead
        title="Card Grading Cost UK | How Much Does Card Grading Cost? | MintVault"
        description="How much does card grading cost in the UK? MintVault offers transparent all-inclusive pricing from £19 per card with insured return shipping."
        canonical="https://mintvaultuk.com/card-grading-cost-uk"
        ogImage="https://mintvaultuk.com/images/collector-lifestyle.webp"
        schema={schema}
      />

      <div className="max-w-3xl mx-auto">
        <BreadcrumbNav items={breadcrumbs} />

        <h1 className="text-3xl md:text-4xl font-bold text-[#1A1A1A] tracking-wide mb-6" data-testid="text-h1-cost">
          Card Grading Cost UK
        </h1>

        <p className="text-[#444444] text-base leading-relaxed mb-4">
          MintVault UK offers transparent, all-inclusive card grading pricing with no hidden fees. Every tier includes the professional grade assessment, tamper-evident precision slab with NFC chip, and fully insured return shipping. Choose the turnaround speed that suits your needs.
        </p>

        <p className="text-[#666666] text-sm leading-relaxed mb-8">
          Unlike sending cards abroad, MintVault's UK pricing means no international shipping costs, no customs duties, and no import VAT. What you see is what you pay.
        </p>

        <section className="mb-10" data-testid="section-cost-tiers">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">Grading Tiers & Pricing</h2>
          <div className="space-y-3">
            {[
              { tier: "Vault Queue", days: "40 working days", price: "£19/card", desc: "Best for bulk collections and standard submissions." },
              { tier: "Standard", days: "15 working days", price: "£25/card", desc: "Faster turnaround for time-sensitive submissions." },
              { tier: "Express", days: "5 working days", price: "£45/card", desc: "Priority processing for urgent or high-value cards." },
            ].map((t) => (
              <div key={t.tier} className="border border-[#D4AF37]/20 bg-[#FAFAF8] rounded-lg px-4 py-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[#1A1A1A] text-sm font-medium">{t.tier}</span>
                  <span className="text-[#D4AF37] font-bold text-sm">{t.price}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[#999999] text-xs">{t.desc}</span>
                  <span className="text-[#666666] text-xs">{t.days}</span>
                </div>
              </div>
            ))}
          </div>
          <p className="text-[#666666] text-sm mt-3">
            All tiers include fully insured return shipping. <Link href="/pricing" className="text-[#D4AF37] hover:underline">View full pricing & bulk discounts</Link>.
          </p>
        </section>

        <section className="mb-10" data-testid="section-cost-included">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">What's Included in Every Grading Fee</h2>
          <div className="space-y-2">
            {[
              "Professional grade assessment on a 1–10 scale",
              "Tamper-evident precision slab with embedded NFC chip",
              "Unique certificate number, verifiable online at any time",
              "Claim code to register verified ownership in the MintVault registry",
              "Fully insured return shipping based on declared card value",
            ].map((item) => (
              <div key={item} className="flex items-start gap-2 text-[#444444] text-sm">
                <span className="text-[#D4AF37] mt-0.5 shrink-0">✓</span>
                <span>{item}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="mb-10" data-testid="section-cost-vs-overseas">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">True Cost: UK vs Overseas Grading</h2>
          <p className="text-[#444444] text-sm leading-relaxed mb-4">
            When UK collectors send cards to overseas graders, the advertised grade fee is only part of the cost. Here's a realistic cost breakdown for sending 10 cards to a US grader:
          </p>
          <div className="border border-[#E8E4DC] bg-[#FAFAF8] rounded-lg p-4 space-y-2 text-sm mb-4">
            {[
              ["Grading fee (10 cards @ ~$25)", "~£200"],
              ["International tracked shipping (outbound)", "~£30"],
              ["Return shipping from US", "~£35"],
              ["UK customs duty (5% on declared value)", "~£15"],
              ["Import VAT (20% on value + duty)", "~£45"],
              ["Total estimated cost", "~£325"],
            ].map(([label, value], i) => (
              <div key={label} className={`flex justify-between ${i === 5 ? "pt-2 border-t border-[#E8E4DC] font-semibold text-[#1A1A1A]" : "text-[#444444]"}`}>
                <span>{label}</span>
                <span className={i === 5 ? "text-[#D4AF37]" : ""}>{value}</span>
              </div>
            ))}
          </div>
          <p className="text-[#444444] text-sm leading-relaxed">
            The same 10 cards with MintVault Vault Queue tier: <strong className="text-[#1A1A1A]">£190 all-inclusive</strong>. No customs. No import VAT. No surprises.
          </p>
        </section>

        <FaqSection faqs={faqs} title="Card Grading Cost — FAQs" />

        <div className="mt-10">
          <CtaSection title="Transparent Pricing, No Hidden Fees" subtitle="Grade your cards with MintVault — all-inclusive UK pricing from £19 per card." />
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
                <span className="flex items-center gap-2 border border-[#D4AF37]/20 bg-[#FAFAF8] rounded px-4 py-2.5 text-[#D4AF37]/70 text-sm hover:text-[#D4AF37] hover:border-[#D4AF37]/40 transition-all cursor-pointer">
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
