import { useEffect, useRef } from "react";
import { Link } from "wouter";
import { ArrowRight, Check } from "lucide-react";
import HeaderV2 from "@/components/v2/header-v2";
import FooterV2 from "@/components/v2/footer-v2";
import SectionEyebrow from "@/components/v2/section-eyebrow";
import HeroSlabFan, { type SlabContent } from "@/components/v2/hero-slab";
import AmbientLayer from "@/components/v2/ambient-layer";
import DarkSectionGlow from "@/components/v2/dark-section-glow";
import {
  pricingTiers,
  insuranceTiers,
  insuranceSurchargeBands,
} from "@shared/schema";
import { ADDON_PRICES, ADDON_ORDER } from "@shared/addons";

// Silver Vault Club perk values — mirrors server/vault-club-tiers.ts Silver
// config (verified 2026-04-19 after merge a8e5f8d). Hardcoded here because
// VAULT_CLUB_TIERS lives under server/ and has no shared import path.
// If Silver's perks shift, update both this file and server/vault-club-tiers.ts.
const SILVER = {
  label: "Silver Vault",
  monthly_price_pence: 999,
  annual_price_pence: 9900,
  ai_credits_monthly: 100,
  free_authentication_monthly: 2,
} as const;

// Display descriptors derived from config — keep all copy/marketing text in
// this file so pricing-v2 stays self-contained while numbers stay bound to
// shared config. Tier display order: VAULT_QUEUE → STANDARD (featured) → EXPRESS.

const TIER_DISPLAY: Record<string, { shortName: string; blurb: string; featured: boolean }> = {
  standard: { // schema id "standard" = Vault Queue
    shortName: "Vault Queue",
    blurb: "No rush. Full grade, NFC chip, registry listing — at the best price per card.",
    featured: false,
  },
  priority: { // schema id "priority" = Standard
    shortName: "Standard",
    blurb: "The balanced option: fair turnaround, full report, priority you can feel.",
    featured: true,
  },
  express: {
    shortName: "Express",
    blurb: "Back in under a week. For grails, auction deadlines, and holiday hand-offs.",
    featured: false,
  },
};

