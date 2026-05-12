import { Link } from "wouter";
import { ArrowLeft, Shield } from "lucide-react";

export default function LiabilityPage() {
  return (
    <div className="px-4 py-10 max-w-3xl mx-auto">
      <Link href="/">
        <button className="flex items-center gap-1.5 text-[#D4AF37]/60 hover:text-[#D4AF37] transition-colors mb-8" data-testid="button-back-home">
          <ArrowLeft size={16} /> Back to Home
        </button>
      </Link>

      <div className="flex items-center justify-center gap-3 mb-2">
        <Shield size={28} className="text-[#D4AF37]" />
        <h1 className="text-3xl font-bold text-[#D4AF37] tracking-widest glow-gold" data-testid="text-liability-title">
          LIABILITY & INSURANCE
        </h1>
      </div>
      <p className="text-[#999999] text-sm text-center mb-10">Last updated: February 2026</p>

      <div className="space-y-8 text-[#444444] text-sm leading-relaxed">
        <section>
          <h2 className="text-[#D4AF37] font-bold tracking-wider text-lg mb-3">1. Incoming Shipping</h2>
          <p>
            Customers are fully responsible for insuring items during transit to MintVault.
            MintVault's liability begins only once signed delivery is confirmed at our facility.
            We strongly recommend using a tracked, insured postal service for all inbound shipments.
          </p>
        </section>

        <section>
          <h2 className="text-[#D4AF37] font-bold tracking-wider text-lg mb-3">2. Custody Period</h2>
          <p>
            While items are in MintVault's custody, our liability is limited to the verified fair
            market value of the item at the time of loss and shall not exceed the declared value
            submitted by the customer at the time of order.
          </p>
        </section>

        <section>
          <h2 className="text-[#D4AF37] font-bold tracking-wider text-lg mb-3">3. Market Value Determination</h2>
          <p>
            In the event of a claim, fair market value will be determined using recent completed
            sales data from recognised marketplaces (including but not limited to eBay sold listings,
            TCGPlayer, and specialist auction records). MintVault reserves the right to use
            independent valuation where appropriate.
          </p>
        </section>

        <section>
          <h2 className="text-[#D4AF37] font-bold tracking-wider text-lg mb-3">4. Return Shipping</h2>
          <p>
            All return shipments are fully insured and tracked based on the declared value provided
            at the time of submission. Signature on delivery is required for all return shipments.
          </p>
        </section>

        <section>
          <h2 className="text-[#D4AF37] font-bold tracking-wider text-lg mb-3">5. Exclusions</h2>
          <p className="mb-3">MintVault is not liable for:</p>
          <ul className="space-y-2">
            <li className="flex items-start gap-2">
              <span className="text-[#D4AF37] mt-0.5">•</span>
              <span>Market value fluctuations occurring before, during, or after the grading process</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-[#D4AF37] mt-0.5">•</span>
              <span>Grading outcome disagreements or dissatisfaction with assigned grades</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-[#D4AF37] mt-0.5">•</span>
              <span>Minor cosmetic slab imperfections that do not affect card protection or grade integrity</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-[#D4AF37] mt-0.5">•</span>
              <span>Third-party postal delays or losses during inbound customer shipping</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-[#D4AF37] mt-0.5">•</span>
              <span>Events beyond reasonable control (force majeure), including but not limited to natural disasters, civil unrest, or government action</span>
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-[#D4AF37] font-bold tracking-wider text-lg mb-3">6. Claims Process</h2>
          <p>
            Any claims must be reported to MintVault within 48 hours of delivery (for return shipping)
            or within 7 days of the expected completion date (for custody claims). Claims should be
            submitted in writing to{" "}
            <a href="mailto:info@mintvault.co.uk" className="text-[#D4AF37] underline" data-testid="link-email-claims">
              info@mintvault.co.uk
            </a>{" "}
            with supporting evidence including photographs and proof of declared value.
          </p>
        </section>

        <section>
          <h2 className="text-[#D4AF37] font-bold tracking-wider text-lg mb-3">7. General</h2>
          <p>
            This policy should be read in conjunction with our{" "}
            <Link href="/terms-and-conditions">
              <span className="text-[#D4AF37] underline cursor-pointer" data-testid="link-terms">Terms & Conditions</span>
            </Link>.
            MintVault reserves the right to update this policy at any time. The latest version will
            always be available on our website.
          </p>
        </section>
      </div>
    </div>
  );
}
