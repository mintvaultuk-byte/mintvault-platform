import { Link } from "wouter";
import SeoHead from "@/components/seo-head";
import BreadcrumbNav, { breadcrumbSchema } from "@/components/breadcrumb-nav";
import FaqSection, { faqSchema } from "@/components/faq-section";
import CtaSection from "@/components/cta-section";
import { Shield, Award, Clock, TrendingUp, ArrowRight, Users } from "lucide-react";

const breadcrumbs = [
  { label: "Home", href: "/" },
  { label: "TCG Grading UK" },
];

const faqs = [
  {
    question: "What does TCG grading mean?",
    answer: "TCG grading is the process of having a trading card game card professionally assessed for condition and authenticity. A trained grader evaluates the card's centering, corners, edges, and surface quality, assigns a numerical grade from 1 to 10, and seals it in a tamper-evident slab with a verifiable certificate.",
  },
  {
    question: "Which TCGs does MintVault grade?",
    answer: "MintVault grades cards from all major trading card games including Pokemon, Yu-Gi-Oh!, Magic: The Gathering, One Piece, Dragon Ball Super, Lorcana, Flesh and Blood, Digimon, Star Wars: Unlimited, Weiss Schwarz, Cardfight!! Vanguard, MetaZoo, and more. See our <a href='/tcg' class='text-[#D4AF37] hover:underline'>full TCG list</a> for details.",
  },
  {
    question: "Is TCG card grading worth the investment?",
    answer: "For cards in good condition with meaningful collector demand, grading typically increases the resale value beyond the cost of the service. Grading also provides long-term physical protection and proof of authenticity. Cards held for investment benefit from the standardised condition assessment that grading provides.",
  },
  {
    question: "How do I choose which TCG cards to grade?",
    answer: "Focus on cards that are in near-mint or better condition and have a raw market value at least 3 to 5 times the grading fee. Chase cards, rare pulls, vintage cards, and cards with strong collector demand are typically the best candidates. You can also grade cards purely for protection and display purposes.",
  },
  {
    question: "Do graded TCG cards sell for more online?",
    answer: "In most cases, yes. Graded cards provide buyers with an independent condition assessment, which increases confidence and willingness to pay. The premium is typically largest for high-grade cards (9 and above) and for cards with significant demand. Graded cards also tend to attract fewer condition-related disputes from buyers.",
  },
  {
    question: "Can I mix different TCGs in one MintVault submission?",
    answer: "Yes. You can include cards from multiple trading card games in a single submission. Each card is graded individually using the same assessment criteria regardless of the game it belongs to. The same pricing applies to all cards in the order.",
  },
];

const serviceSchema = {
  "@context": "https://schema.org",
  "@type": "Service",
  name: "TCG Grading UK",
  provider: {
    "@type": "Organization",
    name: "MintVault UK",
    url: "https://mintvaultuk.com",
  },
  description: "Professional TCG card grading service in the UK for collectors, investors, and resellers. All major trading card games supported.",
  areaServed: "United Kingdom",
  serviceType: "Trading Card Grading",
};

const schema = [
  breadcrumbSchema(breadcrumbs),
  serviceSchema,
  faqSchema(faqs),
];

