import { useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import SeoHead from "@/components/seo-head";
import { useFeatureFlags } from "@/hooks/use-feature-flags";

interface LegalDoc {
  slug: string;
  title: string;
  version: string;
  content: string;
}

export default function LegalPage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug || "";
  const flags = useFeatureFlags();

  const { data, isLoading, error } = useQuery<LegalDoc>({
    queryKey: ["/api/legal", slug],
    queryFn: async () => {
      const res = await fetch(`/api/legal/${slug}`);
      if (!res.ok) throw new Error("Document not found");
      return res.json();
    },
    enabled: !!slug,
  });

  if (!flags.legalPagesLive) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-16 text-center">
        <p className="text-[#888888]">This page is not yet available.</p>
      </div>
    );
  }

  if (isLoading) return (
    <div className="max-w-3xl mx-auto px-4 py-16 text-center">
      <p className="text-[#888888] text-sm">Loading...</p>
    </div>
  );

  if (error || !data) return (
    <div className="max-w-3xl mx-auto px-4 py-16 text-center">
      <p className="text-[#888888]">Document not found.</p>
    </div>
  );

  return (
    <>
      <SeoHead title={`${data.title} | MintVault`} description={data.title} canonical={`/legal/${slug}`} />
      <div className="max-w-[720px] mx-auto px-4 py-12">
        {/* Draft badge */}
        <div className="flex items-center gap-2 mb-8">
          <span className="px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest bg-[#D4AF37]/10 text-[#B8960C] border border-[#D4AF37]/30">
            {data.version} · Draft · Pending review
          </span>
        </div>

        {/* Markdown content */}
        <article className="prose prose-sm max-w-none
          prose-headings:font-sans prose-headings:text-[#1A1A1A] prose-headings:tracking-tight
          prose-h1:text-2xl prose-h1:font-black prose-h1:mb-6
          prose-h2:text-lg prose-h2:font-bold prose-h2:mt-10 prose-h2:mb-4 prose-h2:border-b prose-h2:border-[#E8E4DC] prose-h2:pb-2
          prose-h3:text-base prose-h3:font-semibold
          prose-p:text-[#444444] prose-p:leading-[1.7] prose-p:text-sm
          prose-li:text-[#444444] prose-li:text-sm prose-li:leading-[1.7]
          prose-strong:text-[#1A1A1A]
          prose-a:text-[#B8960C] prose-a:underline hover:prose-a:text-[#D4AF37]
          prose-blockquote:border-l-[#D4AF37] prose-blockquote:text-[#666666] prose-blockquote:bg-[#FAFAF8] prose-blockquote:py-2 prose-blockquote:px-4 prose-blockquote:rounded-r
          prose-hr:border-[#E8E4DC]
        ">
          <ReactMarkdown>{data.content}</ReactMarkdown>
        </article>
      </div>
    </>
  );
}
