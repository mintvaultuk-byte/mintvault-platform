import { useParams } from "wouter";
import { Link } from "wouter";
import { Calendar, User, ArrowLeft } from "lucide-react";
import SeoHead from "@/components/seo-head";
import BreadcrumbNav, { breadcrumbSchema } from "@/components/breadcrumb-nav";
import CtaSection from "@/components/cta-section";
import RelatedGuides from "@/components/related-guides";
import { guides, getGuideBySlug, getRelatedGuides } from "@/data/guides";

export default function GuideDetailPage() {
  const params = useParams<{ slug: string }>();
  const guide = getGuideBySlug(params.slug || "");

  if (!guide) {
    return (
      <div className="px-4 max-w-3xl mx-auto py-16 text-center">
        <h1 className="text-2xl font-bold text-[#D4AF37] mb-4">Guide Not Found</h1>
        <p className="text-gray-400 mb-6">The guide you are looking for does not exist.</p>
        <Link href="/guides">
          <span className="text-[#D4AF37] hover:underline cursor-pointer">Browse all guides</span>
        </Link>
      </div>
    );
  }

  const breadcrumbs = [
    { label: "Home", href: "/" },
    { label: "Guides", href: "/guides" },
    { label: guide.title },
  ];

  const related = getRelatedGuides(guide.slug);

  const headings = guide.body.match(/<h2[^>]*>(.*?)<\/h2>/gi)?.map(h => {
    const text = h.replace(/<[^>]*>/g, "");
    const id = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return { text, id };
  }) || [];

  const articleSchema = {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": guide.title,
    "description": guide.metaDescription,
    "author": { "@type": "Organization", "name": guide.author },
    "publisher": { "@type": "Organization", "name": "MintVault UK", "url": "https://mintvault.co.uk" },
    "datePublished": guide.publishedDate,
    "dateModified": guide.updatedDate || guide.publishedDate,
    "mainEntityOfPage": `https://mintvault.co.uk/guides/${guide.slug}`,
  };

  const bodyWithIds = guide.body.replace(/<h2([^>]*)>(.*?)<\/h2>/gi, (_match, attrs, content) => {
    const text = content.replace(/<[^>]*>/g, "");
    const id = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return `<h2${attrs} id="${id}">${content}</h2>`;
  });

  return (
    <div className="px-4 max-w-3xl mx-auto py-8">
      <SeoHead
        title={guide.metaTitle}
        description={guide.metaDescription}
        canonical={`https://mintvault.co.uk/guides/${guide.slug}`}
        schema={[breadcrumbSchema(breadcrumbs), articleSchema]}
      />

      <BreadcrumbNav items={breadcrumbs} />

      <Link href="/guides">
        <span className="text-[#D4AF37]/50 hover:text-[#D4AF37] text-sm flex items-center gap-1 mb-6 cursor-pointer transition-colors" data-testid="link-back-guides">
          <ArrowLeft size={14} /> All Guides
        </span>
      </Link>

      <article>
        <header className="mb-8">
          <h1 className="text-2xl md:text-3xl font-bold text-[#D4AF37] tracking-wide mb-4 leading-tight" data-testid="text-guide-title">
            {guide.title}
          </h1>
          <div className="flex items-center gap-4 text-xs text-gray-500">
            <span className="flex items-center gap-1" data-testid="text-guide-author">
              <User size={12} /> {guide.author}
            </span>
            <span className="flex items-center gap-1" data-testid="text-guide-date">
              <Calendar size={12} /> {new Date(guide.publishedDate).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
            </span>
            {guide.updatedDate && guide.updatedDate !== guide.publishedDate && (
              <span className="text-gray-600" data-testid="text-guide-updated">
                Updated {new Date(guide.updatedDate).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
              </span>
            )}
          </div>
        </header>

        {headings.length > 2 && (
          <nav className="border border-[#D4AF37]/20 rounded-lg p-4 mb-8" data-testid="nav-toc">
            <h2 className="text-[#D4AF37] text-sm font-semibold uppercase tracking-wider mb-3">Contents</h2>
            <ul className="space-y-1.5">
              {headings.map((h, i) => (
                <li key={i}>
                  <a href={`#${h.id}`} className="text-[#D4AF37]/60 text-sm hover:text-[#D4AF37] transition-colors">
                    {h.text}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}

        <div
          className="prose prose-invert prose-gold max-w-none
            [&_h2]:text-xl [&_h2]:font-bold [&_h2]:text-[#D4AF37] [&_h2]:mt-8 [&_h2]:mb-4 [&_h2]:tracking-wide
            [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:text-white [&_h3]:mt-6 [&_h3]:mb-3
            [&_p]:text-gray-300 [&_p]:text-sm [&_p]:leading-relaxed [&_p]:mb-4
            [&_ul]:space-y-2 [&_ul]:mb-4 [&_li]:text-gray-300 [&_li]:text-sm
            [&_a]:text-[#D4AF37] [&_a]:hover:underline
            [&_strong]:text-white
            [&_blockquote]:border-l-2 [&_blockquote]:border-[#D4AF37]/30 [&_blockquote]:pl-4 [&_blockquote]:italic [&_blockquote]:text-gray-400"
          dangerouslySetInnerHTML={{ __html: bodyWithIds }}
          data-testid="article-body"
        />
      </article>

      <div className="mt-12 space-y-12">
        {related.length > 0 && <RelatedGuides guides={related} />}
        <CtaSection />
      </div>
    </div>
  );
}
