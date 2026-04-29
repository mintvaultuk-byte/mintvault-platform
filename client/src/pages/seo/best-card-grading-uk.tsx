import { Link } from "wouter";
import SeoHead from "@/components/seo-head";
import BreadcrumbNav, { breadcrumbSchema } from "@/components/breadcrumb-nav";
import FaqSection, { faqSchema } from "@/components/faq-section";
import CtaSection from "@/components/cta-section";
import { Shield, Award, Clock, CheckCircle, ArrowRight } from "lucide-react";

const breadcrumbs = [
  { label: "Home", href: "/" },
  { label: "Best Card Grading UK" },
];

const faqs = [
  {
    question: "What is the best card grading company in the UK?",
    answer: "MintVault is the leading UK-based card grading company, offering professional grading for Pokemon, Yu-Gi-Oh, Magic: The Gathering, One Piece, sports cards, and more. As a UK-native service, MintVault eliminates international shipping risks, customs delays, and import duties that affect overseas graders.",
  },
  {
    question: "Why choose a UK grading company over PSA or BGS?",
    answer: "Sending cards to PSA or BGS in the USA involves international shipping costs, customs fees, lengthy delays, and the risk of loss or damage in transit. MintVault processes cards entirely within the UK — faster turnarounds, no customs, and no risk of cards being held at the border.",
  },
  {
    question: "What makes MintVault different from other UK graders?",
    answer: "MintVault is the only UK grading company to offer NFC-enabled precision slabs with a verified ownership registry. Every certificate is verifiable online. When you sell a graded card, ownership transfers to the buyer via a secure email-verified process — giving buyers confidence that no other UK grader can match.",
  },
  {
    question: "How much does professional card grading cost in the UK?",
    answer: "MintVault UK grading starts from £19 per card (Vault Queue, 40 working days) up to £45 (Express, 5 working days). All tiers include fully insured return shipping. Bulk discounts apply for 10 or more cards.",
  },
  {
    question: "Is MintVault recognised for resale on eBay and other platforms?",
    answer: "Yes. MintVault graded cards sell successfully on eBay, Vinted, Facebook Marketplace, and specialist trading card platforms. The online-verifiable certificate gives buyers confidence to purchase without physical inspection.",
  },
];

const schema = [
  breadcrumbSchema(breadcrumbs),
  {
    "@context": "https://schema.org",
    "@type": "Service",
    name: "Best Card Grading UK",
    provider: { "@type": "Organization", name: "MintVault UK", url: "https://mintvaultuk.com" },
    description: "The best UK card grading company — professional grading, NFC-enabled slabs, verified ownership registry. From £19 per card.",
    areaServed: "United Kingdom",
    serviceType: "Trading Card Grading",
  },
  faqSchema(faqs),
];

