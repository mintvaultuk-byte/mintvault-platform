import { Link } from "wouter";
import { ArrowRight, Search, CreditCard } from "lucide-react";
import GradientButton from "@/components/ui/gradient-button";

interface CtaSectionProps {
  title?: string;
  subtitle?: string;
}

export default function CtaSection({
  title = "Ready to Grade Your Cards?",
  subtitle = "Submit your cards for professional UK grading.",
}: CtaSectionProps) {
  return (
    <section
      className="max-w-3xl mx-auto border border-[#D4AF37]/30 rounded-lg p-6 md:p-8 bg-[#D4AF37]/5 text-center"
      data-testid="section-cta"
    >
      <h2 className="text-xl md:text-2xl font-bold text-[#D4AF37] tracking-wide mb-3">{title}</h2>
      <p className="text-[#d4d4d4] text-sm mb-6 max-w-lg mx-auto">{subtitle}</p>
      <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
        <Link href="/submit" className="no-underline">
          <GradientButton height="42px" className="gradient-btn-filled" data-testid="button-cta-submit">
            Submit Your Cards <ArrowRight size={16} />
          </GradientButton>
        </Link>
        <Link href="/" className="no-underline">
          <GradientButton height="42px" data-testid="button-cta-pricing">
            <CreditCard size={16} /> View Pricing
          </GradientButton>
        </Link>
        <Link href="/verify" className="no-underline">
          <GradientButton height="42px" data-testid="button-cta-certs">
            <Search size={16} /> Check Certificates
          </GradientButton>
        </Link>
      </div>
    </section>
  );
}