// Format helpers
const poundsFromPence = (p: number) => `£${(p / 100).toFixed(p % 100 === 0 ? 0 : 2)}`;
const gbp = (n: number) => `£${n.toLocaleString("en-GB")}`;
export default function PricingV2() {
  // FAQ left-edge gold accent fade-in (Section VII).
  // Single IntersectionObserver shared by all FAQ items; each fades once
  // on first intersection then unobserves, no re-trigger on scroll back.
  const faqRefs = useRef<(HTMLDivElement | null)[]>([]);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.3 }
    );
    faqRefs.current.forEach((el) => el && observer.observe(el));
    return () => observer.disconnect();
  }, []);

  return (
    <div className="min-h-screen flex flex-col relative" style={{ backgroundColor: "var(--v2-paper)" }}>
      <AmbientLayer />
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
              Est. Kent &middot; Pricing
            </p>
            <h1
              className="font-display italic font-medium leading-[0.95] mb-6"
              style={{ fontSize: "clamp(2.75rem, 6vw, 5rem)", color: "var(--v2-ink)" }}
            >
              Grade it once.<br />Get it right.
            </h1>
            <p
              className="font-body text-base md:text-lg leading-relaxed max-w-xl mb-8"
              style={{ color: "var(--v2-ink-soft)" }}
            >
              Three tiers, 5 to 40 working day turnaround, same four-point inspection on every
              card. Black Label upgrade when your card earns it &mdash; free, never sold.
            </p>
            <div className="flex flex-wrap items-center gap-3 mb-5">
              <Link
                href="/submit"
                className="inline-flex items-center gap-2 font-body text-sm font-semibold no-underline px-6 py-3 rounded-full transition-all hover:scale-[1.03]"
                style={{ backgroundColor: "var(--v2-ink)", color: "var(--v2-paper)" }}
              >
                Submit a card <ArrowRight size={14} />
              </Link>
              <Link
                href="/tools/estimate"
                className="inline-flex items-center gap-2 font-body text-sm font-semibold no-underline px-6 py-3 rounded-full border transition-all hover:scale-[1.03]"
                style={{ borderColor: "var(--v2-line)", color: "var(--v2-ink-soft)" }}
              >
                Try AI Pre-Grade <ArrowRight size={14} />
              </Link>
            </div>
            <p
              className="font-mono-v2 text-[9px] md:text-[10px] uppercase tracking-wider"
              style={{ color: "var(--v2-ink-mute)" }}
            >
              From &pound;19 &middot; 3 tiers &middot; Free Black Label upgrade
            </p>
          </div>

          {/* Right — tier slab fan. Mirrors home-v2 visually; content swaps
              cert data for locked tier pricing. Slot 0 (top z) = Standard
              (featured), slot 1 = Vault Queue, slot 2 = Express. */}
          {(() => {
            const tierSlabs: [SlabContent, SlabContent, SlabContent] = [
              {
                topBadge: "STANDARD",
                mainLabel: "\u00a325",
                rightLabel: "15 DAY",
                footnote: "MOST CHOSEN",
                key: "standard",
              },
              {
                topBadge: "VAULT QUEUE",
                mainLabel: "\u00a319",
                rightLabel: "40 DAY",
                footnote: "BEST VALUE",
                key: "vault-queue",
              },
              {
                topBadge: "EXPRESS",
                mainLabel: "\u00a345",
                rightLabel: "5 DAY",
                footnote: "FASTEST",
                key: "express",
              },
            ];
            return <HeroSlabFan slabs={tierSlabs} />;
          })()}
        </div>
      </section>

      {/* ── SECTION I: GRADING TIERS (dark) ──────────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-panel-dark)", position: "relative", overflow: "hidden" }}>
        <DarkSectionGlow />
        <div className="mx-auto max-w-7xl px-6 py-24 md:py-32" style={{ position: "relative", zIndex: 1 }}>
          <SectionEyebrow numeral="I" label="Grading Tiers" className="mb-4" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-16 mb-14">
            <h2 className="font-display italic font-medium text-3xl md:text-5xl leading-tight" style={{ color: "#FFFFFF" }}>
              Three tiers.<br />
              <span className="font-display italic font-normal" style={{ color: "var(--v2-gold-soft)" }}>One standard.</span>
            </h2>
            <p className="font-body text-sm md:text-base leading-relaxed self-end" style={{ color: "rgba(255,255,255,0.6)" }}>
              Every card passes the same four-point inspection: centering, corners, edges,
              surface. Tier only changes how quickly the work comes back.
            </p>
          </div>

          {/* Tier cards */}
          <div className="flex justify-center">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5 md:gap-6 w-full" style={{ maxWidth: "1080px" }}>
              {pricingTiers.map((tier) => {
                const d = TIER_DISPLAY[tier.id] ?? { shortName: tier.name, blurb: "", featured: false };
                const priceDisplay = (tier.pricePerCard / 100).toFixed(0);
                const days = tier.turnaroundDays ?? 0;
                return (
                  <div
                    key={tier.id}
                    className="tier-card-v2 relative rounded-xl flex flex-col"
                    style={{
                      padding: "48px 40px",
                      backgroundColor: "transparent",
                      border: d.featured
                        ? "1px solid rgba(212, 175, 55, 0.6)"
                        : "1px solid rgba(212, 175, 55, 0.25)",
                    }}
                  >
                    {d.featured && (
                      <span
                        className="absolute left-1/2 -translate-x-1/2 font-mono-v2 text-[9px] uppercase tracking-widest px-4 py-1.5 rounded"
                        style={{ top: "-14px", backgroundColor: "var(--v2-gold)", color: "var(--v2-panel-dark)" }}
                      >
                        Most chosen
                      </span>
                    )}

                    <p className="font-body text-xs uppercase tracking-widest mb-5" style={{ color: "rgba(255,255,255,0.4)" }}>
                      {d.shortName}
                    </p>

                    {/* Price — floating pound, Fraunces non-italic */}
                    <div className="relative mb-1" style={{ lineHeight: 1 }}>
                      <span
                        className="font-numeral font-semibold absolute"
                        style={{
                          color: "rgba(255,255,255,0.4)",
                          fontSize: "clamp(28px, 3vw, 36px)",
                          top: "4px",
                          left: "-2px",
                          transform: "translateX(-100%)",
                        }}
                      >
                        &pound;
                      </span>
                      <span
                        className="font-numeral font-semibold"
                        style={{
                          color: "#FFFFFF",
                          fontSize: "clamp(72px, 6vw, 96px)",
                          marginLeft: "20px",
                        }}
                      >
                        {priceDisplay}
                      </span>
                    </div>

                    <p
                      className="font-mono-v2 text-[10px] uppercase mb-6"
                      style={{ color: "#888888", letterSpacing: "0.15em" }}
                    >
                      {days} day turnaround
                    </p>

                    {d.blurb && (
                      <p className="font-body text-sm leading-relaxed mb-8" style={{ color: "rgba(255,255,255,0.7)" }}>
                        {d.blurb}
                      </p>
                    )}

                    <ul className="mb-10 flex-1" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                      {tier.features.slice(0, 5).map((f) => (
                        <li key={f} className="flex items-start gap-3 font-body text-sm" style={{ color: "#E8E4DC" }}>
                          <span className="shrink-0" style={{ color: "var(--v2-gold)" }}>&mdash;</span>
                          {f}
                        </li>
                      ))}
                    </ul>

                    <Link
                      href="/submit"
                      className="inline-flex items-center justify-center gap-2 font-body text-sm font-semibold no-underline px-5 py-3 rounded-full transition-all hover:scale-[1.03] w-full"
                      style={
                        d.featured
                          ? { backgroundColor: "var(--v2-gold)", color: "var(--v2-panel-dark)" }
                          : { border: "1px solid var(--v2-gold)", color: "var(--v2-gold)" }
                      }
                    >
                      Start a submission <ArrowRight size={14} />
                    </Link>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Black Label editorial callout — not a 4th tier card */}
          <div className="mt-16 max-w-3xl mx-auto text-center">
            <p
              className="font-mono-v2 text-[9px] uppercase tracking-[0.3em] mb-3"
              style={{ color: "var(--v2-gold-soft)" }}
            >
              Black Label &middot; Earned, not sold
            </p>
            <p className="font-display italic font-medium text-2xl md:text-3xl leading-snug mb-3" style={{ color: "#FFFFFF" }}>
              When every subgrade scores a 10, the slab upgrades automatically.
            </p>
            <p className="font-body text-sm md:text-base" style={{ color: "rgba(255,255,255,0.6)" }}>
              Black Label is MintVault&rsquo;s top-tier finish &mdash; a visual signal that a card hit
              perfect across centering, corners, edges, and surface. There&rsquo;s no separate fee,
              no form to tick. If it earns it, you get it.
            </p>
          </div>
        </div>
      </section>

      {/* ── SECTION II: VALUE PROTECTION ─────────────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-paper)" }}>
        <div className="mx-auto max-w-5xl px-6 py-24 md:py-32">
          <SectionEyebrow numeral="II" label="Value Protection" className="mb-4" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-16 mb-14">
            <h2 className="font-display italic font-medium text-3xl md:text-5xl leading-tight" style={{ color: "var(--v2-ink)" }}>
              Declare what it&rsquo;s worth.
            </h2>
            <p className="font-body text-sm md:text-base leading-relaxed self-end" style={{ color: "var(--v2-ink-soft)" }}>
              Declared value is what your card is worth if lost or damaged in our custody.
              Higher tiers raise our insurance cover with a small per-card surcharge.
            </p>
          </div>

          <div className="rounded-xl overflow-x-auto" style={{ border: "1px solid var(--v2-line)" }}>
            <table className="w-full text-left">
              <thead>
                <tr style={{ backgroundColor: "var(--v2-paper-raised)", borderBottom: "1px solid var(--v2-line)" }}>
                  <th className="font-body text-[10px] uppercase tracking-widest py-3 px-4" style={{ color: "var(--v2-ink-mute)" }}>Tier</th>
                  <th className="font-body text-[10px] uppercase tracking-widest py-3 px-4" style={{ color: "var(--v2-ink-mute)" }}>Declared value</th>
                  <th className="font-body text-[10px] uppercase tracking-widest py-3 px-4" style={{ color: "var(--v2-ink-mute)" }}>Per-card surcharge</th>
                  <th className="font-body text-[10px] uppercase tracking-widest py-3 px-4 hidden md:table-cell" style={{ color: "var(--v2-ink-mute)" }}>Notes</th>
                </tr>
              </thead>
              <tbody>
                {insuranceSurchargeBands.map((band, i) => {
                  const tierName = ["Standard", "Enhanced", "Premium", "Max"][i];
                  const ceiling = gbp(band.maxValue);
                  const fee = band.surchargePence === 0 ? "Included" : `+${poundsFromPence(band.surchargePence)}`;
                  const note =
                    i === 0 ? "Built into every submission" :
                    i === 1 ? "Mid-value cards" :
                    i === 2 ? "High-value grails" :
                              "Cap — contact us above £7.5k";
                  return (
                    <tr key={band.maxValue} style={{ borderBottom: i < insuranceSurchargeBands.length - 1 ? "1px solid var(--v2-line-soft)" : undefined, backgroundColor: "var(--v2-paper-raised)" }}>
                      <td className="font-body text-sm font-semibold py-3 px-4" style={{ color: "var(--v2-ink)" }}>{tierName}</td>
                      <td className="font-mono-v2 text-sm py-3 px-4" style={{ color: "var(--v2-ink)" }}>Up to {ceiling}</td>
                      <td className="font-mono-v2 text-sm py-3 px-4" style={{ color: band.surchargePence === 0 ? "var(--v2-gold)" : "var(--v2-ink)" }}>{fee}</td>
                      <td className="font-body text-xs py-3 px-4 hidden md:table-cell" style={{ color: "var(--v2-ink-mute)" }}>{note}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ── SECTION III: ADD-ONS ─────────────────────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-paper-raised)" }}>
        <div className="mx-auto max-w-5xl px-6 py-24 md:py-32">
          <SectionEyebrow numeral="III" label="Add-ons" className="mb-4" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-16 mb-14">
            <h2 className="font-display italic font-medium text-3xl md:text-5xl leading-tight" style={{ color: "var(--v2-ink)" }}>
              Optional extras.
            </h2>
            <p className="font-body text-sm md:text-base leading-relaxed self-end" style={{ color: "var(--v2-ink-soft)" }}>
              Three services you can stack onto a submission. Add only what you need &mdash;
              nothing hidden, nothing default-on.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 md:gap-10">
            {ADDON_ORDER.map((id) => {
              const addon = ADDON_PRICES[id];
              return (
                <div key={id} className="addon-item-v2">
                  <div className="flex items-baseline justify-between mb-3" style={{ borderBottom: "1px solid var(--v2-line)", paddingBottom: "10px" }}>
                    <h3 className="font-display italic font-medium text-xl md:text-2xl" style={{ color: "var(--v2-ink)" }}>
                      {addon.name}
                    </h3>
                    <span className="font-mono-v2 text-lg font-semibold" style={{ color: "var(--v2-gold)" }}>
                      {addon.display}
                    </span>
                  </div>
                  <p className="font-body text-sm leading-relaxed" style={{ color: "var(--v2-ink-soft)" }}>
                    {addon.description}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── SECTION IV: RETURN SHIPPING ──────────────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-paper-sunk)" }}>
        <div className="mx-auto max-w-5xl px-6 py-24 md:py-32">
          <SectionEyebrow numeral="IV" label="Return Shipping" className="mb-4" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-16 mb-14">
            <h2 className="font-display italic font-medium text-3xl md:text-5xl leading-tight" style={{ color: "var(--v2-ink)" }}>
              Insured, tracked, UK only.
            </h2>
            <p className="font-body text-sm md:text-base leading-relaxed self-end" style={{ color: "var(--v2-ink-soft)" }}>
              Every slab returns via Royal Mail Special Delivery with insurance matched to
              your declared value tier.
            </p>
          </div>

          <div className="rounded-xl overflow-x-auto" style={{ border: "1px solid var(--v2-line)" }}>
            <table className="w-full text-left">
              <thead>
                <tr style={{ backgroundColor: "var(--v2-paper-raised)", borderBottom: "1px solid var(--v2-line)" }}>
                  <th className="font-body text-[10px] uppercase tracking-widest py-3 px-4" style={{ color: "var(--v2-ink-mute)" }}>Declared value</th>
                  <th className="font-body text-[10px] uppercase tracking-widest py-3 px-4" style={{ color: "var(--v2-ink-mute)" }}>Return shipping</th>
                </tr>
              </thead>
              <tbody>
                {insuranceTiers.map((tier, i) => (
                  <tr key={tier.maxValue} style={{ borderBottom: i < insuranceTiers.length - 1 ? "1px solid var(--v2-line-soft)" : undefined, backgroundColor: "var(--v2-paper-raised)" }}>
                    <td className="font-mono-v2 text-sm py-3 px-4" style={{ color: "var(--v2-ink)" }}>Up to {gbp(tier.maxValue)}</td>
                    <td className="font-mono-v2 text-sm font-semibold py-3 px-4" style={{ color: "var(--v2-ink)" }}>{poundsFromPence(tier.shippingPence)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="font-body text-xs mt-6" style={{ color: "var(--v2-ink-mute)" }}>
            Fully insured Royal Mail return. UK addresses only. Above £7,500 declared value,
            please contact us for bespoke carriage.
          </p>
        </div>
      </section>

      {/* ── SECTION V: VAULT CLUB TEASER ─────────────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-paper)" }}>
        <div className="mx-auto max-w-5xl px-6 py-24 md:py-32">
          <SectionEyebrow numeral="V" label="Vault Club" className="mb-4" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-16 mb-10">
            <h2 className="font-display italic font-medium text-3xl md:text-5xl leading-tight" style={{ color: "var(--v2-ink)" }}>
              Silver membership.
            </h2>
            <p className="font-body text-sm md:text-base leading-relaxed self-end" style={{ color: "var(--v2-ink-soft)" }}>
              A perks-and-credits membership for collectors who submit regularly. No
              percentage discount &mdash; tangible perks that cover real costs.
            </p>
          </div>

          <div className="silver-vault-card rounded-xl p-8 md:p-10" style={{ backgroundColor: "var(--v2-paper-raised)", border: "1px solid var(--v2-gold-soft)" }}>
            <div className="flex flex-col md:flex-row md:items-baseline md:justify-between gap-4 mb-8" style={{ borderBottom: "1px solid var(--v2-line)", paddingBottom: "20px" }}>
              <div>
                <p className="font-mono-v2 text-[10px] uppercase tracking-widest mb-2" style={{ color: "var(--v2-gold)" }}>
                  {SILVER.label}
                </p>
                <h3 className="font-display italic font-medium text-2xl md:text-3xl" style={{ color: "var(--v2-ink)" }}>
                  For the regular submitter.
                </h3>
              </div>
              <div className="text-left md:text-right">
                <p className="font-mono-v2 text-lg md:text-xl font-semibold" style={{ color: "var(--v2-ink)" }}>
                  {poundsFromPence(SILVER.monthly_price_pence)}/mo
                </p>
                <p className="font-mono-v2 text-xs mt-1" style={{ color: "var(--v2-ink-mute)" }}>
                  or {poundsFromPence(SILVER.annual_price_pence)}/year
                </p>
              </div>
            </div>

            <ul className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3 mb-8">
              {[
                "Priority queue within your grading tier",
                `${SILVER.free_authentication_monthly} free Authentication add-ons every month`,
                "Free return shipping on every declared-value tier",
                `${SILVER.ai_credits_monthly} AI Pre-Grade credits per month`,
                "Early access to Population Report insights",
              ].map((perk) => (
                <li key={perk} className="flex items-start gap-3 font-body text-sm" style={{ color: "var(--v2-ink-soft)" }}>
                  <Check size={14} style={{ color: "var(--v2-gold)" }} className="mt-1 shrink-0" />
                  <span>{perk}</span>
                </li>
              ))}
            </ul>

            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <Link
                href="/vault-club"
                className="inline-flex items-center gap-2 font-body text-sm font-semibold no-underline px-6 py-3 rounded-full transition-all hover:scale-[1.03] self-start"
                style={{ backgroundColor: "var(--v2-ink)", color: "var(--v2-paper)" }}
              >
                See Vault Club <ArrowRight size={14} />
              </Link>
              <p className="font-mono-v2 text-[10px] uppercase tracking-wider" style={{ color: "var(--v2-ink-mute)" }}>
                Subscriptions temporarily paused &mdash; relaunching with full perks system.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── SECTION VI: DISCOUNT STACKING ────────────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-paper-raised)" }}>
        <div className="mx-auto max-w-4xl px-6 py-24 md:py-32">
          <SectionEyebrow numeral="VI" label="Discount Stacking" className="mb-4" />
          <h2 className="font-display italic font-medium text-3xl md:text-5xl leading-tight mb-8" style={{ color: "var(--v2-ink)" }}>
            One discount at a time.
          </h2>
          <p className="font-body text-base md:text-lg leading-relaxed mb-6" style={{ color: "var(--v2-ink-soft)" }}>
            Your basket uses whichever saves you more &mdash; bulk discount, or Vault Club perks.
            Never both. It keeps the maths honest and the pricing legible.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-10">
            <div className="rounded-lg p-6" style={{ backgroundColor: "var(--v2-paper-sunk)", border: "1px solid var(--v2-line)" }}>
              <p className="font-mono-v2 text-[10px] uppercase tracking-widest mb-3" style={{ color: "var(--v2-gold)" }}>
                Example A
              </p>
              <p className="font-body text-sm leading-relaxed" style={{ color: "var(--v2-ink-soft)" }}>
                Submit 10 or more cards? <strong style={{ color: "var(--v2-ink)" }}>Bulk discount applies</strong> &mdash; graduated from
                5% at 10 cards to 15% at 50+.
              </p>
            </div>
            <div className="rounded-lg p-6" style={{ backgroundColor: "var(--v2-paper-sunk)", border: "1px solid var(--v2-line)" }}>
              <p className="font-mono-v2 text-[10px] uppercase tracking-widest mb-3" style={{ color: "var(--v2-gold)" }}>
                Example B
              </p>
              <p className="font-body text-sm leading-relaxed" style={{ color: "var(--v2-ink-soft)" }}>
                Silver member? <strong style={{ color: "var(--v2-ink)" }}>Vault Club perks apply</strong> &mdash; free return shipping,
                free Authentication credits, priority queue.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── SECTION VII: FAQ ─────────────────────────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-paper)" }}>
        <div className="mx-auto max-w-4xl px-6 py-24 md:py-32">
          <SectionEyebrow numeral="VII" label="FAQ" className="mb-4" />
          <h2 className="font-display italic font-medium text-3xl md:text-5xl leading-tight mb-12" style={{ color: "var(--v2-ink)" }}>
            Pricing questions.
          </h2>

          <div className="space-y-10">
            {[
              {
                q: "Why only three tiers? What happened to Gold?",
                a: "We launched with Vault Queue, Standard, and Express because those cover the three real jobs: cheap-and-patient, balanced, and fast. Demand for a higher-price tier will be re-evaluated post-launch based on submission data rather than guesswork.",
              },
              {
                q: "Is Black Label a paid upgrade?",
                a: "No. Black Label is automatic when every subgrade (centering, corners, edges, surface) hits a 10. There&rsquo;s no extra charge, no form to tick. If your card earns it, you get it.",
              },
              {
                q: "Can I combine Vault Club perks with the bulk discount?",
                a: "No. Your basket applies whichever saves you more &mdash; bulk discount or Vault Club perks &mdash; never both stacked. This keeps pricing predictable and fair.",
              },
              {
                q: "Are cards insured in transit?",
                a: "Yes. All return shipping is Royal Mail Special Delivery with cover matched to your declared-value tier. Incoming shipping is your responsibility, but we recommend Royal Mail Special Delivery for anything above £100.",
              },
              {
                q: "Do you grade cards other than Pokémon?",
                a: "Yes. We grade Pokémon, Magic: The Gathering, Yu-Gi-Oh!, One Piece TCG, sports cards, and most other trading card formats. If you&rsquo;re unsure, submit anyway &mdash; we&rsquo;ll flag it before grading if we can&rsquo;t authenticate.",
              },
            ].map((item, i) => (
              <div
                key={item.q}
                ref={(el) => { faqRefs.current[i] = el; }}
                className="faq-item-accent"
              >
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

      {/* ── SECTION VIII: FINAL CTA (dark) ───────────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-panel-dark)", position: "relative", overflow: "hidden" }}>
        <DarkSectionGlow />
        <div className="mx-auto max-w-3xl px-6 py-24 md:py-32 text-center" style={{ position: "relative", zIndex: 1 }}>
          <SectionEyebrow numeral="VIII" label="Submit" className="mb-4" />
          <h2 className="font-display italic font-medium text-3xl md:text-5xl leading-tight mb-6" style={{ color: "#FFFFFF" }}>
            Ready when you are.
          </h2>
          <p className="font-body text-sm md:text-base mb-10" style={{ color: "rgba(255,255,255,0.5)" }}>
            From &pound;19. UK-based. Insured in transit.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3 mb-6">
            <Link
              href="/submit"
              className="inline-flex items-center gap-2 font-body text-sm font-semibold no-underline px-7 py-3 rounded-full transition-all hover:scale-[1.03]"
              style={{ backgroundColor: "var(--v2-gold)", color: "var(--v2-panel-dark)" }}
            >
              Submit a card <ArrowRight size={14} />
            </Link>
            <Link
              href="/tools/estimate"
              className="inline-flex items-center gap-2 font-body text-sm font-semibold no-underline px-7 py-3 rounded-full border transition-all hover:scale-[1.03]"
              style={{ borderColor: "rgba(255,255,255,0.2)", color: "rgba(255,255,255,0.7)" }}
            >
              Try AI Pre-Grade (free) <ArrowRight size={14} />
            </Link>
          </div>
        </div>
      </section>

      <FooterV2 />
    </div>
  );
}
