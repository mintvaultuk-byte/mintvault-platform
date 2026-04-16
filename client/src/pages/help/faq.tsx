import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import SeoHead from "@/components/seo-head";

interface FAQItem { q: string; a: string; }
interface FAQGroup { category: string; items: FAQItem[]; }

const FAQ_DATA: FAQGroup[] = [
  {
    category: "Submission",
    items: [
      { q: "How do I submit cards for grading?", a: "Choose your service tier on our Pricing page, then click Submit Cards. You'll receive a submission reference number. Place each card in a penny sleeve and semi-rigid card saver, pack securely, and post to MintVault UK, Rochester, Kent, including your order number inside." },
      { q: "What's the turnaround time?", a: "Turnaround times are measured from the day we receive your cards. Vault Queue is 40 working days, Standard is 15 working days, and Express is 5 working days." },
      { q: "How much does grading cost?", a: "Vault Queue grading starts from £19 per card. Standard starts from £25 per card. Express starts from £45 per card. Full pricing including bulk discounts is on our Pricing page." },
      { q: "What payment methods do you accept?", a: "We accept all major credit and debit cards via Stripe. Payment is taken at the time of submission. We do not currently accept bank transfer or PayPal." },
      { q: "Can I track my submission?", a: "Yes. Visit the Track Submission page and enter your submission reference number to see the current status of your order." },
    ],
  },
  {
    category: "Grading",
    items: [
      { q: "What scale do you use?", a: "We use a 1–10 numeric scale with half-point increments where applicable. We also issue Authentic (AA) grades for cards that are genuine but altered, and Not Graded (NG) designations where appropriate." },
      { q: "What's the difference between a standard 10 and a Black Label 10?", a: "A Black Label 10 requires all four subgrades — centering, corners, edges, and surface — to individually score a perfect 10. A standard 10 reflects the overall assessment where the card meets Gem Mint criteria overall." },
      { q: "How does AI-assisted grading work?", a: "Every card is scanned at 6400 DPI and analysed by our AI system, which assesses centering, detects surface defects, and produces an initial grade estimate. This is then reviewed and finalised by our human expert grader. The AI supports the grader; the final decision is always human." },
      { q: "Can I appeal a grade I disagree with?", a: "Not currently. Our grading decisions are final. We take great care with every assessment, and your Vault gives you full visibility into how the grade was reached. Grade appeals may be introduced in a future update." },
      { q: "Do you grade Japanese/Asian language cards?", a: "Yes. We grade cards in English, Japanese, Korean, and other languages. Select the appropriate language when submitting." },
    ],
  },
  {
    category: "Slabs",
    items: [
      { q: "Are your slabs tamper-proof?", a: "Yes. Each slab is sealed with a tamper-evident bond. Once closed, the slab cannot be opened without leaving visible damage. The grade label is inscribed — there are no paper inserts that can be swapped." },
      { q: "How does NFC verification work?", a: "Every slab contains an embedded NFC chip. Tap it with any NFC-capable smartphone to instantly verify the card's authenticity and open your Vault. The chip is registered to a specific certificate ID and cannot be transferred." },
      { q: "What sizes/thicknesses do you support?", a: "We currently support card thicknesses of 35pt, 75pt, 130pt, and 180pt. If you have cards outside these ranges, contact us before submitting." },
      { q: "Can I crack open a slab?", a: "Technically yes, but doing so voids the grade and certificate. The slab is designed to be permanent. If you need your card re-encapsulated or regraded, submit it as a reholder service." },
    ],
  },
  {
    category: "Ownership Registry",
    items: [
      { q: "What is the ownership registry?", a: "MintVault's ownership registry is a verified record of who owns each graded card. When you claim your card using the one-time claim code included with your order, your ownership is registered to your email address." },
      { q: "How do I claim my card?", a: "Visit the Claim page and enter the claim code printed on the insert included with your slab. You'll receive a verification email to confirm your ownership." },
      { q: "How do I transfer ownership when I sell?", a: "Visit the Ownership Portal and initiate a transfer to the buyer's email address. Both parties receive a verification email. Once the buyer confirms, ownership transfers to them." },
      { q: "Is my personal information public?", a: "No. Ownership is tied to your email address, which is never publicly displayed. Your Vault shows ownership as 'Anonymous Owner' by default." },
    ],
  },
  {
    category: "Returns & Insurance",
    items: [
      { q: "How are cards returned to me?", a: "All graded cards are returned via Royal Mail Tracked 24 with appropriate insurance. You'll receive a tracking number when your order ships." },
      { q: "Are cards insured during transit?", a: "Yes. Cards are insured during return shipping. The insurance tier depends on the declared value and service level you selected at submission." },
      { q: "What happens if my card is damaged or lost?", a: "In the unlikely event of damage or loss during return shipping, we will process a claim via the carrier on your behalf. The declared value you provided at submission determines the maximum claimable amount." },
    ],
  },
];

function FAQAccordion({ items }: { items: FAQItem[] }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="space-y-2">
      {items.map(({ q, a }, i) => (
        <div key={q} className="rounded-xl border border-[#E8E4DC] overflow-hidden">
          <button
            onClick={() => setOpen(open === i ? null : i)}
            className="w-full flex items-center justify-between px-5 py-4 text-left bg-white hover:bg-[#FAFAF8] transition-colors"
          >
            <span className="font-semibold text-[#1A1A1A] text-sm pr-4">{q}</span>
            {open === i ? <ChevronUp size={16} className="text-[#B8960C] flex-shrink-0" /> : <ChevronDown size={16} className="text-[#888] flex-shrink-0" />}
          </button>
          {open === i && (
            <div className="px-5 pb-4 pt-1 bg-[#FAFAF8] border-t border-[#E8E4DC]">
              <p className="text-[#555555] text-sm leading-relaxed">{a}</p>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default function FAQPage() {
  return (
    <>
      <SeoHead
        title="FAQ — Frequently Asked Questions | MintVault UK"
        description="Answers to common questions about submitting cards, grading, slabs, ownership registry, and returns. MintVault UK card grading service."
        canonical="/help/faq"
      />

      {/* Hero */}
      <section className="border-b border-[#E8E4DC] bg-[#FAFAF8]">
        <div className="max-w-3xl mx-auto px-6 py-16 md:py-20 text-center">
          <p className="text-[#B8960C] text-xs font-bold uppercase tracking-[0.25em] mb-4">Help</p>
          <h1 className="text-4xl md:text-5xl font-black text-[#1A1A1A] mb-4 leading-tight tracking-tight">
            Frequently Asked Questions
          </h1>
          <p className="text-lg text-[#666666]">Everything you need to know</p>
        </div>
      </section>

      <div className="max-w-2xl mx-auto px-6 py-16 space-y-12">
        {FAQ_DATA.map(({ category, items }) => (
          <section key={category}>
            <p className="text-[#B8960C] text-xs font-bold uppercase tracking-[0.2em] mb-4">{category}</p>
            <FAQAccordion items={items} />
          </section>
        ))}
      </div>
    </>
  );
}
