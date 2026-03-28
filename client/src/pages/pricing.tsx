import { useState, useRef } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { pricingTiers, bulkDiscountTiers, submissionTypes } from "@shared/schema";
import type { PricingTier } from "@shared/schema";
const logoPath = "/mintvault-logo.png";
import { Percent, Shield, Clock, Award, Package, CheckCircle, ArrowRight, BookOpen, Lock, Truck, MapPin, Eye, Star, ChevronLeft, ChevronRight, Zap, FileCheck } from "lucide-react";
import SeoHead from "@/components/seo-head";
import FaqSection, { faqSchema } from "@/components/faq-section";
import CtaSection from "@/components/cta-section";

const homeFaqs = [
  {
    question: "How does Pokémon card grading work in the UK?",
    answer: "You submit your cards to MintVault UK using our online submission wizard. We receive, inspect, and professionally grade each card on a 1–10 scale assessing centering, corners, edges, and surface quality. Your cards are then sealed in tamper-evident precision slabs and returned with fully insured shipping."
  },
  {
    question: "Is card grading worth it?",
    answer: "For valuable or rare cards, grading can significantly increase resale value by providing an independent, trusted assessment of condition. A Gem Mint 10 grade can multiply a card's value many times over compared to selling it raw. Even mid-grade cards benefit from the protection and authentication a slab provides."
  },
  {
    question: "What cards should I grade?",
    answer: "Cards in excellent condition with potential value above the grading cost are ideal candidates. This includes vintage cards, chase cards, full art and secret rares, first editions, and any card you believe is in near-mint or better condition. Our <a href='/guides/what-pokemon-cards-are-worth-grading' class='text-[#f2ca50] hover:underline'>guide on which cards to grade</a> covers this in detail."
  },
  {
    question: "How long does card grading take?",
    answer: "Turnaround depends on your chosen service tier. Our Basic tier offers 60 working days, Standard is 20 working days, Premier is 10 working days, Ultra is 5 working days, and Elite provides just 2 working day turnaround. You can track your submission status online at any time."
  },
  {
    question: "How much does card grading cost in the UK?",
    answer: "Our grading prices start from just £12 per card for our Basic tier. We offer five tiers to suit different needs and budgets, with bulk discounts of up to 10% for larger submissions. All prices include fully insured return shipping based on your declared value. See our <a href='/' class='text-[#f2ca50] hover:underline'>pricing section</a> for full details."
  },
  {
    question: "How do I send my cards for grading safely?",
    answer: "We recommend using penny sleeves and top loaders for each card, then packing them securely in a padded envelope or small box. Use tracked and insured shipping to our facility. Our <a href='/guides/how-to-send-cards-for-grading-safely' class='text-[#f2ca50] hover:underline'>shipping guide</a> has detailed step-by-step instructions."
  },
  {
    question: "Why use a UK grading company instead of PSA or BGS?",
    answer: "Using a UK-based service like MintVault means faster turnaround, no international shipping risks, no customs fees, and local customer support. Your cards stay within the UK throughout the process, reducing the chance of loss or damage. Read our <a href='/psa-alternative-uk' class='text-[#f2ca50] hover:underline'>PSA alternative comparison</a> for more details."
  },
  {
    question: "What affects a card's grade?",
    answer: "Four main factors determine a card's grade: centering (how well the image is centred within the borders), corners (sharpness and wear), edges (whitening or damage along card edges), and surface (scratches, print lines, or other blemishes). Our graders assess each factor carefully to assign an overall grade from 1 to 10."
  },
];

const SITE = "https://mintvaultuk.com";

const homeSchema = [
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    "name": "MintVault UK",
    "url": SITE,
    "logo": `${SITE}/images/collector-lifestyle.webp`,
    "description": "Professional UK trading card grading service offering Pokémon, Yu-Gi-Oh!, Magic: The Gathering and TCG card grading with tamper-evident slabs and insured return shipping.",
    "areaServed": {
      "@type": "Country",
      "name": "United Kingdom"
    },
    "sameAs": []
  },
  {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "name": "MintVault UK",
    "url": SITE,
    "potentialAction": {
      "@type": "SearchAction",
      "target": `${SITE}/cert?q={search_term_string}`,
      "query-input": "required name=search_term_string"
    }
  },
  {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    "@id": `${SITE}/#business`,
    "name": "MintVault UK",
    "description": "Professional Pokémon and trading card grading service in the UK. Expert grading on a 1–10 scale, tamper-evident precision slabs, and fully insured return shipping.",
    "url": SITE,
    "image": `${SITE}/images/collector-lifestyle.webp`,
    "areaServed": {
      "@type": "Country",
      "name": "United Kingdom"
    },
    "priceRange": "£12–£50 per card",
    "serviceType": "Trading Card Grading",
    "hasOfferCatalog": {
      "@type": "OfferCatalog",
      "name": "Card Grading Services",
      "itemListElement": [
        { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "Basic Grading" }, "price": "12.00", "priceCurrency": "GBP" },
        { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "Standard Grading" }, "price": "15.00", "priceCurrency": "GBP" },
        { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "Premier Grading" }, "price": "18.00", "priceCurrency": "GBP" },
        { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "Ultra Grading" }, "price": "25.00", "priceCurrency": "GBP" },
        { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "Elite Grading" }, "price": "50.00", "priceCurrency": "GBP" }
      ]
    }
  },
  faqSchema(homeFaqs)
];

