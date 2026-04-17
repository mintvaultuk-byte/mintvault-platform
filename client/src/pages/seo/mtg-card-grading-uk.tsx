import { Link } from "wouter";
import SeoHead from "@/components/seo-head";
import BreadcrumbNav, { breadcrumbSchema } from "@/components/breadcrumb-nav";
import FaqSection, { faqSchema } from "@/components/faq-section";
import CtaSection from "@/components/cta-section";
import { Shield, Award, CheckCircle, ArrowRight } from "lucide-react";

const breadcrumbs = [
  { label: "Home", href: "/" },
  { label: "MTG Card Grading UK" },
];

const faqs = [
  {
    question: "Does MintVault grade Magic: The Gathering cards?",
    answer: "Yes. MintVault UK grades Magic: The Gathering cards across all sets and editions, from Alpha and Beta vintage cards through to modern Special Guest and Secret Lair prints. All standard-size MTG cards are accepted.",
  },
  {
    question: "Which MTG cards are worth grading?",
    answer: "Power Nine cards, Alpha and Beta rares, dual lands, iconic foils, and high-value modern cards such as Mana Crypt, Force of Will, and fetchlands in near-mint condition are strong candidates. Any card where the raw value significantly exceeds the grading cost is worth considering.",
  },
  {
    question: "How much does MTG card grading cost in the UK?",
    answer: "MintVault UK grading starts from £19 per card. Three tiers: Vault Queue (40 working days, £19), Standard (15 working days, £25), and Express (5 working days, £45). Bulk discounts available for 10+ cards.",
  },
  {
    question: "What is the grading scale MintVault uses for MTG?",
    answer: "MintVault uses a 1–10 grading scale covering centering, corners, edges, and surface. Cards achieving 9.5 or 10 are considered Gem Mint and command significant premiums on the secondary market.",
  },
  {
    question: "Does MintVault grade non-English MTG cards?",
    answer: "Yes. MintVault grades Magic: The Gathering cards in all languages. The card language is recorded on the certificate and displayed on the slab label.",
  },
];

const schema = [
  breadcrumbSchema(breadcrumbs),
  {
    "@context": "https://schema.org",
    "@type": "Service",
    name: "MTG Card Grading UK",
    provider: { "@type": "Organization", name: "MintVault UK", url: "https://mintvaultuk.com" },
    description: "Professional Magic: The Gathering card grading in the UK. Expert grading, tamper-evident slabs, NFC verification, and verified ownership.",
    areaServed: "United Kingdom",
    serviceType: "Trading Card Grading",
  },
  faqSchema(faqs),
];

export default function MtgCardGradingUk() {
  return (
    <div className="px-4 py-10">
      <SeoHead
        title="MTG Card Grading UK | Magic: The Gathering Grading | MintVault"
        description="Professional Magic: The Gathering card grading in the UK. Grade your rarest MTG cards with MintVault — NFC-enabled slabs, verified ownership, from £19."
        canonical="https://mintvaultuk.com/mtg-card-grading-uk"
        ogImage="https://mintvaultuk.com/images/collector-lifestyle.webp"
        schema={schema}
      />

      <div className="max-w-3xl mx-auto">
        <BreadcrumbNav items={breadcrumbs} />

        <h1 className="text-3xl md:text-4xl font-bold text-[#1A1A1A] tracking-wide mb-6" data-testid="text-h1-mtg-grading">
          MTG Card Grading UK
        </h1>

        <p className="text-[#555555] text-base leading-relaxed mb-4">
          MintVault UK provides professional Magic: The Gathering card grading for collectors and investors across the United Kingdom. From Alpha Power Nine to modern Secret Lair foils, our expert graders assess every card across centering, corners, edges, and surface quality, and seal them in tamper-evident NFC-enabled precision slabs.
        </p>

        <p className="text-[#555555] text-sm leading-relaxed mb-8">
          MTG has one of the most established collectible card markets in the world. Vintage cards in high grades command enormous premiums, and even modern staples benefit from professional grading when in exceptional condition. As a UK-based service, MintVault eliminates international shipping risks and customs delays.
        </p>

        <section className="mb-10" data-testid="section-mtg-why">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">Why Grade Magic: The Gathering Cards?</h2>
          <div className="text-[#555555] text-sm leading-relaxed space-y-3">
            <p>
              <strong className="text-[#1A1A1A]">Vintage MTG commands premium grades</strong> — an Alpha Black Lotus or Mox Sapphire in Gem Mint condition can be worth multiples of the same card in ungraded form. The grade provides buyers with certainty about condition that raw cards simply cannot offer.
            </p>
            <p>
              <strong className="text-[#1A1A1A]">Authentication of high-value cards</strong> — counterfeit MTG cards exist, particularly for high-value vintage cards. A MintVault certificate provides independent authentication verifiable online.
            </p>
            <p>
              <strong className="text-[#1A1A1A]">Protection for long-term holding</strong> — sealed in a precision slab, your MTG cards are protected from the environmental damage that degrades card condition over time.
            </p>
          </div>
        </section>

        <section className="mb-10" data-testid="section-mtg-tiers">
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

        <section className="mb-10" data-testid="section-mtg-features">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              { icon: <Shield size={16} />, title: "UK-based service", desc: "No international shipping, no customs fees or import duties." },
              { icon: <Award size={16} />, title: "NFC-enabled slabs", desc: "Every slab has an NFC chip for instant certificate verification." },
              { icon: <CheckCircle size={16} />, title: "Verified ownership", desc: "Register and transfer card ownership through the MintVault registry." },
              { icon: <CheckCircle size={16} />, title: "All MTG sets accepted", desc: "Alpha through to current sets, all languages, all rarities." },
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

        <FaqSection faqs={faqs} title="MTG Card Grading FAQs" />

        <div className="mt-10">
          <CtaSection title="Grade Your MTG Cards" subtitle="Submit your Magic: The Gathering cards for professional UK grading. Insured return, NFC slabs, verified ownership." />
        </div>

        <section className="mt-10">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              { href: "/trading-card-grading-uk", label: "Trading Card Grading UK" },
              { href: "/tcg-grading-uk", label: "TCG Grading UK" },
              { href: "/psa-alternative-uk", label: "PSA Alternative UK" },
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
