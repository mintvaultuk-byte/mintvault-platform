import { useState } from "react";
import { Link } from "wouter";
import { ArrowRight, Loader2 } from "lucide-react";
import HeaderV2 from "@/components/v2/header-v2";
import FooterV2 from "@/components/v2/footer-v2";
import SectionEyebrow from "@/components/v2/section-eyebrow";
import HeroSlabFan, { type SlabContent } from "@/components/v2/hero-slab";
import { insuranceTiers } from "@shared/schema";
import { ADDON_PRICES } from "@shared/addons";
import {
  VAULT_CLUB_PERKS as PERKS,
  VAULT_CLUB_SILVER as SILVER,
  VAULT_CLUB_PENCE_TO_POUNDS as poundsFromPence,
} from "@/config/vault-club-perks";

// Derived display values (all numbers traceable to shared/ config or SILVER above)
const AUTH_PRICE_PENCE = ADDON_PRICES.authentication.price; // 1500
const MONTHLY_AUTH_VALUE_PENCE = AUTH_PRICE_PENCE * SILVER.free_authentication_monthly; // 3000
const SHIPPING_STANDARD = insuranceTiers[0].shippingPence; // 499
const SHIPPING_ENHANCED = insuranceTiers[1].shippingPence; // 999
const ANNUAL_SAVINGS_PENCE = SILVER.monthly_price_pence * 12 - SILVER.annual_price_pence; // 2088

// Math-table scenarios — narrative card counts are hand-picked; all monetary
// values compute from config so the page stays truthful if config drifts.
const SCENARIOS = [
  {
    cards: "1 card",
    authCount: "1",
    authValuePence: AUTH_PRICE_PENCE,
    shippingPence: SHIPPING_STANDARD,
    shippingLabel: "Standard",
  },
  {
    cards: "3 cards",
    authCount: `${SILVER.free_authentication_monthly} (max)`,
    authValuePence: MONTHLY_AUTH_VALUE_PENCE,
    shippingPence: SHIPPING_STANDARD,
    shippingLabel: "Standard",
  },
  {
    cards: "5 cards",
    authCount: `${SILVER.free_authentication_monthly} (max)`,
    authValuePence: MONTHLY_AUTH_VALUE_PENCE,
    shippingPence: SHIPPING_ENHANCED,
    shippingLabel: "Enhanced",
  },
];

// PERKS list lives in client/src/config/vault-club-perks.ts (extracted Step 4
// so /account/vault-club can render the same list).

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
    q: "Do unused credits roll over?",
    a: "No. Free Authentication add-ons and AI Pre-Grade credits reset every month. Use them within the month or lose them.",
  },
  {
    q: "Can I combine Silver with the bulk discount?",
    a: "No. Your basket applies whichever saves more — Silver perks or the bulk discount — never both stacked.",
  },
  {
    q: "Why is checkout paused right now?",
    a: "We\u2019re finishing the perk-evaluator so every waived fee (shipping, Authentication) applies correctly at checkout. Relaunching soon.",
  },
  {
    q: "What if I don\u2019t submit often?",
    a: "Silver pays for itself at roughly one Authentication per month. If you submit less than that, skip membership and pay per-card — honestly, it\u2019s the better deal.",
  },
];

// ── Page ───────────────────────────────────────────────────────────────────

