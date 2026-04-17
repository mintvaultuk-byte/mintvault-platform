import { Link } from "wouter";
import SeoHead from "@/components/seo-head";
import BreadcrumbNav, { breadcrumbSchema } from "@/components/breadcrumb-nav";
import FaqSection, { faqSchema } from "@/components/faq-section";
import CtaSection from "@/components/cta-section";
import { Shield, Award, Clock, CheckCircle, ArrowRight, Layers } from "lucide-react";

const breadcrumbs = [
  { label: "Home", href: "/" },
  { label: "Trading Card Grading UK" },
];

const faqs = [
  {
    question: "What trading card games does MintVault grade?",
    answer: "MintVault grades cards from all major trading card games including Pokemon, Yu-Gi-Oh!, Magic: The Gathering, One Piece, Dragon Ball Super, Lorcana, Flesh and Blood, Digimon, Star Wars: Unlimited, Weiss Schwarz, Cardfight!! Vanguard, and MetaZoo. If your TCG is not listed, please contact us as we may still be able to accommodate your submission.",
  },
  {
    question: "Is trading card grading the same process for all card games?",
    answer: "The core grading methodology is consistent across all card games. Every card is assessed for centering, corners, edges, and surface quality on a 1 to 10 scale. However, our graders are familiar with the specific printing characteristics of each TCG, which ensures accurate assessment regardless of the card type.",
  },
  {
    question: "How does MintVault certify graded trading cards?",
    answer: "Each graded card receives a unique MintVault certificate number that is printed on the slab label. This certificate can be verified online at any time using our <a href='/cert' class='text-[#D4AF37] hover:underline'>certificate lookup tool</a>, which displays the card details, grade, and submission information.",
  },
  {
    question: "Can I submit cards from multiple TCGs in one order?",
    answer: "Yes. You can mix cards from different trading card games in a single submission. Each card is graded individually regardless of the game it belongs to. The same pricing and service tier applies to all cards in the submission.",
  },
  {
    question: "How much does trading card grading cost in the UK?",
    answer: "Grading starts from £19 per card (Vault Queue tier, 40 working days). Standard is £25 (15 working days) and Express is £45 (5 working days). Bulk discounts of up to 15% apply to larger submissions. Visit our <a href='/' class='text-[#D4AF37] hover:underline'>pricing page</a> for full details.",
  },
  {
    question: "Do graded trading cards sell for more than raw cards?",
    answer: "In most cases, yes. Graded cards provide buyers with an independent assessment of condition, which increases buyer confidence and typically results in higher sale prices. The premium is generally largest for cards in high grades (9 and above) and for cards with significant collector demand.",
  },
];

const serviceSchema = {
  "@context": "https://schema.org",
  "@type": "Service",
  name: "Trading Card Grading UK",
  provider: {
    "@type": "Organization",
    name: "MintVault UK",
    url: "https://mintvaultuk.com",
  },
  description: "Professional trading card grading service in the UK covering Pokemon, Yu-Gi-Oh!, Magic: The Gathering and all major TCGs.",
  areaServed: "United Kingdom",
  serviceType: "Trading Card Grading",
};

const schema = [
  breadcrumbSchema(breadcrumbs),
  serviceSchema,
  faqSchema(faqs),
];

