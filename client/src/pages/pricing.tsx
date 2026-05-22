import { useEffect, useRef } from "react";
import { Link } from "wouter";
import { ArrowRight, Check } from "lucide-react";
import GradientButton from "@/components/ui/gradient-button";
import HeaderV2 from "@/components/v2/header-v2";
import FooterV2 from "@/components/v2/footer-v2";
import SectionEyebrow from "@/components/v2/section-eyebrow";
import AmbientLayer from "@/components/v2/ambient-layer";
import DarkSectionGlow from "@/components/v2/dark-section-glow";
import { pricingTiers, insuranceTiers, insuranceSurchargeBands } from "@shared/schema";
import { ADDON_PRICES, ADDON_ORDER } from "@shared/addons";

// Silver Vault Club perk values — mirrors server/vault-club-tiers.ts Silver
// config (verified 2026-04-19 after merge a8e5f8d). Hardcoded here because
// VAULT_CLUB_TIERS lives under server/ and has no shared import path.
// If Silver's perks shift, update both this file and server/vault-club-tiers.ts.
const SILVER = {
  label: "Silver Vault",
  monthly_price_pence: 999,
  annual_price_pence: 9900,
  ai_credits_monthly: 50,
} as const;

// Display descriptors derived from config — keep all copy/marketing text in
// this file so pricing-v2 stays self-contained while numbers stay bound to
// shared config. Tier display order: VAULT_QUEUE → STANDARD (featured) → EXPRESS.

