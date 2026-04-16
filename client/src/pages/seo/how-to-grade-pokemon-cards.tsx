import { Link } from "wouter";
import SeoHead from "@/components/seo-head";
import BreadcrumbNav, { breadcrumbSchema } from "@/components/breadcrumb-nav";
import FaqSection, { faqSchema } from "@/components/faq-section";
import CtaSection from "@/components/cta-section";
import { ArrowRight, Eye, Package, Shield, CheckCircle } from "lucide-react";

const breadcrumbs = [
  { label: "Home", href: "/" },
  { label: "Guides", href: "/guides" },
  { label: "How to Grade Pokemon Cards" },
];

const faqs = [
  {
    question: "Do I need to clean my Pokemon cards before submitting them for grading?",
    answer: "Do not attempt to clean your cards with liquids or abrasive materials, as this can damage the surface and lower the grade. If there is loose dust or debris, you can gently blow it off or use a very soft microfibre cloth with extreme care. Surface scratches or marks cannot be safely removed and attempting to do so may cause further damage.",
  },
  {
    question: "Should I remove my Pokemon cards from penny sleeves before grading?",
    answer: "No. Keep your cards in penny sleeves and top loaders when shipping them. Our graders will carefully remove the cards from their protective sleeves during the grading process. Sending cards unsleeved increases the risk of damage during transit.",
  },
  {
    question: "What happens if my Pokemon card receives a low grade?",
    answer: "Every card is graded based on its actual condition. Even lower-graded cards benefit from the protection of a slab and the authenticity verification provided by the certificate. Some collectors specifically seek lower-graded versions of expensive cards as a more affordable entry point.",
  },
  {
    question: "Can I request a specific grade for my card?",
    answer: "No. Grading is an objective assessment of the card's condition. Our graders evaluate each card independently based on centering, corners, edges, and surface quality. The grade reflects the actual condition of the card as assessed by our team.",
  },
  {
    question: "How should I package multiple cards for grading?",
    answer: "Each card should be in its own penny sleeve inside a top loader. Stack the top loaders together and secure them with a rubber band or painter's tape (not directly on the cards). Place the stack in a rigid box or between two pieces of cardboard, then pack in a padded envelope or shipping box. Include your submission confirmation printout.",
  },
  {
    question: "What is the minimum value a card should have before grading is worthwhile?",
    answer: "As a general guideline, the raw market value of the card should be at least 3 to 5 times the grading cost for grading to make financial sense. However, many collectors grade cards for protection and personal enjoyment regardless of monetary value. Our grading starts from £19 per card.",
  },
];

const serviceSchema = {
  "@context": "https://schema.org",
  "@type": "HowTo",
  name: "How to Grade Pokemon Cards",
  description: "Step-by-step guide to submitting Pokemon cards for professional grading with MintVault UK.",
  step: [
    {
      "@type": "HowToStep",
      name: "Assess Your Cards",
      text: "Examine your Pokemon cards under good lighting to evaluate centering, corners, edges, and surface condition. Identify which cards are worth submitting for professional grading.",
    },
    {
      "@type": "HowToStep",
      name: "Create Your Submission",
      text: "Visit the MintVault submission page, choose your service tier, and enter the details for each card you want graded.",
    },
    {
      "@type": "HowToStep",
      name: "Prepare and Package Your Cards",
      text: "Place each card in a penny sleeve and top loader. Pack securely in a rigid container with padding to prevent movement during transit.",
    },
    {
      "@type": "HowToStep",
      name: "Ship Your Cards",
      text: "Send your packaged cards to MintVault using tracked and insured shipping. Include your submission confirmation.",
    },
    {
      "@type": "HowToStep",
      name: "Receive Your Graded Cards",
      text: "Your cards are graded, encapsulated in tamper-evident slabs, and returned via fully insured shipping.",
    },
  ],
};

const schema = [
  breadcrumbSchema(breadcrumbs),
  serviceSchema,
  faqSchema(faqs),
];

