import { Link } from "wouter";
import { ArrowRight, Search, CreditCard } from "lucide-react";

interface CtaSectionProps {
  title?: string;
  subtitle?: string;
}

export default function CtaSection({
  title = "Ready to Grade Your Cards?",
  subtitle = "Submit your cards for professional UK grading.",
}: CtaSectionProps) {
  return (
    <section className="max-w-3xl mx-auto border border-[#D4AF37]/30 rounded-lg p-6 md:p-8 bg-[#D4AF37]/5 text-center" data-testid="section-cta">
      <h2 className="text-xl md:text-2xl font-bold text-[#D4AF37] tracking-wide mb-3">{title}</h2>
      <p className="text-[#666666] text-sm mb-6 max-w-lg mx-auto">{subtitle}</p>
      <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
        <Link href="/submit">
          <span className="inline-flex items-center gap-2 border border-[#D4AF37] bg-[#D4AF37]/10 text-[#D4AF37] px-6 py-2.5 rounded font-semibold text-sm tracking-wide transition-all hover:bg-[#D4AF37]/20 cursor-pointer" data-testid="button-cta-submit">
            Submit Your Cards <ArrowRight size={16} />
          </span>
        </Link>
        <Link href="/">
          <span className="inline-flex items-center gap-2 border border-[#D4AF37]/30 text-[#D4AF37]/70 px-6 py-2.5 rounded font-medium text-sm tracking-wide transition-all hover:text-[#D4AF37] hover:border-[#D4AF37]/50 cursor-pointer" data-testid="button-cta-pricing">
            <CreditCard size={16} /> View Pricing
          </span>
        </Link>
        <Link href="/cert">
          <span className="inline-flex items-center gap-2 border border-[#D4AF37]/30 text-[#D4AF37]/70 px-6 py-2.5 rounded font-medium text-sm tracking-wide transition-all hover:text-[#D4AF37] hover:border-[#D4AF37]/50 cursor-pointer" data-testid="button-cta-certs">
            <Search size={16} /> Check Certificates
          </span>
        </Link>
      </div>
    </section>
  );
}