export default function TcgGradingUk() {
  return (
    <div className="px-4 py-10">
      <SeoHead
        title="TCG Grading UK | Professional Trading Card Game Grading | MintVault"
        description="Professional TCG grading in the UK for Pokemon, Yu-Gi-Oh!, Magic: The Gathering and all major trading card games. For collectors, investors, and resellers. From £19/card."
        canonical="https://mintvaultuk.com/tcg-grading-uk"
        ogImage="https://mintvaultuk.com/images/collector-lifestyle.webp"
        schema={schema}
      />

      <div className="max-w-3xl mx-auto">
        <BreadcrumbNav items={breadcrumbs} />

        <h1 className="text-3xl md:text-4xl font-bold text-[#1A1A1A] tracking-wide mb-6" data-testid="text-h1-tcg-grading">
          TCG Grading UK
        </h1>

        <p className="text-[#555555] text-base leading-relaxed mb-4">
          The trading card game market in the UK has grown substantially in recent years. From established franchises like Pokemon, Yu-Gi-Oh!, and Magic: The Gathering to newer games like Lorcana and One Piece, collectors and players across the country are accumulating cards with real financial value. MintVault provides professional TCG grading for collectors, investors, and resellers who want to protect, authenticate, and maximise the value of their cards.
        </p>
        <p className="text-[#555555] text-sm leading-relaxed mb-8">
          Our UK-based grading service covers all major trading card games with consistent, professional standards. Whether you have a single high-value pull or a bulk collection across multiple TCGs, MintVault delivers expert grading, tamper-evident slabs, verifiable certificates, and fully insured return shipping.
        </p>

        <section className="mb-10" data-testid="section-for-collectors">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">TCG Grading for Collectors</h2>
          <div className="text-[#555555] text-sm leading-relaxed space-y-3">
            <p>
              Serious TCG collectors grade their most prized cards to preserve them in pristine condition and create a professional, catalogued collection. A graded card in a tamper-evident slab is protected from the environmental and handling damage that affects raw cards over time.
            </p>
            <p>
              <strong className="text-[#1A1A1A]">Protection</strong> — once sealed in a MintVault slab, your card is shielded from fingerprints, moisture, UV exposure, bending, and other physical damage. The tamper-evident casing ensures nobody can access or alter the card without visible evidence.
            </p>
            <p>
              <strong className="text-[#1A1A1A]">Authentication</strong> — grading confirms your card is genuine. Counterfeit cards are an increasing problem in the TCG hobby, particularly for high-value vintage and modern chase cards. A graded card carries the assurance that it has been inspected and authenticated by a professional.
            </p>
            <p>
              <strong className="text-[#1A1A1A]">Organisation</strong> — graded cards are uniform in size, easy to store upright, and simple to display. Many collectors find that a collection of slabbed cards looks significantly more impressive than a binder or box of raw cards.
            </p>
            <p>
              Each MintVault certificate can be verified online using our <Link href="/verify" className="text-[#D4AF37] hover:underline" data-testid="link-cert">certificate lookup tool</Link>, providing a permanent digital record of each card in your collection.
            </p>
          </div>
        </section>

        <section className="mb-10" data-testid="section-for-investors">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">TCG Grading for Investors</h2>
          <div className="text-[#555555] text-sm leading-relaxed space-y-3">
            <p>
              Trading cards have emerged as an alternative asset class, with some rare cards appreciating significantly in value over time. For investors, professional grading serves several important functions.
            </p>
            <p>
              <strong className="text-[#1A1A1A]">Standardised Condition Assessment</strong> — a numerical grade removes subjectivity from condition evaluation. A card graded 9.5 by a professional service means the same thing to every buyer, regardless of where in the world they are. This standardisation is essential for treating cards as investable assets.
            </p>
            <p>
              <strong className="text-[#1A1A1A]">Value Maximisation</strong> — graded cards in high condition consistently sell for more than their raw equivalents. A Gem Mint 10 grade can multiply a card's value many times over compared to selling it as a raw card. Even mid-grade cards often sell for more than ungraded versions because the buyer has certainty about the condition.
            </p>
            <p>
              <strong className="text-[#1A1A1A]">Liquidity</strong> — graded cards are easier to sell on secondary markets. Buyers are more willing to purchase cards sight-unseen when they have a professional grade to rely on, which increases the pool of potential buyers and can speed up sales.
            </p>
            <p>
              <strong className="text-[#1A1A1A]">Condition Preservation</strong> — the slab protects the card's condition indefinitely, ensuring that the grade remains accurate for as long as the card is held. This is particularly important for long-term investment strategies.
            </p>
          </div>
        </section>

        <section className="mb-10" data-testid="section-for-resellers">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">TCG Grading for Resellers</h2>
          <div className="text-[#555555] text-sm leading-relaxed space-y-3">
            <p>
              Professional traders and resellers use grading to differentiate their inventory and command premium prices. Graded cards stand out in marketplace listings and attract more buyer interest.
            </p>
            <p>
              <strong className="text-[#1A1A1A]">Higher Selling Prices</strong> — graded cards typically sell for significantly more than raw cards. The cost of grading is usually recovered many times over through the increased selling price, especially for cards that achieve high grades.
            </p>
            <p>
              <strong className="text-[#1A1A1A]">Fewer Disputes</strong> — raw card sales often lead to disagreements about condition between buyer and seller. A professional grade eliminates this friction. Buyers know exactly what they are getting, which reduces returns, negative feedback, and disputes on platforms like eBay.
            </p>
            <p>
              <strong className="text-[#1A1A1A]">Professional Presentation</strong> — a slabbed card with a printed label looks more professional than a raw card in a penny sleeve. This presentation helps build trust with buyers and can lead to repeat customers.
            </p>
            <p>
              MintVault offers bulk discounts for larger submissions, making professional grading cost-effective for resellers with volume. See our <Link href="/" className="text-[#D4AF37] hover:underline" data-testid="link-pricing">pricing page</Link> for details on bulk discount tiers.
            </p>
          </div>
        </section>

        <section className="mb-10" data-testid="section-why-uk">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">Why Grade Your TCG Cards in the UK</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
            {[
              { icon: <Shield size={20} />, title: "Domestic Service", desc: "Your cards stay within the UK. No international shipping risks, no customs paperwork, no import duties." },
              { icon: <Clock size={20} />, title: "Fast Turnaround", desc: "Service tiers from 5 to 40 working days. Domestic shipping means shorter total elapsed time." },
              { icon: <Award size={20} />, title: "Professional Grading", desc: "Trained UK-based graders assess centering, corners, edges, and surface quality on a 1-10 scale." },
              { icon: <TrendingUp size={20} />, title: "Competitive Pricing", desc: "Grading from £19 per card with bulk discounts up to 15%. No hidden international shipping or customs costs." },
              { icon: <Users size={20} />, title: "UK Customer Support", desc: "Contact our team directly in your time zone for questions about your submission." },
              { icon: <Shield size={20} />, title: "Insured Returns", desc: "All graded cards are returned via fully insured tracked delivery based on your declared card value." },
            ].map((item, i) => (
              <div key={i} className="flex gap-3 border border-[#D4AF37]/15 rounded-lg p-4" data-testid={`card-why-${i}`}>
                <div className="text-[#D4AF37] shrink-0 mt-0.5">{item.icon}</div>
                <div>
                  <h3 className="text-[#1A1A1A] font-semibold text-sm mb-1">{item.title}</h3>
                  <p className="text-[#555555] text-xs leading-relaxed">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
          <p className="text-[#555555] text-sm">
            Compare UK grading with overseas services in our <Link href="/psa-alternative-uk" className="text-[#D4AF37] hover:underline" data-testid="link-psa-alt">PSA alternative guide</Link>.
          </p>
        </section>

        <section className="mb-10" data-testid="section-supported-games">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">Supported Trading Card Games</h2>
          <p className="text-[#555555] text-sm leading-relaxed mb-4">
            MintVault grades cards from all major trading card games. Our grading standards are applied consistently regardless of which TCG a card belongs to:
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-4">
            {["Pokemon", "Yu-Gi-Oh!", "Magic: The Gathering", "One Piece", "Dragon Ball Super", "Lorcana", "Flesh and Blood", "Digimon", "Star Wars: Unlimited", "Weiss Schwarz", "Cardfight!! Vanguard", "MetaZoo"].map((game) => (
              <div key={game} className="border border-[#D4AF37]/15 rounded px-3 py-2 text-[#D4AF37]/80 text-xs text-center" data-testid={`badge-game-${game.toLowerCase().replace(/[^a-z0-9]/g, "-")}`}>
                {game}
              </div>
            ))}
          </div>
          <p className="text-[#555555] text-sm">
            Visit our <Link href="/tcg" className="text-[#D4AF37] hover:underline" data-testid="link-tcg-page">TCG page</Link> for detailed information about each supported game, or <Link href="/submit" className="text-[#D4AF37] hover:underline" data-testid="link-submit">submit your cards</Link> directly.
          </p>
        </section>

        <section className="mb-10" data-testid="section-getting-started">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">Getting Started</h2>
          <div className="text-[#555555] text-sm leading-relaxed space-y-3">
            <p>
              Ready to grade your TCG cards? The process is straightforward:
            </p>
            <ol className="list-decimal list-inside space-y-2 text-[#555555] text-sm pl-2">
              <li>Visit our <Link href="/submit" className="text-[#D4AF37] hover:underline">submission page</Link> and choose your service tier</li>
              <li>Enter the details for each card you want graded</li>
              <li>Pay securely online and receive your submission reference</li>
              <li>Package your cards safely and ship them to us with tracking and insurance</li>
              <li>Receive your graded cards back in tamper-evident slabs via insured delivery</li>
            </ol>
            <p>
              Need help with preparation and packaging? Read our <Link href="/how-to-grade-pokemon-cards" className="text-[#D4AF37] hover:underline" data-testid="link-how-to">step-by-step grading guide</Link> for detailed instructions. While written with Pokemon cards in mind, the preparation advice applies equally to all TCGs.
            </p>
          </div>
        </section>

        <section className="mb-10" data-testid="section-explore">
          <h2 className="text-xl font-bold text-[#D4AF37] tracking-wide mb-4">Explore More</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              { href: "/pokemon-card-grading-uk", label: "Pokemon Card Grading UK" },
              { href: "/trading-card-grading-uk", label: "Trading Card Grading UK" },
              { href: "/card-grading-service-uk", label: "Card Grading Service UK" },
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
          title="Grade Your TCG Cards with MintVault"
          subtitle="Professional UK-based grading for all major trading card games. Fast turnaround, competitive pricing, insured returns."
        />
      </div>
    </div>
  );
}
