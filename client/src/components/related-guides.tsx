import { Link } from "wouter";
import { BookOpen, ArrowRight } from "lucide-react";

interface GuideCard {
  slug: string;
  title: string;
  excerpt: string;
}

export default function RelatedGuides({ guides, title = "Related Guides" }: { guides: GuideCard[]; title?: string }) {
  if (!guides.length) return null;

  return (
    <section className="max-w-3xl mx-auto" data-testid="section-related-guides">
      <h2 className="text-xl font-bold text-[#D4AF37] tracking-wide mb-4 flex items-center gap-2">
        <BookOpen size={20} />
        {title}
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {guides.map((guide) => (
          <Link key={guide.slug} href={`/guides/${guide.slug}`}>
            <div className="border border-[#D4AF37]/20 rounded-lg p-4 hover:border-[#D4AF37]/40 hover:bg-[#D4AF37]/5 transition-all cursor-pointer h-full" data-testid={`card-guide-${guide.slug}`}>
              <h3 className="text-[#1A1A1A] text-sm font-semibold mb-2 leading-snug">{guide.title}</h3>
              <p className="text-[#666666] text-xs leading-relaxed mb-3 line-clamp-3">{guide.excerpt}</p>
              <span className="text-[#D4AF37] text-xs font-medium flex items-center gap-1">
                Read More <ArrowRight size={12} />
              </span>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
