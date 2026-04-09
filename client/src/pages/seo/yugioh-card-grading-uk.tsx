import { Link } from "wouter";
import SeoHead from "@/components/seo-head";
import BreadcrumbNav, { breadcrumbSchema } from "@/components/breadcrumb-nav";
import FaqSection, { faqSchema } from "@/components/faq-section";
import CtaSection from "@/components/cta-section";
import { Shield, Award, Clock, CheckCircle, ArrowRight } from "lucide-react";

const breadcrumbs = [
  { label: "Home", href: "/" },
  { label: "Yu-Gi-Oh Card Grading UK" },
];

const faqs = [
  {
    question: "Can I grade Yu-Gi-Oh cards in the UK?",
    answer: "Yes. MintVault UK grades Yu-Gi-Oh cards alongside all other major TCGs. We accept cards from all Yu-Gi-Oh sets and editions, including vintage Blue-Eyes and Dark Magician cards, modern chase cards, and first edition prints.",
  },
  {
    question: "What Yu-Gi-Oh cards are worth grading?",
    answer: "First edition cards from the early WOTC era, BEWD and Dark Magician variants, limited print tournament rewards, and high-value modern rarities like collector rares and starlight rares are ideal grading candidates. Any card in near-mint condition with a raw value above the grading cost is worth considering.",
  },
  {
    question: "How much does Yu-Gi-Oh card grading cost with MintVault?",
    answer: "MintVault UK offers grading from £12 per card (Standard, 20 working days), £15 (Priority, 10 working days), and £20 (Express, 5 working days). Bulk discounts apply for 10 or more cards. All prices include fully insured return shipping.",
  },
  {
    question: "How long does YGO card grading take?",
    answer: "Turnaround depends on your chosen tier. Standard is 20 working days, Priority is 10 working days, and Express is 5 working days. You can track your submission status online at any time.",
  },
  {
    question: "What grading scale is used for Yu-Gi-Oh cards?",
    answer: "MintVault uses a professional 1–10 grading scale assessing centering, corners, edges, and surface quality. Each graded card receives a tamper-evident precision slab with a unique certificate number that can be verified online.",
  },
];

const schema = [
  breadcrumbSchema(breadcrumbs),
  {
    "@context": "https://schema.org",
    "@type": "Service",
    name: "Yu-Gi-Oh Card Grading UK",
    provider: { "@type": "Organization", name: "MintVault UK", url: "https://mintvaultuk.com" },
    description: "Professional Yu-Gi-Oh card grading service in the UK. Expert grading, tamper-evident slabs, NFC verification, and verified ownership.",
    areaServed: "United Kingdom",
    serviceType: "Trading Card Grading",
  },
  faqSchema(faqs),
];

