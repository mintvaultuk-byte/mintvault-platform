import { useQuery } from "@tanstack/react-query";

export type TierPromo = { pct: number; originalPrice: number; discountedPrice: number };
export type ActivePromo = { bannerText: string; tiers: Record<string, TierPromo> };

/**
 * Single shared source of the active promotion for EVERY pricing surface
 * (homepage tiers, /pricing, …). The server computes the discounted prices —
 * the client never does money math. A missing or failed lookup returns null so
 * every surface falls back to full price unchanged.
 *
 * All surfaces share one cache entry; failed or pending refreshes hide the offer.
 */
export function useActivePromo(): ActivePromo | null {
  const { data, isError, isFetching } = useQuery<{ promo: ActivePromo | null }>({
    queryKey: ["/api/promotions/active"],
    queryFn: async () => {
      const res = await fetch("/api/promotions/active", { cache: "no-store" });
      if (!res.ok) return { promo: null };
      const body = await res.json();
      if (body?.promo === null) return { promo: null };
      if (
        typeof body?.promo?.bannerText !== "string" ||
        !body.promo.tiers ||
        typeof body.promo.tiers !== "object" ||
        Array.isArray(body.promo.tiers)
      ) {
        throw new Error("Invalid active promotion response");
      }
      return body;
    },
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchInterval: 60_000,
    retry: false,
  });
  return isError || isFetching ? null : (data?.promo ?? null);
}

/** The active promo's discount for a given grading tier id, or undefined. */
export function getTierPromo(
  promo: ActivePromo | null,
  tierId: string,
  currentPricePence: number
): TierPromo | undefined {
  const offer = promo?.tiers?.[tierId];
  if (
    !offer ||
    !Number.isSafeInteger(offer.originalPrice) ||
    offer.originalPrice !== currentPricePence ||
    !Number.isFinite(offer.pct) ||
    offer.pct <= 0 ||
    offer.pct > 100 ||
    !Number.isSafeInteger(offer.discountedPrice) ||
    offer.discountedPrice < 0 ||
    offer.discountedPrice !== offer.originalPrice - Math.round((offer.originalPrice * offer.pct) / 100)
  )
    return undefined;
  return offer;
}
