import { Link } from "wouter";
import SeoHead from "@/components/seo-head";
import BreadcrumbNav, { breadcrumbSchema } from "@/components/breadcrumb-nav";
import FaqSection, { faqSchema } from "@/components/faq-section";
import CtaSection from "@/components/cta-section";
import { Shield, Clock, Award, CheckCircle, ArrowRight, Globe } from "lucide-react";

const breadcrumbs = [
  { label: "Home", href: "/" },
  { label: "PSA Alternative UK" },
];

const faqs = [
  {
    question: "Is MintVault a direct replacement for PSA?",
    answer: "MintVault is a professional UK-based card grading service offering the same core deliverables as PSA: expert condition assessment, numerical grading on a 1–10 scale, tamper-evident encapsulation, and unique verifiable certificates. For UK collectors, MintVault offers significant practical advantages — no international shipping, no customs fees, faster turnaround, and UK-based support. PSA remains a recognised global brand, and some collectors use both services depending on their needs.",
  },
  {
    question: "Are MintVault grades recognised by buyers and sellers?",
    answer: "Yes. Every MintVault graded card carries a unique certificate number that can be instantly verified by anyone through our <a href='/cert' class='text-[#D4AF37] hover:underline'>certificate lookup tool</a>. This gives buyers full confidence in the grade and authenticity. Collectors across the UK actively buy, sell, and trade MintVault-graded cards on secondary marketplaces.",
  },
  {
    question: "How much do I save by grading in the UK instead of sending to PSA?",
    answer: "The savings depend on your specific circumstances. By grading with MintVault, you avoid international tracked shipping costs (typically £15-30 each way), potential customs duties, VAT on the grading service charged at import, and broker fees. You also avoid the risk and expense associated with international transit of valuable cards.",
  },
  {
    question: "Can I grade non-Pokemon cards with MintVault?",
    answer: "Yes. MintVault grades cards from all major trading card games including Pokemon, Yu-Gi-Oh!, Magic: The Gathering, One Piece, Dragon Ball Super, Lorcana, and many more. See our <a href='/trading-card-grading-uk' class='text-[#D4AF37] hover:underline'>trading card grading page</a> for the full list.",
  },
  {
    question: "What turnaround times does MintVault offer compared to PSA?",
    answer: "MintVault offers three service tiers with turnaround from 5 to 40 working days. Because there is no international shipping involved, total time from sending your cards to receiving them back is significantly reduced compared to using an overseas service. PSA turnaround times have historically varied considerably depending on demand.",
  },
];

const serviceSchema = {
  "@context": "https://schema.org",
  "@type": "Service",
  name: "PSA Alternative UK - MintVault Card Grading",
  provider: {
    "@type": "Organization",
    name: "MintVault UK",
    url: "https://mintvaultuk.com",
  },
  description: "UK-based alternative to PSA for professional trading card grading. No international shipping, no customs fees, fast turnaround.",
  areaServed: "United Kingdom",
  serviceType: "Trading Card Grading",
};

const schema = [
  breadcrumbSchema(breadcrumbs),
  serviceSchema,
  faqSchema(faqs),
];