export default function HowToGradePokemonCards() {
  return (
    <div className="px-4 py-10">
      <SeoHead
        title="How to Grade Pokemon Cards | Step-by-Step Guide | MintVault UK"
        description="Learn how to grade Pokemon cards step by step. Card preparation, packaging, submission process, and what graders look for. Complete guide for UK collectors."
        canonical="https://mintvaultuk.com/how-to-grade-pokemon-cards"
        ogImage="https://mintvaultuk.com/images/collector-lifestyle.webp"
        schema={schema}
      />

      <div className="max-w-3xl mx-auto">
        <BreadcrumbNav items={breadcrumbs} />

        <h1 className="text-3xl md:text-4xl font-bold text-[#1A1A1A] tracking-wide mb-6" data-testid="text-h1-how-to-grade">
          How to Grade Pokemon Cards
        </h1>

        <p className="text-[#444444] text-base leading-relaxed mb-4">
          Getting your Pokemon cards professionally graded protects their condition, verifies their authenticity, and can significantly increase their market value. This guide walks you through the entire process, from assessing which cards to grade through to receiving your graded cards back in tamper-evident slabs.
        </p>
        <p className="text-[#666666] text-sm leading-relaxed mb-8">
          Whether you are submitting your first card or your hundredth, following these steps will help ensure the best possible experience and outcome from the grading process.
        </p>

        <section className="mb-10" data-testid="section-step-1">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">Step 1: Assess Your Cards</h2>
          <div className="text-[#444444] text-sm leading-relaxed space-y-3">
            <p>
              Before submitting cards for grading, take time to examine them carefully. Use good overhead lighting and handle cards by their edges or while wearing clean cotton gloves to avoid adding fingerprints or oils to the surface.
            </p>
            <p>
              <strong className="text-[#1A1A1A]">Centering</strong> — hold the card at eye level and compare the borders on opposite sides. On the front, the left and right borders should be even, as should the top and bottom. Check the back as well. Centering issues are one of the most common reasons cards do not achieve top grades.
            </p>
            <p>
              <strong className="text-[#1A1A1A]">Corners</strong> — examine each of the four corners closely. Look for any softness, rounding, fraying, or damage to the corner tips. Corners are particularly susceptible to wear and are examined under magnification during grading.
            </p>
            <p>
              <strong className="text-[#1A1A1A]">Edges</strong> — run your eye along all four edges of the card. Look for whitening (where the card core shows through), chipping, nicks, or any roughness. Edge whitening is especially visible on cards with dark borders.
            </p>
            <p>
              <strong className="text-[#1A1A1A]">Surface</strong> — angle the card under light to check for scratches, print lines, ink spots, haze, or other surface blemishes. Holofoil and textured cards may require tilting at multiple angles to spot surface issues. Print lines are factory defects that run across the holofoil pattern and will affect the grade.
            </p>
            <p>
              After your assessment, decide which cards are worth submitting. Cards in near-mint or better condition with a raw value significantly above the grading cost are the best candidates. Our guide on <Link href="/guides/what-pokemon-cards-are-worth-grading" className="text-[#D4AF37] hover:underline" data-testid="link-worth-grading">which Pokemon cards are worth grading</Link> provides more detail.
            </p>
          </div>
        </section>

        <section className="mb-10" data-testid="section-step-2">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">Step 2: Create Your Submission Online</h2>
          <div className="text-[#444444] text-sm leading-relaxed space-y-3">
            <p>
              Visit the MintVault <Link href="/submit" className="text-[#D4AF37] hover:underline" data-testid="link-submit">submission page</Link> to start your order. You will need to:
            </p>
            <ul className="list-disc list-inside space-y-2 text-[#666666] text-sm pl-2">
              <li>Choose your service tier (Standard, Priority, or Express)</li>
              <li>Enter the details for each card, including the card name, set, and card number</li>
              <li>Declare the value of each card for insurance purposes</li>
              <li>Pay securely online</li>
            </ul>
            <p>
              After completing your submission, you will receive a confirmation with your submission reference number and our shipping address. Print or save this confirmation as you will need to include it with your cards.
            </p>
            <p>
              Not sure which tier to choose? View our <Link href="/" className="text-[#D4AF37] hover:underline" data-testid="link-pricing">pricing page</Link> for a comparison of all service tiers, turnaround times, and features.
            </p>
          </div>
        </section>

        <section className="mb-10" data-testid="section-step-3">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">Step 3: Prepare and Package Your Cards</h2>
          <div className="text-[#444444] text-sm leading-relaxed space-y-3">
            <p>
              Proper packaging is essential to ensure your cards arrive in the same condition they left. Follow these steps for each card:
            </p>

            <h3 className="text-lg font-semibold text-[#D4AF37]/90 mt-4 mb-2">Individual Card Protection</h3>
            <ul className="list-disc list-inside space-y-2 text-[#666666] text-sm pl-2">
              <li>Place each card in a clean, new penny sleeve (also called soft sleeves). Insert the card top-edge first so the opening faces down when stored upright.</li>
              <li>Slide the penny-sleeved card into a top loader (rigid plastic holder). The top loader should be the correct size for standard trading cards.</li>
              <li>If you have semi-rigid card savers, these are also acceptable and are preferred by some grading services.</li>
            </ul>

            <h3 className="text-lg font-semibold text-[#D4AF37]/90 mt-4 mb-2">Bundling Multiple Cards</h3>
            <ul className="list-disc list-inside space-y-2 text-[#666666] text-sm pl-2">
              <li>Stack your loaded top loaders together with all cards facing the same direction.</li>
              <li>Secure the stack with a rubber band or painter's tape wrapped around the outside of the top loaders. Never apply tape directly to the cards or the openings of the top loaders.</li>
              <li>If you have a large submission, group cards into smaller stacks of 10-15 cards each.</li>
            </ul>

            <h3 className="text-lg font-semibold text-[#D4AF37]/90 mt-4 mb-2">Outer Packaging</h3>
            <ul className="list-disc list-inside space-y-2 text-[#666666] text-sm pl-2">
              <li>Place the card stack(s) in a small box or rigid mailer. Cards should not be able to move around inside the packaging.</li>
              <li>Fill any empty space with bubble wrap, packing paper, or similar padding material.</li>
              <li>Include your printed submission confirmation in the package.</li>
              <li>Seal the package securely with packing tape.</li>
            </ul>

            <p>
              For detailed packaging instructions with photos, see our guide on <Link href="/guides/how-to-send-cards-for-grading-safely" className="text-[#D4AF37] hover:underline" data-testid="link-shipping-guide">how to send cards for grading safely</Link>.
            </p>
          </div>
        </section>

        <section className="mb-10" data-testid="section-step-4">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">Step 4: Ship Your Cards</h2>
          <div className="text-[#444444] text-sm leading-relaxed space-y-3">
            <p>
              Send your packaged cards to MintVault using a tracked and insured shipping service. We strongly recommend:
            </p>
            <ul className="list-disc list-inside space-y-2 text-[#666666] text-sm pl-2">
              <li>Royal Mail Special Delivery Guaranteed for high-value submissions (includes tracking and insurance up to £500)</li>
              <li>Royal Mail Tracked 24/48 for lower-value submissions</li>
              <li>Any courier service that provides tracking and insurance appropriate to your card values</li>
            </ul>
            <p>
              Always insure your package for the full declared value of the cards inside. Keep your tracking number and shipping receipt until your graded cards are returned.
            </p>
          </div>
        </section>

        <section className="mb-10" data-testid="section-step-5">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">Step 5: Grading and Return</h2>
          <div className="text-[#444444] text-sm leading-relaxed space-y-3">
            <p>
              Once we receive your cards, the grading process begins according to your chosen service tier's turnaround time. You can track the status of your submission online at any time.
            </p>
            <p>
              Each card is assessed individually by our trained graders, who evaluate centering, corners, edges, and surface quality on a 1 to 10 scale. After grading, cards are encapsulated in tamper-evident MintVault slabs with a printed label showing the card name, set, grade, and unique certificate number.
            </p>
            <p>
              Your graded cards are returned via fully insured tracked shipping based on the total declared value of your submission. Once you receive them, you can verify each certificate using our <Link href="/cert" className="text-[#D4AF37] hover:underline" data-testid="link-cert">online certificate lookup tool</Link>.
            </p>
          </div>
        </section>

        <section className="mb-10" data-testid="section-grading-factors">
          <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-4">What Graders Look For</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
            {[
              { icon: <Eye size={20} />, title: "Centering", desc: "The alignment of the printed image within the card borders. Both front and back are assessed. Tighter tolerances are required for grades 9 and above." },
              { icon: <Shield size={20} />, title: "Corners", desc: "Sharpness and condition of all four corners. Any rounding, wear, or damage lowers the corner sub-grade." },
              { icon: <Package size={20} />, title: "Edges", desc: "Condition along all four edges. Whitening, chipping, nicks, and roughness are all assessed under magnification." },
              { icon: <CheckCircle size={20} />, title: "Surface", desc: "Scratches, print lines, ink defects, haze, and foil clouding on both the front and back of the card." },
            ].map((item, i) => (
              <div key={i} className="flex gap-3 border border-[#D4AF37]/15 rounded-lg p-4" data-testid={`card-factor-${i}`}>
                <div className="text-[#D4AF37] shrink-0 mt-0.5">{item.icon}</div>
                <div>
                  <h3 className="text-[#1A1A1A] font-semibold text-sm mb-1">{item.title}</h3>
                  <p className="text-[#666666] text-xs leading-relaxed">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
          <p className="text-[#666666] text-sm">
            The overall grade is a holistic assessment that takes all four factors into account. A significant defect in any single area will limit the maximum achievable grade.
          </p>
        </section>

        <section className="mb-10" data-testid="section-explore">
          <h2 className="text-xl font-bold text-[#D4AF37] tracking-wide mb-4">More Resources</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              { href: "/pokemon-card-grading-uk", label: "Pokemon Card Grading UK" },
              { href: "/trading-card-grading-uk", label: "Trading Card Grading UK" },
              { href: "/card-grading-service-uk", label: "Card Grading Service UK" },
              { href: "/psa-alternative-uk", label: "UK PSA Alternative" },
              { href: "/tcg-grading-uk", label: "TCG Grading UK" },
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
          title="Ready to Grade Your Pokemon Cards?"
          subtitle="Submit your cards to MintVault for professional UK-based grading. Fast turnaround and insured returns."
        />
      </div>
    </div>
  );
}
