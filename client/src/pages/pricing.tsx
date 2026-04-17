import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import type { PricingTier } from "@shared/schema";
import {
  Check, Clock, Shield, ShieldCheck, Camera, Sparkles, Lock,
  FileText, Award, Star, Package, Truck, AlertCircle, ArrowRight,
} from "lucide-react";
import SeoHead from "@/components/seo-head";
import FaqSection, { faqSchema } from "@/components/faq-section";
import CtaSection from "@/components/cta-section";

const SITE = "https://mintvaultuk.com";

const pricingSchema = {
  "@context": "https://schema.org",
  "@type": "WebPage",
  "name": "MintVault UK Pricing — Card Grading from £19",
  "url": `${SITE}/pricing`,
  "description": "Simple, transparent card grading pricing. Three speeds, one label type. Vault Queue £19, Standard £25, Express £45. UK-based service with insured return shipping.",
  "mainEntity": {
    "@type": "OfferCatalog",
    "name": "Card Grading Services",
    "itemListElement": [
      { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "Vault Queue Grading" }, "price": "19.00", "priceCurrency": "GBP" },
      { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "Standard Grading" }, "price": "25.00", "priceCurrency": "GBP" },
      { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "Express Grading" }, "price": "45.00", "priceCurrency": "GBP" },
      { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "Reholder" }, "price": "15.00", "priceCurrency": "GBP" },
      { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "Crossover" }, "price": "35.00", "priceCurrency": "GBP" },
      { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "Authentication" }, "price": "15.00", "priceCurrency": "GBP" },
    ],
  },
};

const pricingFaqs = [
  {
    question: "What's included in every grading tier?",
    answer: "Every tier includes the same professional grade assessment on our 1–10 scale, a MintSeal tamper-evident slab with VaultLock NFC, a unique online-verifiable certificate, a claim code for ownership registration, and fully insured Royal Mail return shipping. The only difference between tiers is how fast your cards are graded.",
  },
  {
    question: "How much does card grading cost in the UK?",
    answer: "MintVault grading starts from £19 per card (Vault Queue, 40 working days). Standard is £25 per card (15 working days) and Express is £45 per card (5 working days). Bulk discounts apply automatically for larger submissions — 5% off for 10+ cards, 10% off for 25+ cards, 15% off for 50+ cards.",
  },
  {
    question: "Do you offer bulk discounts?",
    answer: "Yes. Bulk discounts apply automatically at checkout: 5% off for 10–24 cards, 10% off for 25–49 cards, and 15% off for 50+ cards. Discounts apply to the per-card price across all grading tiers.",
  },
  {
    question: "Is return shipping included?",
    answer: "Yes — fully insured Royal Mail return shipping is included in the price of every tier. There are no hidden shipping fees.",
  },
  {
    question: "What is the turnaround time for grading?",
    answer: "Vault Queue is 40 working days, Standard is 15 working days, and Express is 5 working days. These are working-day estimates from the date we receive your cards. You'll receive an estimated return date at checkout.",
  },
  {
    question: "What is the Black Label?",
    answer: "The Black Label is a free automatic upgrade awarded to cards that achieve perfect 10 subgrades in centering, corners, edges, and surface. The label features a black background with gold accents. It cannot be purchased — it can only be earned through grading excellence.",
  },
  {
    question: "What's included in a Reholder service?",
    answer: "Reholdering places your existing graded card into a new MintVault precision slab with a new VaultLock NFC chip and updated certificate. It does not involve re-grading the card. Cost is £15 per card, 15 working days.",
  },
  {
    question: "What is a Crossover and how much does it cost?",
    answer: "A Crossover is when you submit a card already graded by another company (PSA, BGS, CGC, etc.) to be assessed and graded by MintVault instead. We remove it from the existing slab, grade it fresh, and return it in a MintVault slab with a new certificate. Cost is £35 per card, 15 working days.",
  },
];

const BULK_TIERS = [
  { label: "10–24 cards", discount: "5% off" },
  { label: "25–49 cards", discount: "10% off" },
  { label: "50+ cards", discount: "15% off" },
];