export default function YugiohCardGradingUk() {
  return (
    <div className="px-4 py-10">
      <SeoHead
        title="Yu-Gi-Oh Card Grading UK | Professional YGO Grading | MintVault"
        description="Professional Yu-Gi-Oh card grading in the UK. Grade your rarest YGO cards with MintVault — tamper-evident slabs, NFC verification, from £12 per card."
        canonical="https://mintvaultuk.com/yugioh-card-grading-uk"
        ogImage="https://mintvaultuk.com/images/collector-lifestyle.webp"
        schema={schema}
      />

      <div className="max-w-3xl mx-auto">
        <BreadcrumbNav items={breadcrumbs} />

        <h1 className="text-3xl md:text-4xl font-bold text-[#1A1A1A] tracking-wide mb-6" data-testid="text-h1-yugioh-grading">
          Yu-Gi-Oh Card Grading UK
        </h1>

        <p className="text-[#444444] text-base leading-relaxed mb-4">
          MintVault UK offers professional Yu-Gi-Oh card grading for collectors and investors across the United Kingdom. Whether you have vintage first edition Blue-Eyes White Dragon cards, high-value tournament rewards, or modern collector and starlight rares, our grading service provides expert assessment and tamper-evident encapsulation to protect and authenticate your cards.
        </p>

        <p className="text-[#666666] text-sm leading-relaxed mb-8">
          Every graded Yu-Gi-Oh card receives a unique certificate number and is placed in a precision slab with an NFC chip for instant verification. Ownership can be registered and transferred through our verified ownership registry — the only service of its kind offered by a UK grading company.
        </p>

        <section className="mb-10" data-testid="section-why-grade-ygo">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">Why Grade Your Yu-Gi-Oh Cards?</h2>
          <div className="text-[#444444] text-sm leading-relaxed space-y-3">
            <p>
              <strong className="text-[#1A1A1A]">Increased resale value</strong> — professionally graded Yu-Gi-Oh cards consistently sell for significantly more than their raw counterparts. A high-grade first edition card can command a considerable premium on platforms like eBay and TCGPlayer.
            </p>
            <p>
              <strong className="text-[#1A1A1A]">Authentication</strong> — counterfeit Yu-Gi-Oh cards are increasingly common, particularly for high-value vintage cards. Grading confirms your card is genuine. Each MintVault certificate can be <Link href="/cert" className="text-[#D4AF37] hover:underline">verified online</Link>.
            </p>
            <p>
              <strong className="text-[#1A1A1A]">Protection</strong> — sealed in a tamper-evident precision slab, your Yu-Gi-Oh card is shielded from fingerprints, moisture, UV exposure, and bending. The card's condition is preserved indefinitely.
            </p>
          </div>
        </section>

        <section className="mb-10" data-testid="section-ygo-tiers">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">Yu-Gi-Oh Grading Service Tiers</h2>
          <div className="space-y-3">
            {[
              { tier: "Standard", days: "20 working days", price: "£12/card" },
              { tier: "Priority", days: "10 working days", price: "£15/card" },
              { tier: "Express", days: "5 working days", price: "£20/card" },
            ].map((t) => (
              <div key={t.tier} className="flex items-center justify-between border border-[#D4AF37]/20 bg-[#FAFAF8] rounded-lg px-4 py-3">
                <span className="text-[#1A1A1A] text-sm font-medium">{t.tier}</span>
                <span className="text-[#666666] text-sm">{t.days}</span>
                <span className="text-[#D4AF37] font-bold text-sm">{t.price}</span>
              </div>
            ))}
          </div>
          <p className="text-[#666666] text-sm mt-3">
            All tiers include fully insured return shipping. <Link href="/pricing" className="text-[#D4AF37] hover:underline">View full pricing</Link>.
          </p>
        </section>

        <section className="mb-10" data-testid="section-ygo-ownership">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">Verified Ownership for Yu-Gi-Oh Cards</h2>
          <p className="text-[#444444] text-sm leading-relaxed mb-3">
            MintVault is the only UK grading company offering a verified ownership registry. After your Yu-Gi-Oh card is graded and returned, you can register as the verified owner using the unique claim code included with your slab. Your ownership is then recorded on the MintVault registry and can be transferred to a new owner when you sell.
          </p>
          <p className="text-[#444444] text-sm leading-relaxed">
            This makes it straightforward for buyers to verify that the card being sold matches its certificate and that the seller is the registered owner — a significant trust advantage when selling high-value vintage Yu-Gi-Oh cards.
          </p>
        </section>

        <section className="mb-10" data-testid="section-ygo-why-mintvault">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">Why Choose MintVault for Yu-Gi-Oh Grading?</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              { icon: <Shield size={16} />, title: "UK-based service", desc: "No international shipping, no customs fees, no import duties." },
              { icon: <Award size={16} />, title: "NFC-enabled slabs", desc: "Every slab has an NFC chip for instant certificate verification." },
              { icon: <Clock size={16} />, title: "Fast turnaround", desc: "Express tier available in 5 working days." },
              { icon: <CheckCircle size={16} />, title: "Verified ownership", desc: "Register and transfer card ownership through the MintVault registry." },
            ].map((item, i) => (
              <div key={i} className="flex gap-3 border border-[#D4AF37]/20 bg-[#FAFAF8] rounded-2xl p-4">
                <div className="text-[#D4AF37] shrink-0 mt-0.5">{item.icon}</div>
                <div>
                  <h3 className="text-[#1A1A1A] font-semibold text-sm mb-1">{item.title}</h3>
                  <p className="text-[#666666] text-xs leading-relaxed">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <FaqSection faqs={faqs} title="Yu-Gi-Oh Card Grading FAQs" />

        <div className="mt-10">
          <CtaSection title="Ready to Grade Your Yu-Gi-Oh Cards?" subtitle="Submit your cards online in minutes. Fast turnaround, insured return shipping, verified ownership." />
        </div>

        <section className="mt-10" data-testid="section-ygo-related">
          <h2 className="text-lg font-bold text-[#D4AF37] tracking-wide mb-4">Related Services</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              { href: "/trading-card-grading-uk", label: "Trading Card Grading UK" },
              { href: "/pokemon-card-grading-uk", label: "Pokemon Card Grading UK" },
              { href: "/tcg-grading-uk", label: "TCG Grading UK" },
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