// Fills 100% of whatever container it sits in — no fixed heights.
// The parent controls size via aspect-ratio, so fallback = image height exactly.
function PremiumSlabFallback() {
  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center w-full h-full"
      style={{
        background: "linear-gradient(160deg, #1c1b1b 0%, #131313 100%)",
      }}
    >
      <div className="flex flex-col items-center gap-3 px-6 text-center">
        <div
          className="w-14 h-14 rounded-full flex items-center justify-center shrink-0"
          style={{ background: "rgba(242,202,80,0.12)", border: "1px solid rgba(242,202,80,0.3)" }}
        >
          <Award size={28} className="text-[#f2ca50]" />
        </div>
        <p className="text-[#f2ca50] font-bold tracking-widest text-sm uppercase">MintVault Premium Slab</p>
        <p className="text-[#e5e2e1]/70 text-xs leading-relaxed max-w-[220px]">
          Professional grading. Tamper-evident precision encapsulation.
        </p>
        <div className="flex flex-wrap justify-center gap-1.5 mt-1">
          {["Centering", "Corners", "Edges", "Surface"].map((label) => (
            <span key={label} className="text-[10px] text-[#f2ca50]/70 border border-[#f2ca50]/25 rounded px-1.5 py-0.5">
              {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// aspect is the CSS aspect-ratio string, e.g. "4/3" or "40/21"
function ImageWithFallback({
  webp, fallbackSrc, alt, overlay, aspect,
}: {
  webp: string; fallbackSrc: string; alt: string;
  overlay?: JSX.Element; aspect: string;
}) {
  const [errored, setErrored] = useState(false);
  return (
    <div
      className="relative rounded-2xl overflow-hidden shadow-lg max-w-md mx-auto border border-[#f2ca50]/20"
      style={{ aspectRatio: aspect }}
    >
      {errored ? (
        <PremiumSlabFallback />
      ) : (
        <picture>
          <source srcSet={webp} type="image/webp" />
          <img
            src={fallbackSrc}
            alt={alt}
            className="w-full h-full object-cover block"
            loading="lazy"
            onError={() => setErrored(true)}
          />
        </picture>
      )}
      {!errored && (
        <span className="absolute bottom-2 right-2 text-white/25 text-[10px] font-medium tracking-wider pointer-events-none select-none">
          Sample Image
        </span>
      )}
      {!errored && overlay}
    </div>
  );
}

function GradingImage() {
  return (
    <ImageWithFallback
      webp="/images/premium-slab-closeup.webp"
      fallbackSrc="/images/premium-slab-closeup.png"
      alt="MintVault premium grading slab close-up – professional trading card grading"
      aspect="4/3"
    />
  );
}

function ReholderImage() {
  return (
    <ImageWithFallback
      webp="/images/reholder-upgrade.webp"
      fallbackSrc="/images/reholder-upgrade.png"
      alt="MintVault reholder upgrade – before and after slab comparison"
      aspect="4/3"
      overlay={
        <>
          <span className="absolute top-3 left-3 bg-[#131313]/90 text-[#e5e2e1] text-xs font-semibold px-2 py-1 rounded-md">Standard Slab</span>
          <span className="absolute top-3 right-3 bg-[#f2ca50] text-black text-xs font-semibold px-2 py-1 rounded">MintVault Upgrade</span>
        </>
      }
    />
  );
}

function LifestyleImage() {
  const [errored, setErrored] = useState(false);
  return (
    <div
      className="relative rounded-2xl overflow-hidden shadow-xl border border-[#f2ca50]/20"
      style={{ aspectRatio: "40/21" }}
    >
      {errored ? (
        <PremiumSlabFallback />
      ) : (
        <picture>
          <source media="(max-width: 480px)" srcSet="/images/collector-lifestyle-mobile.webp" type="image/webp" />
          <source srcSet="/images/collector-lifestyle.webp" type="image/webp" />
          <img
            src="/images/collector-lifestyle.png"
            alt="Premium graded trading card collection – MintVault UK card grading service"
            className="w-full h-full object-cover block"
            loading="lazy"
            onError={() => setErrored(true)}
          />
        </picture>
      )}
      {!errored && (
        <span className="absolute bottom-2 right-2 text-white/25 text-[10px] font-medium tracking-wider pointer-events-none select-none">
          Sample Image
        </span>
      )}
    </div>
  );
}

type FeaturedCert = {
  certId: string;
  cardName: string;
  setName: string;
  gradeOverall: string;
  gradeType: string;
  cardGame: string;
  frontImageUrl: string;
};

function FeaturedCertsSection() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { data: certs = [] } = useQuery<FeaturedCert[]>({
    queryKey: ["/api/featured-certificates"],
    queryFn: async () => {
      const res = await fetch("/api/featured-certificates");
      if (!res.ok) return [];
      return res.json();
    },
  });

  if (!certs || certs.length === 0) return null;

  const scroll = (dir: "left" | "right") => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollBy({ left: dir === "left" ? -220 : 220, behavior: "smooth" });
  };

  return (
    <section className="px-4 max-w-3xl mx-auto mb-12" data-testid="section-featured-certs">
      <h2 className="text-2xl font-black text-[#e5e2e1] tracking-tighter mb-2 text-center">VIEW REAL <span className="text-[#f2ca50]">CERTIFICATES</span></h2>
      <p className="text-[#e5e2e1]/50 text-sm text-center mb-5">Real graded cards. Live certificates. Tap any card to verify.</p>
      <div className="relative">
        {certs.length > 2 && (
          <>
            <button
              type="button"
              onClick={() => scroll("left")}
              className="absolute -left-3 top-1/2 -translate-y-1/2 z-10 w-8 h-8 rounded-full bg-[#1c1b1b] border border-[#f2ca50]/30 flex items-center justify-center text-[#f2ca50] hover:bg-[#f2ca50]/10 transition-all shadow-lg"
              data-testid="button-certs-scroll-left"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              type="button"
              onClick={() => scroll("right")}
              className="absolute -right-3 top-1/2 -translate-y-1/2 z-10 w-8 h-8 rounded-full bg-[#1c1b1b] border border-[#f2ca50]/30 flex items-center justify-center text-[#f2ca50] hover:bg-[#f2ca50]/10 transition-all shadow-lg"
              data-testid="button-certs-scroll-right"
            >
              <ChevronRight size={16} />
            </button>
          </>
        )}
        <div
          ref={scrollRef}
          className="flex gap-4 overflow-x-auto pb-2 scroll-smooth"
          style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
          data-testid="container-featured-certs"
        >
          {certs.map((cert) => {
            const grade = parseFloat(cert.gradeOverall || "0");
            const gradeColour =
              grade >= 10 ? "text-emerald-400" :
              grade >= 9  ? "text-[#f2ca50]" :
              grade >= 8  ? "text-blue-400" :
              "text-[#e5e2e1]/50";
            return (
              <Link key={cert.certId} href={`/cert/${cert.certId}`}>
                <div
                  className="shrink-0 w-44 border border-[#f2ca50]/20 bg-[#1c1b1b] rounded-2xl overflow-hidden hover:border-[#f2ca50]/50 hover:shadow-[0_0_16px_rgba(242,202,80,0.12)] transition-all cursor-pointer"
                  data-testid={`card-featured-cert-${cert.certId}`}
                >
                  <div className="aspect-[3/4] bg-[#131313]/60 overflow-hidden">
                    <img
                      src={cert.frontImageUrl}
                      alt={`${cert.cardName} — MintVault Certificate ${cert.certId}`}
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  </div>
                  <div className="p-3">
                    <p className="text-[#e5e2e1] text-xs font-semibold leading-tight line-clamp-2 mb-1">{cert.cardName}</p>
                    <p className="text-[#e5e2e1]/40 text-[10px] leading-tight truncate mb-2">{cert.setName}</p>
                    <div className="flex items-center justify-between">
                      <span className={`text-lg font-bold ${gradeColour}`}>{cert.gradeType === "numeric" ? cert.gradeOverall : cert.gradeType}</span>
                      <span className="text-[#f2ca50]/50 text-[10px] font-mono">{cert.certId}</span>
                    </div>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function TrustBadgesStrip() {
  const badges = [
    { icon: <Lock size={16} />, label: "Secure Payments" },
    { icon: <Truck size={16} />, label: "Fully Insured Return" },
    { icon: <MapPin size={16} />, label: "UK-Based Service" },
    { icon: <Eye size={16} />, label: "Online Verification" },
  ];
  return (
    <section className="px-4 max-w-3xl mx-auto mb-10" data-testid="section-trust-badges">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {badges.map((b, i) => (
          <div
            key={i}
            className="flex flex-col items-center gap-2 border border-[#f2ca50]/20 bg-[#1c1b1b] rounded-2xl py-4 px-2"
            data-testid={`badge-trust-${i}`}
          >
            <span className="text-[#f2ca50]/70">{b.icon}</span>
            <span className="text-[#e5e2e1]/70 text-xs text-center font-medium">{b.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function PricingPage() {
  const [activeService, setActiveService] = useState("grading");

  const { data: fetchedTiers } = useQuery<PricingTier[]>({
    queryKey: ["/api/service-tiers", activeService],
    queryFn: async () => {
      const res = await fetch(`/api/service-tiers?serviceType=${activeService}`);
      if (!res.ok) throw new Error("Failed to fetch tiers");
      return res.json();
    },
  });

  const tiers = fetchedTiers || pricingTiers;
  const activeType = submissionTypes.find(t => t.id === activeService);
  const serviceLabel = activeType?.name?.toUpperCase() || "GRADING";

  return (
    <div className="bg-[#131313] text-[#e5e2e1] overflow-x-hidden">
      <SeoHead
        title="Pricing | MintVault UK"
        description="Transparent card grading pricing for UK collectors. Standard, Express and Bulk tiers available. Fully insured return shipping included. No hidden fees."
        canonical={`${SITE}/pricing`}
        ogImage={`${SITE}/images/collector-lifestyle.webp`}
        schema={homeSchema}
      />

      <article>
        <section className="text-center px-4 pt-12 pb-8 max-w-3xl mx-auto">
          <img
            src={logoPath}
            alt="MintVault UK - Professional Pokemon and Trading Card Grading Service"
            className="mx-auto w-64 md:w-80 h-auto mb-6"
            loading="eager"
            width={320}
            height={120}
            data-testid="img-hero-logo"
          />
          <h1
            className="text-3xl md:text-5xl font-black text-[#e5e2e1] tracking-tighter leading-none mb-4"
            data-testid="text-hero-title"
          >
            PROFESSIONAL CARD GRADING<br />
            <span className="text-[#f2ca50]">IN THE UK</span>
          </h1>
          <p className="text-[#e5e2e1]/60 text-base md:text-lg leading-relaxed max-w-xl mx-auto mb-4" data-testid="text-hero-description">
            MintVault UK offers professional trading card grading for Pokémon, Yu-Gi-Oh!, Magic: The Gathering and all major TCGs. Based in the United Kingdom, we provide fast turnaround, tamper-evident precision slabs, and fully insured return shipping.
          </p>
          <p className="text-[#e5e2e1]/70 text-sm leading-relaxed max-w-lg mx-auto">
            Whether you are a collector looking to protect your most valuable pulls or a seller wanting to maximise resale value, our UK card grading service delivers trusted, professional results.
          </p>
        </section>

        <section className="px-4 max-w-3xl mx-auto mb-10">
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link href="/submit">
              <span
                className="inline-flex items-center gap-2 px-7 py-3 rounded-xl font-black text-sm tracking-widest text-[#3c2f00] active:scale-95 transition-transform cursor-pointer"
                style={{ background: "linear-gradient(135deg,#f2ca50 0%,#d4af37 100%)" }}
                data-testid="button-hero-submit"
              >
                SUBMIT CARDS <ArrowRight size={15} />
              </span>
            </Link>
            <Link href="/cert">
              <span className="inline-flex items-center gap-2 border border-[#f2ca50]/30 text-[#f2ca50]/70 px-6 py-3 rounded-xl font-semibold text-sm tracking-wide transition-all hover:text-[#f2ca50] hover:border-[#f2ca50]/50 cursor-pointer" data-testid="button-hero-cert">
                Check a Certificate
              </span>
            </Link>
          </div>
          <p className="text-[#e5e2e1]/40 text-xs text-center mt-3 flex items-center justify-center gap-1.5" data-testid="text-cta-support">
            <Truck size={12} className="text-[#f2ca50]/40 shrink-0" />
            Tracked, insured and handled with care
          </p>
        </section>

        <section className="px-4 max-w-3xl mx-auto mb-12" data-testid="section-how-it-works">
          <h2 className="text-2xl font-black text-[#f2ca50] tracking-tighter mb-6 text-center">How It Works</h2>
          <div className="space-y-3">
            {[
              { icon: <Package size={18} />, n: "01", title: "Submit your cards online", desc: "Choose your service tier, enter your card details, and pay securely online in minutes." },
              { icon: <Truck size={18} />, n: "02", title: "Send them securely to MintVault", desc: "Pack your cards using penny sleeves and top loaders. Post to us via tracked, insured shipping." },
              { icon: <Award size={18} />, n: "03", title: "We grade and encapsulate", desc: "Expert graders assess centering, corners, edges, and surface. Cards are sealed in tamper-evident precision slabs." },
              { icon: <Eye size={18} />, n: "04", title: "Track your order online", desc: "Follow every status update in real time. Each certificate is verifiable online the moment it is issued." },
              { icon: <Shield size={18} />, n: "05", title: "Cards returned fully insured", desc: "Your slabbed cards are returned via fully insured tracked delivery, protected for the entire journey." },
            ].map((step, i) => (
              <div key={i} className="flex gap-4 border border-[#f2ca50]/20 bg-[#1c1b1b] rounded-2xl p-4" data-testid={`card-step-${i}`}>
                <div className="shrink-0 flex flex-col items-center gap-1">
                  <span className="text-[#f2ca50]/30 text-[10px] font-mono font-bold">{step.n}</span>
                  <div className="text-[#f2ca50]">{step.icon}</div>
                </div>
                <div>
                  <h3 className="text-[#e5e2e1] font-semibold text-sm mb-1">{step.title}</h3>
                  <p className="text-[#e5e2e1]/70 text-xs leading-relaxed">{step.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="px-4 max-w-3xl mx-auto mb-12" data-testid="section-why-grade">
          <h2 className="text-2xl font-black text-[#f2ca50] tracking-tighter mb-4">Why Collectors Grade Their Cards</h2>
          <div className="text-[#e5e2e1]/70 text-sm leading-relaxed space-y-3">
            <p>
              Card grading transforms a raw trading card into a professionally authenticated, condition-verified collectible sealed in a protective slab. For Pokémon card collectors and investors across the UK, grading provides several key benefits.
            </p>
            <p>
              <strong className="text-[#e5e2e1]">Increased value</strong> — graded cards consistently sell for more than raw cards of similar condition. A card graded Gem Mint 10 can be worth many multiples of its raw counterpart, as buyers have confidence in the card's authenticated condition.
            </p>
            <p>
              <strong className="text-[#e5e2e1]">Protection</strong> — once sealed in a tamper-evident slab, your card is protected from handling damage, moisture, UV exposure, and accidental bending. This preserves the card's condition indefinitely.
            </p>
            <p>
              <strong className="text-[#e5e2e1]">Authentication</strong> — grading confirms your card is genuine, not a counterfeit or altered reproduction. Each MintVault certificate can be <Link href="/cert" className="text-[#f2ca50] hover:underline">verified online</Link>.
            </p>
            <p>
              Learn more in our guide on <Link href="/guides/why-graded-cards-sell-for-more" className="text-[#f2ca50] hover:underline">why graded cards sell for more</Link>.
            </p>
          </div>
        </section>

        <section className="px-4 max-w-3xl mx-auto mb-12" data-testid="section-why-mintvault">
          <h2 className="text-2xl font-black text-[#f2ca50] tracking-tighter mb-4">Why Choose MintVault</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              { icon: <FileCheck size={18} />, title: "Transparent grading criteria", desc: "Centering, corners, edges, and surface — we explain every point deduction clearly." },
              { icon: <Clock size={18} />, title: "Fast turnaround times", desc: "From 2 to 60 working days depending on your tier. Track your submission status online." },
              { icon: <Eye size={18} />, title: "Secure online verification", desc: "Every certificate is verifiable at mintvaultuk.com/cert — scannable by anyone, forever." },
              { icon: <Star size={18} />, title: "Premium slab design", desc: "Tamper-evident precision encapsulation. Your card protected and presented at its best." },
              { icon: <MapPin size={18} />, title: "UK-based service", desc: "Your cards stay in the UK — no international shipping, no customs fees, no import duties." },
            ].map((item, i) => (
              <div key={i} className="flex gap-3 border border-[#f2ca50]/20 bg-[#1c1b1b] rounded-2xl p-4" data-testid={`card-why-${i}`}>
                <div className="text-[#f2ca50] shrink-0 mt-0.5">{item.icon}</div>
                <div>
                  <h3 className="text-[#e5e2e1] font-semibold text-sm mb-1">{item.title}</h3>
                  <p className="text-[#e5e2e1]/70 text-xs leading-relaxed">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
          <p className="text-[#e5e2e1]/70 text-sm mt-4">
            Compare MintVault to international services in our <Link href="/psa-alternative-uk" className="text-[#f2ca50] hover:underline">PSA alternative guide</Link>.
          </p>
        </section>

        <section className="px-4 max-w-3xl mx-auto mb-12" data-testid="section-what-cards">
          <h2 className="text-2xl font-black text-[#f2ca50] tracking-tighter mb-4">What Cards Can Be Graded?</h2>
          <p className="text-[#e5e2e1]/70 text-sm leading-relaxed mb-4">
            MintVault UK grades cards from all major trading card games. Our grading standards are consistent across all supported TCGs:
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {["Pokémon", "Yu-Gi-Oh!", "Magic: The Gathering", "One Piece", "Dragon Ball Super", "Lorcana", "Flesh and Blood", "Digimon", "Star Wars: Unlimited", "Weiss Schwarz", "Cardfight!! Vanguard", "MetaZoo"].map((game) => (
              <div key={game} className="border border-[#f2ca50]/15 rounded px-3 py-2 text-[#f2ca50]/80 text-xs text-center">{game}</div>
            ))}
          </div>
          <p className="text-[#e5e2e1]/70 text-xs mt-3">
            See our full list of <Link href="/tcg" className="text-[#f2ca50] hover:underline">supported trading card games</Link>.
          </p>
        </section>

        <FeaturedCertsSection />
      </article>

      <section className="px-4 max-w-3xl mx-auto mb-8">
        <h2 className="text-2xl font-black text-[#e5e2e1] tracking-tighter mb-2 text-center">
          CARD <span className="text-[#f2ca50]">{serviceLabel}</span> PRICES
        </h2>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-2 sm:gap-4 mb-5">
          <p className="text-[#e5e2e1]/70 text-sm text-center" data-testid="text-trust-line">
            Trusted by collectors across the UK
          </p>
          <span className="hidden sm:block text-[#f2ca50]/30">·</span>
          <p className="text-[#f2ca50]/80 text-sm font-medium text-center" data-testid="text-urgency-line">
            ⚡ Limited slots available this month
          </p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          {[
            { id: "grading",        name: "Grading",        desc: "Grade your raw cards with MintVault." },
            { id: "reholder",       name: "Reholder",       desc: "Upgrade your existing MintVault slab." },
            { id: "crossover",      name: "Crossover",      desc: "Move cards graded by another company into MintVault." },
            { id: "authentication", name: "Authentication", desc: "Verify your card is genuine without grading." },
          ].map((st) => (
            <button
              key={st.id}
              onClick={() => setActiveService(st.id)}
              className={`flex flex-col items-center text-center p-3 rounded border transition-all ${
                activeService === st.id
                  ? "bg-[#f2ca50]/20 text-[#f2ca50] border-[#f2ca50]/40"
                  : "bg-[#1c1b1b] text-[#e5e2e1]/70 border-[#f2ca50]/15 hover:text-[#e5e2e1] hover:border-[#f2ca50]/40 hover:bg-[#f2ca50]/5"
              }`}
              data-testid={`button-pricing-${st.id}`}
            >
              <span className="font-bold tracking-wider text-sm mb-1">{st.name}</span>
              <span className="text-xs leading-snug opacity-70">{st.desc}</span>
            </button>
          ))}
        </div>

        {activeService === "grading" && (
          <div className="mt-4 mb-2">
            <GradingImage />
            <p className="text-center text-[#e5e2e1]/70 text-xs mt-2 italic">Professional grading. Tamper-evident precision slabs.</p>
          </div>
        )}

        {activeService === "reholder" && (
          <div className="mt-4 mb-2">
            <ReholderImage />
            <p className="text-center text-[#e5e2e1]/70 text-xs mt-2 italic">Upgrade your slab for a stronger, cleaner, premium finish.</p>
            <div className="flex items-center justify-center gap-4 mt-2 mb-3">
              <span className="text-[#f2ca50] font-semibold text-sm" data-testid="text-reholder-price-anchor">From £7.99 per card</span>
              <span className="text-[#f2ca50]/80 text-xs font-medium" data-testid="text-reholder-urgency">⚡ Limited intake — slots fill daily</span>
            </div>
          </div>
        )}
      </section>

      <section className="px-4 max-w-3xl mx-auto space-y-6 pb-6">
        {tiers.map((tier) => {
          const useBadges = true;

          const tierBadges: Record<string, { text: string; popular: boolean }> = {
            basic:    { text: "Economy Service",  popular: false },
            standard: { text: "Most Popular",     popular: true  },
            priority: { text: "Fast Turnaround",  popular: false },
            express:  { text: "Priority Service", popular: false },
            premium:  { text: "Fastest Service",  popular: false },
          };
          const badge = useBadges ? (tierBadges[tier.id] ?? null) : null;
          const isPopular = badge?.popular ?? false;

          const tierAvailability: Record<string, { text: string; colour: string }> = {
            basic:    { text: "Good Availability",     colour: "text-[#f2ca50]/70" },
            standard: { text: "Good Availability",     colour: "text-[#f2ca50]/70" },
            priority: { text: "Good Availability",     colour: "text-[#f2ca50]/70" },
            express:  { text: "Limited Availability",  colour: "text-[#f2ca50]"    },
            premium:  { text: "Limited Availability",  colour: "text-[#f2ca50]"    },
          };
          const availability = useBadges ? (tierAvailability[tier.id] ?? null) : null;

          return (
            <div
              key={tier.id}
              className={`relative rounded-2xl p-6 md:p-8 transition-all ${
                isPopular
                  ? "border-2 border-[#f2ca50] bg-[#f2ca50]/5 shadow-[0_0_24px_rgba(242,202,80,0.15)]"
                  : "border border-[#f2ca50]/30"
              }`}
              data-testid={`tier-${tier.id}`}
            >
              {/* Badge row — tier name + badge on one line, availability below on mobile */}
              <div className="mb-4">
                <div className="flex items-center justify-between gap-3">
                  <h3
                    className="text-2xl md:text-3xl font-black text-[#f2ca50] tracking-tighter shrink-0"
                    data-testid={`text-tier-name-${tier.id}`}
                  >
                    {tier.name}
                  </h3>
                  {badge && (
                    <span
                      className={`text-xs font-bold px-3 py-1 rounded-full tracking-wider whitespace-nowrap ${
                        isPopular
                          ? "bg-[#f2ca50] text-black"
                          : "border border-[#f2ca50]/40 text-[#f2ca50]/80"
                      }`}
                      data-testid={`badge-${tier.id}`}
                    >
                      {badge.text}
                    </span>
                  )}
                </div>
                {availability && (
                  <p
                    className={`text-xs font-medium mt-1 ${availability.colour}`}
                    data-testid={`availability-${tier.id}`}
                  >
                    {availability.text}
                  </p>
                )}
              </div>

              <div className="space-y-3 mb-6">
                <div className="flex justify-between items-center border-b border-[#f2ca50]/10 pb-3">
                  <span className="text-[#f2ca50]/70 text-sm uppercase tracking-wider">Price</span>
                  <span className="text-[#e5e2e1] font-bold text-xl" data-testid={`text-price-${tier.id}`}>
                    {tier.price}
                  </span>
                </div>
                <div className="flex justify-between items-center border-b border-[#f2ca50]/10 pb-3">
                  <span className="text-[#f2ca50]/70 text-sm uppercase tracking-wider">Turnaround</span>
                  <span className="text-[#e5e2e1] font-semibold" data-testid={`text-turnaround-${tier.id}`}>
                    {tier.turnaround}
                  </span>
                </div>
              </div>

              <div className="mb-6">
                <h4 className="text-[#f2ca50]/70 text-xs uppercase tracking-wider mb-3">Includes</h4>
                <ul className="space-y-2">
                  {tier.features.map((feature, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <CheckCircle size={14} className="text-[#f2ca50] mt-0.5 shrink-0" />
                      <span className="text-[#f2ca50]/90 text-sm" data-testid={`text-feature-${tier.id}-${i}`}>
                        {feature}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              <Link href={`/submit?type=${activeService}&tier=${tier.id}`}>
                <button
                  className="w-full py-3 rounded-xl font-black tracking-widest text-sm active:scale-95 transition-transform text-[#3c2f00]"
                  style={{ background: "linear-gradient(135deg,#f2ca50 0%,#d4af37 100%)" }}
                  data-testid={`button-submit-${tier.id}`}
                >
                  Submit Your Cards
                </button>
              </Link>
              {isPopular && (
                <p className="text-[#f2ca50]/70 text-[11px] text-center mt-2 flex items-center justify-center gap-1" data-testid="text-urgency-cta">
                  <Zap size={10} className="shrink-0" /> Turnaround times filling quickly
                </p>
              )}
            </div>
          );
        })}
      </section>

      <TrustBadgesStrip />

      <section className="px-4 max-w-3xl mx-auto pb-12" data-testid="section-bulk-discounts">
        <div className="border border-[#f2ca50]/30 rounded-2xl p-6 md:p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-full border border-[#f2ca50]/40 flex items-center justify-center">
              <Percent size={20} className="text-[#f2ca50]" />
            </div>
            <div>
              <h3 className="text-2xl font-black text-[#f2ca50] tracking-tighter" data-testid="text-bulk-title">
                BULK DISCOUNTS
              </h3>
              <p className="text-[#e5e2e1]/70 text-sm">Save more when you submit more cards</p>
            </div>
          </div>

          <div className="space-y-0 border border-[#f2ca50]/20 rounded-2xl overflow-hidden mb-6">
            <div className="flex justify-between items-center px-5 py-2.5 border-b border-[#f2ca50]/20 bg-[#f2ca50]/10" data-testid="bulk-header">
              <span className="text-[#f2ca50] text-xs font-bold tracking-widest uppercase">Quantity</span>
              <span className="text-[#f2ca50] text-xs font-bold tracking-widest uppercase">Bulk Deal</span>
            </div>
            {bulkDiscountTiers.map((dt, i) => (
              <div
                key={i}
                className={`flex justify-between items-center px-5 py-3 ${
                  i < bulkDiscountTiers.length - 1 ? "border-b border-[#f2ca50]/10" : ""
                } ${dt.percent > 0 ? "bg-[#f2ca50]/5" : ""}`}
                data-testid={`bulk-tier-${i}`}
              >
                <span className="text-[#e5e2e1] text-sm font-medium" data-testid={`text-bulk-range-${i}`}>
                  {dt.label}
                </span>
                <span
                  className={`font-bold text-sm tracking-wider ${
                    dt.percent > 0 ? "text-[#f2ca50]" : "text-[#e5e2e1]/50"
                  }`}
                  data-testid={`text-bulk-percent-${i}`}
                >
                  {dt.percent > 0 ? `${dt.percent}% off` : "No discount"}
                </span>
              </div>
            ))}
          </div>

          <p className="text-[#f2ca50]/70 text-xs text-center" data-testid="text-bulk-note">
            Bulk discounts apply to service fees only (not shipping or add-ons).
            Discounts are applied automatically at checkout.
          </p>
        </div>
      </section>

      <section className="px-4 max-w-3xl mx-auto pb-12">
        <FaqSection faqs={homeFaqs} />
      </section>

      <section className="px-4 max-w-3xl mx-auto pb-12" data-testid="section-explore-links">
        <h2 className="text-xl font-black text-[#f2ca50] tracking-tighter mb-4 flex items-center gap-2">
          <BookOpen size={20} /> Learn More About Card Grading
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[
            { href: "/pokemon-card-grading-uk", label: "Pokemon Card Grading UK" },
            { href: "/trading-card-grading-uk", label: "Trading Card Grading UK" },
            { href: "/card-grading-service-uk", label: "Card Grading Service UK" },
            { href: "/psa-alternative-uk", label: "UK PSA Alternative" },
            { href: "/how-to-grade-pokemon-cards", label: "How to Grade Pokemon Cards" },
            { href: "/tcg-grading-uk", label: "TCG Grading UK" },
            { href: "/guides", label: "All Guides & Articles" },
            { href: "/why-mintvault", label: "Why MintVault" },
          ].map((link) => (
            <Link key={link.href} href={link.href}>
              <span className="flex items-center gap-2 border border-[#f2ca50]/15 rounded px-4 py-2.5 text-[#f2ca50]/70 text-sm hover:text-[#f2ca50] hover:border-[#f2ca50]/30 transition-all cursor-pointer" data-testid={`link-explore-${link.href.slice(1)}`}>
                <ArrowRight size={14} /> {link.label}
              </span>
            </Link>
          ))}
        </div>
      </section>

      <section className="px-4 max-w-3xl mx-auto pb-8">
        <LifestyleImage />
        <p className="text-center text-[#e5e2e1]/70 text-xs mt-2">Trusted by collectors across the UK to protect and authenticate their most valuable cards.</p>
      </section>

      <section className="px-4 pb-12">
        <CtaSection />
      </section>
    </div>
  );
}
