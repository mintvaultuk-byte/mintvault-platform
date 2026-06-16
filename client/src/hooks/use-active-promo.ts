import { useQuery } from "@tanstack/react-query";

export type TierPromo = { pct: number; originalPrice: number; discountedPrice: number };
export type ActivePromo = { bannerText: string; tiers: Record<string, TierPromo> };

/**
 * Single shared source of the active promotion for EVERY pricing surface
 * (homepage tiers, /pricing, …). The server computes the discounted prices —
 * the client never does money math. A missing or failed lookup returns null so
 * every surface falls back to full price unchanged.
 *
 * Mirrors the fetch /pricing originally used (GET /api/promotions/active,
 * 60s stale) so all surfaces share one cache entry rather than re-fetching.
 */
export function useActivePromo(): ActivePromo | null {
  const { data } = useQuery<{ promo: ActivePromo | null }>({
    queryKey: ["/api/promotions/active"],
    queryFn: async () => {
      const res = await fetch("/api/promotions/active");
      if (!res.ok) return { promo: null };
      return res.json();
    },
    staleTime: 60_000,
  });
  return data?.promo ?? null;
}

/** The active promo's discount for a given grading tier id, or undefined. */
export function getTierPromo(promo: ActivePromo | null, tierId: string): TierPromo | undefined {
  return promo?.tiers?.[tierId];
}
