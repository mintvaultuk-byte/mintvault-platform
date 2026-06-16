import { useEffect, useRef } from "react";
import { Link } from "wouter";
import { ArrowRight, Check, CheckCheck, Shield, Clock, Zap } from "lucide-react";
import GradientButton from "@/components/ui/gradient-button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TimelineContent } from "@/components/ui/timeline-animation";
import HeaderV2 from "@/components/v2/header-v2";
import FooterV2 from "@/components/v2/footer-v2";
import SectionEyebrow from "@/components/v2/section-eyebrow";
import AmbientLayer from "@/components/v2/ambient-layer";
import DarkSectionGlow from "@/components/v2/dark-section-glow";
import { pricingTiers, insuranceTiers, insuranceSurchargeBands } from "@shared/schema";
import { ADDON_PRICES, ADDON_ORDER } from "@shared/addons";
import { cn } from "@/lib/utils";
import { useActivePromo } from "@/hooks/use-active-promo";
import { PromoBanner, TierPriceWithPromo } from "@/components/v2/promo-display";

const SILVER = {
  label: "Silver Vault",
  monthly_price_pence: 999,
  annual_price_pence: 9900,
  ai_credits_monthly: 50,
} as const;

const TIER_DISPLAY: Record<string, { shortName: string; blurb: string; featured: boolean; icon: React.ReactNode }> = {
  standard: {
    shortName: "Vault Queue",
    blurb: "No rush. Full grade, NFC chip, registry listing — at the best price per card.",
    featured: false,
    icon: <Shield size={20} />,
  },
  priority: {
    shortName: "Standard",
    blurb: "The balanced option: fair turnaround, full report, priority you can feel.",
    featured: true,
    icon: <Clock size={20} />,
  },
  express: {
    shortName: "Express",
    blurb: "Back in under a week. For grails, auction deadlines, and holiday hand-offs.",
    featured: false,
    icon: <Zap size={20} />,
  },
};

const poundsFromPence = (p: number) => `£${(p / 100).toFixed(p % 100 === 0 ? 0 : 2)}`;
const gbp = (n: number) => `£${n.toLocaleString("en-GB")}`;

const revealVariants = {
  visible: (i: number) => ({
    y: 0,
    opacity: 1,
    filter: "blur(0px)",
    transition: { delay: i * 0.3, duration: 0.5 },
  }),
  hidden: { filter: "blur(10px)", y: -20, opacity: 0 },
};

