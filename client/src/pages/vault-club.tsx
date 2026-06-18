import { useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowRight, Loader2 } from "lucide-react";
import GradientButton from "@/components/ui/gradient-button";
import HeaderV2 from "@/components/v2/header-v2";
import FooterV2 from "@/components/v2/footer-v2";
import SectionEyebrow from "@/components/v2/section-eyebrow";
import { apiRequest } from "@/lib/queryClient";
import { VAULT_CLUB_SILVER_DISCOUNT_PERCENT } from "@shared/schema";

// Silver Vault Club perk values — mirrors server/vault-club-tiers.ts Silver
// config. v1 active perks (all enforced in code): grading discount, AI credits,
// public Showroom, Silver badge. See bf16063 + 1e95c9d for the truth-up.
const SILVER = {
  monthly_price_pence: 999,
  annual_price_pence: 9900,
  ai_credits_monthly: 50,
  grading_discount_percent: VAULT_CLUB_SILVER_DISCOUNT_PERCENT, // 10
} as const;

const poundsFromPence = (p: number) => `£${(p / 100).toFixed(p % 100 === 0 ? 0 : 2)}`;

const ANNUAL_SAVINGS_PENCE = SILVER.monthly_price_pence * 12 - SILVER.annual_price_pence; // 2088

// ── Perks list data (Section I) ────────────────────────────────────────────

const PERKS = [
  {
    number: "01",
    title: `${SILVER.grading_discount_percent}% off every grading submission`,
    body: "Applied automatically at checkout on the per-card grading fee. Stacks with bulk discounts via max-of-the-two — Silver wins up to 49 cards, bulk wins at 50+.",
    value: `${SILVER.grading_discount_percent}% per card`,
  },
  {
    number: "02",
    title: `${SILVER.ai_credits_monthly} AI Pre-Grade credits every month`,
    body: "Test cards before submitting — single-photo subgrade estimate with confidence labels. Credits reset monthly, no rollover.",
    value: `${SILVER.ai_credits_monthly}/mo`,
  },
  {
    number: "03",
    title: "Public Showroom for your collection",
    body: "Personal page at mintvaultuk.com/showroom/[your-name]. Your verified slabs displayed publicly; activates on your first Silver billing cycle.",
    value: "Personal URL",
  },
  {
    number: "04",
    title: "Silver Vault badge on every cert",
    body: "Member badge surfaces on your dashboard, your Showroom, and the public cert pages of slabs you own. Visible across the registry.",
    value: "Across the registry",
  },
];

// ── FAQ (Section V) ────────────────────────────────────────────────────────

const FAQS = [
  {
    q: "Why no Gold or Bronze tier?",
    a: "We launched Silver-only to learn what collectors actually use. Bronze and Gold return once the data supports them.",
  },
  {
    q: "Can I cancel anytime?",
    a: "Yes. Monthly plans cancel from the next billing cycle. Annual plans run to the end of the paid term — no partial refunds, but you keep every perk until it ends.",
  },
  {
    q: "Do unused AI credits roll over?",
    a: "No. AI Pre-Grade credits reset every month. Use them within the month or lose them.",
  },
  {
    q: "How does Silver stack with bulk discounts?",
    // bulk figures: keep in sync with bulkDiscountTiers (shared/schema.ts)
    a: "We apply whichever saves you more, never both. Silver's 10% wins on smaller orders; the bulk discount (5/7.5/10% at 10/25/50+ cards) overtakes Silver at 50+ cards. Tied at 25 cards, Silver wins.",
  },
  {
    q: "What if I don't submit often?",
    a: "Silver pays off at roughly 4 cards per month at Standard (£25). The 10% discount alone returns £2.50 per card; AI credits and Showroom are bonus on top. If you submit less than that, skip membership and pay per-card — honestly, it's the better deal.",
  },
];

// ── Page ───────────────────────────────────────────────────────────────────

