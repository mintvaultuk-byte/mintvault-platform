import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  Shield, ShieldCheck, Check, ChevronDown, ChevronUp,
  Zap, Star, Award, TrendingDown, CreditCard, Loader2,
} from "lucide-react";
import SeoHead from "@/components/seo-head";
import VaultClubBadge from "@/components/vault-club-badge";
import { apiRequest } from "@/lib/queryClient";

// ── Types ──────────────────────────────────────────────────────────────────────

interface VaultClubMe {
  tier: "bronze" | "silver" | "gold" | null;
  label: string | null;
  status: string | null;
  billing_interval: "month" | "year" | null;
  renews_at: string | null;
  cancels_at: string | null;
  started_at: string | null;
  perks: Record<string, unknown> | null;
  ai_credits_balance: number;
  ai_credits_monthly: number;
  next_refill_at: string | null;
  reholder_credits_remaining: number;
  stripe_customer_id: string | null;
  username: string | null;
}

// ── Pricing data (mirrors server/vault-club-tiers.ts) ─────────────────────────
//
// Bronze and Gold deprecated 2026-04-19 — Silver-only launch. Perk evaluator
// (free shipping, free monthly authentication, queue-jump) ships in Phase 1B.

const TIERS = [
  {
    key: "silver" as const,
    label: "Silver Vault",
    icon: <Shield size={28} style={{ color: "#C0C0C0" }} />,
    monthly: 9.99,
    annual: 99.00,
    monthlyPence: 999,
    annualPence: 9900,
    popular: true,
    colour: "#C0C0C0",
    features: [
      "Free insured UK return shipping on every submission",
      "2 free Authentication add-ons per month",
      "Queue-jump within your chosen grading tier",
      "100 AI Pre-Grade credits per month",
      "Early access to Population Report insights",
      "Silver Verified badge on certificates and Showroom",
      "All 8 Showroom themes + custom banner",
      "Members-only Vault report design",
    ],
  },
];

const FAQS = [
  {
    q: "What is Vault Club?",
    a: "Vault Club is MintVault's exclusive membership programme for serious collectors. Silver members get free insured return shipping, two free Authentication add-ons per month, queue-jump on submissions, monthly AI Pre-Grade credits, an activated Showroom, and a verified tier badge on every certificate and report.",
  },
  {
    q: "Can I cancel anytime?",
    a: "Yes. Cancel anytime from the billing portal — you'll keep your perks until the end of the current billing period, then your membership ends. No cancellation fees.",
  },
  {
    q: "What happens to my Showroom if I cancel?",
    a: "Your username and Showroom URL are reserved permanently — you won't lose them. Your Showroom will be set back to 'reserved' mode (not publicly visible) until you rejoin.",
  },
  {
    q: "Do unused AI credits roll over?",
    a: "No. AI Pre-Grade credits refresh to your monthly allowance on each billing date. Unused credits do not carry over.",
  },
  {
    q: "How does the free trial work?",
    a: "Annual plans include a 14-day free trial. You won't be charged for 14 days, and you can cancel anytime before the trial ends without paying anything. Monthly plans do not include a trial.",
  },
  {
    q: "Are Vault Club perks available on all card games?",
    a: "Yes. Silver member perks — free shipping, monthly free Authentication credits, queue-jump, AI Pre-Grade credits — apply to all grading submissions regardless of card game: Pokémon, Yu-Gi-Oh!, Magic: The Gathering, One Piece, sports cards, and more.",
  },
];

// ── Sub-components ─────────────────────────────────────────────────────────────

function IntervalToggle({ interval, onChange }: { interval: "month" | "year"; onChange: (v: "month" | "year") => void }) {
  return (
    <div className="flex items-center justify-center mb-10">
      <div className="flex items-center gap-0 bg-[#F5F2EB] rounded-xl p-1 border border-[#E8E4DC]">
        <button
          onClick={() => onChange("month")}
          className={`px-5 py-2 rounded-lg text-sm font-bold transition-all ${
            interval === "month"
              ? "bg-white text-[#1A1A1A] shadow-sm"
              : "text-[#999999] hover:text-[#666666]"
          }`}
        >
          Monthly
        </button>
        <button
          onClick={() => onChange("year")}
          className={`px-5 py-2 rounded-lg text-sm font-bold transition-all flex items-center gap-1.5 ${
            interval === "year"
              ? "bg-white text-[#1A1A1A] shadow-sm"
              : "text-[#999999] hover:text-[#666666]"
          }`}
        >
          Annual
          <span className="text-[10px] font-black text-[#D4AF37] bg-[#D4AF37]/10 px-1.5 py-0.5 rounded-md">
            Save 2 months
          </span>
        </button>
      </div>
    </div>
  );
}