export default function PricingV2() {
  const pricingRef = useRef<HTMLDivElement>(null);

  // Active promotion — shared source used by every pricing surface.
  const promo = useActivePromo();

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
    <div className="min-h-screen flex flex-col relative vault-page" ref={pricingRef}>
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
              <GradientButton>
                Submit a card <ArrowRight size={14} />
              </GradientButton>
            </Link>
            <Link href="/tools/estimate" className="no-underline">
              <GradientButton>
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

      {/* ── SECTION I: GRADING TIERS (animated cards) ────────────────── */}
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

          <PromoBanner promo={promo} />

          <div className="flex justify-center">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5 md:gap-6 w-full" style={{ maxWidth: "1080px" }}>
              {pricingTiers.map((tier, index) => {
                const d = TIER_DISPLAY[tier.id] ?? {
                  shortName: tier.name,
                  blurb: "",
                  featured: false,
                  icon: <Shield size={20} />,
                };
                const price = tier.pricePerCard / 100;
                const days = tier.turnaroundDays ?? 0;

                return (
                  <TimelineContent
                    key={tier.id}
                    as="div"
                    animationNum={3 + index}
                    timelineRef={pricingRef}
                    customVariants={revealVariants}
                  >
                    <Card
                      className={cn(
                        "relative border h-full flex flex-col transition-all duration-300",
                        d.featured
                          ? "ring-2 ring-[#D4AF37] bg-[#171510] border-[#D4AF37]/50 md:scale-105 md:-my-4 z-10 shadow-[0_0_30px_rgba(212,175,55,0.3),0_0_60px_rgba(212,175,55,0.15)]"
                          : "bg-[#0f0e0b] border-[#333]"
                      )}
                    >
                      {d.featured && (
                        <span className="absolute -top-5 left-1/2 -translate-x-1/2 z-20 bg-gradient-to-r from-[#B8960C] to-[#D4AF37] text-[#1a1400] px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider whitespace-nowrap no-text-shadow shadow-[0_0_12px_rgba(212,175,55,0.6),0_0_24px_rgba(212,175,55,0.3)]">
                          Most chosen
                        </span>
                      )}
                      <CardHeader className="text-left">
                        <div className="flex items-center gap-3 mb-2">
                          <div className="w-10 h-10 rounded-xl bg-[#1a1400] border border-[#D4AF37]/20 flex items-center justify-center text-[#D4AF37]">
                            {d.icon}
                          </div>
                          <h3 className="xl:text-3xl md:text-2xl text-3xl font-semibold text-white">{d.shortName}</h3>
                        </div>
                        <p className="xl:text-sm md:text-xs text-sm text-[#888] mb-4">{d.blurb}</p>
                        <TierPriceWithPromo tierId={tier.id} fullPricePounds={price} promo={promo} />
                        <p className="text-xs text-[#666] mt-1">{days} working day turnaround</p>
                      </CardHeader>

                      <CardContent className="pt-0 flex flex-col flex-1">
                        <div className="space-y-3 pt-4 border-t border-[#333] mb-6 flex-1">
                          <h4 className="text-xs font-bold uppercase tracking-wider text-[#D4AF37] mb-3">
                            What&rsquo;s included
                          </h4>
                          <ul className="space-y-2.5">
                            {tier.features.map((feature, featureIndex) => (
                              <li key={featureIndex} className="flex items-center">
                                <span className="h-5 w-5 rounded-full border border-[#D4AF37]/40 grid place-content-center mr-3 flex-shrink-0">
                                  <CheckCheck className="h-3 w-3 text-[#D4AF37]" />
                                </span>
                                <span className="text-sm text-[#ccc]">{feature}</span>
                              </li>
                            ))}
                          </ul>
                        </div>

                        <Link href="/submit" className="no-underline block">
                          <GradientButton height="52px" className="w-full">
                            Start a submission <ArrowRight size={14} />
                          </GradientButton>
                        </Link>
                      </CardContent>
                    </Card>
                  </TimelineContent>
                );
              })}
            </div>
          </div>

          {/* Bulk-discount tiers table — full-width row beneath the cards.
              Lives outside the flex/grid wrapper so it doesn't sit next to
              the Express card. */}
          <div className="mt-12 max-w-3xl mx-auto">
            <p
              className="font-mono-v2 text-[10px] md:text-xs uppercase tracking-[0.3em] no-text-shadow mb-3 text-center"
              style={{ color: "#D4AF37" }}
            >
              Bulk discount tiers
            </p>
            <div className="overflow-x-auto rounded-xl border border-[#333] bg-[#0f0e0b]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#333]">
                    <th className="text-left py-3 px-4 text-[10px] uppercase tracking-widest font-bold text-[#D4AF37]">
                      Cards
                    </th>
                    <th className="text-right py-3 px-4 text-[10px] uppercase tracking-widest font-bold text-[#D4AF37]">
                      Vault Queue
                    </th>
                    <th className="text-right py-3 px-4 text-[10px] uppercase tracking-widest font-bold text-[#D4AF37]">
                      Standard
                    </th>
                    <th className="text-right py-3 px-4 text-[10px] uppercase tracking-widest font-bold text-[#D4AF37]">
                      Express
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { qty: "10+", off: "5% off", vq: "£18.05", st: "£23.75", ex: "£42.75" },
                    { qty: "25+", off: "7.5% off", vq: "£17.58", st: "£23.13", ex: "£41.63" },
                    { qty: "50+", off: "10% off", vq: "£17.10", st: "£22.50", ex: "£40.50" },
                  ].map((row) => (
                    <tr key={row.qty} className="border-b border-[#222] last:border-b-0">
                      <td className="py-3 px-4">
                        <div className="text-white font-semibold">{row.qty}</div>
                        <div className="text-[#666] text-[10px] uppercase tracking-wider">{row.off}</div>
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-[#ccc]">{row.vq}</td>
                      <td className="py-3 px-4 text-right font-mono text-[#ccc]">{row.st}</td>
                      <td className="py-3 px-4 text-right font-mono text-[#ccc]">{row.ex}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="font-body text-xs md:text-sm text-center mt-3" style={{ color: "var(--v2-ink-mute)" }}>
              Vault Club and bulk discounts are mutually exclusive — the higher discount applies. Pristine 10P upgrade
              is excluded from bulk pricing.
            </p>
          </div>

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
                <GradientButton>
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
            {[
              { range: "10–24 cards", discount: "5% off" },
              { range: "25–49 cards", discount: "10% off" },
              { range: "50+ cards", discount: "15% off" },
            ].map((tier) => (
              <div
                key={tier.range}
                className="rounded-lg p-6"
                style={{ backgroundColor: "var(--v2-paper-sunk)", border: "1px solid var(--v2-line)" }}
              >
                <p
                  className="font-mono-v2 text-[10px] uppercase tracking-widest mb-3"
                  style={{ color: "var(--v2-gold)" }}
                >
                  {tier.range}
                </p>
                <p className="font-body text-sm leading-relaxed" style={{ color: "var(--v2-ink-soft)" }}>
                  <strong style={{ color: "var(--v2-ink)" }}>{tier.discount}</strong> the per-card grading fee.
                </p>
              </div>
            ))}
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
                a: "No. Pristine 10P is automatic when every subgrade (centering, corners, edges, surface) hits a 10. There’s no extra charge, no form to tick. If your card earns it, you get it.",
              },
              {
                q: "Are cards insured in transit?",
                a: "Yes. All return shipping is Royal Mail Special Delivery with cover matched to your declared-value tier. Incoming shipping is your responsibility, but we recommend Royal Mail Special Delivery for anything above £100.",
              },
              {
                q: "Do you grade cards other than Pokémon?",
                a: "Yes. We grade Pokémon, Magic: The Gathering, Yu-Gi-Oh!, One Piece TCG, sports cards, and most other trading card formats. If you’re unsure, submit anyway — we’ll flag it before grading if we can’t authenticate.",
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
              <GradientButton>
                Submit a card <ArrowRight size={14} />
              </GradientButton>
            </Link>
            <Link href="/tools/estimate" className="no-underline">
              <GradientButton>
                Try AI Pre-Grade (free) <ArrowRight size={14} />
              </GradientButton>
            </Link>
          </div>
        </div>
      </section>

      <FooterV2 />
    </div>
  );
}
