import { Link } from "wouter";
import SeoHead from "@/components/seo-head";
import BreadcrumbNav, { breadcrumbSchema } from "@/components/breadcrumb-nav";
import FaqSection, { faqSchema } from "@/components/faq-section";
import CtaSection from "@/components/cta-section";
import { Shield, Award, Clock, CheckCircle, ArrowRight } from "lucide-react";

const breadcrumbs = [
  { label: "Home", href: "/" },
  { label: "One Piece Card Grading UK" },
];

const faqs = [
  {
    question: "Can I grade One Piece cards in the UK?",
    answer: "Yes. MintVault UK accepts One Piece TCG cards for grading alongside all other major trading card games. We grade all sets and rarities including Secret Rares, Alt Art cards, and Manga illustrations.",
  },
  {
    question: "Are One Piece cards worth grading?",
    answer: "High-value One Piece cards — particularly Luffy alt arts, Secret Rares, and cards from early sets — can significantly increase in value when professionally graded. If the raw card value exceeds the grading cost and the card is in near-mint or better condition, grading is typically worthwhile.",
  },
  {
    question: "How much does One Piece card grading cost in the UK?",
    answer: "MintVault UK grading starts from £19 per card (Vault Queue, 40 working days). Standard is £25 (15 working days) and Express is £45 (5 working days). Bulk discounts are available for submissions of 10 or more cards.",
  },
  {
    question: "How are One Piece cards returned after grading?",
    answer: "Every graded card is sealed in a tamper-evident precision slab with a unique MintVault certificate number and NFC chip. Cards are returned via fully insured tracked shipping. Each certificate can be verified online at mintvaultuk.com/cert.",
  },
  {
    question: "Does MintVault grade Japanese One Piece cards?",
    answer: "Yes. MintVault grades One Piece cards in all languages, including Japanese, English, and other language editions. The language is recorded on the certificate and visible on the slab label.",
  },
];

const schema = [
  breadcrumbSchema(breadcrumbs),
  {
    "@context": "https://schema.org",
    "@type": "Service",
    name: "One Piece Card Grading UK",
    provider: { "@type": "Organization", name: "MintVault UK", url: "https://mintvaultuk.com" },
    description: "Professional One Piece card grading service in the UK. Expert grading, tamper-evident slabs, NFC verification, and verified ownership.",
    areaServed: "United Kingdom",
    serviceType: "Trading Card Grading",
  },
  faqSchema(faqs),
];

export default function OnePieceCardGradingUk() {
  return (
    <div className="px-4 py-10">
      <SeoHead
        title="One Piece Card Grading UK | Professional TCG Grading | MintVault"
        description="Professional One Piece card grading in the UK. Protect and authenticate your rarest One Piece cards with MintVault — NFC-enabled slabs from £19."
        canonical="https://mintvaultuk.com/one-piece-card-grading-uk"
        ogImage="https://mintvaultuk.com/images/collector-lifestyle.webp"
        schema={schema}
      />

      <div className="max-w-3xl mx-auto">
        <BreadcrumbNav items={breadcrumbs} />

        <h1 className="text-3xl md:text-4xl font-bold text-[#1A1A1A] tracking-wide mb-6" data-testid="text-h1-onepiece-grading">
          One Piece Card Grading UK
        </h1>

        <p className="text-[#555555] text-base leading-relaxed mb-4">
          MintVault UK provides professional One Piece TCG card grading for collectors and investors across the United Kingdom. As the One Piece card game has grown rapidly in popularity, the value of top-tier cards — particularly alt art Secret Rares and early set cards — has surged. Grading protects and authenticates these investments.
        </p>

        <p className="text-[#555555] text-sm leading-relaxed mb-8">
          Every graded One Piece card is assessed on our 1–10 grading scale, sealed in a tamper-evident precision slab with an NFC chip, and given a unique certificate number. Ownership can be claimed and transferred through the MintVault verified ownership registry.
        </p>

        <section className="mb-10" data-testid="section-onepiece-tiers">
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

        <section className="mb-10" data-testid="section-onepiece-ownership">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">Verified Ownership Registry</h2>
          <p className="text-[#555555] text-sm leading-relaxed mb-3">
            MintVault is the only UK grading company with a verified ownership registry. After receiving your graded One Piece card, use the unique claim code to register your ownership online. When you sell the card, the ownership record transfers to the new owner — providing buyers with confidence that the card is genuine and the seller is its registered owner.
          </p>
        </section>

        <section className="mb-10" data-testid="section-onepiece-why">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">Why Grade One Piece Cards?</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              { icon: <Shield size={16} />, title: "Protect your investment", desc: "Tamper-evident slabs prevent damage and preserve card condition indefinitely." },
              { icon: <Award size={16} />, title: "Increase resale value", desc: "High-grade One Piece cards command premium prices on eBay and other markets." },
              { icon: <CheckCircle size={16} />, title: "Verify authenticity", desc: "Grading confirms your card is genuine. All certs verifiable at mintvaultuk.com/cert." },
              { icon: <Clock size={16} />, title: "UK-based, fast turnaround", desc: "No international shipping or customs. Express tier available in 5 working days." },
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

        <FaqSection faqs={faqs} title="One Piece Card Grading FAQs" />

        <div className="mt-10">
          <CtaSection title="Grade Your One Piece Cards" subtitle="Submit online in minutes. Fast turnaround, insured return, verified ownership registry." />
        </div>

        <section className="mt-10" data-testid="section-onepiece-related">
          <h2 className="text-lg font-bold text-[#D4AF37] tracking-wide mb-4">Related Services</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              { href: "/trading-card-grading-uk", label: "Trading Card Grading UK" },
              { href: "/tcg-grading-uk", label: "TCG Grading UK" },
              { href: "/pokemon-card-grading-uk", label: "Pokemon Card Grading UK" },
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