export default function BestCardGradingUk() {
  return (
    <div className="px-4 py-10">
      <SeoHead
        title="Best Card Grading UK | Top UK Card Grading Company | MintVault"
        description="Looking for the best card grading in the UK? MintVault offers professional grading, NFC slabs, and a verified ownership registry — from £19 per card."
        canonical="https://mintvaultuk.com/best-card-grading-uk"
        ogImage="https://mintvaultuk.com/images/collector-lifestyle.webp"
        schema={schema}
      />

      <div className="max-w-3xl mx-auto">
        <BreadcrumbNav items={breadcrumbs} />

        <h1 className="text-3xl md:text-4xl font-bold text-[#1A1A1A] tracking-wide mb-6" data-testid="text-h1-best-grading">
          Best Card Grading UK
        </h1>

        <p className="text-[#555555] text-base leading-relaxed mb-4">
          MintVault UK is the leading professional card grading service in the United Kingdom. We grade Pokemon, Yu-Gi-Oh, Magic: The Gathering, One Piece, sports cards, and all other standard-size trading cards — providing tamper-evident precision slabs with NFC tracking and a verified ownership registry that no other UK grader offers.
        </p>

        <p className="text-[#555555] text-sm leading-relaxed mb-8">
          Unlike sending your cards overseas to PSA or CGC, MintVault processes everything within the UK. That means no international shipping risk, no customs fees, no import duties, and no cards sitting at a border for weeks. Your collection stays in safe hands from submission to return.
        </p>

        <section className="mb-10" data-testid="section-best-why">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">Why MintVault Is the Best Choice</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              { icon: <Shield size={16} />, title: "UK-based, no customs", desc: "Cards never leave the UK. No import duties, no border delays, no international shipping risk." },
              { icon: <Award size={16} />, title: "NFC-enabled slabs", desc: "Every slab has an NFC chip. Buyers can verify any certificate instantly with a phone scan." },
              { icon: <CheckCircle size={16} />, title: "Verified ownership registry", desc: "The only UK grader with an ownership registry. Transfer ownership securely when you sell." },
              { icon: <Clock size={16} />, title: "Fast turnarounds", desc: "Vault Queue (40 days), Standard (15 days), or Express (5 days). Choose the speed you need." },
            ].map((item, i) => (
              <div key={i} className="flex gap-3 border border-[#D4AF37]/20 bg-[#FAFAF8] rounded-2xl p-4">
                <div className="text-[#D4AF37] shrink-0 mt-0.5">{item.icon}</div>
                <div>
                  <h3 className="text-[#1A1A1A] font-semibold text-sm mb-1">{item.title}</h3>
                  <p className="text-[#555555] text-xs leading-relaxed">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="mb-10" data-testid="section-best-comparison">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">MintVault vs Sending Abroad</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-[#E8E4DC]">
                  <th className="text-left py-2 pr-4 text-[#1A1A1A] font-semibold">Feature</th>
                  <th className="text-center py-2 px-4 text-[#D4AF37] font-semibold">MintVault UK</th>
                  <th className="text-center py-2 pl-4 text-[#555555] font-semibold">Overseas (PSA etc.)</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["UK-based processing", "✓", "✗"],
                  ["No customs fees", "✓", "✗"],
                  ["NFC chip verification", "✓", "✗"],
                  ["Verified ownership registry", "✓", "✗"],
                  ["Online cert lookup", "✓", "✓"],
                  ["Insured return shipping", "✓", "✓"],
                ].map(([feature, mv, overseas]) => (
                  <tr key={feature} className="border-b border-[#E8E4DC]">
                    <td className="py-2.5 pr-4 text-[#555555]">{feature}</td>
                    <td className="py-2.5 px-4 text-center text-emerald-600 font-medium">{mv}</td>
                    <td className="py-2.5 pl-4 text-center text-[#888888]">{overseas}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mb-10" data-testid="section-best-tiers">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">Service Tiers & Pricing</h2>
          <div className="space-y-3">
            {[
              { tier: "Vault Queue", days: "40 working days", price: "£19/card" },
              { tier: "Standard", days: "15 working days", price: "£25/card" },
              { tier: "Express", days: "5 working days", price: "£45/card" },
            ].map((t) => (
              <div key={t.tier} className="flex items-center justify-between border border-[#D4AF37]/20 bg-[#FAFAF8] rounded-lg px-4 py-3">
                <span className="text-[#1A1A1A] text-sm font-medium">{t.tier}</span>
                <span className="text-[#555555] text-sm">{t.days}</span>
                <span className="text-[#D4AF37] font-bold text-sm">{t.price}</span>
              </div>
            ))}
          </div>
          <p className="text-[#555555] text-sm mt-3">
            All tiers include fully insured return shipping. <Link href="/pricing" className="text-[#D4AF37] hover:underline">View full pricing</Link>.
          </p>
        </section>

        <FaqSection faqs={faqs} title="Best Card Grading UK — FAQs" />

        <div className="mt-10">
          <CtaSection title="Grade With the Best" subtitle="Submit your cards to the UK's leading grading service. NFC slabs, verified ownership, insured return." />
        </div>

        <section className="mt-10">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              { href: "/trading-card-grading-uk", label: "Trading Card Grading UK" },
              { href: "/psa-alternative-uk", label: "PSA Alternative UK" },
              { href: "/card-grading-cost-uk", label: "Card Grading Cost UK" },
              { href: "/pricing", label: "View All Pricing" },
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
