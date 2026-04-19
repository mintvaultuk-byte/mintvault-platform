import { Link } from "wouter";
import SeoHead from "@/components/seo-head";
import BreadcrumbNav, { breadcrumbSchema } from "@/components/breadcrumb-nav";
import FaqSection, { faqSchema } from "@/components/faq-section";
import CtaSection from "@/components/cta-section";
import { Shield, Clock, Award, CheckCircle, ArrowRight, MapPin } from "lucide-react";

const breadcrumbs = [
  { label: "Home", href: "/" },
  { label: "Card Grading Service UK" },
];

const faqs = [
  {
    question: "Why should I use a UK card grading service instead of an overseas one?",
    answer: "A UK-based service eliminates international shipping risks, customs fees, import duties, and lengthy transit times. Your cards remain within the United Kingdom throughout the process, reducing the chance of loss or damage. Turnaround is typically faster, and you have access to local customer support.",
  },
  {
    question: "What types of cards does MintVault grade?",
    answer: "MintVault grades cards from all major trading card games including Pokemon, Yu-Gi-Oh!, Magic: The Gathering, One Piece, Dragon Ball Super, Lorcana, Flesh and Blood, Digimon, and more. Visit our <a href='/tcg' class='text-[#D4AF37] hover:underline'>supported TCGs page</a> for the full list.",
  },
  {
    question: "How do I know my cards are safe during the grading process?",
    answer: "MintVault uses tracked and insured shipping for all returns. Cards are handled in controlled conditions by trained graders. Our tamper-evident slabs provide permanent protection once grading is complete. You can track your submission status online at any time.",
  },
  {
    question: "What grading scale does MintVault use?",
    answer: "We use a 1 to 10 grading scale where 10 is Gem Mint. Each card is assessed for centering, corners, edges, and surface quality. Half-point grades (such as 9.5) are possible when a card falls between two whole number grades.",
  },
  {
    question: "How do I submit cards for grading?",
    answer: "Start by creating a submission on our <a href='/submit' class='text-[#D4AF37] hover:underline'>submission page</a>. Choose your service tier, enter your card details, and pay securely online. Then post your cards to us using tracked, insured shipping. We handle the rest and return your graded cards via insured delivery.",
  },
  {
    question: "Can I verify a MintVault graded card's authenticity?",
    answer: "Yes. Every graded card has a unique certificate number printed on the slab label. Anyone can verify this certificate using our <a href='/cert' class='text-[#D4AF37] hover:underline'>online certificate lookup tool</a>, which displays the card details, grade, and submission information.",
  },
];

const serviceSchema = {
  "@context": "https://schema.org",
  "@type": "Service",
  name: "Card Grading Service UK",
  provider: {
    "@type": "Organization",
    name: "MintVault UK",
    url: "https://mintvaultuk.com",
  },
  description: "Professional card grading service based in the UK for Pokemon, Yu-Gi-Oh!, Magic: The Gathering and all major trading card games.",
  areaServed: "United Kingdom",
  serviceType: "Trading Card Grading",
};

const schema = [
  breadcrumbSchema(breadcrumbs),
  serviceSchema,
  faqSchema(faqs),
];

