import NumberFlow from "@number-flow/react";
import { cn } from "@/lib/utils";
import { getTierPromo, type ActivePromo } from "@/hooks/use-active-promo";
import { bulkDiscountTiers } from "@shared/commerce";

const poundsFromPence = (p: number) => `£${(p / 100).toFixed(p % 100 === 0 ? 0 : 2)}`;

/**
 * Shared promo-display primitives — the exact gold banner / struck-price / "X% OFF"
 * badge /pricing uses, factored out so every grading-pricing surface renders them
 * identically. Display only: the server-provided discountedPrice is authoritative.
 */

/** Gold promotion banner shown above grading tier cards. Renders nothing if no promo. */
export function PromoBanner({ promo, className }: { promo: ActivePromo | null; className?: string }) {
  if (!promo) return null;
  return (
    <div
      className={cn("mb-10 mx-auto max-w-3xl text-center rounded-2xl px-6 py-4 font-bold", className)}
      style={{
        color: "var(--v2-gold)",
        border: "1px solid var(--v2-gold-soft, rgba(212,175,55,0.4))",
        background: "rgba(212,175,55,0.06)",
      }}
    >
      {promo.bannerText}
    </div>
  );
}

/** The "X% off" gold pill. */
export function PromoBadge({ pct, className }: { pct: number; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center w-fit bg-gradient-to-r from-[#B8960C] to-[#D4AF37] text-[#1a1400] px-2.5 py-0.5 rounded-full text-xs font-bold uppercase tracking-wider no-text-shadow",
        className
      )}
    >
      {pct}% off
    </span>
  );
}

/**
 * A grading tier's price line: when the active promo discounts this tier, the
 * original price struck through + the discounted price (gold) + "/ card", followed
 * by the % badge; otherwise the full price unchanged. Drop-in replacement for the
 * tier-card price block on /pricing and the homepage (identical styling).
 */
export function TierPriceWithPromo({
  tierId,
  fullPricePounds,
  promo,
}: {
  tierId: string;
  fullPricePounds: number;
  promo: ActivePromo | null;
}) {
  const tierPromo = getTierPromo(promo, tierId, Math.round(fullPricePounds * 100));
  return (
    <>
      <div className="flex items-baseline gap-2 flex-wrap">
        {tierPromo ? (
          <>
            <span className="text-2xl font-semibold text-[#777] line-through">
              {poundsFromPence(tierPromo.originalPrice)}
            </span>
            <span className="text-4xl font-semibold" style={{ color: "var(--v2-gold)" }}>
              £
              <NumberFlow value={tierPromo.discountedPrice / 100} className="text-4xl font-semibold" />
            </span>
            <span className="text-[#888]">/ card</span>
          </>
        ) : (
          <>
            <span className="text-4xl font-semibold text-white">
              £
              <NumberFlow value={fullPricePounds} className="text-4xl font-semibold" />
            </span>
            <span className="text-[#888] ml-1">/ card</span>
          </>
        )}
      </div>
      {tierPromo && <PromoBadge pct={tierPromo.pct} className="mt-2" />}
    </>
  );
}

/** Shared policy bands, without stale per-card money derived from seed tier prices. */
export function BulkDiscountGuide() {
  return (
    <div className="mt-12 max-w-3xl mx-auto text-center text-white">
      <h3 className="text-sm font-bold uppercase tracking-wider text-[#D4AF37] mb-3">Bulk discount tiers</h3>
      <div className="overflow-x-auto rounded-xl border border-[#333] bg-[#0f0e0b]">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className="p-3">Cards</th>
              <th className="p-3">Bulk discount</th>
            </tr>
          </thead>
          <tbody>
            {bulkDiscountTiers
              .filter((band) => band.percent > 0)
              .map((band) => (
                <tr key={band.minQty} className="border-t border-[#333]">
                  <td className="p-3">{band.label}</td>
                  <td className="p-3">{band.percent}%</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs mt-3">
        Applied to current grading fees at checkout. Your server-calculated quote includes eligible discounts. Vault
        Club and bulk discounts are mutually exclusive — the higher discount applies.
      </p>
    </div>
  );
}
