/**
 * /community — public community wall. Approved posts (featured first) in a
 * masonry grid, dark vault aesthetic. Manual + future-webhook submissions.
 */
import { useState } from "react";
import { Link } from "wouter";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ArrowRight, Instagram } from "lucide-react";
import HeaderV2 from "@/components/v2/header-v2";
import FooterV2 from "@/components/v2/footer-v2";
import SeoHead from "@/components/seo-head";

interface CommunityPost {
  id: number;
  certNumber: string | null;
  instagramHandle: string | null;
  imageUrl: string | null;
  cardName: string | null;
  grade: number | null;
  featured: boolean;
}

const PAGE_SIZE = 20;

function gradeColor(grade: number): string {
  if (grade >= 10) return "#D4AF37";
  if (grade >= 9) return "#22c55e";
  if (grade >= 8) return "#16a34a";
  if (grade >= 7) return "#3b82f6";
  if (grade >= 6) return "#f59e0b";
  if (grade >= 5) return "#ea580c";
  if (grade >= 4) return "#ef4444";
  return "#991b1b";
}

export default function CommunityPage() {
  const [total, setTotal] = useState(0);

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } = useInfiniteQuery({
    queryKey: ["/api/public/community"],
    initialPageParam: 1,
    queryFn: async ({ pageParam }) => {
      const r = await fetch(`/api/public/community?page=${pageParam}&limit=${PAGE_SIZE}`);
      const j = (await r.json()) as { posts: CommunityPost[]; total: number };
      setTotal(j.total);
      return j;
    },
    getNextPageParam: (lastPage, pages) => {
      const loaded = pages.reduce((n, p) => n + p.posts.length, 0);
      return loaded < lastPage.total ? pages.length + 1 : undefined;
    },
  });

  const posts = data?.pages.flatMap((p) => p.posts) ?? [];

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "#080808" }}>
      <SeoHead
        title="Certified by the Community | MintVault"
        description="Real collectors sharing their MintVault-graded cards. Grade your cards, share on Instagram, tag @mintvaultuk to appear here."
        canonical="/community"
      />
      <HeaderV2 />

      <main className="flex-1 mx-auto max-w-7xl w-full px-6 py-16 md:py-24">
        <div className="text-center mb-12">
          <h1 className="font-display font-medium text-4xl md:text-6xl text-white mb-4">
            Certified by the <span style={{ color: "#D4AF37" }}>Community</span>
          </h1>
          <p className="text-white/50 text-base md:text-lg max-w-2xl mx-auto mb-6">
            Grade your cards at MintVault. Share on Instagram. Tag <span className="text-[#D4AF37]">@mintvaultuk</span>{" "}
            to appear here.
          </p>
          <Link
            href="/pricing"
            className="inline-flex items-center gap-2 bg-[#D4AF37] hover:bg-[#B8960C] text-[#1A1400] font-bold text-sm uppercase tracking-wider px-6 py-3 rounded-lg transition-colors no-underline"
          >
            Get Your Card Graded <ArrowRight size={14} />
          </Link>
        </div>

        {isLoading ? (
          <div className="text-center text-white/40 py-20">Loading…</div>
        ) : posts.length === 0 ? (
          <div className="text-center text-white/40 py-20">No posts yet. Be the first to share your grade!</div>
        ) : (
          <>
            <div className="columns-1 sm:columns-2 lg:columns-3 gap-5 [&>*]:mb-5">
              {posts.map((post) => (
                <div
                  key={post.id}
                  className={`break-inside-avoid rounded-xl overflow-hidden bg-[#0d0d0d] border ${
                    post.featured ? "border-[#D4AF37]/60 shadow-[0_0_24px_rgba(212,175,55,0.2)]" : "border-white/8"
                  }`}
                >
                  {post.imageUrl && (
                    <img
                      src={post.imageUrl}
                      alt={post.cardName || "Community submission"}
                      className="w-full block"
                      loading="lazy"
                    />
                  )}
                  <div className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        {post.cardName && <p className="text-white font-medium truncate">{post.cardName}</p>}
                        {post.instagramHandle && (
                          <p className="text-white/40 text-xs flex items-center gap-1 mt-0.5">
                            <Instagram size={11} /> @{post.instagramHandle.replace(/^@/, "")}
                          </p>
                        )}
                      </div>
                      {post.grade != null && (
                        <div
                          className="shrink-0 w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold tabular-nums border-2"
                          style={{
                            borderColor: gradeColor(post.grade),
                            color: gradeColor(post.grade),
                            background: gradeColor(post.grade) + "18",
                          }}
                        >
                          {post.grade}
                        </div>
                      )}
                    </div>
                    {post.certNumber && (
                      <Link
                        href={`/cert/${post.certNumber}`}
                        className="mt-3 inline-flex items-center gap-1 text-[#D4AF37] text-xs hover:text-[#f0d070] transition-colors"
                      >
                        Verify Certificate <ArrowRight size={11} />
                      </Link>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {hasNextPage && (
              <div className="text-center mt-10">
                <button
                  type="button"
                  onClick={() => fetchNextPage()}
                  disabled={isFetchingNextPage}
                  className="border border-white/15 hover:border-[#D4AF37]/50 text-white/70 text-sm px-6 py-2.5 rounded-lg transition-colors disabled:opacity-60"
                >
                  {isFetchingNextPage ? "Loading…" : "Load more"}
                </button>
              </div>
            )}
            <p className="text-center text-white/25 text-xs mt-6">
              {total} certified card{total !== 1 ? "s" : ""} shared
            </p>
          </>
        )}
      </main>

      <FooterV2 />
    </div>
  );
}