export default function PsaAlternativeUk() {
  return (
    <div className="px-4 py-10">
      <SeoHead
        title="PSA Alternative UK | UK Card Grading Service | MintVault"
        description="Looking for a PSA alternative in the UK? MintVault offers professional card grading without international shipping, customs fees, or long wait times. Grade locally from £19/card."
        canonical="https://mintvaultuk.com/psa-alternative-uk"
        ogImage="https://mintvaultuk.com/images/collector-lifestyle.webp"
        schema={schema}
      />

      <div className="max-w-3xl mx-auto">
        <BreadcrumbNav items={breadcrumbs} />

        <h1 className="text-3xl md:text-4xl font-bold text-[#1A1A1A] tracking-wide mb-6" data-testid="text-h1-psa-alternative">
          PSA Alternative UK: Grade Your Cards Locally
        </h1>

        <p className="text-[#555555] text-base leading-relaxed mb-4">
          UK collectors no longer need to send their cards overseas to receive a professional grading service. MintVault delivers expert card grading, tamper-evident encapsulation, and fully verifiable certificates — all without leaving the UK. No customs paperwork, no import duties, no weeks spent waiting for international shipping.
        </p>
        <p className="text-[#555555] text-sm leading-relaxed mb-8">
          While PSA, BGS, and CGC are well-known names in the grading world, MintVault was built specifically for UK collectors who want a faster, more predictable, and more cost-effective grading experience. This page explains the practical advantages of grading your cards domestically.
        </p>

        <section className="mb-10" data-testid="section-comparison">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">UK vs US Grading: A Practical Comparison</h2>
          <div className="text-[#555555] text-sm leading-relaxed space-y-3">
            <p>
              Grading with a US-based company from the UK introduces several layers of cost, risk, and delay that simply do not exist when you grade domestically. MintVault eliminates these friction points while delivering the same core outcome: a professionally assessed, encapsulated, and verifiable graded card.
            </p>

            <h3 className="text-lg font-semibold text-[#D4AF37]/90 mt-6 mb-2">Shipping and Transit</h3>
            <p>
              International tracked and insured shipping to the US typically costs £15 to £30 or more, depending on the weight and declared value of your parcel. The same applies for the return journey. Transit time each way is usually 7 to 14 days, and packages can occasionally be delayed or held by customs. With MintVault, you ship domestically within the UK using Royal Mail or a courier, with shorter transit times, lower costs, and significantly less risk of loss during transit.
            </p>

            <h3 className="text-lg font-semibold text-[#D4AF37]/90 mt-6 mb-2">Customs and Import Fees</h3>
            <p>
              When graded cards are returned to the UK from the US, they may be subject to customs duty, import VAT (currently 20%), and courier handling fees. These charges can add up quickly, especially for high-value submissions. Because MintVault is based in the UK, there are no customs declarations, no import duties, and no VAT surprises on the return of your cards.
            </p>

            <h3 className="text-lg font-semibold text-[#D4AF37]/90 mt-6 mb-2">Turnaround Time</h3>
            <p>
              The total time from posting your cards to receiving them back includes the grading service's processing time plus shipping time in both directions. For US services, this can mean adding 2 to 4 weeks of transit time on top of the stated turnaround. MintVault's turnaround times range from 5 to 40 working days, and because shipping is domestic, the total elapsed time is much more predictable.
            </p>

            <h3 className="text-lg font-semibold text-[#D4AF37]/90 mt-6 mb-2">Brand Recognition and Verification</h3>
            <p>
              PSA, BGS, and CGC have long histories in the global grading market, and their labels are widely recognised on international marketplaces. MintVault brings the same fundamentals — expert assessment, numerical grading on a 1–10 scale, tamper-evident encapsulation, and unique certificate numbers — with the added advantage that every grade is instantly <Link href="/verify" className="text-[#D4AF37] hover:underline" data-testid="link-cert">verifiable online</Link> by any buyer, anywhere in the world. As the UK grading market matures and collectors increasingly value convenience, transparency, and domestic service quality, UK-graded cards are gaining strong traction across secondary marketplaces.
            </p>

            <h3 className="text-lg font-semibold text-[#D4AF37]/90 mt-6 mb-2">UK-Based Customer Support</h3>
            <p>
              When you grade with MintVault, you deal with a UK team in your time zone. Questions about your submission, grading queries, or return scheduling are handled directly — no navigating overseas call centres, email delays across time zones, or support tickets that take days to receive a response.
            </p>
          </div>
        </section>

        <section className="mb-10" data-testid="section-benefits-summary">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">Benefits of Grading in the UK</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
            {[
              { icon: <Shield size={20} />, title: "Cards Stay in the UK", desc: "No international transit risk. Your cards are handled domestically from start to finish." },
              { icon: <Globe size={20} />, title: "No Customs or Duties", desc: "Avoid import VAT, customs duty, and broker handling fees that apply to international returns." },
              { icon: <Clock size={20} />, title: "Faster Total Turnaround", desc: "Domestic shipping is faster and more predictable. No weeks of transit time added to the process." },
              { icon: <Award size={20} />, title: "Competitive Pricing", desc: "Grading from £19 per card with no hidden international costs. Bulk discounts available for larger orders." },
              { icon: <CheckCircle size={20} />, title: "Online Verification", desc: "Every MintVault certificate can be verified online, providing proof of grade and authenticity." },
              { icon: <Globe size={20} />, title: "UK Customer Support", desc: "Reach our team directly without time zone complications. Get answers about your submission quickly." },
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

        <section className="mb-10" data-testid="section-when-to-choose">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">Why UK Collectors Choose MintVault</h2>
          <div className="text-[#555555] text-sm leading-relaxed space-y-3">
            <p>
              For UK-based collectors, MintVault is the practical choice for professional card grading. Here is why:
            </p>
            <ul className="list-disc list-inside space-y-2 text-[#555555] text-sm pl-2">
              <li>Your cards stay in the UK — no international transit risk for irreplaceable items</li>
              <li>Zero customs paperwork, zero import charges, zero VAT surprises</li>
              <li>Predictable turnaround: 5 to 40 working days, with no international shipping delays added</li>
              <li>Transparent pricing from £19 per card — what you see is what you pay</li>
              <li>UK-based support team available in your time zone</li>
              <li>Bulk discounts up to 15% make large submissions significantly more affordable than shipping overseas</li>
            </ul>
            <p className="mt-3">
              Some collectors also use PSA or BGS for specific high-value pieces intended for the international auction market. MintVault complements this approach perfectly — grade your broader collection domestically with the speed and cost savings of a UK service, and reserve international grading only where global brand recognition is essential to your selling strategy.
            </p>
          </div>
        </section>

        <section className="mb-10" data-testid="section-how-it-works">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">How MintVault Works</h2>
          <div className="text-[#555555] text-sm leading-relaxed space-y-3">
            <p>
              Getting your cards graded with MintVault is simple. <Link href="/submit" className="text-[#D4AF37] hover:underline" data-testid="link-submit">Create a submission</Link> online, choose your service tier, and post your cards to us. Our graders assess each card on a 1 to 10 scale, encapsulate them in tamper-evident slabs, and return them via fully insured shipping.
            </p>
            <p>
              Every card receives a unique certificate number that can be verified at any time through our website. Read our <Link href="/how-to-grade-pokemon-cards" className="text-[#D4AF37] hover:underline" data-testid="link-guide">step-by-step grading guide</Link> for detailed instructions on preparing and submitting your cards.
            </p>
            <p>
              Learn more about <Link href="/why-mintvault" className="text-[#D4AF37] hover:underline" data-testid="link-why-mv">why collectors choose MintVault</Link>.
            </p>
          </div>
        </section>

        <section className="mb-10" data-testid="section-explore">
          <h2 className="text-xl font-bold text-[#D4AF37] tracking-wide mb-4">Related Pages</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              { href: "/pokemon-card-grading-uk", label: "Pokemon Card Grading UK" },
              { href: "/trading-card-grading-uk", label: "Trading Card Grading UK" },
              { href: "/card-grading-service-uk", label: "Card Grading Service UK" },
              { href: "/tcg-grading-uk", label: "TCG Grading UK" },
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
          title="Grade Your Cards in the UK"
          subtitle="No customs, no international shipping risks. Professional grading from £19 per card with insured returns."
        />
      </div>
    </div>
  );
}
