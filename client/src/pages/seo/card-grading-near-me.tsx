import { Link } from "wouter";
import SeoHead from "@/components/seo-head";
import BreadcrumbNav, { breadcrumbSchema } from "@/components/breadcrumb-nav";
import FaqSection, { faqSchema } from "@/components/faq-section";
import CtaSection from "@/components/cta-section";
import { Shield, Package, CheckCircle, ArrowRight } from "lucide-react";

const breadcrumbs = [
  { label: "Home", href: "/" },
  { label: "Card Grading Near Me" },
];

const faqs = [
  {
    question: "Is there a card grading service near me in the UK?",
    answer: "MintVault UK accepts card submissions by post from anywhere in the United Kingdom. Whether you are in London, Manchester, Birmingham, Edinburgh, Cardiff, or a rural area, the process is the same — submit online, post your cards, and receive them back graded and encapsulated in tamper-evident slabs.",
  },
  {
    question: "Do I need to visit a physical location to get my cards graded?",
    answer: "No. MintVault is a fully postal service. You submit your cards online, pack them securely, and post them to our UK grading facility. There is no need to visit in person. This means you can access professional UK grading regardless of where you live.",
  },
  {
    question: "How do I send my cards safely for grading?",
    answer: "MintVault provides full packing guidance after you submit online. Cards should be placed in penny sleeves, then top loaders or card savers, padded with bubble wrap inside a rigid box or padded envelope. We recommend sending via Royal Mail Special Delivery or a tracked courier for security.",
  },
  {
    question: "How long does card grading take by post?",
    answer: "MintVault offers three service tiers. Vault Queue is 40 working days, Standard is 15 working days, and Express is 5 working days — measured from when your cards arrive at our facility. You'll receive confirmation when your cards are received and when grading is complete.",
  },
  {
    question: "Can I track my card grading submission?",
    answer: "Yes. After submission, you can track the status of your order online using your submission reference number. You'll receive email notifications when your cards are received, when grading is complete, and when your return package is dispatched.",
  },
];

const schema = [
  breadcrumbSchema(breadcrumbs),
  {
    "@context": "https://schema.org",
    "@type": "Service",
    name: "Card Grading Near Me — UK Postal Service",
    provider: { "@type": "Organization", name: "MintVault UK", url: "https://mintvaultuk.com" },
    description: "UK card grading by post — no local drop-off required. MintVault accepts cards from anywhere in the UK. Professional grading from £19 per card.",
    areaServed: "United Kingdom",
    serviceType: "Trading Card Grading",
  },
  faqSchema(faqs),
];

export default function CardGradingNearMe() {
  return (
    <div className="px-4 py-10">
      <SeoHead
        title="Card Grading Near Me | UK Card Grading by Post | MintVault"
        description="Looking for card grading near you in the UK? MintVault accepts postal submissions from anywhere in the UK. Professional grading from £19 — no drop-off needed."
        canonical="https://mintvaultuk.com/card-grading-near-me"
        ogImage="https://mintvaultuk.com/images/collector-lifestyle.webp"
        schema={schema}
      />

      <div className="max-w-3xl mx-auto">
        <BreadcrumbNav items={breadcrumbs} />

        <h1 className="text-3xl md:text-4xl font-bold text-[#1A1A1A] tracking-wide mb-6" data-testid="text-h1-near-me">
          Card Grading Near Me
        </h1>

        <p className="text-[#444444] text-base leading-relaxed mb-4">
          MintVault UK is a fully postal card grading service, accepting submissions from anywhere in the United Kingdom. Whether you're in London, Glasgow, Cardiff, Belfast, or anywhere in between — you have access to professional UK card grading without needing to travel to a physical location.
        </p>

        <p className="text-[#666666] text-sm leading-relaxed mb-8">
          Submit your cards online, pack them securely using our guidance, and post them to our UK facility. We'll grade, encapsulate, and return them via fully insured tracked delivery. No drop-off, no travel, no hassle.
        </p>

        <section className="mb-10" data-testid="section-nearme-how">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">How Postal Card Grading Works</h2>
          <div className="space-y-4">
            {[
              { step: "1", title: "Submit online", desc: "Go to mintvaultuk.com/submit, enter your card details, choose your service tier, and pay securely online." },
              { step: "2", title: "Pack and post", desc: "Follow our packing guide to protect your cards. Post to our UK address via tracked, insured delivery." },
              { step: "3", title: "We grade your cards", desc: "Our graders assess each card on centering, corners, edges, and surface. You'll be notified when grading is complete." },
              { step: "4", title: "Cards returned in slabs", desc: "Your graded cards are sealed in tamper-evident NFC-enabled precision slabs and returned via insured tracked delivery." },
            ].map((item) => (
              <div key={item.step} className="flex gap-4 border border-[#D4AF37]/20 bg-[#FAFAF8] rounded-2xl p-4">
                <div className="shrink-0 w-8 h-8 rounded-full bg-[#D4AF37] text-[#1A1400] font-bold text-sm flex items-center justify-center">
                  {item.step}
                </div>
                <div>
                  <h3 className="text-[#1A1A1A] font-semibold text-sm mb-1">{item.title}</h3>
                  <p className="text-[#666666] text-xs leading-relaxed">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="mb-10" data-testid="section-nearme-features">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">Everything Included, Wherever You Are</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              { icon: <Shield size={16} />, title: "UK-based processing", desc: "Cards graded and returned entirely within the UK — no customs, no international risk." },
              { icon: <Package size={16} />, title: "Insured return shipping", desc: "Every return shipment is fully insured based on the declared value of your cards." },
              { icon: <CheckCircle size={16} />, title: "Online tracking", desc: "Track your submission status online at any time using your submission reference." },
              { icon: <CheckCircle size={16} />, title: "NFC-verified slabs", desc: "Every slab has an NFC chip — buyers can verify your certificate with a phone scan." },
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

        <section className="mb-10" data-testid="section-nearme-tiers">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">Service Tiers & Pricing</h2>
          <div className="space-y-3">
            {[
              { tier: "Vault Queue", days: "40 working days", price: "£19/card" },
              { tier: "Standard", days: "15 working days", price: "£25/card" },
              { tier: "Express", days: "5 working days", price: "£45/card" },
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

        <FaqSection faqs={faqs} title="Card Grading Near Me — FAQs" />

        <div className="mt-10">
          <CtaSection title="Grade Your Cards From Anywhere in the UK" subtitle="Postal submissions accepted from across the United Kingdom. Submit online in minutes." />
        </div>

        <section className="mt-10">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              { href: "/card-grading-service-uk", label: "Card Grading Service UK" },
              { href: "/card-grading-cost-uk", label: "Card Grading Cost UK" },
              { href: "/best-card-grading-uk", label: "Best Card Grading UK" },
              { href: "/trading-card-grading-uk", label: "Trading Card Grading UK" },
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