export default function VaultClubV2() {
  const checkoutMutation = useMutation({
    mutationFn: async ({ interval }: { interval: "month" | "year" }) => {
      const res = await apiRequest("POST", "/api/vault-club/checkout", { tier: "silver", interval });
      return res.json();
    },
    onSuccess: (data: any) => {
      if (data?.url) {
        window.location.href = data.url;
      } else {
        alert("Checkout returned no redirect URL. Please try again.");
      }
    },
    onError: (err: any) => {
      const msg = err?.message || "";
      if (err?.status === 401 || /unauthor/i.test(msg)) {
        window.location.href = "/customer-login?return=/vault-club";
      } else {
        alert(msg || "Checkout failed. Please try again.");
      }
    },
  });

  return (
    <div className="min-h-screen flex flex-col vault-page">
      <HeaderV2 />

      {/* ── SECTION A: HERO ──────────────────────────────────────────── */}
      <section
        className="relative"
        style={{
          backgroundImage:
            "linear-gradient(180deg, rgba(20,15,10,0.55) 0%, rgba(20,15,10,0.35) 40%, rgba(20,15,10,0.75) 100%), url('/images/vault-club-lounge.webp')",
          backgroundSize: "cover",
          backgroundPosition: "center",
        }}
      >
        <div className="mx-auto max-w-3xl px-6 pt-10 pb-20 md:pt-16 md:pb-32 text-center">
          <p
            className="font-mono-v2 text-sm md:text-base font-semibold uppercase tracking-[0.25em] no-text-shadow mb-6"
            style={{ color: "#D4AF37" }}
          >
            Est. Kent &middot; Vault Club
          </p>
          <h1
            className="font-display italic font-medium leading-[0.95] mb-6"
            style={{ fontSize: "clamp(2.75rem, 6vw, 5rem)", color: "var(--v2-ink)" }}
          >
            For the
            <br />
            regular submitter.
          </h1>
          <p
            className="font-body text-base md:text-lg leading-relaxed max-w-xl mx-auto mb-8"
            style={{ color: "var(--v2-ink-soft)" }}
          >
            Silver is a paid membership for collectors who submit regularly. {SILVER.grading_discount_percent}% off
            every grading fee, {SILVER.ai_credits_monthly} AI Pre-Grade credits every month, your own public Showroom,
            and a member badge across the registry.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3 mb-5">
            <GradientButton
              as="button"
              type="button"
              onClick={() => checkoutMutation.mutate({ interval: "month" })}
              disabled={checkoutMutation.isPending}
              className="gradient-btn-filled"
            >
              {checkoutMutation.isPending ? (
                <>
                  <Loader2 size={14} className="animate-spin" /> Loading…
                </>
              ) : (
                <>
                  Subscribe — {poundsFromPence(SILVER.monthly_price_pence)}/mo <ArrowRight size={14} />
                </>
              )}
            </GradientButton>
            <Link href="/tools/estimate" className="no-underline">
              <GradientButton className="gradient-btn-filled">
                Try AI Pre-Grade (free) <ArrowRight size={14} />
              </GradientButton>
            </Link>
          </div>
          <p
            className="font-mono-v2 text-xs md:text-sm uppercase tracking-wider"
            style={{ color: "var(--v2-ink-mute)" }}
          >
            {poundsFromPence(SILVER.monthly_price_pence)} / month &middot; {poundsFromPence(SILVER.annual_price_pence)}{" "}
            / year &middot; Available now
          </p>
        </div>
      </section>

      {/* ── SECTION I: WHY SILVER (dark) ─────────────────────────────── */}
      <section className="frost-panel-dark">
        <div className="mx-auto max-w-7xl px-6 py-24 md:py-32">
          <SectionEyebrow numeral="I" label="Why Silver" className="mb-4" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-16 mb-16">
            <h2
              className="font-display italic font-medium text-3xl md:text-5xl leading-tight"
              style={{ color: "#FFFFFF" }}
            >
              Four perks.
              <br />
              <span className="font-display italic font-normal" style={{ color: "var(--v2-gold)" }}>
                All enforced.
              </span>
            </h2>
            <p className="font-body text-sm md:text-base leading-relaxed self-end" style={{ color: "#ffffff" }}>
              Every Silver perk is wired into code &mdash; the discount applies at checkout, the credits land in your
              account, the Showroom activates on first billing, the badge renders on your certs. Nothing promised that
              we don&rsquo;t deliver.
            </p>
          </div>

          {/* Perks vertical list */}
          <div className="max-w-4xl">
            {PERKS.map((perk, i) => (
              <div
                key={perk.number}
                className="grid grid-cols-[auto_1fr] md:grid-cols-[auto_1fr_auto] gap-6 md:gap-10 py-8 md:py-10"
                style={{
                  borderTop: i === 0 ? "1px solid rgba(255,255,255,0.1)" : undefined,
                  borderBottom: "1px solid rgba(255,255,255,0.1)",
                }}
              >
                <p
                  className="font-display italic font-medium leading-none"
                  style={{
                    color: "var(--v2-gold)",
                    fontSize: "clamp(2rem, 4vw, 3rem)",
                  }}
                >
                  {perk.number}
                </p>
                <div>
                  <h3
                    className="font-display italic font-medium text-xl md:text-2xl leading-snug mb-3"
                    style={{ color: "#FFFFFF" }}
                  >
                    {perk.title}
                  </h3>
                  <p className="font-body text-sm md:text-base leading-relaxed max-w-xl" style={{ color: "#ffffff" }}>
                    {perk.body}
                  </p>
                  {perk.value && (
                    <p
                      className="md:hidden font-mono-v2 text-xs md:text-sm uppercase tracking-widest mt-3"
                      style={{ color: "#ffffff" }}
                    >
                      {perk.value}
                    </p>
                  )}
                </div>
                {perk.value && (
                  <p
                    className="hidden md:block font-mono-v2 text-xs md:text-sm uppercase tracking-widest self-start text-right whitespace-nowrap"
                    style={{ color: "#ffffff" }}
                  >
                    {perk.value}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── SECTION II: WHEN IT PAYS OFF ─────────────────────────────── */}
      <section className="frost-paper">
        <div className="mx-auto max-w-4xl px-6 py-24 md:py-32">
          <SectionEyebrow numeral="II" label="When it pays off" className="mb-4" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-16">
            <h2
              className="font-display italic font-medium text-3xl md:text-5xl leading-tight"
              style={{ color: "var(--v2-ink)" }}
            >
              Roughly four cards a month.
            </h2>
            <p
              className="font-body text-sm md:text-base leading-relaxed self-end"
              style={{ color: "var(--v2-ink-soft)" }}
            >
              Membership is {poundsFromPence(SILVER.monthly_price_pence)}/month. At Standard grading (£25/card), the{" "}
              {SILVER.grading_discount_percent}% discount alone returns £2.50 per card &mdash; four cards covers the
              membership. AI Pre-Grade credits, Showroom, and the badge are bonus on top. Submit fewer than that and
              you&rsquo;re better off paying per-card.
            </p>
          </div>
        </div>
      </section>

      {/* ── SECTION III: MONTHLY VS ANNUAL ───────────────────────────── */}
      <section className="frost-paper-raised">
        <div className="mx-auto max-w-4xl px-6 py-24 md:py-32">
          <SectionEyebrow numeral="III" label="Pricing" className="mb-4" />
          <h2
            className="font-display italic font-medium text-3xl md:text-5xl leading-tight mb-12"
            style={{ color: "var(--v2-ink)" }}
          >
            Monthly or annual.
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {/* Monthly card */}
            <div
              className="rounded-xl p-8 flex flex-col"
              style={{ backgroundColor: "var(--v2-paper)", border: "1px solid var(--v2-line)" }}
            >
              <p
                className="font-mono-v2 text-[10px] uppercase tracking-widest mb-4"
                style={{ color: "var(--v2-ink-mute)" }}
              >
                Monthly
              </p>
              <div className="flex items-baseline gap-2 mb-2">
                <span
                  className="font-numeral font-semibold"
                  style={{ color: "var(--v2-ink)", fontSize: "clamp(48px, 5vw, 64px)", lineHeight: 1 }}
                >
                  {poundsFromPence(SILVER.monthly_price_pence)}
                </span>
                <span className="font-body text-sm" style={{ color: "var(--v2-ink-mute)" }}>
                  / month
                </span>
              </div>
              <p className="font-body text-sm mb-6" style={{ color: "var(--v2-ink-soft)" }}>
                Cancel anytime. Bill renews monthly.
              </p>
              <button
                type="button"
                onClick={() => checkoutMutation.mutate({ interval: "month" })}
                disabled={checkoutMutation.isPending}
                className="inline-flex items-center justify-center gap-2 font-body text-sm font-semibold no-underline px-5 py-3 rounded-full transition-all hover:scale-[1.03] disabled:opacity-60 mb-4"
                style={{ backgroundColor: "var(--v2-ink)", color: "var(--v2-paper)" }}
              >
                {checkoutMutation.isPending ? (
                  <>
                    <Loader2 size={14} className="animate-spin" /> Loading…
                  </>
                ) : (
                  <>
                    Subscribe monthly <ArrowRight size={14} />
                  </>
                )}
              </button>
              <p
                className="font-mono-v2 text-[10px] uppercase tracking-widest mt-auto"
                style={{ color: "var(--v2-ink-mute)" }}
              >
                Good for month-to-month flexibility.
              </p>
            </div>

            {/* Annual card */}
            <div
              className="relative rounded-xl p-8 flex flex-col"
              style={{ backgroundColor: "var(--v2-paper)", border: "1px solid var(--v2-gold-soft)" }}
            >
              <span
                className="absolute left-1/2 -translate-x-1/2 font-mono-v2 text-[9px] uppercase tracking-widest px-4 py-1.5 rounded whitespace-nowrap"
                style={{ top: "-14px", backgroundColor: "var(--v2-gold)", color: "var(--v2-panel-dark)" }}
              >
                Save {poundsFromPence(ANNUAL_SAVINGS_PENCE)}
              </span>
              <p
                className="font-mono-v2 text-[10px] uppercase tracking-widest mb-4"
                style={{ color: "var(--v2-gold)" }}
              >
                Annual
              </p>
              <div className="flex items-baseline gap-2 mb-2">
                <span
                  className="font-numeral font-semibold"
                  style={{ color: "var(--v2-ink)", fontSize: "clamp(48px, 5vw, 64px)", lineHeight: 1 }}
                >
                  {poundsFromPence(SILVER.annual_price_pence)}
                </span>
                <span className="font-body text-sm" style={{ color: "var(--v2-ink-mute)" }}>
                  / year
                </span>
              </div>
              <p className="font-body text-sm mb-6" style={{ color: "var(--v2-ink-soft)" }}>
                Equivalent to two months free. Bill renews yearly.
              </p>
              <GradientButton
                as="button"
                type="button"
                onClick={() => checkoutMutation.mutate({ interval: "year" })}
                disabled={checkoutMutation.isPending}
                className="gradient-btn-filled mb-4 w-full"
              >
                {checkoutMutation.isPending ? (
                  <>
                    <Loader2 size={14} className="animate-spin" /> Loading…
                  </>
                ) : (
                  <>
                    Subscribe annual <ArrowRight size={14} />
                  </>
                )}
              </GradientButton>
              <p
                className="font-mono-v2 text-[10px] uppercase tracking-widest mt-auto"
                style={{ color: "var(--v2-gold)" }}
              >
                Best value for regular submitters.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── SECTION IV: WHAT SILVER ISN'T ────────────────────────────── */}
      <section className="frost-paper">
        <div className="mx-auto max-w-4xl px-6 py-24 md:py-32">
          <SectionEyebrow numeral="IV" label="Honesty" className="mb-4" />
          <h2
            className="font-display italic font-medium text-3xl md:text-5xl leading-tight mb-12"
            style={{ color: "var(--v2-ink)" }}
          >
            What Silver isn&rsquo;t.
          </h2>

          <div className="space-y-8">
            <div>
              <h3
                className="font-display italic font-medium text-xl md:text-2xl leading-snug mb-3"
                style={{ color: "var(--v2-ink)" }}
              >
                Not stacked with bulk discounts.
              </h3>
              <p className="font-body text-sm md:text-base leading-relaxed" style={{ color: "var(--v2-ink-soft)" }}>
                The basket applies whichever saves you more, never both. Silver&rsquo;s{" "}
                {SILVER.grading_discount_percent}% wins up to 49 cards per submission. The bulk discount overtakes
                Silver at 50+ cards (10% bracket). Either way, you get the better number.
              </p>
            </div>
            <div>
              <h3
                className="font-display italic font-medium text-xl md:text-2xl leading-snug mb-3"
                style={{ color: "var(--v2-ink)" }}
              >
                Not free shipping or free authentication.
              </h3>
              <p className="font-body text-sm md:text-base leading-relaxed" style={{ color: "var(--v2-ink-soft)" }}>
                Earlier drafts of Silver promised free return shipping and free Authentication add-ons. We didn&rsquo;t
                ship those for v1, so we stripped them rather than overclaim. They may return as paid perks later if
                there&rsquo;s demand.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── SECTION V: FAQ ───────────────────────────────────────────── */}
      <section className="frost-paper-raised">
        <div className="mx-auto max-w-4xl px-6 py-24 md:py-32">
          <SectionEyebrow numeral="V" label="FAQ" className="mb-4" />
          <h2
            className="font-display italic font-medium text-3xl md:text-5xl leading-tight mb-12"
            style={{ color: "var(--v2-ink)" }}
          >
            Silver questions.
          </h2>

          <div className="space-y-10">
            {FAQS.map((item) => (
              <div key={item.q}>
                <h3
                  className="font-display italic font-medium text-xl md:text-2xl leading-snug mb-3"
                  style={{ color: "var(--v2-ink)" }}
                >
                  {item.q}
                </h3>
                <p className="font-body text-sm md:text-base leading-relaxed" style={{ color: "var(--v2-ink-soft)" }}>
                  {item.a}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── SECTION VI: FINAL CTA (dark) ─────────────────────────────── */}
      <section className="frost-panel-dark">
        <div className="mx-auto max-w-3xl px-6 py-24 md:py-32 text-center">
          <SectionEyebrow numeral="VI" label="Subscribe" className="mb-4" />
          <h2
            className="font-display italic font-medium text-3xl md:text-5xl leading-tight mb-6"
            style={{ color: "#FFFFFF" }}
          >
            Ready when you are.
          </h2>
          <p className="font-body text-sm md:text-base mb-10" style={{ color: "#ffffff" }}>
            {poundsFromPence(SILVER.monthly_price_pence)}/month or {poundsFromPence(SILVER.annual_price_pence)}/year.
            Cancel anytime.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3 mb-6">
            <GradientButton
              as="button"
              type="button"
              onClick={() => checkoutMutation.mutate({ interval: "month" })}
              disabled={checkoutMutation.isPending}
              className="gradient-btn-filled"
            >
              {checkoutMutation.isPending ? (
                <>
                  <Loader2 size={14} className="animate-spin" /> Loading…
                </>
              ) : (
                <>
                  Subscribe monthly <ArrowRight size={14} />
                </>
              )}
            </GradientButton>
            <GradientButton
              as="button"
              type="button"
              onClick={() => checkoutMutation.mutate({ interval: "year" })}
              disabled={checkoutMutation.isPending}
              className="gradient-btn-filled"
            >
              {checkoutMutation.isPending ? (
                <>
                  <Loader2 size={14} className="animate-spin" /> Loading…
                </>
              ) : (
                <>
                  Subscribe annual <ArrowRight size={14} />
                </>
              )}
            </GradientButton>
          </div>
        </div>
      </section>

      <FooterV2 />
    </div>
  );
}
