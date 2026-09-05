import { useQuery } from "@tanstack/react-query";
import { formatTierPrice, type LivePricingTier } from "@shared/commerce";

const EMPTY_TIERS: LivePricingTier[] = [];

export async function fetchPricingProjection(serviceType: string, signal?: AbortSignal): Promise<LivePricingTier[]> {
  const response = await fetch(`/api/service-tiers?serviceType=${encodeURIComponent(serviceType)}`, {
    credentials: "include",
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new Error("Current pricing is unavailable");
  const rows: unknown = await response.json();
  if (
    !Array.isArray(rows) ||
    !rows.every(
      (row) =>
        row &&
        typeof row === "object" &&
        row.serviceType === serviceType &&
        typeof row.id === "string" &&
        typeof row.name === "string" &&
        typeof row.price === "string" &&
        Number.isSafeInteger(row.pricePerCard) &&
        row.pricePerCard > 0 &&
        row.price === formatTierPrice(row.pricePerCard) &&
        Number.isSafeInteger(row.turnaroundDays) &&
        row.turnaroundDays > 0 &&
        typeof row.turnaround === "string" &&
        typeof row.recommendedCardValue === "string" &&
        typeof row.capacityStatus === "string" &&
        Array.isArray(row.features) &&
        (row.capacityPausedUntil === null || typeof row.capacityPausedUntil === "string") &&
        (row.capacityMessage === null || typeof row.capacityMessage === "string") &&
        row.features.every((feature: unknown) => typeof feature === "string")
    )
  )
    throw new Error("Invalid current pricing response");
  return rows as LivePricingTier[];
}

/** Display-only live catalogue; never falls back to seed prices or a previous service. */
export function usePricingProjection(serviceType = "grading", enabled = true) {
  const query = useQuery({
    queryKey: ["/api/service-tiers", serviceType],
    queryFn: ({ signal }) => fetchPricingProjection(serviceType, signal),
    enabled: enabled && !!serviceType,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchInterval: 60_000,
    retry: false,
  });
  return { ...query, tiers: query.isError || !enabled ? EMPTY_TIERS : (query.data ?? EMPTY_TIERS) };
}
