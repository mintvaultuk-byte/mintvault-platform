import { MapPin } from "lucide-react";
import type { PublicPartnerShop } from "@/lib/partner-api";

type CoordinateShop = PublicPartnerShop & {
  addressLine1?: string | null;
  addressLine2?: string | null;
};

export type PublicShopMapPoint = {
  shop: CoordinateShop;
  left: number;
  top: number;
};

const MINIMUM_SPAN = 0.015;

function clamp(value: number, lower: number, upper: number): number {
  return Math.min(upper, Math.max(lower, value));
}

export function publicShopAddress(shop: CoordinateShop): string {
  return [shop.addressLine1, shop.addressLine2, shop.townCity, shop.county, shop.postcode, shop.country]
    .filter((part): part is string => Boolean(part))
    .join(", ");
}

export function googleMapsSearchUrl(shop: CoordinateShop): string | null {
  const query =
    shop.latitude != null && shop.longitude != null ? `${shop.latitude},${shop.longitude}` : publicShopAddress(shop);
  return query ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}` : null;
}

export function googleMapsDirectionsUrl(shop: CoordinateShop): string | null {
  const destination =
    shop.latitude != null && shop.longitude != null ? `${shop.latitude},${shop.longitude}` : publicShopAddress(shop);
  return destination ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}` : null;
}

/**
 * Returns a stable, padded coordinate plot for the public results currently on screen. This is a
 * provider-free map surface: it uses only HQ-approved shop coordinates and never geocodes or
 * persists a visitor's location. The outer padding keeps pins touchable at the edges.
 */
export function publicShopMapPoints(shops: CoordinateShop[]): PublicShopMapPoint[] {
  const coordinateShops = shops.filter(
    (shop): shop is CoordinateShop & { latitude: number; longitude: number } =>
      shop.latitude != null && shop.longitude != null
  );
  if (coordinateShops.length === 0) return [];

  const latitudes = coordinateShops.map((shop) => shop.latitude);
  const longitudes = coordinateShops.map((shop) => shop.longitude);
  const centreLatitude = (Math.min(...latitudes) + Math.max(...latitudes)) / 2;
  const centreLongitude = (Math.min(...longitudes) + Math.max(...longitudes)) / 2;
  const latitudeSpan = Math.max(Math.max(...latitudes) - Math.min(...latitudes), MINIMUM_SPAN);
  const longitudeSpan = Math.max(Math.max(...longitudes) - Math.min(...longitudes), MINIMUM_SPAN);
  const minLatitude = centreLatitude - latitudeSpan / 2;
  const minLongitude = centreLongitude - longitudeSpan / 2;
  const duplicateCoordinates = new Map<string, number>();

  return coordinateShops.map((shop) => {
    const coordinateKey = `${shop.latitude}:${shop.longitude}`;
    const occurrence = duplicateCoordinates.get(coordinateKey) ?? 0;
    duplicateCoordinates.set(coordinateKey, occurrence + 1);
    // Two approved shops can share a building. Offset only the visual pin, keeping the source
    // coordinates and outbound Google Maps target exact.
    const overlapOffset = occurrence === 0 ? 0 : (((occurrence - 1) % 3) - 1) * 2.2;
    return {
      shop,
      left: clamp(8 + ((shop.longitude - minLongitude) / longitudeSpan) * 84 + overlapOffset, 5, 95),
      top: clamp(92 - ((shop.latitude - minLatitude) / latitudeSpan) * 84 + overlapOffset, 5, 95),
    };
  });
}

export function PublicShopCoordinateMap({
  shops,
  selectedSlug,
  onSelect,
  className = "",
}: {
  shops: CoordinateShop[];
  selectedSlug?: string | null;
  onSelect?: (shop: CoordinateShop) => void;
  className?: string;
}) {
  const points = publicShopMapPoints(shops);
  if (points.length === 0) {
    return (
      <div
        className={`rounded-md border border-dashed bg-muted/30 p-5 text-sm text-muted-foreground ${className}`}
        data-testid="public-shop-coordinate-map-empty"
      >
        Map pins appear when a shop has administrator-approved coordinates. Shops without coordinates remain available
        in the list.
      </div>
    );
  }

  const selected = points.find((point) => point.shop.slug === selectedSlug)?.shop ?? points[0]!.shop;
  return (
    <div
      className={`relative min-h-72 overflow-hidden rounded-md border bg-gradient-to-br from-primary/10 via-background to-primary/5 ${className}`}
      data-testid="public-shop-coordinate-map"
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 opacity-40 [background-image:linear-gradient(to_right,hsl(var(--border))_1px,transparent_1px),linear-gradient(to_bottom,hsl(var(--border))_1px,transparent_1px)] [background-size:3rem_3rem]"
      />
      <p className="absolute left-4 top-3 max-w-56 text-xs text-muted-foreground">
        Approximate positions from approved shop coordinates
      </p>
      <div className="absolute inset-0" aria-label="Map of approved MintVault Partner shops" role="region">
        {points.map((point) => {
          const active = point.shop.slug === selected.slug;
          return (
            <button
              aria-label={`Select ${point.shop.displayName} on the map`}
              aria-pressed={active}
              className={`absolute grid h-11 w-11 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                active
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background text-primary hover:border-primary"
              }`}
              data-testid={`public-shop-map-pin-${point.shop.slug}`}
              key={point.shop.slug}
              onClick={() => onSelect?.(point.shop)}
              style={{ left: `${point.left}%`, top: `${point.top}%` }}
              type="button"
            >
              <MapPin className="h-5 w-5" />
            </button>
          );
        })}
      </div>
    </div>
  );
}