export default function CardGradingServiceUk() {
  return (
    <div className="px-4 py-10">
      <SeoHead
        title="Card Grading Service UK | Professional Trading Card Grading | MintVault"
        description="Professional card grading service in the UK. Grade your Pokemon, Yu-Gi-Oh!, Magic and TCG cards locally. No customs, fast turnaround, insured shipping. From £19/card."
        canonical="https://mintvaultuk.com/card-grading-service-uk"
        ogImage="https://mintvaultuk.com/images/collector-lifestyle.webp"
        schema={schema}
      />

      <div className="max-w-3xl mx-auto">
        <BreadcrumbNav items={breadcrumbs} />

        <h1 className="text-3xl md:text-4xl font-bold text-[#1A1A1A] tracking-wide mb-6" data-testid="text-h1-card-grading-service">
          Card Grading Service UK
        </h1>

        <p className="text-[#444444] text-base leading-relaxed mb-4">
          MintVault is a professional card grading service based in the United Kingdom, purpose-built for UK collectors who want to grade their trading cards without the hassle, cost, and risk of sending them overseas. We provide the same rigorous grading standards you would expect from any professional service, combined with the convenience and security of keeping your cards within the UK.
        </p>
        <p className="text-[#666666] text-sm leading-relaxed mb-8">
          From Pokemon and Yu-Gi-Oh! to Magic: The Gathering and beyond, MintVault grades cards from all major trading card games. Every card is assessed by trained graders, sealed in a tamper-evident precision slab, and returned with fully insured shipping.
        </p>

        <section className="mb-10" data-testid="section-why-local">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">Why UK Collectors Choose a Local Grading Service</h2>
          <div className="text-[#444444] text-sm leading-relaxed space-y-3">
            <p>
              For years, UK trading card collectors had limited options for professional grading. Most services were based in the United States, meaning collectors had to navigate international shipping, customs declarations, import duties, and weeks of additional waiting time just for transit alone.
            </p>
            <p>
              A UK-based card grading service solves all of these problems. Your cards never leave the country, so there is no risk of loss during international transit. There are no customs forms to fill out, no surprise import duty charges, and no VAT complications on the return journey. Turnaround times are shorter because domestic postal services are faster and more predictable.
            </p>
            <p>
              MintVault was founded specifically to serve the growing community of UK card collectors and investors who wanted professional-quality grading without the overhead of dealing with international services. Our team is based in the UK, our support is in your time zone, and our processes are designed around the needs of British collectors.
            </p>
          </div>
        </section>

        <section className="mb-10" data-testid="section-advantages">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">Advantages of MintVault's UK Service</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
            {[
              { icon: <MapPin size={20} />, title: "UK-Based Throughout", desc: "Your cards stay within the United Kingdom from receipt to return. No international shipping means lower risk and faster service." },
              { icon: <Clock size={20} />, title: "Predictable Turnaround", desc: "Choose from three service tiers with turnaround from 5 to 40 working days. Track your submission status online at any time." },
              { icon: <Shield size={20} />, title: "Insured Return Shipping", desc: "All graded cards are returned via fully insured tracked delivery based on your declared card value." },
              { icon: <Award size={20} />, title: "Professional Standards", desc: "Every card is graded on our 1-10 scale by trained assessors evaluating centering, corners, edges, and surface quality." },
              { icon: <CheckCircle size={20} />, title: "Verifiable Certificates", desc: "Each slab carries a unique certificate number that can be checked online using our certificate verification tool." },
              { icon: <MapPin size={20} />, title: "No Hidden Costs", desc: "No customs fees, no import duties, no international shipping premiums. Pricing starts from £19 per card with bulk discounts available." },
            ].map((item, i) => (
              <div key={i} className="flex gap-3 border border-[#D4AF37]/15 rounded-lg p-4" data-testid={`card-advantage-${i}`}>
                <div className="text-[#D4AF37] shrink-0 mt-0.5">{item.icon}</div>
                <div>
                  <h3 className="text-[#1A1A1A] font-semibold text-sm mb-1">{item.title}</h3>
                  <p className="text-[#666666] text-xs leading-relaxed">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="mb-10" data-testid="section-how-it-works">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">How Our Card Grading Service Works</h2>
          <div className="text-[#444444] text-sm leading-relaxed space-y-3">
            <p>
              Using MintVault's card grading service is straightforward. The entire process is managed through our website, from submission to tracking to certificate verification.
            </p>
            <p>
              <strong className="text-[#1A1A1A]">Step 1: Create Your Submission</strong> — visit our <Link href="/submit" className="text-[#D4AF37] hover:underline" data-testid="link-submit">submission page</Link> and choose your service tier. Enter the details for each card you want graded, including the card name, set, and any relevant identifiers. Pay securely online.
            </p>
            <p>
              <strong className="text-[#1A1A1A]">Step 2: Post Your Cards</strong> — package your cards securely using penny sleeves and top loaders, then send them to our facility via tracked, insured shipping. Our <Link href="/how-to-grade-pokemon-cards" className="text-[#D4AF37] hover:underline" data-testid="link-how-to">preparation guide</Link> has detailed packaging instructions.
            </p>
            <p>
              <strong className="text-[#1A1A1A]">Step 3: Grading</strong> — our trained assessors evaluate each card for centering, corners, edges, and surface quality. Cards are graded on a 1 to 10 scale under controlled conditions with proper lighting and magnification.
            </p>
            <p>
              <strong className="text-[#1A1A1A]">Step 4: Encapsulation</strong> — graded cards are sealed in tamper-evident precision slabs with a professionally printed label showing the card details, grade, and unique certificate number.
            </p>
            <p>
              <strong className="text-[#1A1A1A]">Step 5: Insured Return</strong> — your graded cards are returned via fully insured tracked shipping. Once delivered, you can verify your certificates online at any time using our <Link href="/cert" className="text-[#D4AF37] hover:underline" data-testid="link-cert">certificate lookup tool</Link>.
            </p>
          </div>
        </section>

        <section className="mb-10" data-testid="section-who-grades">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">Who Uses Our Grading Service?</h2>
          <div className="text-[#444444] text-sm leading-relaxed space-y-3">
            <p>
              MintVault serves a wide range of UK-based trading card enthusiasts:
            </p>
            <p>
              <strong className="text-[#1A1A1A]">Collectors</strong> — serious collectors grade their most prized cards to protect them, verify authenticity, and create a professional-looking collection. Graded cards are easier to store, display, and catalogue.
            </p>
            <p>
              <strong className="text-[#1A1A1A]">Investors</strong> — card investors grade high-value cards to maximise their resale potential. A professional grade from a recognised service adds confidence for buyers and typically increases the selling price.
            </p>
            <p>
              <strong className="text-[#1A1A1A]">Resellers</strong> — traders and resellers use grading to differentiate their inventory and justify premium pricing. Graded cards attract more attention on marketplaces and sell with fewer disputes about condition.
            </p>
            <p>
              <strong className="text-[#1A1A1A]">Casual Players</strong> — even casual TCG players sometimes have high-value pulls from booster packs that are worth protecting. Grading ensures these cards are preserved in top condition.
            </p>
          </div>
        </section>

        <section className="mb-10" data-testid="section-pricing-overview">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">Pricing Overview</h2>
          <p className="text-[#444444] text-sm leading-relaxed mb-4">
            MintVault offers three service tiers. All tiers include the same professional grading process, tamper-evident slab, certificate, and insured return shipping.
          </p>
          <div className="border border-[#D4AF37]/20 rounded-lg overflow-hidden mb-4">
            {[
              { tier: "Vault Queue", price: "£19", turnaround: "40 working days" },
              { tier: "Standard", price: "£25", turnaround: "15 working days" },
              { tier: "Express", price: "£45", turnaround: "5 working days" },
            ].map((t, i) => (
              <div key={i} className={`flex items-center justify-between px-5 py-3 ${i > 0 ? "border-t border-[#D4AF37]/10" : ""}`} data-testid={`row-tier-${i}`}>
                <span className="text-[#1A1A1A] text-sm font-medium">{t.tier}</span>
                <span className="text-[#666666] text-sm">{t.turnaround}</span>
                <span className="text-[#D4AF37] text-sm font-semibold">{t.price}/card</span>
              </div>
            ))}
          </div>
          <p className="text-[#666666] text-sm">
            Bulk discounts of up to 15% are available for larger submissions. Visit our <Link href="/" className="text-[#D4AF37] hover:underline" data-testid="link-pricing">pricing page</Link> for full details.
          </p>
        </section>

        <section className="mb-10" data-testid="section-explore">
          <h2 className="text-xl font-bold text-[#D4AF37] tracking-wide mb-4">Explore More</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              { href: "/pokemon-card-grading-uk", label: "Pokemon Card Grading UK" },
              { href: "/trading-card-grading-uk", label: "Trading Card Grading UK" },
              { href: "/tcg-grading-uk", label: "TCG Grading UK" },
              { href: "/psa-alternative-uk", label: "UK PSA Alternative" },
              { href: "/how-to-grade-pokemon-cards", label: "How to Grade Pokemon Cards" },
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
          title="Start Grading Your Cards Today"
          subtitle="Professional UK card grading service with no customs, no delays, and fully insured returns."
        />
      </div>
    </div>
  );
}