function TierCard({
  tier,
  interval,
  onSubscribe,
  isPending,
}: {
  tier: typeof TIERS[number];
  interval: "month" | "year";
  onSubscribe: (t: string, i: string) => void;
  isPending: boolean;
}) {
  const price = interval === "year" ? tier.annual / 12 : tier.monthly;
  const annualLabel = interval === "year"
    ? `£${tier.annual.toFixed(0)} billed annually`
    : `£${tier.monthly.toFixed(2)}/month`;

  return (
    <div
      className={`relative flex flex-col bg-white rounded-2xl border ${
        tier.popular
          ? "border-[#D4AF37]/60 shadow-[0_0_0_2px_rgba(212,175,55,0.15),0_8px_32px_rgba(0,0,0,0.08)]"
          : "border-[#E8E4DC] shadow-sm"
      } overflow-hidden`}
    >
      {/* Most popular ribbon */}
      {tier.popular && (
        <div
          className="absolute top-0 left-0 right-0 py-1.5 text-center text-[10px] font-black uppercase tracking-widest text-[#1A1400]"
          style={{ background: "linear-gradient(90deg,#B8960C,#D4AF37)" }}
        >
          Most Popular
        </div>
      )}

      <div className={`p-6 ${tier.popular ? "pt-10" : ""}`}>
        {/* Header */}
        <div className="flex items-center gap-3 mb-4">
          {tier.icon}
          <h3
            className="text-xl font-black text-[#1A1A1A]"
           
          >
            {tier.label}
          </h3>
        </div>

        {/* Price */}
        <div className="mb-1">
          <span className="text-3xl font-black text-[#1A1A1A]">£{price.toFixed(2)}</span>
          <span className="text-sm text-[#999999] ml-1">/month</span>
        </div>
        <p className="text-xs text-[#AAAAAA] mb-1">{annualLabel}</p>
        {interval === "year" && (
          <p className="text-xs text-[#D4AF37] font-semibold mb-4">14-day free trial</p>
        )}
        {interval === "month" && <div className="mb-4" />}

        {/* CTA */}
        <button
          onClick={() => onSubscribe(tier.key, interval)}
          disabled={isPending}
          className="w-full py-3 rounded-xl font-bold text-sm transition-all active:scale-95 disabled:opacity-60 flex items-center justify-center gap-2 mb-5"
          style={{
            background: tier.popular
              ? "linear-gradient(135deg,#B8960C,#D4AF37)"
              : "white",
            color: tier.popular ? "#1A1400" : "#1A1A1A",
            border: tier.popular ? "none" : `1.5px solid ${tier.colour}`,
          }}
        >
          {isPending && <Loader2 size={14} className="animate-spin" />}
          Subscribe
        </button>

        <p className="text-[10px] text-[#AAAAAA] text-center mb-5">Cancel anytime</p>

        {/* Features */}
        <ul className="space-y-2">
          {tier.features.map((f) => (
            <li key={f} className="flex items-start gap-2 text-sm text-[#444444]">
              <Check size={14} className="text-[#D4AF37] flex-shrink-0 mt-0.5" />
              {f}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-[#E8E4DC] last:border-0">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-start justify-between gap-4 py-4 text-left"
      >
        <span className="text-sm font-semibold text-[#1A1A1A]">{q}</span>
        {open ? <ChevronUp size={16} className="text-[#AAAAAA] flex-shrink-0 mt-0.5" /> : <ChevronDown size={16} className="text-[#AAAAAA] flex-shrink-0 mt-0.5" />}
      </button>
      {open && (
        <p className="text-sm text-[#666666] pb-4 leading-relaxed">{a}</p>
      )}
    </div>
  );
}

// ── Member dashboard view ──────────────────────────────────────────────────────

function MemberView({ me }: { me: VaultClubMe }) {
  const statusColour: Record<string, string> = {
    active: "text-emerald-600 bg-emerald-50 border-emerald-200",
    trialing: "text-blue-600 bg-blue-50 border-blue-200",
    past_due: "text-amber-600 bg-amber-50 border-amber-200",
    grace: "text-orange-600 bg-orange-50 border-orange-200",
    canceled: "text-red-600 bg-red-50 border-red-200",
  };
  const statusLabel: Record<string, string> = {
    active: "Active",
    trialing: "Free Trial",
    past_due: "Payment Due",
    grace: "Grace Period",
    canceled: "Cancelled",
  };

  const portalMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/vault-club/portal", {}),
    onSuccess: (data: any) => {
      if (data?.url) window.location.href = data.url;
    },
  });

  const renewsDate = me.renews_at
    ? new Date(me.renews_at).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
    : null;
  const startedDate = me.started_at
    ? new Date(me.started_at).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
    : null;

  const tierColour: Record<string, string> = {
    bronze: "#CD7F32",
    silver: "#C0C0C0",
    gold: "#D4AF37",
  };
  const colour = me.tier ? tierColour[me.tier] : "#D4AF37";
  const creditPercent = me.ai_credits_monthly > 0
    ? Math.round((me.ai_credits_balance / me.ai_credits_monthly) * 100)
    : 0;

  return (
    <div className="max-w-2xl mx-auto px-4 py-10">
      {/* Welcome header */}
      <div className="flex items-center gap-3 mb-6">
        <VaultClubBadge tier={me.tier} size="lg" />
        <div>
          <h1
            className="text-2xl font-black text-[#1A1A1A]"
           
          >
            {me.label || "Vault Club"}
          </h1>
          {me.status && (
            <span className={`inline-block mt-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${statusColour[me.status] || "text-[#999999]"}`}>
              {statusLabel[me.status] || me.status}
            </span>
          )}
        </div>
      </div>

      {/* Subscription card */}
      <div
        className="rounded-2xl p-6 mb-6 border"
        style={{ borderColor: `${colour}40`, background: `${colour}08` }}
      >
        <div className="flex items-start justify-between flex-wrap gap-4 mb-4">
          <div>
            {renewsDate && (
              <p className="text-sm text-[#666666]">
                {me.cancels_at ? "Cancels on" : "Renews on"}: <strong className="text-[#1A1A1A]">{renewsDate}</strong>
              </p>
            )}
            <p className="text-xs text-[#AAAAAA] mt-0.5">
              {me.billing_interval === "year" ? "Annual plan" : "Monthly plan"}
            </p>
          </div>
          <button
            onClick={() => portalMutation.mutate()}
            disabled={portalMutation.isPending}
            className="flex items-center gap-2 px-4 py-2 rounded-xl border border-[#E8E4DC] bg-white text-sm font-semibold text-[#444444] hover:border-[#D4AF37]/40 transition-colors disabled:opacity-60"
          >
            {portalMutation.isPending ? <Loader2 size={13} className="animate-spin" /> : <CreditCard size={13} />}
            Manage Subscription
          </button>
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-3 mb-6">
        {/* AI credits */}
        <div className="bg-white border border-[#E8E4DC] rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <Zap size={14} className="text-[#D4AF37]" />
            <span className="text-[10px] font-bold uppercase tracking-wider text-[#888888]">AI Credits</span>
          </div>
          <p className="text-xl font-black text-[#1A1A1A]">{me.ai_credits_balance}</p>
          <p className="text-xs text-[#AAAAAA]">of {me.ai_credits_monthly}/month</p>
          <div className="mt-2 h-1.5 bg-[#F0EDE6] rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${creditPercent}%`, background: "linear-gradient(90deg,#B8960C,#D4AF37)" }}
            />
          </div>
        </div>

        {/* Reholder credits */}
        <div className="bg-white border border-[#E8E4DC] rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <Award size={14} className="text-[#D4AF37]" />
            <span className="text-[10px] font-bold uppercase tracking-wider text-[#888888]">Reholder Credits</span>
          </div>
          <p className="text-xl font-black text-[#1A1A1A]">{me.reholder_credits_remaining}</p>
          <p className="text-xs text-[#AAAAAA]">quarterly</p>
        </div>

        {/* Free shipping perk */}
        <div className="bg-white border border-[#E8E4DC] rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <TrendingDown size={14} className="text-[#D4AF37]" />
            <span className="text-[10px] font-bold uppercase tracking-wider text-[#888888]">Return Shipping</span>
          </div>
          <p className="text-xl font-black text-[#1A1A1A]">Free</p>
          <p className="text-[10px] text-[#AAAAAA]">insured, UK, every submission</p>
        </div>

        {/* Member since */}
        <div className="bg-white border border-[#E8E4DC] rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <Star size={14} className="text-[#D4AF37]" />
            <span className="text-[10px] font-bold uppercase tracking-wider text-[#888888]">Member Since</span>
          </div>
          <p className="text-sm font-bold text-[#1A1A1A]">{startedDate || "—"}</p>
        </div>
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-1 gap-2 mb-8">
        {me.username && (
          <Link href={`/showroom/${me.username}`}>
            <button className="w-full py-3 rounded-xl border border-[#E8E4DC] bg-white text-sm font-semibold text-[#444444] hover:border-[#D4AF37]/40 text-left px-4 transition-colors">
              View My Showroom → <span className="text-[#AAAAAA]">mintvaultuk.com/showroom/{me.username}</span>
            </button>
          </Link>
        )}
        <Link href="/submit">
          <button
            className="w-full py-3 rounded-xl text-sm font-bold text-[#1A1400] transition-all active:scale-95"
            style={{ background: "linear-gradient(135deg,#B8960C,#D4AF37)" }}
          >
            Submit cards (free return shipping) →
          </button>
        </Link>
        <Link href="/tools/estimate">
          <button className="w-full py-3 rounded-xl border border-[#E8E4DC] bg-white text-sm font-semibold text-[#444444] hover:border-[#D4AF37]/40 transition-colors">
            AI Pre-Grade Checker — {me.ai_credits_balance} credits remaining
          </button>
        </Link>
      </div>

      {/* Members news */}
      <div className="bg-white border border-[#D4AF37]/20 rounded-xl p-5">
        <h2 className="text-sm font-bold text-[#D4AF37] uppercase tracking-widest mb-3">What's New for Members</h2>
        <div className="border border-dashed border-[#E8E4DC] rounded-lg p-4 text-center">
          <p className="text-sm text-[#999999]">More members-only features coming soon.</p>
          <p className="text-xs text-[#AAAAAA] mt-1">Early access, exclusive tools, and collector events.</p>
        </div>
      </div>
    </div>
  );
}

// ── Marketing view ─────────────────────────────────────────────────────────────

function MarketingView() {
  const [interval, setInterval] = useState<"month" | "year">("month");
  const [pendingTier, setPendingTier] = useState<string | null>(null);
  const [, navigate] = useLocation();

  const checkoutMutation = useMutation({
    mutationFn: ({ tier, interval: inv }: { tier: string; interval: string }) =>
      apiRequest("POST", "/api/vault-club/checkout", { tier, interval: inv }),
    onSuccess: (data: any) => {
      if (data?.url) window.location.href = data.url;
    },
    onError: (err: any) => {
      // If auth required, redirect to login
      if (err?.status === 401) navigate("/login?next=/club");
      setPendingTier(null);
    },
  });

  function handleSubscribe(tier: string, inv: string) {
    setPendingTier(tier);
    checkoutMutation.mutate({ tier, interval: inv });
  }

  return (
    <div className="bg-[#FAFAF8]">
      <SeoHead
        title="Vault Club | MintVault UK"
        description="Join Vault Club — Silver membership gives serious collectors free insured return shipping, free monthly Authentication credits, queue-jump, AI Pre-Grade credits, and a verified badge on every certificate."
        canonical="https://mintvaultuk.com/club"
      />

      {/* Hero */}
      <div
        className="relative overflow-hidden"
        style={{ background: "linear-gradient(135deg,#0A0A0A 0%,#1A1200 100%)" }}
      >
        <div className="absolute inset-0 pointer-events-none" style={{ background: "radial-gradient(ellipse 70% 60% at 50% 0%, rgba(212,175,55,0.12) 0%, transparent 70%)" }} />
        <div className="relative max-w-3xl mx-auto px-4 py-20 text-center">
          <div className="inline-flex items-center gap-1.5 bg-[#D4AF37]/10 border border-[#D4AF37]/30 rounded-full px-3 py-1 mb-5">
            <Shield size={11} className="text-[#D4AF37]" />
            <span className="text-[10px] font-black uppercase tracking-widest text-[#D4AF37]">Exclusive Membership</span>
          </div>
          <h1
            className="text-5xl md:text-6xl font-black mb-5"
            style={{ color: "#D4AF37" }}
          >
            Vault Club
          </h1>
          <p className="text-[#B8A060] text-base max-w-xl mx-auto">
            Exclusive perks for serious collectors. Free return shipping, free monthly Authentication credits, queue-jump, AI Pre-Grade credits, and your own Showroom.
          </p>
        </div>
      </div>

      {/* Tier cards */}
      <div className="max-w-5xl mx-auto px-4 py-14">
        <IntervalToggle interval={interval} onChange={setInterval} />

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-16">
          {TIERS.map((t) => (
            <TierCard
              key={t.key}
              tier={t}
              interval={interval}
              onSubscribe={handleSubscribe}
              isPending={checkoutMutation.isPending && pendingTier === t.key}
            />
          ))}
        </div>

        {/* Why section */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-16">
          {[
            { icon: <TrendingDown size={24} className="text-[#D4AF37]" />, title: "Save on every submission", body: "Free insured UK return shipping on every submission, plus two free Authentication add-ons every month." },
            { icon: <Shield size={24} className="text-[#D4AF37]" />, title: "Stand out", body: "A verified Silver badge on your Showroom and certificates tells other collectors you're a serious member of the registry." },
            { icon: <Zap size={24} className="text-[#D4AF37]" />, title: "Get priority", body: "Queue-jump within your grading tier, 100 AI Pre-Grade credits a month, and members-only Vault report design." },
          ].map((item) => (
            <div key={item.title} className="bg-white border border-[#E8E4DC] rounded-xl p-6 text-center shadow-sm">
              <div className="w-12 h-12 rounded-xl bg-[#D4AF37]/10 flex items-center justify-center mx-auto mb-4">
                {item.icon}
              </div>
              <h3 className="font-bold text-[#1A1A1A] mb-2">{item.title}</h3>
              <p className="text-xs text-[#666666] leading-relaxed">{item.body}</p>
            </div>
          ))}
        </div>

        {/* FAQ */}
        <h2
          className="text-2xl font-black text-[#1A1A1A] mb-6 text-center"
         
        >
          Frequently Asked Questions
        </h2>
        <div className="bg-white border border-[#E8E4DC] rounded-2xl px-6 mb-16 shadow-sm">
          {FAQS.map((faq) => (
            <FaqItem key={faq.q} q={faq.q} a={faq.a} />
          ))}
        </div>

        {/* CTA */}
        <div
          className="rounded-2xl p-10 text-center"
          style={{ background: "linear-gradient(135deg,#0A0A0A 0%,#1A1200 100%)" }}
        >
          <h2
            className="text-3xl font-black mb-4"
            style={{ color: "#D4AF37" }}
          >
            Ready to join?
          </h2>
          <p className="text-[#B8A060] text-sm mb-6 max-w-md mx-auto">
            Start with Silver — the most popular choice for serious collectors.
          </p>
          <button
            onClick={() => handleSubscribe("silver", interval)}
            disabled={checkoutMutation.isPending && pendingTier === "silver"}
            className="px-8 py-3.5 rounded-xl font-bold text-[#1A1400] text-sm transition-all active:scale-95 disabled:opacity-60 flex items-center gap-2 mx-auto"
            style={{ background: "linear-gradient(135deg,#B8960C,#D4AF37)" }}
          >
            {checkoutMutation.isPending && pendingTier === "silver" ? <Loader2 size={14} className="animate-spin" /> : null}
            Subscribe to Silver →
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main export ────────────────────────────────────────────────────────────────

export default function ClubPage() {
  const [location] = useLocation();
  const isWelcome = location.includes("welcome=1") || (typeof window !== "undefined" && window.location.search.includes("welcome=1"));

  const { data: me, isLoading } = useQuery<VaultClubMe | null>({
    queryKey: ["/api/vault-club/me"],
    queryFn: async () => {
      const res = await fetch("/api/vault-club/me");
      if (res.status === 401) return null;
      if (!res.ok) return null;
      return res.json();
    },
    retry: false,
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="w-8 h-8 text-[#D4AF37] animate-spin" />
      </div>
    );
  }

  const isMember = me?.tier && me?.status && (me.status === "active" || me.status === "trialing");

  if (isMember) {
    return (
      <>
        <SeoHead
          title="Vault Club | MintVault UK"
          description="Your Vault Club membership dashboard."
          canonical="https://mintvaultuk.com/club"
        />
        {isWelcome && (
          <div
            className="px-4 py-3 text-center text-sm font-semibold"
            style={{ background: "linear-gradient(90deg,#B8960C,#D4AF37)", color: "#1A1400" }}
          >
            Welcome to Vault Club! Your membership is now active.
          </div>
        )}
        <MemberView me={me!} />
      </>
    );
  }

  return <MarketingView />;
}
