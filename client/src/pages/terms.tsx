import { Link } from "wouter";
import { ArrowLeft } from "lucide-react";

export default function TermsPage() {
  return (
    <div className="px-4 py-10 max-w-3xl mx-auto">
      <Link href="/">
        <button className="flex items-center gap-1.5 text-[#D4AF37]/60 hover:text-[#D4AF37] transition-colors mb-8" data-testid="button-back-home">
          <ArrowLeft size={16} /> Back to Home
        </button>
      </Link>

      <h1 className="text-3xl font-bold text-[#D4AF37] tracking-widest mb-2 glow-gold text-center" data-testid="text-terms-title">
        TERMS & CONDITIONS
      </h1>
      <p className="text-[#999999] text-sm text-center mb-10">Last updated: February 2026</p>

      <div className="space-y-8 text-[#444444] text-sm leading-relaxed">
        <section>
          <h2 className="text-[#D4AF37] font-bold tracking-wider text-lg mb-3">1. Service Overview</h2>
          <p>
            MintVault UK Ltd ("MintVault", "we", "us") provides professional trading card grading, reholdering,
            and related services. By submitting cards to MintVault, you agree to these Terms & Conditions
            in full.
          </p>
        </section>

        <section>
          <h2 className="text-[#D4AF37] font-bold tracking-wider text-lg mb-3">2. Submissions</h2>
          <p className="mb-2">
            All submissions must be made through our online portal. Each submission requires a declared
            value for all cards included. The declared value is used for insurance and liability purposes only
            and does not guarantee or imply any grading outcome.
          </p>
          <p>
            MintVault reserves the right to refuse any submission at our discretion.
          </p>
        </section>

        <section>
          <h2 className="text-[#D4AF37] font-bold tracking-wider text-lg mb-3">3. Grading & Assessment</h2>
          <p className="mb-2">
            All grades are final once issued and reflect MintVault UK Ltd's professional opinion at the time of assessment.
          </p>
          <p>
            Grading outcomes are independent professional opinions and may differ from other grading
            services.
          </p>
        </section>

        <section>
          <h2 className="text-[#D4AF37] font-bold tracking-wider text-lg mb-3">4. Turnaround Times</h2>
          <p>
            Turnaround times are estimates provided in working days and begin from the date items are
            received and verified at our facility. MintVault will make reasonable efforts to meet stated
            turnaround times but does not guarantee exact completion dates.
          </p>
        </section>

        <section>
          <h2 className="text-[#D4AF37] font-bold tracking-wider text-lg mb-3">5. Payment</h2>
          <p>
            Payment is required at the time of submission and is processed securely via Stripe.
            All prices are listed in GBP and include VAT where applicable. Service fees are
            non-refundable once grading has commenced.
          </p>
        </section>

        <section id="liability" data-testid="section-liability">
          <h2 className="text-[#D4AF37] font-bold tracking-wider text-lg mb-3">6. Liability & Shipping Policy</h2>

          <h3 className="text-[#1A1A1A] font-semibold mt-4 mb-2">6.1 Inbound Shipping Responsibility</h3>
          <p className="mb-2">Customers are fully responsible for items until they are:</p>
          <ul className="space-y-1 ml-4 mb-3">
            <li className="flex items-start gap-2"><span className="text-[#D4AF37]">•</span><span>Delivered to MintVault's registered address</span></li>
            <li className="flex items-start gap-2"><span className="text-[#D4AF37]">•</span><span>Signed for and logged into our intake system</span></li>
          </ul>
          <p className="mb-2">MintVault accepts no liability for items lost or damaged in transit to us.</p>
          <p className="mb-2">Customers must use:</p>
          <ul className="space-y-1 ml-4 mb-3">
            <li className="flex items-start gap-2"><span className="text-[#D4AF37]">•</span><span>Secure packaging</span></li>
            <li className="flex items-start gap-2"><span className="text-[#D4AF37]">•</span><span>Fully tracked delivery</span></li>
            <li className="flex items-start gap-2"><span className="text-[#D4AF37]">•</span><span>Insurance coverage appropriate to the declared value</span></li>
          </ul>
          <p>Claims for parcels lost in transit to MintVault must be made directly with the courier.</p>

          <h3 className="text-[#1A1A1A] font-semibold mt-6 mb-2">6.2 Declared Value Requirement</h3>
          <p className="mb-2">Each submitted item must include a declared value.</p>
          <p className="mb-2">Declared value:</p>
          <ul className="space-y-1 ml-4 mb-3">
            <li className="flex items-start gap-2"><span className="text-[#D4AF37]">•</span><span>Must reflect fair market value at time of submission</span></li>
            <li className="flex items-start gap-2"><span className="text-[#D4AF37]">•</span><span>Determines return shipping insurance</span></li>
            <li className="flex items-start gap-2"><span className="text-[#D4AF37]">•</span><span>Sets maximum liability cap during custody</span></li>
          </ul>
          <p>MintVault reserves the right to suspend processing if declared value is missing or inaccurate.</p>

          <h3 className="text-[#1A1A1A] font-semibold mt-6 mb-2">6.3 Custody Liability</h3>
          <p className="mb-2">While items are physically in MintVault UK Ltd's custody, liability is limited to the lower of:</p>
          <ul className="space-y-1 ml-4 mb-3">
            <li className="flex items-start gap-2"><span className="text-[#D4AF37]">•</span><span>The declared value submitted</span></li>
            <li className="flex items-start gap-2"><span className="text-[#D4AF37]">•</span><span>OR Verified fair market value at time of loss</span></li>
          </ul>
          <p>Fair market value shall be determined at MintVault UK Ltd's reasonable discretion using publicly available market data.</p>

          <h3 className="text-[#1A1A1A] font-semibold mt-6 mb-2">6.4 Return Shipping</h3>
          <p className="mb-2">Return shipments are sent using:</p>
          <ul className="space-y-1 ml-4 mb-3">
            <li className="flex items-start gap-2"><span className="text-[#D4AF37]">•</span><span>Fully tracked delivery</span></li>
            <li className="flex items-start gap-2"><span className="text-[#D4AF37]">•</span><span>Insurance up to declared value</span></li>
            <li className="flex items-start gap-2"><span className="text-[#D4AF37]">•</span><span>Signature confirmation where applicable</span></li>
          </ul>
          <p className="mb-2">Once handed to the courier and tracking issued, liability transfers to the courier.</p>
          <p>Customers are responsible for pursuing any claims directly with the courier once tracking has been issued.</p>

          <h3 className="text-[#1A1A1A] font-semibold mt-6 mb-2">6.5 Exclusions</h3>
          <p className="mb-2">MintVault is not liable for:</p>
          <ul className="space-y-1 ml-4 mb-3">
            <li className="flex items-start gap-2"><span className="text-[#D4AF37]">•</span><span>Market fluctuations</span></li>
            <li className="flex items-start gap-2"><span className="text-[#D4AF37]">•</span><span>Grading outcome disputes</span></li>
            <li className="flex items-start gap-2"><span className="text-[#D4AF37]">•</span><span>Minor cosmetic slab/label variations</span></li>
            <li className="flex items-start gap-2"><span className="text-[#D4AF37]">•</span><span>Courier delays</span></li>
            <li className="flex items-start gap-2"><span className="text-[#D4AF37]">•</span><span>Events beyond reasonable control</span></li>
          </ul>

          <h3 className="text-[#1A1A1A] font-semibold mt-6 mb-2">6.6 Maximum Liability</h3>
          <p className="mb-2">Total liability per submission shall not exceed the total declared value of items in that submission.</p>
          <p>MintVault shall not be liable for consequential losses, lost profits, or speculative resale value.</p>

          <h3 className="text-[#1A1A1A] font-semibold mt-6 mb-2">6.7 High-Value Submissions</h3>
          <p className="mb-2">MintVault reserves the right to:</p>
          <ul className="space-y-1 ml-4">
            <li className="flex items-start gap-2"><span className="text-[#D4AF37]">•</span><span>Require additional insurance</span></li>
            <li className="flex items-start gap-2"><span className="text-[#D4AF37]">•</span><span>Apply insurance surcharges</span></li>
            <li className="flex items-start gap-2"><span className="text-[#D4AF37]">•</span><span>Decline items exceeding declared value thresholds</span></li>
          </ul>
        </section>

        <section>
          <h2 className="text-[#D4AF37] font-bold tracking-wider text-lg mb-3">7. Cancellations & Refunds</h2>
          <p className="mb-2">
            Submissions may be cancelled before cards are received at our facility for a full refund.
            Once cards have been received, cancellations are subject to a handling fee.
          </p>
          <p>
            Completed services are non-refundable.
          </p>
        </section>

        <section>
          <h2 className="text-[#D4AF37] font-bold tracking-wider text-lg mb-3">8. Intellectual Property</h2>
          <p>
            All MintVault branding, slab designs, certificate formats, and grading scales are the
            intellectual property of MintVault UK Ltd. Reproduction or imitation is strictly prohibited.
          </p>
        </section>

        <section>
          <h2 className="text-[#D4AF37] font-bold tracking-wider text-lg mb-3">9. Force Majeure</h2>
          <p>
            MintVault UK Ltd shall not be liable for any delay or failure to perform its obligations where such delay or failure results from events beyond its reasonable control, including but not limited to natural disasters, postal or courier disruptions, strikes, system failures, acts of government, or other unforeseen events.
          </p>
        </section>

        <section>
          <h2 className="text-[#D4AF37] font-bold tracking-wider text-lg mb-3">10. Governing Law</h2>
          <p>
            These Terms & Conditions are governed by the laws of England and Wales. Any disputes
            shall be subject to the exclusive jurisdiction of the courts of England and Wales.
          </p>
        </section>

        <section>
          <h2 className="text-[#D4AF37] font-bold tracking-wider text-lg mb-3">11. Contact</h2>
          <p>
            For questions regarding these terms, please contact us at{" "}
            <a href="mailto:mintvaultuk@gmail.com" className="text-[#D4AF37] underline" data-testid="link-email-terms">
              mintvaultuk@gmail.com
            </a>.
          </p>
        </section>
      </div>
    </div>
  );
}
