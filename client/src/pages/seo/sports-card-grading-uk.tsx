import { Link } from "wouter";
import SeoHead from "@/components/seo-head";
import BreadcrumbNav, { breadcrumbSchema } from "@/components/breadcrumb-nav";
import FaqSection, { faqSchema } from "@/components/faq-section";
import CtaSection from "@/components/cta-section";
import { Shield, Award, CheckCircle, ArrowRight } from "lucide-react";

const breadcrumbs = [
  { label: "Home", href: "/" },
  { label: "Sports Card Grading UK" },
];

const faqs = [
  {
    question: "Does MintVault grade sports cards in the UK?",
    answer: "Yes. MintVault UK grades sports cards alongside trading card games. We accept football cards, basketball cards, cricket cards, and other standard-size sports cards. All cards must be standard dimensions (63mm × 88mm) to fit our precision slabs.",
  },
  {
    question: "What sports cards are worth grading?",
    answer: "Rookie cards of prominent players, limited print run parallels, autographed cards, and any card in near-mint or better condition with a raw market value above the grading cost are strong candidates. Graded Erling Haaland, Marcus Rashford, and Premier League rookie cards regularly sell for significant premiums.",
  },
  {
    question: "How much does sports card grading cost in the UK?",
    answer: "MintVault UK grading starts from £19 per card. Three service tiers: Vault Queue (40 working days, £19), Standard (15 working days, £25), Express (5 working days, £45). Bulk discounts apply for 10 or more cards. All prices include insured return shipping.",
  },
  {
    question: "How are sports cards graded by MintVault?",
    answer: "Each card is assessed on a 1–10 scale across four categories: centering, corners, edges, and surface quality. Cards are then sealed in a tamper-evident precision slab with an NFC chip and a unique certificate number verifiable online.",
  },
  {
    question: "Can I grade oversized or non-standard sports cards?",
    answer: "MintVault currently grades standard-size cards (63mm × 88mm). Oversized or non-standard cards cannot be accepted at this time. Contact us if you are unsure whether your cards qualify.",
  },
];

const schema = [
  breadcrumbSchema(breadcrumbs),
  {
    "@context": "https://schema.org",
    "@type": "Service",
    name: "Sports Card Grading UK",
    provider: { "@type": "Organization", name: "MintVault UK", url: "https://mintvaultuk.com" },
    description: "Professional sports card grading in the UK. Football, basketball, cricket and more. Tamper-evident slabs, NFC verification, and verified ownership.",
    areaServed: "United Kingdom",
    serviceType: "Sports Card Grading",
  },
  faqSchema(faqs),
];

export default function SportsCardGradingUk() {
  return (
    <div className="px-4 py-10">
      <SeoHead
        title="Sports Card Grading UK | Football & Basketball Card Grading | MintVault"
        description="Professional sports card grading in the UK. Grade your football, basketball, and cricket cards with MintVault — verified ownership, tamper-evident slabs."
        canonical="https://mintvaultuk.com/sports-card-grading-uk"
        ogImage="https://mintvaultuk.com/images/collector-lifestyle.webp"
        schema={schema}
      />

      <div className="max-w-3xl mx-auto">
        <BreadcrumbNav items={breadcrumbs} />

        <h1 className="text-3xl md:text-4xl font-bold text-[#1A1A1A] tracking-wide mb-6" data-testid="text-h1-sports-grading">
          Sports Card Grading UK
        </h1>

        <p className="text-[#555555] text-base leading-relaxed mb-4">
          MintVault UK provides professional sports card grading for collectors and investors in the United Kingdom. Whether you collect Premier League football cards, NBA basketball cards, cricket cards, or other sports collectibles, our expert grading service authenticates and protects your cards in tamper-evident precision slabs.
        </p>

        <p className="text-[#555555] text-sm leading-relaxed mb-8">
          The UK sports card market has grown significantly, with top Premier League rookie cards, player parallels, and autographs commanding considerable prices on the secondary market. Professional grading is now essential for any serious sports card investor or collector.
        </p>

        <section className="mb-10" data-testid="section-sports-why">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">Why Grade Sports Cards?</h2>
          <div className="text-[#555555] text-sm leading-relaxed space-y-3">
            <p>
              <strong className="text-[#1A1A1A]">Protect rookie card value</strong> — a professionally graded Erling Haaland or Jude Bellingham rookie card in Gem Mint condition sells for dramatically more than an ungraded equivalent. The grade removes buyer uncertainty about card condition.
            </p>
            <p>
              <strong className="text-[#1A1A1A]">Verify authenticity</strong> — with the rise of counterfeit sports cards, grading provides authentication from an independent third party. Each MintVault certificate is verifiable online.
            </p>
            <p>
              <strong className="text-[#1A1A1A]">UK-based processing</strong> — no customs delays, no international shipping risks. Your cards stay within the UK throughout the entire process.
            </p>
          </div>
        </section>

        <section className="mb-10" data-testid="section-sports-tiers">
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

        <section className="mb-10" data-testid="section-sports-ownership">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">Verified Ownership for Sports Cards</h2>
          <p className="text-[#555555] text-sm leading-relaxed">
            MintVault is the only UK grading company with a verified ownership registry. When you sell a graded sports card, ownership can be transferred to the buyer through a secure two-step email-verified process. This gives buyers confidence that the card's ownership history is verified and recorded — particularly valuable for high-profile player cards where provenance matters.
          </p>
        </section>

        <section className="mb-10" data-testid="section-sports-features">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              { icon: <Shield size={16} />, title: "UK-based service", desc: "No international shipping, no customs fees or delays." },
              { icon: <Award size={16} />, title: "NFC-enabled slabs", desc: "Instant verification with NFC chip embedded in every slab." },
              { icon: <CheckCircle size={16} />, title: "Verified ownership", desc: "Register and transfer card ownership through our registry." },
              { icon: <CheckCircle size={16} />, title: "Insured return shipping", desc: "Cards returned via fully insured tracked delivery." },
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

        <FaqSection faqs={faqs} title="Sports Card Grading FAQs" />

        <div className="mt-10">
          <CtaSection title="Grade Your Sports Cards" subtitle="Submit your football, basketball, or cricket cards for professional grading. Fast turnaround, insured return." />
        </div>

        <section className="mt-10">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              { href: "/trading-card-grading-uk", label: "Trading Card Grading UK" },
              { href: "/card-grading-service-uk", label: "Card Grading Service UK" },
              { href: "/pricing", label: "View All Pricing" },
              { href: "/psa-alternative-uk", label: "PSA Alternative UK" },
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
