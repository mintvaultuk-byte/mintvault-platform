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
    answer: "See the current pricing page for available grading services, prices and turnaround. Your submission quote confirms applicable discounts, insurance, return shipping and the total before payment.",
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
    description: "The best UK card grading company — professional grading, NFC-enabled slabs, verified ownership registry. View current service options and pricing.",
    areaServed: "United Kingdom",
    serviceType: "Trading Card Grading",
  },
  faqSchema(faqs),
];

export default function BestCardGradingUk() {
  return (
    <div className="max-w-5xl mx-auto px-4 py-10 no-text-shadow">
      <SeoHead
        title="Best Card Grading UK | Top UK Card Grading Company | MintVault"
        description="Looking for the best card grading in the UK? MintVault offers professional grading, NFC slabs, and a verified ownership registry. View current service options and pricing."
        canonical="https://mintvaultuk.com/best-card-grading-uk"
        ogImage="https://mintvaultuk.com/images/collector-lifestyle.webp"
        schema={schema}
      />

      <div className="max-w-3xl mx-auto">
        <BreadcrumbNav items={breadcrumbs} />

        <h1 className="text-3xl md:text-4xl font-bold text-white tracking-wide mb-6" data-testid="text-h1-best-grading">
          Best Card Grading UK
        </h1>

        <p className="text-[#d4d4d4] text-base leading-relaxed mb-4">
          MintVault UK is the leading professional card grading service in the United Kingdom. We grade Pokemon, Yu-Gi-Oh, Magic: The Gathering, One Piece, sports cards, and all other standard-size trading cards — providing tamper-evident precision slabs with NFC tracking and a verified ownership registry that no other UK grader offers.
        </p>

        <p className="text-[#d4d4d4] text-sm leading-relaxed mb-8">
          Unlike sending your cards overseas to PSA or CGC, MintVault processes everything within the UK. That means no international shipping risk, no customs fees, no import duties, and no cards sitting at a border for weeks. Your collection stays in safe hands from submission to return.
        </p>

        <section className="mb-10" data-testid="section-best-why">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">Why MintVault Is the Best Choice</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              { icon: <Shield size={16} />, title: "UK-based, no customs", desc: "Cards never leave the UK. No import duties, no border delays, no international shipping risk." },
              { icon: <Award size={16} />, title: "NFC-enabled slabs", desc: "Every slab has an NFC chip. Buyers can verify any certificate instantly with a phone scan." },
              { icon: <CheckCircle size={16} />, title: "Verified ownership registry", desc: "The only UK grader with an ownership registry. Transfer ownership securely when you sell." },
              { icon: <Clock size={16} />, title: "Fast turnarounds", desc: "Compare current service turnaround on the pricing page." },
            ].map((item, i) => (
              <div key={i} className="flex gap-3 border border-[#D4AF37]/20 bg-[#0a0e1a]/85 backdrop-blur-sm rounded-2xl p-4">
                <div className="text-[#D4AF37] shrink-0 mt-0.5">{item.icon}</div>
                <div>
                  <h3 className="text-white font-semibold text-sm mb-1">{item.title}</h3>
                  <p className="text-[#d4d4d4] text-xs leading-relaxed">{item.desc}</p>
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
                <tr className="border-b border-[#D4AF37]/20">
                  <th className="text-left py-2 pr-4 text-white font-semibold">Feature</th>
                  <th className="text-center py-2 px-4 text-[#D4AF37] font-semibold">MintVault UK</th>
                  <th className="text-center py-2 pl-4 text-[#d4d4d4] font-semibold">Overseas (PSA etc.)</th>
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
                  <tr key={feature} className="border-b border-[#D4AF37]/20">
                    <td className="py-2.5 pr-4 text-[#d4d4d4]">{feature}</td>
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
            <Link href="/pricing" className="block px-4 py-3 text-[#D4AF37] hover:underline">
              View current grading prices and turnaround →
            </Link>
          </div>
          <p className="text-[#d4d4d4] text-sm mt-3">
            Your quote confirms insurance and return shipping before payment. <Link href="/pricing" className="text-[#D4AF37] hover:underline">View full pricing</Link>.
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