const TIER_DISPLAY: Record<string, { shortName: string; blurb: string; featured: boolean }> = {
  standard: {
    // schema id "standard" = Vault Queue
    shortName: "Vault Queue",
    blurb: "No rush. Full grade, NFC chip, registry listing — at the best price per card.",
    featured: false,
  },
  priority: {
    // schema id "priority" = Standard
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
    <div className="min-h-screen flex flex-col relative vault-page">
      <AmbientLayer />
      <HeaderV2 />

      {/* ── SECTION A: HERO ──────────────────────────────────────────── */}
      <section className="relative">
        <div className="mx-auto max-w-3xl px-6 pt-10 pb-20 md:pt-16 md:pb-32 text-center">
          <p
            className="font-mono-v2 text-sm md:text-base font-semibold uppercase tracking-[0.25em] no-text-shadow mb-6"
            style={{ color: "#D4AF37" }}
          >
            Est. Kent &middot; Pricing
          </p>
          <h1
            className="font-display italic font-medium leading-[0.95] mb-6"
            style={{ fontSize: "clamp(2.75rem, 6vw, 5rem)", color: "var(--v2-ink)" }}
          >
            Grade it once.
            <br />
            Get it right.
          </h1>
          <p
            className="font-body text-base md:text-lg leading-relaxed max-w-xl mx-auto mb-8"
            style={{ color: "var(--v2-ink-soft)" }}
          >
            Three tiers, 5 to 40 working day turnaround, same four-point inspection on every card. Pristine 10P upgrade
            when your card earns it &mdash; free, never sold.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3 mb-5">
            <Link href="/submit" className="no-underline">
              <GradientButton className="gradient-btn-filled">
                Submit a card <ArrowRight size={14} />
              </GradientButton>
            </Link>
            <Link href="/tools/estimate" className="no-underline">
              <GradientButton className="gradient-btn-filled">
                Try AI Pre-Grade <ArrowRight size={14} />
              </GradientButton>
            </Link>
          </div>
          <p
            className="font-mono-v2 text-xs md:text-sm uppercase tracking-wider"
            style={{ color: "var(--v2-ink-mute)" }}
          >
            From &pound;19 &middot; 3 tiers &middot; Free Pristine 10P upgrade
          </p>
        </div>
      </section>

      {/* ── SECTION I: GRADING TIERS (dark) ──────────────────────────── */}
      <section className="frost-panel-dark" style={{ position: "relative", overflow: "hidden" }}>
        <DarkSectionGlow />
        <div className="mx-auto max-w-7xl px-6 py-24 md:py-32" style={{ position: "relative", zIndex: 1 }}>
          <SectionEyebrow numeral="I" label="Grading Tiers" className="mb-4" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-16 mb-14">
            <h2
              className="font-display italic font-medium text-3xl md:text-5xl leading-tight"
              style={{ color: "#FFFFFF" }}
            >
              Three tiers.
              <br />
              <span className="font-display italic font-normal" style={{ color: "var(--v2-gold)" }}>
                One standard.
              </span>
            </h2>
            <p className="font-body text-sm md:text-base leading-relaxed self-end" style={{ color: "#ffffff" }}>
              Every card passes the same four-point inspection: centering, corners, edges, surface. Tier only changes
              how quickly the work comes back.{" "}
              <Link
                href="/standard"
                className="underline underline-offset-2"
                style={{ color: "var(--v2-gold)" }}
                data-testid="link-mvgs-pricing"
              >
                Published as the open MVGS standard.
              </Link>
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
                      backgroundColor: "var(--v2-paper)",
                      border: d.featured ? "1px solid rgba(212, 175, 55, 0.6)" : "1px solid rgba(212, 175, 55, 0.25)",
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

                    <p className="font-body text-xs uppercase tracking-widest mb-5" style={{ color: "var(--v2-gold)" }}>
                      {d.shortName}
                    </p>

                    {/* Price — floating pound, Fraunces non-italic */}
                    <div className="relative mb-1" style={{ lineHeight: 1 }}>
                      <span
                        className="font-numeral font-semibold absolute"
                        style={{
                          color: "var(--v2-ink-mute)",
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
                          color: "var(--v2-ink)",
                          fontSize: "clamp(72px, 6vw, 96px)",
                          marginLeft: "20px",
                        }}
                      >
                        {priceDisplay}
                      </span>
                    </div>

                    <p
                      className="font-mono-v2 text-[10px] uppercase mb-6"
                      style={{ color: "var(--v2-ink-mute)", letterSpacing: "0.15em" }}
                    >
                      {days} day turnaround
                    </p>

                    {d.blurb && (
                      <p className="font-body text-sm leading-relaxed mb-8" style={{ color: "var(--v2-ink-soft)" }}>
                        {d.blurb}
                      </p>
                    )}

                    <ul className="mb-10 flex-1" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                      {tier.features.slice(0, 5).map((f) => (
                        <li
                          key={f}
                          className="flex items-start gap-3 font-body text-sm"
                          style={{ color: "var(--v2-ink-soft)" }}
                        >
                          <span className="shrink-0" style={{ color: "var(--v2-gold)" }}>
                            &mdash;
                          </span>
                          {f}
                        </li>
                      ))}
                    </ul>

                    <Link href="/submit" className="no-underline w-full">
                      <GradientButton className={d.featured ? "gradient-btn-filled w-full" : "w-full"}>
                        Start a submission <ArrowRight size={14} />
                      </GradientButton>
                    </Link>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Black Label editorial callout — not a 4th tier card */}
          <div className="mt-16 max-w-3xl mx-auto text-center">
            <p
              className="font-mono-v2 text-xs md:text-sm uppercase tracking-[0.3em] no-text-shadow mb-3"
              style={{ color: "#D4AF37" }}
            >
              Pristine 10P &middot; Earned, not sold
            </p>
            <p
              className="font-display italic font-medium text-2xl md:text-3xl leading-snug mb-3"
              style={{ color: "#FFFFFF" }}
            >
              When every subgrade scores a 10, the slab upgrades automatically.
            </p>
            <p className="font-body text-sm md:text-base" style={{ color: "#ffffff" }}>
              Pristine 10P is MintVault&rsquo;s top-tier finish &mdash; a visual signal that a card hit perfect across
              centering, corners, edges, and surface. There&rsquo;s no separate fee, no form to tick. If it earns it,
              you get it.
            </p>
          </div>
        </div>
      </section>

      {/* ── SECTION II: VALUE PROTECTION ─────────────────────────────── */}
      <section className="frost-paper">
        <div className="mx-auto max-w-5xl px-6 py-24 md:py-32">
          <SectionEyebrow numeral="II" label="Value Protection" className="mb-4" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-16 mb-14">
            <h2
              className="font-display italic font-medium text-3xl md:text-5xl leading-tight"
              style={{ color: "var(--v2-ink)" }}
            >
              Declare what it&rsquo;s worth.
            </h2>
            <p
              className="font-body text-sm md:text-base leading-relaxed self-end"
              style={{ color: "var(--v2-ink-soft)" }}
            >
              Declared value is what your card is worth if lost or damaged in our custody. Higher tiers raise our
              insurance cover with a small per-card surcharge.
            </p>
          </div>

          <div className="rounded-xl overflow-x-auto" style={{ border: "1px solid var(--v2-line)" }}>
            <table className="w-full text-left">
              <thead>
                <tr style={{ backgroundColor: "var(--v2-paper-raised)", borderBottom: "1px solid var(--v2-line)" }}>
                  <th
                    className="font-body text-[10px] uppercase tracking-widest py-3 px-4"
                    style={{ color: "var(--v2-ink-mute)" }}
                  >
                    Tier
                  </th>
                  <th
                    className="font-body text-[10px] uppercase tracking-widest py-3 px-4"
                    style={{ color: "var(--v2-ink-mute)" }}
                  >
                    Declared value
                  </th>
                  <th
                    className="font-body text-[10px] uppercase tracking-widest py-3 px-4"
                    style={{ color: "var(--v2-ink-mute)" }}
                  >
                    Per-card surcharge
                  </th>
                  <th
                    className="font-body text-[10px] uppercase tracking-widest py-3 px-4 hidden md:table-cell"
                    style={{ color: "var(--v2-ink-mute)" }}
                  >
                    Notes
                  </th>
                </tr>
              </thead>
              <tbody>
                {insuranceSurchargeBands.map((band, i) => {
                  const tierName = ["Standard", "Enhanced", "Premium", "Max"][i];
                  const ceiling = gbp(band.maxValue);
                  const fee = band.surchargePence === 0 ? "Included" : `+${poundsFromPence(band.surchargePence)}`;
                  const note =
                    i === 0
                      ? "Built into every submission"
                      : i === 1
                        ? "Mid-value cards"
                        : i === 2
                          ? "High-value grails"
                          : "Cap — contact us above £7.5k";
                  return (
                    <tr
                      key={band.maxValue}
                      style={{
                        borderBottom:
                          i < insuranceSurchargeBands.length - 1 ? "1px solid var(--v2-line-soft)" : undefined,
                        backgroundColor: "var(--v2-paper-raised)",
                      }}
                    >
                      <td className="font-body text-sm font-semibold py-3 px-4" style={{ color: "var(--v2-ink)" }}>
                        {tierName}
                      </td>
                      <td className="font-mono-v2 text-sm py-3 px-4" style={{ color: "var(--v2-ink)" }}>
                        Up to {ceiling}
                      </td>
                      <td
                        className="font-mono-v2 text-sm py-3 px-4"
                        style={{ color: band.surchargePence === 0 ? "var(--v2-gold)" : "var(--v2-ink)" }}
                      >
                        {fee}
                      </td>
                      <td
                        className="font-body text-xs py-3 px-4 hidden md:table-cell"
                        style={{ color: "var(--v2-ink-mute)" }}
                      >
                        {note}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ── SECTION III: ADD-ONS ─────────────────────────────────────── */}
      <section className="frost-paper-raised">
        <div className="mx-auto max-w-5xl px-6 py-24 md:py-32">
          <SectionEyebrow numeral="III" label="Add-ons" className="mb-4" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-16 mb-14">
            <h2
              className="font-display italic font-medium text-3xl md:text-5xl leading-tight"
              style={{ color: "var(--v2-ink)" }}
            >
              Optional extras.
            </h2>
            <p
              className="font-body text-sm md:text-base leading-relaxed self-end"
              style={{ color: "var(--v2-ink-soft)" }}
            >
              Three services you can stack onto a submission. Add only what you need &mdash; nothing hidden, nothing
              default-on.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 md:gap-10">
            {ADDON_ORDER.map((id) => {
              const addon = ADDON_PRICES[id];
              return (
                <div key={id} className="addon-item-v2">
                  <div
                    className="flex items-baseline justify-between mb-3"
                    style={{ borderBottom: "1px solid var(--v2-line)", paddingBottom: "10px" }}
                  >
                    <h3
                      className="font-display italic font-medium text-xl md:text-2xl"
                      style={{ color: "var(--v2-ink)" }}
                    >
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
      <section className="frost-paper-sunk">
        <div className="mx-auto max-w-5xl px-6 py-24 md:py-32">
          <SectionEyebrow numeral="IV" label="Return Shipping" className="mb-4" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-16 mb-14">
            <h2
              className="font-display italic font-medium text-3xl md:text-5xl leading-tight"
              style={{ color: "var(--v2-ink)" }}
            >
              Insured, tracked, UK only.
            </h2>
            <p
              className="font-body text-sm md:text-base leading-relaxed self-end"
              style={{ color: "var(--v2-ink-soft)" }}
            >
              Every slab returns via Royal Mail Special Delivery with insurance matched to your declared value tier.
            </p>
          </div>

          <div className="rounded-xl overflow-x-auto" style={{ border: "1px solid var(--v2-line)" }}>
            <table className="w-full text-left">
              <thead>
                <tr style={{ backgroundColor: "var(--v2-paper-raised)", borderBottom: "1px solid var(--v2-line)" }}>
                  <th
                    className="font-body text-[10px] uppercase tracking-widest py-3 px-4"
                    style={{ color: "var(--v2-ink-mute)" }}
                  >
                    Declared value
                  </th>
                  <th
                    className="font-body text-[10px] uppercase tracking-widest py-3 px-4"
                    style={{ color: "var(--v2-ink-mute)" }}
                  >
                    Return shipping
                  </th>
                </tr>
              </thead>
              <tbody>
                {insuranceTiers.map((tier, i) => (
                  <tr
                    key={tier.maxValue}
                    style={{
                      borderBottom: i < insuranceTiers.length - 1 ? "1px solid var(--v2-line-soft)" : undefined,
                      backgroundColor: "var(--v2-paper-raised)",
                    }}
                  >
                    <td className="font-mono-v2 text-sm py-3 px-4" style={{ color: "var(--v2-ink)" }}>
                      Up to {gbp(tier.maxValue)}
                    </td>
                    <td className="font-mono-v2 text-sm font-semibold py-3 px-4" style={{ color: "var(--v2-ink)" }}>
                      {poundsFromPence(tier.shippingPence)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="font-body text-xs mt-6" style={{ color: "var(--v2-ink-mute)" }}>
            Fully insured Royal Mail return. UK addresses only. Above £7,500 declared value, please contact us for
            bespoke carriage.
          </p>
        </div>
      </section>

      {/* ── SECTION V: VAULT CLUB TEASER ─────────────────────────────── */}
      <section className="frost-paper">
        <div className="mx-auto max-w-5xl px-6 py-24 md:py-32">
          <SectionEyebrow numeral="V" label="Vault Club" className="mb-4" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-16 mb-10">
            <h2
              className="font-display italic font-medium text-3xl md:text-5xl leading-tight"
              style={{ color: "var(--v2-ink)" }}
            >
              Silver membership.
            </h2>
            <p
              className="font-body text-sm md:text-base leading-relaxed self-end"
              style={{ color: "var(--v2-ink-soft)" }}
            >
              A perks-and-credits membership for collectors who submit regularly. No percentage discount &mdash;
              tangible perks that cover real costs.
            </p>
          </div>

          <div
            className="silver-vault-card rounded-xl p-8 md:p-10"
            style={{ backgroundColor: "var(--v2-paper-raised)", border: "1px solid var(--v2-gold-soft)" }}
          >
            <div
              className="flex flex-col md:flex-row md:items-baseline md:justify-between gap-4 mb-8"
              style={{ borderBottom: "1px solid var(--v2-line)", paddingBottom: "20px" }}
            >
              <div>
                <p
                  className="font-mono-v2 text-[10px] uppercase tracking-widest mb-2"
                  style={{ color: "var(--v2-gold)" }}
                >
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
                "10% off all grading submissions",
                `${SILVER.ai_credits_monthly} AI Pre-Grade credits per month`,
                "Your own public Showroom at mintvaultuk.com/showroom/[your-name]",
                "Silver Vault badge on every cert",
              ].map((perk) => (
                <li
                  key={perk}
                  className="flex items-start gap-3 font-body text-sm"
                  style={{ color: "var(--v2-ink-soft)" }}
                >
                  <Check size={14} style={{ color: "var(--v2-gold)" }} className="mt-1 shrink-0" />
                  <span>{perk}</span>
                </li>
              ))}
            </ul>

            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <Link href="/vault-club" className="no-underline self-start">
                <GradientButton className="gradient-btn-filled">
                  See Vault Club <ArrowRight size={14} />
                </GradientButton>
              </Link>
              <p className="font-mono-v2 text-[10px] uppercase tracking-wider" style={{ color: "var(--v2-ink-mute)" }}>
                Subscriptions temporarily paused &mdash; relaunching with full perks system.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── SECTION VI: BULK DISCOUNTS ────────────────────────────── */}
      <section className="frost-paper-raised">
        <div className="mx-auto max-w-4xl px-6 py-24 md:py-32">
          <SectionEyebrow numeral="VI" label="Bulk Discounts" className="mb-4" />
          <h2
            className="font-display italic font-medium text-3xl md:text-5xl leading-tight mb-8"
            style={{ color: "var(--v2-ink)" }}
          >
            Save more when you submit more.
          </h2>
          <p className="font-body text-base md:text-lg leading-relaxed mb-6" style={{ color: "var(--v2-ink-soft)" }}>
            Bulk discounts apply automatically at checkout based on your card count. The more cards you submit, the more
            you save per card.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-10">
            <div
              className="rounded-lg p-6"
              style={{ backgroundColor: "var(--v2-paper-sunk)", border: "1px solid var(--v2-line)" }}
            >
              <p
                className="font-mono-v2 text-[10px] uppercase tracking-widest mb-3"
                style={{ color: "var(--v2-gold)" }}
              >
                10–24 cards
              </p>
              <p className="font-body text-sm leading-relaxed" style={{ color: "var(--v2-ink-soft)" }}>
                <strong style={{ color: "var(--v2-ink)" }}>5% off</strong> the per-card grading fee.
              </p>
            </div>
            <div
              className="rounded-lg p-6"
              style={{ backgroundColor: "var(--v2-paper-sunk)", border: "1px solid var(--v2-line)" }}
            >
              <p
                className="font-mono-v2 text-[10px] uppercase tracking-widest mb-3"
                style={{ color: "var(--v2-gold)" }}
              >
                25–49 cards
              </p>
              <p className="font-body text-sm leading-relaxed" style={{ color: "var(--v2-ink-soft)" }}>
                <strong style={{ color: "var(--v2-ink)" }}>10% off</strong> the per-card grading fee.
              </p>
            </div>
            <div
              className="rounded-lg p-6"
              style={{ backgroundColor: "var(--v2-paper-sunk)", border: "1px solid var(--v2-line)" }}
            >
              <p
                className="font-mono-v2 text-[10px] uppercase tracking-widest mb-3"
                style={{ color: "var(--v2-gold)" }}
              >
                50+ cards
              </p>
              <p className="font-body text-sm leading-relaxed" style={{ color: "var(--v2-ink-soft)" }}>
                <strong style={{ color: "var(--v2-ink)" }}>15% off</strong> the per-card grading fee.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── SECTION VII: FAQ ─────────────────────────────────────────── */}
      <section className="frost-paper">
        <div className="mx-auto max-w-4xl px-6 py-24 md:py-32">
          <SectionEyebrow numeral="VII" label="FAQ" className="mb-4" />
          <h2
            className="font-display italic font-medium text-3xl md:text-5xl leading-tight mb-12"
            style={{ color: "var(--v2-ink)" }}
          >
            Pricing questions.
          </h2>

          <div className="space-y-10">
            {[
              {
                q: "Why only three tiers? What happened to Gold?",
                a: "We launched with Vault Queue, Standard, and Express because those cover the three real jobs: cheap-and-patient, balanced, and fast. Demand for a higher-price tier will be re-evaluated post-launch based on submission data rather than guesswork.",
              },
              {
                q: "Is Pristine 10P a paid upgrade?",
                a: "No. Pristine 10P is automatic when every subgrade (centering, corners, edges, surface) hits a 10. There&rsquo;s no extra charge, no form to tick. If your card earns it, you get it.",
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
                ref={(el) => {
                  faqRefs.current[i] = el;
                }}
                className="faq-item-accent"
              >
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

      {/* ── SECTION VIII: FINAL CTA (dark) ───────────────────────────── */}
      <section className="frost-panel-dark" style={{ position: "relative", overflow: "hidden" }}>
        <DarkSectionGlow />
        <div className="mx-auto max-w-3xl px-6 py-24 md:py-32 text-center" style={{ position: "relative", zIndex: 1 }}>
          <SectionEyebrow numeral="VIII" label="Submit" className="mb-4" />
          <h2
            className="font-display italic font-medium text-3xl md:text-5xl leading-tight mb-6"
            style={{ color: "#FFFFFF" }}
          >
            Ready when you are.
          </h2>
          <p className="font-body text-sm md:text-base mb-10" style={{ color: "#ffffff" }}>
            From &pound;19. UK-based. Insured in transit.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3 mb-6">
            <Link href="/submit" className="no-underline">
              <GradientButton className="gradient-btn-filled">
                Submit a card <ArrowRight size={14} />
              </GradientButton>
            </Link>
            <Link
              href="/tools/estimate"
              className="inline-flex items-center gap-2 font-body text-sm font-semibold no-underline px-7 py-3 rounded-full transition-all hover:scale-[1.03]"
              style={{ borderColor: "rgba(255,255,255,0.2)", color: "#ffffff" }}
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
