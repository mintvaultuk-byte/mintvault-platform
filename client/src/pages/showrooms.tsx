import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Shield, Award, Layers } from "lucide-react";
import SeoHead from "@/components/seo-head";
import VaultClubBadge from "@/components/vault-club-badge";

interface ShowroomEntry {
  username: string;
  display_name: string;
  bio: string | null;
  total_cards: number;
  black_label_count: number;
  claimed_at: string;
  vault_club_tier: "bronze" | "silver" | "gold" | null;
}

function InitialCircle({ name }: { name: string }) {
  const letter = (name || "?")[0].toUpperCase();
  return (
    <div
      className="w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0 font-black text-lg"
      style={{ background: "linear-gradient(135deg,#B8960C,#D4AF37)", color: "#1A1400" }}
    >
      {letter}
    </div>
  );
}

export default function ShowroomsListPage() {
  const { data, isLoading } = useQuery<{ showrooms: ShowroomEntry[] }>({
    queryKey: ["/api/showrooms"],
    queryFn: async () => {
      const res = await fetch("/api/showrooms?limit=50&offset=0");
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
    staleTime: 60_000,
  });

  const showrooms = data?.showrooms ?? [];

  return (
    <div className="bg-[#FAFAF8] min-h-screen">
      <SeoHead
        title="Showrooms | MintVault UK"
        description="Browse verified MintVault collector Showrooms — public collections of graded trading cards."
        canonical="https://mintvaultuk.com/showrooms"
      />

      {/* Hero */}
      <div
        className="relative overflow-hidden"
        style={{ background: "linear-gradient(135deg,#0A0A0A 0%,#1A1200 100%)" }}
      >
        <div className="absolute inset-0 pointer-events-none" style={{ background: "radial-gradient(ellipse 70% 60% at 50% 0%, rgba(212,175,55,0.12) 0%, transparent 70%)" }} />
        <div className="relative max-w-3xl mx-auto px-4 py-16 text-center">
          <div className="inline-flex items-center gap-1.5 bg-[#D4AF37]/10 border border-[#D4AF37]/30 rounded-full px-3 py-1 mb-5">
            <Shield size={11} className="text-[#D4AF37]" />
            <span className="text-[10px] font-black uppercase tracking-widest text-[#D4AF37]">Verified Collectors</span>
          </div>
          <h1
            className="text-4xl md:text-5xl font-black mb-4"
            style={{ color: "#D4AF37" }}
          >
            Showrooms
          </h1>
          <p className="text-[#B8A060] text-base max-w-xl mx-auto">
            Public collections from verified MintVault collectors. Each card grade-authenticated and registry-backed.
          </p>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-10">
        {isLoading ? (
          <div className="flex justify-center py-16">
            <div className="w-8 h-8 rounded-full border-2 border-[#D4AF37] border-t-transparent animate-spin" />
          </div>
        ) : showrooms.length < 5 ? (
          /* Empty / early state */
          <div className="text-center py-16">
            <div className="w-20 h-20 rounded-full bg-[#D4AF37]/10 border border-[#D4AF37]/20 flex items-center justify-center mx-auto mb-6">
              <Shield size={36} className="text-[#D4AF37]" />
            </div>
            <h2
              className="text-2xl font-black text-[#1A1A1A] mb-3"
             
            >
              Showrooms is just getting started
            </h2>
            <p className="text-sm text-[#888888] max-w-sm mx-auto mb-8">
              Be one of the first to claim your Showroom and showcase your verified MintVault collection to the world.
            </p>
            <Link href="/dashboard">
              <button
                className="px-7 py-3 rounded-xl font-bold text-sm text-[#1A1400] transition-all"
                style={{ background: "linear-gradient(135deg,#B8960C,#D4AF37)" }}
              >
                Claim Your Showroom →
              </button>
            </Link>

            {/* Still render any that exist */}
            {showrooms.length > 0 && (
              <div className="mt-12 space-y-3 text-left">
                {showrooms.map(s => <ShowroomRow key={s.username} showroom={s} />)}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {showrooms.map(s => <ShowroomRow key={s.username} showroom={s} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function ShowroomRow({ showroom }: { showroom: ShowroomEntry }) {
  const memberSince = showroom.claimed_at
    ? new Date(showroom.claimed_at).toLocaleDateString("en-GB", { month: "short", year: "numeric" })
    : "";
  return (
    <Link href={`/showroom/${showroom.username}`}>
      <div className="flex items-center gap-4 bg-white border border-[#E8E4DC] rounded-xl p-4 hover:border-[#D4AF37]/40 hover:-translate-y-0.5 transition-all cursor-pointer shadow-sm">
        <InitialCircle name={showroom.display_name} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-[#1A1A1A] text-sm">
              {showroom.display_name}
            </span>
            {showroom.vault_club_tier && <VaultClubBadge tier={showroom.vault_club_tier} size="sm" />}
            <span className="text-[10px] text-[#AAAAAA]">@{showroom.username}</span>
          </div>
          {showroom.bio && (
            <p className="text-xs text-[#666666] truncate mt-0.5">
              {showroom.bio.length > 100 ? showroom.bio.slice(0, 100) + "…" : showroom.bio}
            </p>
          )}
          <div className="flex items-center gap-3 mt-1.5 text-[10px] text-[#999999]">
            <span className="flex items-center gap-1"><Layers size={10} />{showroom.total_cards} cards</span>
            {showroom.black_label_count > 0 && (
              <span className="flex items-center gap-1"><Award size={10} />{showroom.black_label_count} Black Label</span>
            )}
            <span>Since {memberSince}</span>
          </div>
        </div>
        <div className="text-[#CCCCCC] text-xs">→</div>
      </div>
    </Link>
  );
}
