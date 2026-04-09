import { useState } from "react";
import { ChevronDown } from "lucide-react";

interface FaqItem {
  question: string;
  answer: string;
}

export default function FaqSection({ faqs, title = "Frequently Asked Questions" }: { faqs: FaqItem[]; title?: string }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <section className="max-w-3xl mx-auto" data-testid="section-faq">
      <h2 className="text-2xl font-bold text-[#D4AF37] tracking-wide mb-6">{title}</h2>
      <div className="space-y-3">
        {faqs.map((faq, i) => (
          <div
            key={i}
            className="border border-[#D4AF37]/20 rounded-lg overflow-hidden"
            data-testid={`faq-item-${i}`}
          >
            <button
              onClick={() => setOpenIndex(openIndex === i ? null : i)}
              className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-[#D4AF37]/5 transition-colors"
              aria-expanded={openIndex === i}
              aria-controls={`faq-answer-${i}`}
              data-testid={`button-faq-${i}`}
            >
              <span className="text-[#1A1A1A] text-sm font-medium pr-4">{faq.question}</span>
              <ChevronDown
                size={16}
                className={`text-[#D4AF37] shrink-0 transition-transform ${openIndex === i ? "rotate-180" : ""}`}
              />
            </button>
            {openIndex === i && (
              <div id={`faq-answer-${i}`} role="region" className="px-5 pb-4 text-[#444444] text-sm leading-relaxed border-t border-[#E8E4DC]" data-testid={`text-faq-answer-${i}`}>
                <div className="pt-3" dangerouslySetInnerHTML={{ __html: faq.answer }} />
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

export function faqSchema(faqs: FaqItem[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": faqs.map(faq => ({
      "@type": "Question",
      "name": faq.question,
      "acceptedAnswer": {
        "@type": "Answer",
        "text": faq.answer.replace(/<[^>]*>/g, ""),
      },
    })),
  };
}
