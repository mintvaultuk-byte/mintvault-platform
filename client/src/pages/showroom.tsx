import { useState, useMemo, useEffect } from "react";
import { Link, useRoute } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Shield, Lock, Grid2x2, List, Copy, Check, ExternalLink,
  Star, Award, TrendingUp, Layers, Hash,
} from "lucide-react";
import SeoHead from "@/components/seo-head";
import VaultClubBadge from "@/components/vault-club-badge";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ShowroomCard {
  cert_id: string;
  card_name: string | null;
  set_name: string | null;
  year: number | null;
  card_number: string | null;
  grade: number | null;
  is_black_label: boolean;
  front_image_url: string | null;
  graded_at: string;
}

interface ShowroomData {
  username: string;
  display_name: string;
  bio: string | null;
  claimed_at: string;
  active: boolean;
  vault_club_tier: "bronze" | "silver" | "gold" | null;
  stats: {
    total_cards: number;
    grade_breakdown: Record<string, number>;
    black_label_count: number;
    average_grade: number | null;
  } | null;
  cards: ShowroomCard[];
}

// ── Grade badge ───────────────────────────────────────────────────────────────

function GradeBadge({ grade, isBlackLabel }: { grade: number | null; isBlackLabel: boolean }) {
  if (grade === null) return null;
  const bg = isBlackLabel
    ? "#1A1A1A"
    : grade >= 10 ? "#D4AF37"
    : grade >= 9 ? "#22c55e"
    : grade >= 8 ? "#3b82f6"
    : "#9ca3af";
  const text = isBlackLabel ? "#D4AF37" : grade >= 10 ? "#1A1400" : "#fff";
  return (
    <span
      className="absolute top-2 right-2 w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-black shadow-lg"
      style={{ background: bg, color: text, border: isBlackLabel ? "1px solid #D4AF37" : "none" }}
    >
      {grade}
    </span>
  );
}

// ── Card grid item ────────────────────────────────────────────────────────────

