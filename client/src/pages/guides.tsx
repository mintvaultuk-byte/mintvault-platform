import { useState } from "react";
import { Link } from "wouter";
import { BookOpen, Search, Calendar, ArrowRight } from "lucide-react";
import SeoHead from "@/components/seo-head";
import BreadcrumbNav, { breadcrumbSchema } from "@/components/breadcrumb-nav";
import { guides } from "@/data/guides";

const breadcrumbs = [
  { label: "Home", href: "/" },
  { label: "Guides" },
];

export default function GuidesPage() {
  const [search, setSearch] = useState("");

  const filtered = guides.filter(g =>
    g.title.toLowerCase().includes(search.toLowerCase()) ||
    g.excerpt.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="px-4 max-w-4xl mx-auto py-8">
      <SeoHead
        title="Card Grading Guides & Articles | MintVault UK"
        description="Expert guides on Pokémon card grading, trading card collecting, grading costs, and how to prepare cards for grading in the UK. Free resources from MintVault."
        canonical="https://mintvaultuk.com/guides"
        schema={[
          breadcrumbSchema(breadcrumbs),
          {
            "@context": "https://schema.org",
            "@type": "CollectionPage",
            "name": "Card Grading Guides",
            "description": "Expert guides on trading card grading from MintVault UK.",
            "url": "https://mintvaultuk.com/guides",
          },
        ]}
      />

      <BreadcrumbNav items={breadcrumbs} />

      <div className="text-center mb-8">
        <h1 className="text-2xl md:text-3xl font-black text-[#1A1A1A] tracking-tighter mb-3" data-testid="text-guides-title">
          Card Grading <span className="gold-shimmer-text">Guides</span> & Articles
        </h1>
        <p className="text-[#666666] text-sm max-w-lg mx-auto">
          Expert resources to help you understand card grading, prepare your cards, and get the most value from your collection.
        </p>
      </div>

      <div className="relative max-w-md mx-auto mb-8">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#D4AF37]/40" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search guides..."
          aria-label="Search guides"
          className="w-full bg-white border border-[#E8E4DC] rounded-lg pl-10 pr-4 py-2.5 text-[#1A1A1A] text-sm placeholder:text-[#999999] focus:outline-none focus:border-[#D4AF37] transition-colors"
          data-testid="input-search-guides"
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" data-testid="grid-guides">
        {filtered.map((guide) => (
          <Link key={guide.slug} href={`/guides/${guide.slug}`}>
            <article className="glass-card rounded-2xl cursor-pointer h-full flex flex-col p-5" data-testid={`card-guide-${guide.slug}`}>
              <h2 className="text-[#1A1A1A] text-sm font-semibold mb-2 leading-snug">{guide.title}</h2>
              <p className="text-[#666666] text-xs leading-relaxed mb-3 flex-1 line-clamp-3">{guide.excerpt}</p>
              <div className="flex items-center justify-between mt-auto">
                <span className="text-[#D4AF37]/40 text-xs flex items-center gap-1">
                  <Calendar size={10} /> {guide.publishedDate}
                </span>
                <span className="text-[#D4AF37] text-xs font-medium flex items-center gap-1">
                  Read <ArrowRight size={12} />
                </span>
              </div>
            </article>
          </Link>
        ))}
      </div>

      {filtered.length === 0 && (
        <p className="text-[#999999] text-center py-12" data-testid="text-no-results">No guides found matching your search.</p>
      )}

      <div className="text-center mt-12">
        <Link href="/submit">
          <span className="btn-gold inline-flex items-center gap-2 px-6 py-2.5 rounded-xl font-black text-sm tracking-widest text-[#1A1400] cursor-pointer" data-testid="button-guides-submit">
            <BookOpen size={16} /> Ready to Grade? Submit Your Cards
          </span>
        </Link>
      </div>
    </div>
  );
}