const ANCILLARY_SERVICES = [
  {
    id: "reholder",
    name: "Reholder",
    price: "£15",
    turnaround: "15 working days",
    description: "Place your existing graded card into a new MintVault slab with updated VaultLock NFC and certificate.",
  },
  {
    id: "crossover",
    name: "Crossover",
    price: "£35",
    turnaround: "15 working days",
    description: "Submit a card graded by another company (PSA, BGS, etc.) and have it graded fresh by MintVault.",
  },
  {
    id: "authentication",
    name: "Authentication",
    price: "£15",
    turnaround: "15 working days",
    description: "Verify a card's authenticity and determine whether any physical alterations have been made.",
  },
];

// Gold tiers removed — Black Label is now a free auto-upgrade, not a paid tier

// ── Shared sub-components ────────────────────────────────────────────────────

function SectionDivider({ label }: { label: string }) {
  return (
    <div className="relative flex items-center my-3.5">
      <div className="flex-1 h-px bg-[#E8E4DC]" />
      <span className="mx-3 text-[8px] font-bold uppercase tracking-[0.12em] whitespace-nowrap text-[#888888]">
        {label}
      </span>
      <div className="flex-1 h-px bg-[#E8E4DC]" />
    </div>
  );
}

function FeatureRow({
  icon,
  label,
  value,
  star = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  star?: boolean;
}) {
  return (
    <div className="flex items-start gap-3 py-2">
      <div className="text-[#D4AF37] shrink-0 mt-0.5">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider mb-0.5 text-[#AAAAAA]">
          {label}
          {star && <span className="text-[#D4AF37] text-[9px]">★</span>}
        </div>
        <div className="text-[13px] leading-snug text-[#1A1A1A]">{value}</div>
      </div>
    </div>
  );
}

function GradeIcon() {
  return (
    <div className="w-5 h-5 rounded text-[9px] font-black flex items-center justify-center shrink-0 bg-[#1A1A1A] text-white">
      10
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function PricingPage() {

  const { data: apiTiers } = useQuery<PricingTier[]>({
    queryKey: ["/api/service-tiers", "grading"],
    queryFn: async () => {
      const res = await fetch("/api/service-tiers?serviceType=grading");
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });

  const activeTiers = apiTiers?.filter(t => t.id !== "gold" && t.id !== "gold-elite");
  const tiers: PricingTier[] = activeTiers && activeTiers.length > 0 ? activeTiers : [
    { id: "standard", name: "VAULT QUEUE", price: "£19 per card", pricePerCard: 1900, recommendedCardValue: "Any value", turnaround: "40 working days", turnaroundDays: 40, features: [] },
    { id: "priority",  name: "STANDARD",   price: "£25 per card", pricePerCard: 2500, recommendedCardValue: "Any value", turnaround: "15 working days", turnaroundDays: 15, features: [] },
    { id: "express",  name: "EXPRESS",     price: "£45 per card", pricePerCard: 4500, recommendedCardValue: "Any value", turnaround: "5 working days",  turnaroundDays: 5,  features: [] },
  ];

  const tierInsurance = ["£150", "£350", "£750"];
  const tierImaging = [
    "Hi-res card imaging, Front/Back",
    "Hi-res card imaging, Front/Back + enhanced",
    "Hi-res card imaging, Front/Back + enhanced",
  ];
  const tierBestFor = [
    "Bulk submissions & new collectors",
    "Regular collectors",
    "High-value or time-sensitive cards",
  ];

  return (
    <>
      <SeoHead
        title="Card Grading Pricing UK — From £19 | MintVault"
        description="Simple, transparent card grading pricing. Vault Queue £19/40 days, Standard £25/15 days, Express £45/5 days. Every tier includes the same precision slab and insured return shipping."
        canonical="/pricing"
        schema={[pricingSchema, faqSchema(pricingFaqs)]}
      />

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="bg-white border-b border-[#E8E4DC] py-16 md:py-20 text-center">
        <div className="max-w-2xl mx-auto px-4">
          <p className="text-[#B8960C] text-xs font-bold uppercase tracking-widest mb-3">Pricing</p>
          <h1 className="text-3xl md:text-4xl font-sans font-black text-[#1A1A1A] tracking-tight mb-4 leading-tight">
            One label. One price.<br />Pick your speed.
          </h1>
          <p className="text-[#555555] text-base leading-relaxed">
            Professional UK card grading from £19. Every tier includes the same precision slab, VaultLock NFC verification, and insured return shipping.
          </p>
        </div>
      </section>

      {/* ── Grading tiers ─────────────────────────────────────────────────── */}
      <section className="bg-[#FAFAF8] py-16 md:py-20">
        <div className="max-w-5xl mx-auto px-4">

          {/* Subtitle banner */}
          <div className="text-center mb-10">
            <div className="inline-flex items-center gap-2 bg-gradient-to-r from-[#FFFAE8] to-[#FFF4CC] border border-[#D4AF37]/40 rounded-full px-5 py-2 text-xs font-bold uppercase tracking-widest text-[#B8960C]">
              <Check className="h-3.5 w-3.5" />
              Standard is recommended for most cards
            </div>
          </div>

          {/* ── Grading tier cards ──────────────────────────────────────── */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-10">
                {tiers.map((tier, idx) => {
                  const isExpress = idx === 2;
                  const isMid  = idx === 1;
                  const isPremium = idx > 0;

                  return (
                    <div
                      key={tier.id}
                      className={`rounded-2xl border flex flex-col overflow-hidden ${
                        isExpress ? "bg-white border-2 border-[#D4AF37] shadow-lg"
                        : isMid  ? "bg-white border-[#D4AF37] shadow-lg"
                        :          "bg-white border-[#E8E4DC]"
                      }`}
                      data-testid={`card-tier-${tier.id}`}
                    >
                      {/* Card header */}
                      <div className={`px-6 pt-6 pb-5 ${
                        isExpress ? "bg-[#FFF9E6] border-b border-[#D4AF37]/20"
                        : isMid  ? "bg-[#FFFDF5] border-b border-[#F0ECE4]"
                        :          "bg-[#F7F7F5] border-b border-[#EBEBEA]"
                      }`}>
                        <div className="flex items-center gap-2 mb-3">
                          <span className={`text-[10px] font-bold uppercase tracking-widest ${
                            isExpress ? "text-[#D4AF37]" : isMid ? "text-[#B8960C]" : "text-[#888888]"
                          }`}>
                            {tier.name}
                          </span>
                          {isMid && (
                            <span className="text-[8px] font-bold uppercase tracking-widest text-[#B8960C] bg-[#FFF9E6] border border-[#D4AF37]/40 rounded-full px-2 py-0.5 leading-none">
                              Most Popular
                            </span>
                          )}
                          {isExpress && (
                            <span className="text-[8px] font-bold uppercase tracking-widest text-[#D4AF37] bg-[#FFF9E6] border border-[#D4AF37]/40 rounded-full px-2 py-0.5 leading-none">
                              Fast Track
                            </span>
                          )}
                        </div>
                        <div className="text-4xl font-black mb-1 text-[#1A1A1A]">
                          {tier.price.replace(" per card", "")}
                        </div>
                        <div className="text-xs mb-1 text-[#AAAAAA]">per card</div>
                        <div className="text-xs mt-2 text-[#888888]">
                          {tierBestFor[idx]}
                        </div>
                      </div>

                      {/* Card body */}
                      <div className="px-6 pb-6 flex-1 flex flex-col">
                        <Link href={`/submit?tier=${tier.id}`}>
                          <button className="gold-shimmer w-full py-2.5 rounded-lg text-sm font-bold uppercase tracking-wider mt-5 mb-0.5 inline-flex items-center justify-center gap-1">
                            Submit Cards <ArrowRight className="w-3.5 h-3.5" />
                          </button>
                        </Link>

                        <SectionDivider label="GRADING" />
                        <FeatureRow icon={<GradeIcon />} label="GRADE" value="Standard 1–10 pt." star={isPremium} />
                        <FeatureRow icon={<ShieldCheck className="h-4 w-4" />} label="DIGITAL REPORT" value="Full subgrade breakdown with defect analysis" star={isPremium} />

                        <SectionDivider label="SPEED & PROTECTION" />
                        <FeatureRow
                          icon={<Clock className="h-4 w-4" />}
                          label="TIMING"
                          value={`${tier.turnaround} from receipt`}
                          star={isPremium}
                        />
                        <FeatureRow
                          icon={<Shield className="h-4 w-4" />}
                          label="INSURANCE"
                          value={`${tierInsurance[idx]} per card · No Value Upcharge`}
                          star={isPremium}
                        />

                        <SectionDivider label="REPORTING" />
                        <FeatureRow icon={<FileText className="h-4 w-4" />} label="GRADING REPORT" value="Corners / Edges / Surface / Centering analysis" />
                        <FeatureRow icon={<Camera className="h-4 w-4" />} label="IMAGING" value={tierImaging[idx]} star={isPremium} />

                        <SectionDivider label="SERVICE DETAILS" />
                        <FeatureRow icon={<Sparkles className="h-4 w-4" />} label="CARD CARE" value="Fingerprint removal, Protective sleeving" />
                        <FeatureRow icon={<Lock className="h-4 w-4" />} label="ENCASING" value="VaultGlass UV protection, VaultLock NFC slab" />
                        <FeatureRow icon={<Shield className="h-4 w-4" />} label="OWNERSHIP" value="Verified ownership registry, VaultLink QR verification" />
                      </div>
                    </div>
                  );
                })}
              </div>

          <div className="text-center mb-8">
            <p className="text-sm text-[#888888] mb-1">Not sure which tier your card needs?</p>
            <Link href="/tools/estimate" className="inline-flex items-center gap-1 text-[#D4AF37] hover:text-[#B8960C] font-bold text-sm transition-colors">
              Try our free AI Pre-Grade tool →
            </Link>
          </div>

              {/* Insurance note */}
              <div className="bg-[#FFF9E6] border border-[#D4AF37]/30 rounded-xl p-4 mb-10 flex items-start gap-3">
                <ShieldCheck className="h-5 w-5 text-[#D4AF37] shrink-0 mt-0.5" />
                <p className="text-[#555555] text-xs leading-relaxed">
                  <span className="font-semibold text-[#555555]">Insurance is included at no extra cost</span> with every submission. No declared value upcharges. For cards valued above the tier limit,{" "}
                  <a href="mailto:mintvaultuk@gmail.com" className="text-[#B8960C] hover:underline">contact us</a> for additional coverage.
                </p>
              </div>


          {/* ── Black Label — always visible below tier cards ─────────────── */}
          <div className="bg-[#FFF9E6] border border-[#D4AF37]/30 rounded-2xl p-6 mb-8 flex items-start gap-5">
            <div className="w-12 h-12 rounded-xl flex items-center justify-center shrink-0" style={{ background: "linear-gradient(135deg,#D4AF37,#B8960C)", boxShadow: "0 0 20px rgba(212,175,55,0.4)" }}>
              <Star className="h-6 w-6 text-[#1A1400]" />
            </div>
            <div>
              <p className="text-[#1A1A1A] text-sm font-black uppercase tracking-widest mb-2">The Black Label</p>
              <p className="text-[#555555] text-sm leading-relaxed">
                Cards that achieve a perfect <span className="text-[#1A1A1A] font-bold">GEM MINT 10</span> with flawless subgrades in centering, corners, edges, and surface receive our exclusive Black Label — a black and gold slab marking perfection. Cards graded a standard 10 receive our white and gold GEM MINT label. <span className="text-[#D4AF37]/80 font-medium">The Black Label cannot be bought — it can only be earned.</span>
              </p>
            </div>
          </div>

          {/* ── Turnaround footnote ──────────────────────────────────────── */}
          <div className="flex items-start gap-3 mb-8 px-1">
            <Clock className="h-4 w-4 text-[#D4AF37]/60 shrink-0 mt-0.5" />
            <p className="text-[#888888] text-xs leading-relaxed">
              <span className="font-semibold text-[#555555]">*Turnaround times are measured in working days from the date your cards are received at our facility</span> — not from the date of posting. This ensures your turnaround guarantee is accurate regardless of postal delays. You'll receive an email confirmation when your cards arrive.
            </p>
          </div>

          {/* ── Always-visible sections ──────────────────────────────────── */}

          {/* What's included in every tier */}
          <div className="bg-white border border-[#E8E4DC] rounded-2xl p-6 mb-8">
            <h2 className="text-[#1A1A1A] font-bold text-sm uppercase tracking-widest mb-4 flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-[#D4AF37]" />
              What's included in every tier
            </h2>
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2.5">
              {[
                "Professional grade assessment on our 1–10 scale",
                "MintSeal tamper-evident slab with VaultLock NFC",
                "Unique online-verifiable certificate",
                "Claim code for verified ownership registration",
                "Fully insured Royal Mail return shipping",
              ].map((item) => (
                <li key={item} className="flex items-start gap-2 text-sm text-[#1A1A1A]">
                  <Check className="h-4 w-4 text-[#D4AF37] shrink-0 mt-0.5" />
                  {item}
                </li>
              ))}
            </ul>
          </div>

          {/* Bulk discounts */}
          <div className="bg-white border border-[#E8E4DC] rounded-2xl p-6 mb-8">
            <h2 className="text-[#1A1A1A] font-bold text-sm uppercase tracking-widest mb-1 flex items-center gap-2">
              <Package className="h-4 w-4 text-[#D4AF37]" />
              Bulk discounts
            </h2>
            <p className="text-[#888888] text-xs mb-5">Applied automatically at checkout. Discounts apply across all grading tiers.</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {BULK_TIERS.map((b) => (
                <div key={b.label} className="text-center border border-[#E8E4DC] rounded-xl p-4">
                  <p className="text-2xl font-black text-[#D4AF37]">{b.discount}</p>
                  <p className="text-[#555555] text-xs mt-1">{b.label}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="text-center mb-8">
            <p className="text-sm text-[#555555]">
              <span className="text-[#D4AF37] font-bold">Vault Club members save up to 20%</span> on every submission.{" "}
              <Link href="/club" className="text-[#D4AF37] hover:text-[#B8960C] underline underline-offset-2 font-medium">
                Learn about Vault Club →
              </Link>
            </p>
          </div>

          {/* Other services */}
          <div className="mb-8">
            <h2 className="text-[#1A1A1A] font-bold text-sm uppercase tracking-widest mb-5 flex items-center gap-2">
              <Truck className="h-4 w-4 text-[#D4AF37]" />
              Other services
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {ANCILLARY_SERVICES.map((svc) => (
                <div
                  key={svc.id}
                  className="bg-white border border-[#E8E4DC] rounded-xl p-5 flex flex-col cursor-pointer transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md hover:border-[#D4AF37]/40"
                >
                  <div className="flex justify-between items-start mb-2">
                    <p className="font-bold text-[#1A1A1A] text-sm">{svc.name}</p>
                    <p className="text-[#D4AF37] font-black text-2xl leading-none">{svc.price}</p>
                  </div>
                  <p className="text-[#888888] text-xs mb-3">{svc.turnaround}</p>
                  <p className="text-[#555555] text-xs leading-relaxed mb-5 flex-1">{svc.description}</p>
                  <Link href={`/submit?type=${svc.id}&tier=${svc.id}`}>
                    <button className="gold-shimmer w-full py-2 rounded-lg text-xs font-bold uppercase tracking-wider inline-flex items-center justify-center gap-1">
                      Submit Now <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </Link>
                </div>
              ))}
            </div>
          </div>

          {/* Authorized dealer */}
          <div className="border border-[#D4AF37]/30 rounded-2xl p-6 bg-white">
            <h2 className="text-[#1A1A1A] font-bold text-sm uppercase tracking-widest mb-2 flex items-center gap-2">
              <Award className="h-4 w-4 text-[#D4AF37]" />
              Become an Authorised Dealer
            </h2>
            <p className="text-[#555555] text-xs leading-relaxed mb-5">
              Own a card shop or run a local collecting community? Partner with MintVault as an official submission drop-off point.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
              {[
                "Get your shop listed on our dealer locator",
                "Earn commission on every submission",
                "Dedicated support for group submissions",
              ].map((text, i) => (
                <div key={i} className="flex items-start gap-2 text-xs text-[#555555]">
                  <Check className="h-3.5 w-3.5 text-[#D4AF37] shrink-0 mt-0.5" />
                  {text}
                </div>
              ))}
            </div>
            <p className="text-[#555555] text-xs">
              For partnership enquiries:{" "}
              <a href="mailto:mintvaultuk@gmail.com" className="text-[#B8960C] hover:underline font-medium">mintvaultuk@gmail.com</a>
            </p>
          </div>

        </div>
      </section>

      {/* FAQ */}
      <section className="bg-white py-16 md:py-20 border-t border-[#E8E4DC]">
        <div className="max-w-2xl mx-auto px-4">
          <FaqSection faqs={pricingFaqs} title="Pricing FAQ" />
        </div>
      </section>

      <CtaSection />
    </>
  );
}