export default function VaultClubV2() {
  const [isLoading, setIsLoading] = useState<"month" | "year" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleCheckout(interval: "month" | "year") {
    setIsLoading(interval);
    setError(null);
    try {
      const r = await fetch("/api/vault-club/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ interval }),
      });
      if (r.status === 401) {
        window.location.href = `/login?next=${encodeURIComponent("/vault-club")}`;
        return;
      }
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data?.url) {
        setError(data?.message || "Could not start checkout. Please try again.");
        setIsLoading(null);
        return;
      }
      window.location.href = data.url as string;
    } catch {
      setError("Network error. Please try again.");
      setIsLoading(null);
    }
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ backgroundColor: "var(--v2-paper)" }}>
      <HeaderV2 />

      {/* ── SECTION A: HERO ──────────────────────────────────────────── */}
      <section className="relative">
        <div className="mx-auto max-w-7xl px-6 pt-10 pb-20 md:pt-16 md:pb-32 grid grid-cols-1 md:grid-cols-[1.4fr_1fr] gap-12 md:gap-16 items-center">
          {/* Left — copy */}
          <div>
            <p
              className="font-mono-v2 text-[10px] md:text-xs uppercase tracking-[0.25em] mb-6"
              style={{ color: "var(--v2-gold)" }}
            >
              Est. Kent &middot; Vault Club
            </p>
            <h1
              className="font-display italic font-medium leading-[0.95] mb-6"
              style={{ fontSize: "clamp(2.75rem, 6vw, 5rem)", color: "var(--v2-ink)" }}
            >
              For the<br />regular submitter.
            </h1>
            <p
              className="font-body text-base md:text-lg leading-relaxed max-w-xl mb-8"
              style={{ color: "var(--v2-ink-soft)" }}
            >
              Silver is a perks-and-credits membership for collectors who submit regularly.
              Subscriptions are paused while we finish the perk system &mdash; join the
              waitlist and you&rsquo;ll be first when it reopens.
            </p>
            <div className="flex flex-wrap items-center gap-3 mb-5">
              <a
                href="mailto:support@mintvaultuk.com?subject=Vault%20Club%20waitlist"
                className="inline-flex items-center gap-2 font-body text-sm font-semibold no-underline px-6 py-3 rounded-full transition-all hover:scale-[1.03]"
                style={{ backgroundColor: "var(--v2-gold)", color: "var(--v2-panel-dark)" }}
              >
                Notify me when it reopens <ArrowRight size={14} />
              </a>
              <Link
                href="/tools/estimate"
                className="inline-flex items-center gap-2 font-body text-sm font-semibold no-underline px-6 py-3 rounded-full border transition-all hover:scale-[1.03]"
                style={{ borderColor: "var(--v2-line)", color: "var(--v2-ink-soft)" }}
              >
                Try AI Pre-Grade (free) <ArrowRight size={14} />
              </Link>
            </div>
            <p
              className="font-mono-v2 text-[9px] md:text-[10px] uppercase tracking-wider"
              style={{ color: "var(--v2-ink-mute)" }}
            >
              &pound;9.99 / month &middot; 5 perks &middot; Membership paused
            </p>
          </div>

          {/* Right — perk-preview slab fan. Top slab = Authentication (highest
              per-submission value), middle = Return shipping (always-on perk),
              back = AI credits (recurring monthly benefit). */}
          {(() => {
            const slabs: [SlabContent, SlabContent, SlabContent] = [
              {
                topBadge: "AUTHENTICATION",
                mainLabel: "\u00d72 free",
                rightLabel: "/mo",
                footnote: `${poundsFromPence(MONTHLY_AUTH_VALUE_PENCE)} VALUE \u00b7 MONTHLY`,
                key: "auth",
              },
              {
                topBadge: "RETURN SHIPPING",
                mainLabel: "Free",
                rightLabel: "Always",
                footnote: "ALL TIERS INSURED",
                key: "shipping",
              },
              {
                topBadge: "AI CREDITS",
                mainLabel: `\u00d7${SILVER.ai_credits_monthly}`,
                rightLabel: "/mo",
                footnote: "PRE-GRADE UNLIMITED",
                key: "credits",
              },
            ];
            return <HeroSlabFan slabs={slabs} />;
          })()}
        </div>
      </section>

      {/* ── SECTION I: WHY SILVER (dark) ─────────────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-panel-dark)" }}>
        <div className="mx-auto max-w-7xl px-6 py-24 md:py-32">
          <SectionEyebrow numeral="I" label="Why Silver" className="mb-4" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-16 mb-16">
            <h2 className="font-display italic font-medium text-3xl md:text-5xl leading-tight" style={{ color: "#FFFFFF" }}>
              Perks, not<br />
              <span className="font-display italic font-normal" style={{ color: "var(--v2-gold-soft)" }}>percentages.</span>
            </h2>
            <p className="font-body text-sm md:text-base leading-relaxed self-end" style={{ color: "rgba(255,255,255,0.6)" }}>
              A percentage discount scales with the cheapest cards and hurts our margin on
              Express. Perks do the opposite &mdash; they give members tangible, predictable
              value that stays honest on both sides of the transaction.
            </p>
          </div>

          {/* Perks vertical list */}
          <div className="max-w-4xl">
            {PERKS.map((perk, i) => (
              <div
                key={perk.number}
                className="grid grid-cols-[auto_1fr] md:grid-cols-[auto_1fr_auto] gap-6 md:gap-10 py-8 md:py-10"
                style={{ borderTop: i === 0 ? "1px solid rgba(255,255,255,0.1)" : undefined, borderBottom: "1px solid rgba(255,255,255,0.1)" }}
              >
                <p
                  className="font-display italic font-medium leading-none"
                  style={{
                    color: "rgba(212, 175, 55, 0.35)",
                    fontSize: "clamp(2rem, 4vw, 3rem)",
                  }}
                >
                  {perk.number}
                </p>
                <div>
                  <h3 className="font-display italic font-medium text-xl md:text-2xl leading-snug mb-3" style={{ color: "#FFFFFF" }}>
                    {perk.title}
                  </h3>
                  <p className="font-body text-sm md:text-base leading-relaxed max-w-xl" style={{ color: "rgba(255,255,255,0.6)" }}>
                    {perk.body}
                  </p>
                  {perk.value && (
                    <p className="md:hidden font-mono-v2 text-[10px] uppercase tracking-widest mt-3" style={{ color: "var(--v2-gold)" }}>
                      {perk.value}
                    </p>
                  )}
                </div>
                {perk.value && (
                  <p
                    className="hidden md:block font-mono-v2 text-[10px] uppercase tracking-widest self-start text-right whitespace-nowrap"
                    style={{ color: "var(--v2-gold)" }}
                  >
                    {perk.value}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── SECTION II: THE MATH ─────────────────────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-paper)" }}>
        <div className="mx-auto max-w-5xl px-6 py-24 md:py-32">
          <SectionEyebrow numeral="II" label="The Math" className="mb-4" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-16 mb-12">
            <h2 className="font-display italic font-medium text-3xl md:text-5xl leading-tight" style={{ color: "var(--v2-ink)" }}>
              When Silver<br />pays off.
            </h2>
            <p className="font-body text-sm md:text-base leading-relaxed self-end" style={{ color: "var(--v2-ink-soft)" }}>
              Membership is {poundsFromPence(SILVER.monthly_price_pence)}/month. Here&rsquo;s
              what you&rsquo;d save at different submission cadences, assuming Standard grading
              tier with one Authentication add-on per submission.
            </p>
          </div>

          <div className="rounded-xl overflow-x-auto" style={{ border: "1px solid var(--v2-line)" }}>
            <table className="w-full text-left" style={{ minWidth: "640px" }}>
              <thead>
                <tr style={{ backgroundColor: "var(--v2-paper-raised)", borderBottom: "1px solid var(--v2-line)" }}>
                  <th className="font-body text-[10px] uppercase tracking-widest py-3 px-4" style={{ color: "var(--v2-ink-mute)" }}>Submissions / month</th>
                  <th className="font-body text-[10px] uppercase tracking-widest py-3 px-4" style={{ color: "var(--v2-ink-mute)" }}>Authentication</th>
                  <th className="font-body text-[10px] uppercase tracking-widest py-3 px-4" style={{ color: "var(--v2-ink-mute)" }}>Shipping saved</th>
                  <th className="font-body text-[10px] uppercase tracking-widest py-3 px-4" style={{ color: "var(--v2-ink-mute)" }}>Total value</th>
                  <th className="font-body text-[10px] uppercase tracking-widest py-3 px-4" style={{ color: "var(--v2-ink-mute)" }}>Net vs {poundsFromPence(SILVER.monthly_price_pence)}</th>
                </tr>
              </thead>
              <tbody>
                {SCENARIOS.map((s, i) => {
                  const totalPence = s.authValuePence + s.shippingPence;
                  const netPence = totalPence - SILVER.monthly_price_pence;
                  return (
                    <tr key={s.cards} style={{ borderBottom: i < SCENARIOS.length - 1 ? "1px solid var(--v2-line-soft)" : undefined, backgroundColor: "var(--v2-paper-raised)" }}>
                      <td className="font-body text-sm font-semibold py-3 px-4" style={{ color: "var(--v2-ink)" }}>{s.cards}</td>
                      <td className="font-mono-v2 text-sm py-3 px-4" style={{ color: "var(--v2-ink)" }}>
                        {s.authCount} &middot; {poundsFromPence(s.authValuePence)}
                      </td>
                      <td className="font-mono-v2 text-sm py-3 px-4" style={{ color: "var(--v2-ink)" }}>
                        {poundsFromPence(s.shippingPence)}
                        <span className="font-body text-xs ml-1" style={{ color: "var(--v2-ink-mute)" }}>({s.shippingLabel})</span>
                      </td>
                      <td className="font-mono-v2 text-sm py-3 px-4" style={{ color: "var(--v2-ink)" }}>{poundsFromPence(totalPence)}</td>
                      <td className="font-mono-v2 text-sm font-semibold py-3 px-4" style={{ color: "var(--v2-gold)" }}>
                        +{poundsFromPence(netPence)} saved
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="font-body text-xs mt-6" style={{ color: "var(--v2-ink-mute)" }}>
            Based on Standard grading tier. Higher declared values save more on shipping.
            AI Pre-Grade credits excluded &mdash; bonus on top.
          </p>
        </div>
      </section>

      {/* ── SECTION III: MONTHLY VS ANNUAL ───────────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-paper-raised)" }}>
        <div className="mx-auto max-w-4xl px-6 py-24 md:py-32">
          <SectionEyebrow numeral="III" label="Pricing" className="mb-4" />
          <h2 className="font-display italic font-medium text-3xl md:text-5xl leading-tight mb-12" style={{ color: "var(--v2-ink)" }}>
            Monthly or annual.
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {/* Monthly card */}
            <div className="rounded-xl p-8 flex flex-col" style={{ backgroundColor: "var(--v2-paper)", border: "1px solid var(--v2-line)" }}>
              <p className="font-mono-v2 text-[10px] uppercase tracking-widest mb-4" style={{ color: "var(--v2-ink-mute)" }}>
                Monthly
              </p>
              <div className="flex items-baseline gap-2 mb-2">
                <span className="font-numeral font-semibold" style={{ color: "var(--v2-ink)", fontSize: "clamp(48px, 5vw, 64px)", lineHeight: 1 }}>
                  {poundsFromPence(SILVER.monthly_price_pence)}
                </span>
                <span className="font-body text-sm" style={{ color: "var(--v2-ink-mute)" }}>/ month</span>
              </div>
              <p className="font-body text-sm mb-6" style={{ color: "var(--v2-ink-soft)" }}>
                Cancel anytime. Bill renews monthly.
              </p>
              <p className="font-mono-v2 text-[10px] uppercase tracking-widest mb-6" style={{ color: "var(--v2-ink-mute)" }}>
                Good for month-to-month flexibility.
              </p>
              <button
                type="button"
                onClick={() => handleCheckout("month")}
                disabled={isLoading !== null}
                data-testid="vault-club-checkout-month"
                className="mt-auto inline-flex items-center justify-center gap-2 font-body text-sm font-semibold px-6 py-3 rounded-full transition-all hover:scale-[1.03] disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:scale-100"
                style={{ backgroundColor: "var(--v2-gold)", color: "var(--v2-panel-dark)" }}
              >
                {isLoading === "month" ? (
                  <>
                    <Loader2 size={14} className="animate-spin" /> Starting checkout&hellip;
                  </>
                ) : (
                  <>
                    Start 14-day free trial <ArrowRight size={14} />
                  </>
                )}
              </button>
              <p className="font-mono-v2 text-[9px] uppercase tracking-widest text-center mt-3" style={{ color: "var(--v2-ink-mute)" }}>
                Card required &middot; Cancel anytime
              </p>
            </div>

            {/* Annual card */}
            <div className="relative rounded-xl p-8 flex flex-col" style={{ backgroundColor: "var(--v2-paper)", border: "1px solid var(--v2-gold-soft)" }}>
              <span
                className="absolute left-1/2 -translate-x-1/2 font-mono-v2 text-[9px] uppercase tracking-widest px-4 py-1.5 rounded whitespace-nowrap"
                style={{ top: "-14px", backgroundColor: "var(--v2-gold)", color: "var(--v2-panel-dark)" }}
              >
                Save {poundsFromPence(ANNUAL_SAVINGS_PENCE)}
              </span>
              <p className="font-mono-v2 text-[10px] uppercase tracking-widest mb-4" style={{ color: "var(--v2-gold)" }}>
                Annual
              </p>
              <div className="flex items-baseline gap-2 mb-2">
                <span className="font-numeral font-semibold" style={{ color: "var(--v2-ink)", fontSize: "clamp(48px, 5vw, 64px)", lineHeight: 1 }}>
                  {poundsFromPence(SILVER.annual_price_pence)}
                </span>
                <span className="font-body text-sm" style={{ color: "var(--v2-ink-mute)" }}>/ year</span>
              </div>
              <p className="font-body text-sm mb-6" style={{ color: "var(--v2-ink-soft)" }}>
                Equivalent to two months free. Bill renews yearly.
              </p>
              <p className="font-mono-v2 text-[10px] uppercase tracking-widest mb-6" style={{ color: "var(--v2-gold)" }}>
                Best value for regular submitters.
              </p>
              <button
                type="button"
                onClick={() => handleCheckout("year")}
                disabled={isLoading !== null}
                data-testid="vault-club-checkout-year"
                className="mt-auto inline-flex items-center justify-center gap-2 font-body text-sm font-semibold px-6 py-3 rounded-full transition-all hover:scale-[1.03] disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:scale-100"
                style={{ backgroundColor: "var(--v2-gold)", color: "var(--v2-panel-dark)" }}
              >
                {isLoading === "year" ? (
                  <>
                    <Loader2 size={14} className="animate-spin" /> Starting checkout&hellip;
                  </>
                ) : (
                  <>
                    Start 14-day free trial <ArrowRight size={14} />
                  </>
                )}
              </button>
              <p className="font-mono-v2 text-[9px] uppercase tracking-widest text-center mt-3" style={{ color: "var(--v2-gold)" }}>
                Card required &middot; Cancel anytime
              </p>
            </div>
          </div>

          {error && (
            <p
              role="alert"
              data-testid="vault-club-checkout-error"
              className="font-body text-sm text-center mt-8"
              style={{ color: "#B00020" }}
            >
              {error}
            </p>
          )}
        </div>
      </section>

      {/* ── SECTION IV: WHAT SILVER ISN'T ────────────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-paper)" }}>
        <div className="mx-auto max-w-4xl px-6 py-24 md:py-32">
          <SectionEyebrow numeral="IV" label="Honesty" className="mb-4" />
          <h2 className="font-display italic font-medium text-3xl md:text-5xl leading-tight mb-12" style={{ color: "var(--v2-ink)" }}>
            What Silver isn&rsquo;t.
          </h2>

          <div className="space-y-8">
            <div>
              <h3 className="font-display italic font-medium text-xl md:text-2xl leading-snug mb-3" style={{ color: "var(--v2-ink)" }}>
                Not a percentage discount on grading.
              </h3>
              <p className="font-body text-sm md:text-base leading-relaxed" style={{ color: "var(--v2-ink-soft)" }}>
                Perks are flag-based &mdash; specific fees waived (Authentication, return
                shipping), not a blanket percentage off the price per card. Your grading fee
                is the same as a non-member&rsquo;s.
              </p>
            </div>
            <div>
              <h3 className="font-display italic font-medium text-xl md:text-2xl leading-snug mb-3" style={{ color: "var(--v2-ink)" }}>
                Not stackable with the bulk discount.
              </h3>
              <p className="font-body text-sm md:text-base leading-relaxed" style={{ color: "var(--v2-ink-soft)" }}>
                Your basket applies whichever saves more &mdash; Silver perks or the bulk
                discount &mdash; never both combined. Submitting 10 or more cards? The
                basket may use bulk instead. It&rsquo;s always the better of the two.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── SECTION V: FAQ ───────────────────────────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-paper-raised)" }}>
        <div className="mx-auto max-w-4xl px-6 py-24 md:py-32">
          <SectionEyebrow numeral="V" label="FAQ" className="mb-4" />
          <h2 className="font-display italic font-medium text-3xl md:text-5xl leading-tight mb-12" style={{ color: "var(--v2-ink)" }}>
            Silver questions.
          </h2>

          <div className="space-y-10">
            {FAQS.map((item) => (
              <div key={item.q}>
                <h3 className="font-display italic font-medium text-xl md:text-2xl leading-snug mb-3" style={{ color: "var(--v2-ink)" }}>
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
      <section style={{ backgroundColor: "var(--v2-panel-dark)" }}>
        <div className="mx-auto max-w-3xl px-6 py-24 md:py-32 text-center">
          <SectionEyebrow numeral="VI" label="Waitlist" className="mb-4" />
          <h2 className="font-display italic font-medium text-3xl md:text-5xl leading-tight mb-6" style={{ color: "#FFFFFF" }}>
            Ready when we are.
          </h2>
          <p className="font-body text-sm md:text-base mb-10" style={{ color: "rgba(255,255,255,0.5)" }}>
            Subscriptions are paused while we finish the perks system. Join the waitlist &mdash;
            you&rsquo;ll be first when we reopen.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3 mb-6">
            <a
              href="mailto:support@mintvaultuk.com?subject=Vault%20Club%20waitlist"
              className="inline-flex items-center gap-2 font-body text-sm font-semibold no-underline px-7 py-3 rounded-full transition-all hover:scale-[1.03]"
              style={{ backgroundColor: "var(--v2-gold)", color: "var(--v2-panel-dark)" }}
            >
              Email the waitlist <ArrowRight size={14} />
            </a>
            <Link
              href="/tools/estimate"
              className="inline-flex items-center gap-2 font-body text-sm font-semibold no-underline px-7 py-3 rounded-full border transition-all hover:scale-[1.03]"
              style={{ borderColor: "rgba(255,255,255,0.2)", color: "rgba(255,255,255,0.7)" }}
            >
              Try AI Pre-Grade <ArrowRight size={14} />
            </Link>
          </div>
        </div>
      </section>

      <FooterV2 />
    </div>
  );
}