export default function TradingCardGradingUk() {
  return (
    <div className="px-4 py-10">
      <SeoHead
        title="Trading Card Grading UK | Grade Pokemon, Yu-Gi-Oh & More | MintVault"
        description="Professional trading card grading in the UK for Pokemon, Yu-Gi-Oh!, Magic: The Gathering and all major TCGs. Tamper-evident slabs, insured shipping, fast turnaround."
        canonical="https://mintvaultuk.com/trading-card-grading-uk"
        ogImage="https://mintvaultuk.com/images/collector-lifestyle.webp"
        schema={schema}
      />

      <div className="max-w-3xl mx-auto">
        <BreadcrumbNav items={breadcrumbs} />

        <h1 className="text-3xl md:text-4xl font-bold text-[#1A1A1A] tracking-wide mb-6" data-testid="text-h1-trading-grading">
          Trading Card Grading UK
        </h1>

        <p className="text-[#555555] text-base leading-relaxed mb-4">
          MintVault provides professional trading card grading for collectors across the United Kingdom. We grade cards from all major trading card games, including Pokemon, Yu-Gi-Oh!, Magic: The Gathering, One Piece, Dragon Ball Super, Lorcana, and many more. Every card receives expert assessment, a tamper-evident precision slab, a unique certificate, and fully insured return shipping.
        </p>
        <p className="text-[#555555] text-sm leading-relaxed mb-8">
          Whether you collect a single TCG or have cards spanning multiple games, MintVault's grading service covers them all under one roof. Our graders are trained to recognise the printing characteristics and quality standards specific to each card game, ensuring accurate and fair grades every time.
        </p>

        <section className="mb-10" data-testid="section-supported-games">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">Trading Card Games We Grade</h2>
          <p className="text-[#555555] text-sm leading-relaxed mb-4">
            MintVault accepts submissions from all major trading card games. Our grading standards are consistent and rigorous across every TCG we support:
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-4">
            {["Pokemon", "Yu-Gi-Oh!", "Magic: The Gathering", "One Piece", "Dragon Ball Super", "Lorcana", "Flesh and Blood", "Digimon", "Star Wars: Unlimited", "Weiss Schwarz", "Cardfight!! Vanguard", "MetaZoo"].map((game) => (
              <div key={game} className="border border-[#D4AF37]/15 rounded px-3 py-2 text-[#D4AF37]/80 text-xs text-center" data-testid={`badge-game-${game.toLowerCase().replace(/[^a-z0-9]/g, "-")}`}>
                {game}
              </div>
            ))}
          </div>
          <p className="text-[#555555] text-sm">
            See our <Link href="/tcg" className="text-[#D4AF37] hover:underline" data-testid="link-tcg-list">full list of supported TCGs</Link> for more information on each game.
          </p>
        </section>

        <section className="mb-10" data-testid="section-grading-process">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">Our Grading Process</h2>
          <div className="text-[#555555] text-sm leading-relaxed space-y-3">
            <p>
              Every trading card submitted to MintVault undergoes the same thorough grading process, regardless of the game it comes from. Our graders work in controlled conditions using proper lighting and magnification tools to assess each card fairly and consistently.
            </p>
            <p>
              <strong className="text-[#1A1A1A]">Centering</strong> — we measure the positioning of the printed image relative to the card borders on both the front and back. Cards with tighter centering tolerances receive higher marks in this category.
            </p>
            <p>
              <strong className="text-[#1A1A1A]">Corners</strong> — each of the four corners is examined for sharpness, wear, fraying, or damage. Even minor corner softening can affect the overall grade.
            </p>
            <p>
              <strong className="text-[#1A1A1A]">Edges</strong> — the full perimeter of the card is inspected for whitening, chipping, nicks, or roughness. Edge condition is often the most revealing indicator of how a card has been handled.
            </p>
            <p>
              <strong className="text-[#1A1A1A]">Surface</strong> — the card face and back are checked for scratches, print lines, ink defects, foil clouding, haze, or other surface imperfections that affect visual appeal.
            </p>
            <p>
              After assessment, each card is assigned an overall grade from 1 to 10 and encapsulated in a tamper-evident MintVault slab. The grade, card details, and unique certificate number are printed on a professionally designed label.
            </p>
          </div>
        </section>

        <section className="mb-10" data-testid="section-certification">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">Certification and Verification</h2>
          <div className="text-[#555555] text-sm leading-relaxed space-y-3">
            <p>
              Every card graded by MintVault receives a unique certificate number. This number is printed directly on the slab label and recorded in our database. Anyone can verify a MintVault certificate using our <Link href="/cert" className="text-[#D4AF37] hover:underline" data-testid="link-cert-verify">online certificate lookup tool</Link>.
            </p>
            <p>
              Certificate verification displays the card name, set, grade, and submission details. This provides buyers with confidence that the card and grade are authentic, which is particularly valuable when selling cards on secondary markets like eBay or trading card forums.
            </p>
            <p>
              Our tamper-evident slabs are designed to show visible signs of interference if anyone attempts to open or alter them. This protects both the card inside and the integrity of the grade assigned.
            </p>
          </div>
        </section>

        <section className="mb-10" data-testid="section-why-grade">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">Why Grade Your Trading Cards?</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
            {[
              { icon: <Award size={20} />, title: "Increase Resale Value", desc: "Graded cards in high condition typically sell for significantly more than their raw equivalents. A trusted grade gives buyers confidence." },
              { icon: <Shield size={20} />, title: "Protect Your Collection", desc: "Slabs guard against handling damage, moisture, UV light, and physical impact. Your cards are preserved in the condition they were graded." },
              { icon: <CheckCircle size={20} />, title: "Prove Authenticity", desc: "Grading includes authentication. Counterfeit and altered cards are identified and rejected, so a graded card carries trust." },
              { icon: <Layers size={20} />, title: "Standardised Condition", desc: "A numerical grade removes subjectivity. Sellers and buyers share a common language for card condition across all trading platforms." },
            ].map((item, i) => (
              <div key={i} className="flex gap-3 border border-[#D4AF37]/15 rounded-lg p-4" data-testid={`card-benefit-${i}`}>
                <div className="text-[#D4AF37] shrink-0 mt-0.5">{item.icon}</div>
                <div>
                  <h3 className="text-[#1A1A1A] font-semibold text-sm mb-1">{item.title}</h3>
                  <p className="text-[#555555] text-xs leading-relaxed">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="mb-10" data-testid="section-uk-advantage">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">The UK Grading Advantage</h2>
          <div className="text-[#555555] text-sm leading-relaxed space-y-3">
            <p>
              Choosing a UK-based grading service means your cards never leave the country. There is no risk of loss during international transit, no customs paperwork, no import duties or VAT surprises, and no weeks of additional waiting for overseas shipping.
            </p>
            <p>
              MintVault offers turnaround from 40 working days down to 5 working days, with all return shipping fully insured. Our UK-based customer support team is available to answer questions about your submission without time zone complications.
            </p>
            <p>
              For a detailed comparison of UK versus international grading options, see our <Link href="/psa-alternative-uk" className="text-[#D4AF37] hover:underline" data-testid="link-psa-alt">PSA alternative guide</Link>.
            </p>
          </div>
        </section>

        <section className="mb-10" data-testid="section-explore">
          <h2 className="text-xl font-bold text-[#D4AF37] tracking-wide mb-4">Related Pages</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              { href: "/pokemon-card-grading-uk", label: "Pokemon Card Grading UK" },
              { href: "/card-grading-service-uk", label: "Card Grading Service UK" },
              { href: "/tcg-grading-uk", label: "TCG Grading UK" },
              { href: "/how-to-grade-pokemon-cards", label: "How to Grade Pokemon Cards" },
              { href: "/psa-alternative-uk", label: "UK PSA Alternative" },
              { href: "/guides", label: "All Guides & Articles" },
              { href: "/submit", label: "Submit Your Cards" },
              { href: "/why-mintvault", label: "Why MintVault" },
            ].map((link) => (
              <Link key={link.href} href={link.href}>
                <span className="flex items-center gap-2 border border-[#D4AF37]/15 rounded px-4 py-2.5 text-[#D4AF37]/70 text-sm hover:text-[#D4AF37] hover:border-[#D4AF37]/30 transition-all cursor-pointer" data-testid={`link-explore-${link.href.slice(1)}`}>
                  <ArrowRight size={14} /> {link.label}
                </span>
              </Link>
            ))}
          </div>
        </section>

        <section className="mb-10">
          <FaqSection faqs={faqs} />
        </section>

        <CtaSection
          title="Get Your Trading Cards Graded"
          subtitle="Professional UK-based grading for all major trading card games. Fast turnaround and insured shipping."
        />
      </div>
    </div>
  );
}
