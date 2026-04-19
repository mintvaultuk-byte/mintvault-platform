import { Link } from "wouter";
import SeoHead from "@/components/seo-head";
import BreadcrumbNav, { breadcrumbSchema } from "@/components/breadcrumb-nav";
import FaqSection, { faqSchema } from "@/components/faq-section";
import { Shield, Award, Clock, Package, CheckCircle, ArrowRight } from "lucide-react";

function PokeballDivider() {
  return (
    <div className="flex items-center justify-center my-10" aria-hidden="true">
      <div className="flex-1 h-px bg-[#E3350D]/20" />
      <div className="mx-5 relative w-9 h-9 flex-shrink-0">
        <div className="absolute top-0 left-0 w-full h-[47%] rounded-t-full bg-[#E3350D]" />
        <div className="absolute bottom-0 left-0 w-full h-[47%] rounded-b-full bg-white border border-[#1A1A1A]/15" />
        <div className="absolute top-1/2 -translate-y-1/2 left-0 w-full h-[6%] bg-[#1A1A1A]/25" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[30%] h-[30%] rounded-full bg-white border-2 border-[#1A1A1A]/40 z-10" style={{ boxShadow: "0 0 0 2px white, 0 0 0 3.5px rgba(0,0,0,0.2)" }} />
      </div>
      <div className="flex-1 h-px bg-[#E3350D]/20" />
    </div>
  );
}

const breadcrumbs = [
  { label: "Home", href: "/" },
  { label: "Pokemon Card Grading UK" },
];

const faqs = [
  {
    question: "How much does Pokemon card grading cost in the UK?",
    answer: "MintVault UK offers grading from £19 per card on the Vault Queue tier (40 working days). Standard is £25 (15 working days) and Express is £45 (5 working days). Bulk discounts are available for 10+ card submissions. All prices include fully insured return shipping based on your declared card value.",
  },
  {
    question: "How long does Pokemon card grading take with MintVault?",
    answer: "Turnaround times depend on your chosen service tier. Vault Queue is 40 working days, Standard is 15 working days, and Express is 5 working days. You can track your submission status online at any time via our <a href='/track' class='text-[#E3350D] hover:underline'>tracking page</a>.",
  },
  {
    question: "What Pokemon cards are worth grading?",
    answer: "Cards in near-mint or better condition with a raw market value above the grading cost are ideal candidates. This includes vintage WOTC cards, chase cards from modern sets, full art and secret rare cards, first editions, and promotional cards. Our <a href='/guides/what-pokemon-cards-are-worth-grading' class='text-[#E3350D] hover:underline'>grading guide</a> covers this topic in detail.",
  },
  {
    question: "What grading scale does MintVault use for Pokemon cards?",
    answer: "MintVault uses a 1 to 10 grading scale, where 10 represents Gem Mint condition. Each card is assessed across four key areas: centering, corners, edges, and surface quality. Half-point grades such as 8.5 or 9.5 are also possible when a card falls between two whole number grades.",
  },
  {
    question: "Is it better to grade Pokemon cards in the UK or send them to PSA?",
    answer: "Using a UK-based grading service like MintVault eliminates international shipping risks, customs fees, and lengthy transit times. Your cards stay within the United Kingdom throughout the entire process. Turnaround is typically faster than sending cards overseas, and you benefit from local customer support. Read our <a href='/psa-alternative-uk' class='text-[#E3350D] hover:underline'>PSA alternative comparison</a> for a detailed breakdown.",
  },
  {
    question: "How are graded Pokemon cards returned to me?",
    answer: "Every graded card is sealed in a tamper-evident precision slab with a unique MintVault certificate number. Cards are returned via fully insured tracked shipping based on the declared value of your submission. You can verify any certificate online using our <a href='/cert' class='text-[#E3350D] hover:underline'>certificate lookup tool</a>.",
  },
];

const serviceSchema = {
  "@context": "https://schema.org",
  "@type": "Service",
  name: "Pokemon Card Grading UK",
  provider: {
    "@type": "Organization",
    name: "MintVault UK",
    url: "https://mintvaultuk.com",
  },
  description: "Professional Pokemon card grading service based in the United Kingdom. Expert assessment, tamper-evident slabs, and insured return shipping.",
  areaServed: "United Kingdom",
  serviceType: "Trading Card Grading",
};

const schema = [
  breadcrumbSchema(breadcrumbs),
  serviceSchema,
  faqSchema(faqs),
];

export default function PokemonCardGradingUk() {
  return (
    <div className="px-4 py-10">
      <SeoHead
        title="Pokemon Card Grading UK | Professional Grading Service | MintVault"
        description="Professional Pokemon card grading in the UK. Fast turnaround, tamper-evident slabs, insured shipping. Grade your Pokemon cards with MintVault from £19 per card."
        canonical="https://mintvaultuk.com/pokemon-card-grading-uk"
        ogImage="https://mintvaultuk.com/images/collector-lifestyle.webp"
        schema={schema}
      />

      <div className="max-w-3xl mx-auto">
        <BreadcrumbNav items={breadcrumbs} />

        <h1 className="text-3xl md:text-4xl font-bold text-[#1A1A1A] tracking-wide mb-2" data-testid="text-h1-pokemon-grading">
          Pokemon Card Grading UK
        </h1>
        <p className="text-[#888888] italic text-base mb-6">Gotta grade 'em all</p>

        <p className="text-[#444444] text-base leading-relaxed mb-4">
          MintVault is a professional Pokemon card grading service based in the United Kingdom. We provide expert card assessment, tamper-evident precision slabs, and fully insured return shipping for collectors, investors, and resellers across the UK. Whether you have a single high-value chase card or a bulk submission of vintage pulls, our grading service is designed to protect and authenticate your collection.
        </p>
        <p className="text-[#666666] text-sm leading-relaxed mb-8">
          Every card submitted to MintVault is individually assessed by trained graders who evaluate centering, corners, edges, and surface quality on a 1 to 10 scale. Your graded cards are sealed in our precision slabs and assigned a unique certificate that can be <Link href="/cert" className="text-[#E3350D] hover:underline" data-testid="link-cert-lookup">verified online</Link> at any time.
        </p>

        <PokeballDivider />

        <section className="mb-10" data-testid="section-process">
          <h2 className="text-2xl font-bold text-[#E3350D] tracking-wide mb-4">How Pokemon Card Grading Works</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
            {[
              { icon: <Package size={24} />, title: "1. Submit Online", desc: "Choose your service tier, enter your card details using our online wizard, and pay securely. Then post your cards to us using tracked, insured shipping." },
              { icon: <Award size={24} />, title: "2. Expert Grading", desc: "Our trained graders inspect each Pokemon card under controlled lighting, assessing centering, corners, edges, and surface condition to assign a grade from 1 to 10." },
              { icon: <Shield size={24} />, title: "3. Slab & Return", desc: "Your cards are encapsulated in tamper-evident precision slabs with a unique MintVault certificate and returned via fully insured tracked delivery." },
            ].map((step, i) => (
              <div key={i} className="border border-[#E3350D]/20 rounded-lg p-5 text-center" data-testid={`card-process-${i}`}>
                <div className="text-[#E3350D] mb-3 flex justify-center">{step.icon}</div>
                <h3 className="text-[#1A1A1A] font-semibold mb-2">{step.title}</h3>
                <p className="text-[#666666] text-sm leading-relaxed">{step.desc}</p>
              </div>
            ))}
          </div>
          <p className="text-[#666666] text-sm">
            Ready to get started? <Link href="/submit" className="text-[#E3350D] hover:underline" data-testid="link-submit-cards">Submit your Pokemon cards now</Link> or read our <Link href="/how-to-grade-pokemon-cards" className="text-[#E3350D] hover:underline" data-testid="link-how-to-guide">step-by-step grading guide</Link> first.
          </p>
        </section>

        <section className="mb-10" data-testid="section-benefits">
          <h2 className="text-2xl font-bold text-[#E3350D] tracking-wide mb-4">Benefits of Grading Your Pokemon Cards</h2>
          <div className="text-[#444444] text-sm leading-relaxed space-y-3">
            <p>
              Professional grading transforms a raw Pokemon card into an authenticated, condition-verified collectible sealed in a protective slab. For UK collectors and investors, there are several compelling reasons to grade your cards.
            </p>
            <p>
              <strong className="text-[#1A1A1A]">Increased Market Value</strong> — graded Pokemon cards consistently command higher prices than raw cards in comparable condition. A Gem Mint 10 grade can multiply a card's value many times over. Buyers on platforms like eBay have greater confidence in purchasing graded cards because the condition has been independently verified.
            </p>
            <p>
              <strong className="text-[#1A1A1A]">Long-Term Protection</strong> — once sealed in a MintVault slab, your Pokemon card is shielded from fingerprints, moisture, bending, UV exposure, and other environmental damage. The tamper-evident casing ensures the card's condition is preserved indefinitely, making it ideal for long-term holding or display.
            </p>
            <p>
              <strong className="text-[#1A1A1A]">Authentication and Trust</strong> — counterfeit Pokemon cards are an increasing concern in the hobby. Grading provides authentication that your card is genuine. Each MintVault certificate can be checked using our <Link href="/cert" className="text-[#E3350D] hover:underline">online verification tool</Link>, giving buyers and fellow collectors confidence in authenticity.
            </p>
            <p>
              <strong className="text-[#1A1A1A]">Collection Organisation</strong> — slabbed cards are uniform in size and easy to store, display, and catalogue. Many serious collectors prefer the clean, organised appearance that graded cards provide in a display case or binder.
            </p>
          </div>
        </section>

        <PokeballDivider />

        <section className="mb-10" data-testid="section-grading-standards">
          <h2 className="text-2xl font-bold text-[#E3350D] tracking-wide mb-4">Our Grading Standards</h2>
          <p className="text-[#444444] text-sm leading-relaxed mb-3">
            MintVault graders assess every Pokemon card across four distinct categories. Each factor contributes to the overall grade assigned on our 1 to 10 scale:
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
            {[
              { title: "Centering", desc: "How well the printed image is positioned within the card borders. Front and back centering are both evaluated, with tighter tolerances required for higher grades." },
              { title: "Corners", desc: "The sharpness and condition of all four corners. Any rounding, fraying, or damage to corner tips will affect the grade." },
              { title: "Edges", desc: "The condition along all four edges of the card. Whitening, chipping, or roughness is assessed under magnification." },
              { title: "Surface", desc: "The card's surface is inspected for scratches, print lines, ink spots, haze, or other blemishes that could affect the visual quality." },
            ].map((item, i) => (
              <div key={i} className="border border-[#E3350D]/15 rounded-lg p-4" data-testid={`card-standard-${i}`}>
                <h3 className="text-[#1A1A1A] font-semibold text-sm mb-1">{item.title}</h3>
                <p className="text-[#666666] text-xs leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
          <p className="text-[#666666] text-sm">
            Learn more about <Link href="/why-mintvault" className="text-[#E3350D] hover:underline" data-testid="link-why-mintvault">why collectors choose MintVault</Link> for accurate and consistent grading.
          </p>
        </section>

        <section className="mb-10" data-testid="section-tiers">
          <h2 className="text-2xl font-bold text-[#E3350D] tracking-wide mb-4">Service Tiers and Turnaround</h2>
          <p className="text-[#444444] text-sm leading-relaxed mb-4">
            MintVault offers five grading tiers to accommodate different timelines and budgets. All tiers include the same rigorous grading process, tamper-evident slab, unique certificate, and insured return shipping.
          </p>
          <div className="border border-[#E3350D]/20 rounded-lg overflow-hidden mb-4">
            {[
              { tier: "Vault Queue", price: "£19", turnaround: "40 working days" },
              { tier: "Standard", price: "£25", turnaround: "15 working days" },
              { tier: "Express", price: "£45", turnaround: "5 working days" },
            ].map((t, i) => (
              <div key={i} className={`flex items-center justify-between px-5 py-3 ${i > 0 ? "border-t border-[#E3350D]/10" : ""}`} data-testid={`row-tier-${i}`}>
                <span className="text-[#1A1A1A] text-sm font-medium">{t.tier}</span>
                <span className="text-[#666666] text-sm">{t.turnaround}</span>
                <span className="text-[#E3350D] text-sm font-semibold">{t.price}/card</span>
              </div>
            ))}
          </div>
          <p className="text-[#666666] text-sm">
            View full pricing details and bulk discounts on our <Link href="/" className="text-[#E3350D] hover:underline" data-testid="link-pricing">pricing page</Link>.
          </p>
        </section>

        <section className="mb-10" data-testid="section-what-to-grade">
          <h2 className="text-2xl font-bold text-[#E3350D] tracking-wide mb-4">Which Pokemon Cards Should You Grade?</h2>
          <div className="text-[#444444] text-sm leading-relaxed space-y-3">
            <p>
              Not every Pokemon card benefits equally from professional grading. The best candidates are cards where the grading cost represents a small fraction of the card's potential graded value. Here are some categories to consider:
            </p>
            <p>
              <strong className="text-[#1A1A1A]">Vintage WOTC Cards</strong> — Base Set, Jungle, Fossil, and other early Wizards of the Coast sets. Cards like the Base Set Charizard, Blastoise, and Venusaur in good condition can be worth significantly more when graded.
            </p>
            <p>
              <strong className="text-[#1A1A1A]">Modern Chase Cards</strong> — alternate art rares, illustration rares, special art rares, and hyper rares from recent Scarlet and Violet or Sword and Shield era sets. High-grade examples of popular cards command premium prices.
            </p>
            <p>
              <strong className="text-[#1A1A1A]">Promotional and Event Cards</strong> — tournament prizes, pre-release promos, and limited distribution cards. These tend to have lower print runs and higher demand among serious collectors.
            </p>
            <p>
              For a more detailed breakdown, read our guide on <Link href="/guides/what-pokemon-cards-are-worth-grading" className="text-[#E3350D] hover:underline" data-testid="link-worth-grading">which Pokemon cards are worth grading</Link>.
            </p>
          </div>
        </section>

        <section className="mb-10" data-testid="section-why-uk">
          <h2 className="text-2xl font-bold text-[#E3350D] tracking-wide mb-4">Why Choose a UK Pokemon Card Grading Service?</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
            {[
              { icon: <Shield size={20} />, title: "No International Shipping", desc: "Your cards stay within the UK. No risk of loss or damage during international transit, no customs delays." },
              { icon: <Clock size={20} />, title: "Faster Turnaround", desc: "Domestic shipping means your cards reach us quickly and are returned promptly after grading." },
              { icon: <CheckCircle size={20} />, title: "No Customs or Import Fees", desc: "Avoid unexpected duties, VAT charges, or broker fees that apply when shipping cards internationally." },
              { icon: <Award size={20} />, title: "Local Support", desc: "Contact our UK-based team directly with questions about your submission. No time zone differences." },
            ].map((item, i) => (
              <div key={i} className="flex gap-3 border border-[#E3350D]/15 rounded-lg p-4" data-testid={`card-why-uk-${i}`}>
                <div className="text-[#E3350D] shrink-0 mt-0.5">{item.icon}</div>
                <div>
                  <h3 className="text-[#1A1A1A] font-semibold text-sm mb-1">{item.title}</h3>
                  <p className="text-[#666666] text-xs leading-relaxed">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
          <p className="text-[#666666] text-sm">
            See our full <Link href="/psa-alternative-uk" className="text-[#E3350D] hover:underline" data-testid="link-psa-alt">comparison with international grading services</Link>.
          </p>
        </section>

        <section className="mb-10" data-testid="section-explore">
          <h2 className="text-xl font-bold text-[#E3350D] tracking-wide mb-4">Explore More</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              { href: "/trading-card-grading-uk", label: "Trading Card Grading UK" },
              { href: "/card-grading-service-uk", label: "Card Grading Service UK" },
              { href: "/tcg-grading-uk", label: "TCG Grading UK" },
              { href: "/how-to-grade-pokemon-cards", label: "How to Grade Pokemon Cards" },
              { href: "/guides", label: "All Guides & Articles" },
              { href: "/why-mintvault", label: "Why MintVault" },
            ].map((link) => (
              <Link key={link.href} href={link.href}>
                <span className="flex items-center gap-2 border border-[#E3350D]/15 rounded px-4 py-2.5 text-[#E3350D]/70 text-sm hover:text-[#E3350D] hover:border-[#E3350D]/30 transition-all cursor-pointer" data-testid={`link-explore-${link.href.slice(1)}`}>
                  <ArrowRight size={14} /> {link.label}
                </span>
              </Link>
            ))}
          </div>
        </section>

        <section className="mb-10">
          <FaqSection faqs={faqs} />
        </section>

        <PokeballDivider />

        <section className="max-w-3xl mx-auto border border-[#E3350D]/30 rounded-lg p-6 md:p-8 bg-[#E3350D]/5 text-center" data-testid="section-cta">
          <h2 className="text-xl md:text-2xl font-bold text-[#E3350D] tracking-wide mb-3">Grade Your Pokemon Cards Today</h2>
          <p className="text-[#666666] text-sm mb-6 max-w-lg mx-auto">Professional UK-based grading with fast turnaround and insured return shipping.</p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link href="/submit?tier=standard">
              <span className="inline-flex items-center gap-2 border border-[#E3350D] bg-[#E3350D]/10 text-[#E3350D] px-6 py-2.5 rounded font-semibold text-sm tracking-wide transition-all hover:bg-[#E3350D]/20 cursor-pointer" data-testid="button-cta-submit">
                Submit Your Cards <ArrowRight size={16} />
              </span>
            </Link>
            <Link href="/pricing">
              <span className="inline-flex items-center gap-2 border border-[#E3350D]/30 text-[#E3350D]/70 px-6 py-2.5 rounded font-medium text-sm tracking-wide transition-all hover:text-[#E3350D] hover:border-[#E3350D]/50 cursor-pointer" data-testid="button-cta-pricing">
                View Pricing
              </span>
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