function CardGridItem({ card }: { card: ShowroomCard }) {
  return (
    <Link href={`/vault/${card.cert_id}`}>
      <div className={`group relative bg-white rounded-xl overflow-hidden border transition-all cursor-pointer hover:-translate-y-1 hover:shadow-lg ${
        card.is_black_label ? "border-[#1A1A1A]" : "border-[#E8E4DC]"
      }`}>
        {/* Image */}
        <div className="relative aspect-[2.5/3.5] bg-[#F5F2EB] overflow-hidden">
          {card.front_image_url ? (
            <img
              src={card.front_image_url}
              alt={card.card_name || card.cert_id}
              loading="lazy"
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-[#CCCCCC]">
              <Award size={32} />
            </div>
          )}
          <GradeBadge grade={card.grade} isBlackLabel={card.is_black_label} />
          {card.is_black_label && (
            <div className="absolute bottom-2 left-2">
              <span className="text-[8px] font-black uppercase tracking-widest bg-[#1A1A1A] text-[#D4AF37] px-1.5 py-0.5 rounded">
                BLACK LABEL
              </span>
            </div>
          )}
        </div>
        {/* Info */}
        <div className="p-2.5">
          <p className="text-xs font-bold text-[#1A1A1A] truncate">
            {card.card_name || card.cert_id}
          </p>
          <p className="text-[10px] text-[#999999] truncate mt-0.5">
            {[card.set_name, card.year].filter(Boolean).join(" · ")}
          </p>
        </div>
      </div>
    </Link>
  );
}

// ── Card list item ────────────────────────────────────────────────────────────

function CardListItem({ card }: { card: ShowroomCard }) {
  return (
    <div className={`flex items-center gap-4 p-3 rounded-xl border bg-white hover:border-[#D4AF37]/40 transition-all ${
      card.is_black_label ? "border-[#1A1A1A]" : "border-[#E8E4DC]"
    }`}>
      {/* Thumbnail */}
      <div className="w-12 h-[68px] rounded-lg bg-[#F5F2EB] overflow-hidden flex-shrink-0">
        {card.front_image_url ? (
          <img src={card.front_image_url} alt={card.card_name || ""} loading="lazy" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-[#CCCCCC]">
            <Award size={18} />
          </div>
        )}
      </div>
      {/* Details */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-bold text-[#1A1A1A] truncate">
          {card.card_name || card.cert_id}
        </p>
        <p className="text-xs text-[#888888] truncate">
          {[card.set_name, card.year].filter(Boolean).join(" · ")}
          {card.card_number && <span className="ml-1 text-[#CCCCCC]">#{card.card_number}</span>}
        </p>
        {card.is_black_label && (
          <span className="inline-block text-[8px] font-black uppercase tracking-widest bg-[#1A1A1A] text-[#D4AF37] px-1.5 py-0.5 rounded mt-1">
            BLACK LABEL
          </span>
        )}
      </div>
      {/* Grade + link */}
      <div className="flex items-center gap-3 flex-shrink-0">
        {card.grade !== null && (
          <span
            className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-black"
            style={{
              background: card.is_black_label ? "#1A1A1A" : card.grade >= 10 ? "#D4AF37" : card.grade >= 9 ? "#22c55e" : card.grade >= 8 ? "#3b82f6" : "#9ca3af",
              color: card.is_black_label ? "#D4AF37" : card.grade >= 10 ? "#1A1400" : "#fff",
            }}
          >
            {card.grade}
          </span>
        )}
        <Link href={`/vault/${card.cert_id}`} className="text-xs text-[#B8960C] font-semibold hover:text-[#D4AF37] flex items-center gap-0.5 transition-colors">
          Vault <ExternalLink size={10} />
        </Link>
      </div>
    </div>
  );
}

// ── Stat tile ─────────────────────────────────────────────────────────────────

function StatTile({ label, value, icon }: { label: string; value: string | number; icon: React.ReactNode }) {
  return (
    <div className="bg-white border border-[#E8E4DC] rounded-xl p-4 text-center">
      <div className="flex items-center justify-center text-[#D4AF37] mb-2">{icon}</div>
      <div className="text-2xl font-black text-[#1A1A1A]">{value}</div>
      <div className="text-[10px] font-bold uppercase tracking-widest text-[#999999] mt-0.5">{label}</div>
    </div>
  );
}

// ── Sort/filter helpers ───────────────────────────────────────────────────────

type SortKey = "newest" | "oldest" | "grade_high" | "grade_low" | "name_az";

function sortCards(cards: ShowroomCard[], sort: SortKey): ShowroomCard[] {
  return [...cards].sort((a, b) => {
    switch (sort) {
      case "newest": return new Date(b.graded_at).getTime() - new Date(a.graded_at).getTime();
      case "oldest": return new Date(a.graded_at).getTime() - new Date(b.graded_at).getTime();
      case "grade_high": return (b.grade ?? 0) - (a.grade ?? 0);
      case "grade_low": return (a.grade ?? 0) - (b.grade ?? 0);
      case "name_az": return (a.card_name ?? "").localeCompare(b.card_name ?? "");
    }
  });
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ShowroomPage() {
  const [, params] = useRoute("/showroom/:username");
  const username = params?.username ?? "";

  const [layout, setLayout] = useState<"grid" | "list">(() => {
    try { return (localStorage.getItem("showroom_layout") as "grid" | "list") || "grid"; } catch { return "grid"; }
  });
  const [sort, setSort] = useState<SortKey>("newest");
  const [gradeFilter, setGradeFilter] = useState<string>("all");
  const [setFilter, setSetFilter] = useState<string>("all");

  useEffect(() => {
    try { localStorage.setItem("showroom_layout", layout); } catch { /* ok */ }
  }, [layout]);

  const { data, isLoading, isError } = useQuery<ShowroomData>({
    queryKey: [`/api/showroom/${username}`],
    queryFn: async () => {
      const res = await fetch(`/api/showroom/${encodeURIComponent(username)}`);
      if (res.status === 404) throw new Error("not_found");
      if (!res.ok) throw new Error("error");
      return res.json();
    },
    retry: false,
    enabled: !!username,
  });

  if (isLoading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="w-8 h-8 rounded-full border-2 border-[#D4AF37] border-t-transparent animate-spin" />
      </div>
    );
  }

  // State 1 — not found
  if (isError || !data) {
    return (
      <div className="min-h-[60vh] bg-[#FAFAF8] flex items-center justify-center px-4 py-16">
        <SeoHead title="Showroom Not Found | MintVault UK" description="" canonical="" />
        <div className="text-center max-w-md">
          <div className="w-16 h-16 rounded-full bg-[#F5F2EB] border border-[#E8E4DC] flex items-center justify-center mx-auto mb-6">
            <Hash size={28} className="text-[#CCCCCC]" />
          </div>
          <h1 className="text-2xl font-black text-[#1A1A1A] mb-3">
            Showroom not found
          </h1>
          <p className="text-sm text-[#888888] mb-8">
            The username <strong className="text-[#1A1A1A]">{username}</strong> isn't registered with MintVault.
          </p>
          <div className="flex items-center justify-center gap-3 flex-wrap">
            <Link href="/showrooms">
              <button className="px-5 py-2.5 rounded-xl border border-[#D4AF37]/40 text-[#B8960C] text-sm font-bold hover:bg-[#D4AF37]/5 transition-all">
                Browse Showrooms
              </button>
            </Link>
            <Link href="/dashboard">
              <button className="px-5 py-2.5 rounded-xl text-sm font-bold text-[#1A1400] transition-all"
                style={{ background: "linear-gradient(135deg,#B8960C,#D4AF37)" }}>
                Claim your own
              </button>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // State 2 — reserved / not yet active
  if (!data.active) {
    return (
      <div className="min-h-[60vh] bg-[#FAFAF8] flex items-center justify-center px-4 py-16">
        <SeoHead
          title={`${data.username}'s Showroom | MintVault UK`}
          description="This Showroom is reserved."
          canonical={`https://mintvaultuk.com/showroom/${data.username}`}
        />
        <div className="text-center max-w-md">
          {/* Faded mock with lock overlay */}
          <div className="relative w-full rounded-2xl border border-[#E8E4DC] overflow-hidden mb-8 select-none pointer-events-none" style={{ height: 180 }}>
            <div className="absolute inset-0 grid grid-cols-4 gap-2 p-3 opacity-20">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="aspect-[2.5/3.5] bg-[#D4AF37]/30 rounded-lg" />
              ))}
            </div>
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/70 backdrop-blur-sm">
              <Lock size={32} className="text-[#D4AF37] mb-2" />
              <span className="text-xs font-bold text-[#888888] uppercase tracking-widest">Not yet activated</span>
            </div>
          </div>

          <h1 className="text-2xl font-black text-[#1A1A1A] mb-3">
            {data.username}'s Showroom
          </h1>
          <p className="text-sm text-[#888888] mb-6">
            This Showroom is reserved. The owner hasn't activated their Vault Club membership yet.
          </p>
          <div className="flex flex-col items-center gap-3">
            <Link href="/vault-club" className="text-sm text-[#B8960C] font-semibold hover:text-[#D4AF37] transition-colors">
              Are you {data.username}? Activate your Showroom →
            </Link>
            <Link href="/showrooms" className="text-xs text-[#AAAAAA] hover:text-[#888888] transition-colors">
              Browse other Showrooms →
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // State 3 — active showroom
  const sets = useMemo(() => {
    const s = new Set<string>();
    data.cards.forEach(c => { if (c.set_name) s.add(c.set_name); });
    return Array.from(s).sort();
  }, [data.cards]);

  const filtered = useMemo(() => {
    let cards = data.cards;
    if (gradeFilter !== "all") {
      const target = parseFloat(gradeFilter);
      cards = cards.filter(c => c.grade !== null && Math.floor(c.grade) === Math.floor(target));
    }
    if (setFilter !== "all") {
      cards = cards.filter(c => c.set_name === setFilter);
    }
    return sortCards(cards, sort);
  }, [data.cards, sort, gradeFilter, setFilter]);

  const memberSince = data.claimed_at
    ? new Date(data.claimed_at).toLocaleDateString("en-GB", { month: "long", year: "numeric" })
    : "";

  return (
    <div className="bg-[#FAFAF8] min-h-screen">
      <SeoHead
        title={`${data.display_name}'s Showroom | MintVault UK`}
        description={data.bio || `${data.display_name}'s verified MintVault collection — ${data.stats?.total_cards ?? 0} graded cards.`}
        canonical={`https://mintvaultuk.com/showroom/${data.username}`}
      />

      {/* Hero */}
      <div
        className="relative overflow-hidden"
        style={{ background: "linear-gradient(135deg,#0A0A0A 0%,#1A1200 100%)" }}
      >
        <div className="absolute inset-0 pointer-events-none" style={{ background: "radial-gradient(ellipse 70% 60% at 50% 0%, rgba(212,175,55,0.12) 0%, transparent 70%)" }} />
        <div className="relative max-w-4xl mx-auto px-4 py-16 text-center">
          <div className="inline-flex items-center gap-1.5 bg-[#D4AF37]/10 border border-[#D4AF37]/30 rounded-full px-3 py-1 mb-5">
            <Shield size={11} className="text-[#D4AF37]" />
            <span className="text-[10px] font-black uppercase tracking-widest text-[#D4AF37]">Verified MintVault Collector</span>
          </div>
          <div className="flex items-center justify-center gap-3 mb-3">
            <h1
              className="text-4xl md:text-5xl font-black"
              style={{ color: "#D4AF37" }}
            >
              {data.display_name}
            </h1>
            {data.vault_club_tier && (
              <VaultClubBadge tier={data.vault_club_tier} size="lg" showLabel={false} />
            )}
          </div>
          {data.bio && (
            <p className="text-[#B8A060] text-base max-w-lg mx-auto mb-4">{data.bio}</p>
          )}
          <div className="flex items-center justify-center gap-4 text-[#888888] text-xs mt-4 flex-wrap">
            <span><strong className="text-white">{data.stats?.total_cards ?? 0}</strong> cards</span>
            <span className="text-[#444]">·</span>
            <span>Member since {memberSince}</span>
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 py-10">

        {/* Stats bar */}
        {data.stats && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-10">
            <StatTile label="Total Cards" value={data.stats.total_cards} icon={<Layers size={18} />} />
            <StatTile label="Black Labels" value={data.stats.black_label_count} icon={<Award size={18} />} />
            <StatTile label="Gem Mint 10s" value={data.stats.grade_breakdown["10"] ?? 0} icon={<Star size={18} />} />
            <StatTile label="Mint 9s" value={data.stats.grade_breakdown["9"] ?? 0} icon={<TrendingUp size={18} />} />
            <StatTile label="Avg Grade" value={data.stats.average_grade ?? "—"} icon={<Hash size={18} />} />
          </div>
        )}

        {/* Filters + layout toggle */}
        <div className="flex items-center gap-3 mb-6 flex-wrap">
          <select
            value={sort}
            onChange={e => setSort(e.target.value as SortKey)}
            className="text-xs border border-[#E8E4DC] rounded-lg px-3 py-2 bg-white text-[#1A1A1A] focus:outline-none focus:border-[#D4AF37]"
          >
            <option value="newest">Newest First</option>
            <option value="oldest">Oldest First</option>
            <option value="grade_high">Highest Grade</option>
            <option value="grade_low">Lowest Grade</option>
            <option value="name_az">Card Name A-Z</option>
          </select>
          <select
            value={gradeFilter}
            onChange={e => setGradeFilter(e.target.value)}
            className="text-xs border border-[#E8E4DC] rounded-lg px-3 py-2 bg-white text-[#1A1A1A] focus:outline-none focus:border-[#D4AF37]"
          >
            <option value="all">All Grades</option>
            {[10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map(g => (
              <option key={g} value={String(g)}>{g}s only</option>
            ))}
          </select>
          {sets.length > 0 && (
            <select
              value={setFilter}
              onChange={e => setSetFilter(e.target.value)}
              className="text-xs border border-[#E8E4DC] rounded-lg px-3 py-2 bg-white text-[#1A1A1A] focus:outline-none focus:border-[#D4AF37]"
            >
              <option value="all">All Sets</option>
              {sets.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          )}
          <div className="ml-auto flex items-center gap-1 border border-[#E8E4DC] rounded-lg overflow-hidden">
            <button
              onClick={() => setLayout("grid")}
              className={`p-2 transition-colors ${layout === "grid" ? "bg-[#D4AF37]/15 text-[#B8960C]" : "bg-white text-[#999999] hover:text-[#666666]"}`}
              aria-label="Grid view"
            >
              <Grid2x2 size={14} />
            </button>
            <button
              onClick={() => setLayout("list")}
              className={`p-2 transition-colors ${layout === "list" ? "bg-[#D4AF37]/15 text-[#B8960C]" : "bg-white text-[#999999] hover:text-[#666666]"}`}
              aria-label="List view"
            >
              <List size={14} />
            </button>
          </div>
        </div>

        {/* Cards */}
        {filtered.length === 0 ? (
          <div className="text-center py-16 text-[#999999] text-sm">No cards match this filter.</div>
        ) : layout === "grid" ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
            {filtered.map(c => <CardGridItem key={c.cert_id} card={c} />)}
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map(c => <CardListItem key={c.cert_id} card={c} />)}
          </div>
        )}

        {/* Footer CTA */}
        <div className="mt-16 border-t border-[#E8E4DC] pt-8 text-center">
          <p className="text-sm text-[#888888] mb-3">Want your own Showroom?</p>
          <Link href="/dashboard">
            <button
              className="px-6 py-2.5 rounded-xl text-sm font-bold text-[#1A1400] transition-all"
              style={{ background: "linear-gradient(135deg,#B8960C,#D4AF37)" }}
            >
              Claim yours →
            </button>
          </Link>
        </div>
      </div>
    </div>
  );
}
