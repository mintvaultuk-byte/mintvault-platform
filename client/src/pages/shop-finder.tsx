import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ExternalLink, LocateFixed, MapPin, Navigation, Search, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  googleMapsDirectionsUrl,
  googleMapsSearchUrl,
  PublicShopCoordinateMap,
  publicShopAddress,
} from "@/components/partner/public-shop-coordinate-map";
import { partnerErrorMessage, publicPartnerShops, type PublicPartnerRating } from "@/lib/partner-api";

function Rating({ rating }: { rating: PublicPartnerRating }) {
  if (!rating.available) {
    return (
      <p className="text-sm text-muted-foreground">
        {rating.label} · {rating.sampleSize} of {rating.minimumSample} cards graded
      </p>
    );
  }
  return (
    <p className="text-sm">
      <span className="font-semibold">{rating.rating?.toFixed(1)} / 5</span> · {rating.label} · based on{" "}
      {rating.sampleSize} graded cards
    </p>
  );
}

export default function ShopFinderPage() {
  const [submitted, setSubmitted] = useState({
    q: "",
    postcode: "",
    town: "",
    county: "",
    lat: undefined as number | undefined,
    lng: undefined as number | undefined,
  });
  const [form, setForm] = useState(submitted);
  const [selectedMapShopSlug, setSelectedMapShopSlug] = useState<string | null>(null);
  const finder = useQuery({ queryKey: ["/api/shops", submitted], queryFn: () => publicPartnerShops.find(submitted) });
  const selectedMapShop =
    finder.data?.rows.find(
      (shop) => shop.slug === selectedMapShopSlug && shop.latitude != null && shop.longitude != null
    ) ??
    finder.data?.rows.find((shop) => shop.latitude != null && shop.longitude != null) ??
    null;

  function useLocation() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const next = { ...form, lat: coords.latitude, lng: coords.longitude };
        setForm(next);
        setSubmitted(next);
      },
      () => undefined,
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 }
    );
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-10 sm:py-14" data-testid="shop-finder-page">
      <div className="max-w-2xl">
        <p className="text-xs font-semibold uppercase text-primary">MintVault Partner Network</p>
        <h1 className="mt-2 text-3xl font-semibold text-foreground">Find a MintVault Grading Shop</h1>
        <p className="mt-3 text-muted-foreground">
          Find a verified MintVault Partner for in-person card intake and grading services.
        </p>
      </div>

      <form
        className="mt-8 grid gap-3 rounded-md border bg-card p-4 sm:grid-cols-2 lg:grid-cols-5"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(form);
        }}
      >
        <div className="space-y-1.5 lg:col-span-2">
          <Label htmlFor="shop-query">Shop name</Label>
          <Input id="shop-query" value={form.q} onChange={(event) => setForm({ ...form, q: event.target.value })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="shop-postcode">Postcode</Label>
          <Input
            id="shop-postcode"
            value={form.postcode}
            onChange={(event) => setForm({ ...form, postcode: event.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="shop-town">Town</Label>
          <Input
            id="shop-town"
            value={form.town}
            onChange={(event) => setForm({ ...form, town: event.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="shop-county">County</Label>
          <Input
            id="shop-county"
            value={form.county}
            onChange={(event) => setForm({ ...form, county: event.target.value })}
          />
        </div>
        <div className="flex flex-wrap items-end gap-2 lg:col-span-5">
          <Button type="submit">
            <Search className="mr-2 h-4 w-4" />
            Search
          </Button>
          <Button type="button" variant="outline" onClick={useLocation}>
            <LocateFixed className="mr-2 h-4 w-4" />
            Use my location
          </Button>
        </div>
      </form>

      <section className="mt-8" aria-live="polite">
        {finder.isLoading && <p className="text-sm text-muted-foreground">Finding grading shops…</p>}
        {finder.error && (
          <p role="alert" className="text-sm text-destructive">
            {partnerErrorMessage(finder.error)}
          </p>
        )}
        {finder.data && (
          <>
            <p className="mb-3 text-sm text-muted-foreground">
              {finder.data.total} shop{finder.data.total === 1 ? "" : "s"} found
            </p>
            {finder.data.rows.length === 0 ? (
              <Card>
                <CardContent className="p-6 text-sm text-muted-foreground">
                  No active MintVault Partner shops match this search.
                </CardContent>
              </Card>
            ) : (
              <div className="grid gap-5 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
                <div className="space-y-3 lg:sticky lg:top-4">
                  <PublicShopCoordinateMap
                    onSelect={(shop) => setSelectedMapShopSlug(shop.slug)}
                    selectedSlug={selectedMapShop?.slug}
                    shops={finder.data.rows}
                  />
                  {selectedMapShop && (
                    <Card className="rounded-md" data-testid="public-shop-map-selection">
                      <CardContent className="space-y-3 p-4">
                        <div>
                          <p className="font-semibold">{selectedMapShop.displayName}</p>
                          <p className="mt-1 text-sm text-muted-foreground">{publicShopAddress(selectedMapShop)}</p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button asChild size="sm" variant="outline">
                            <Link href={`/shops/${selectedMapShop.slug}`}>View shop profile</Link>
                          </Button>
                          <Button asChild size="sm" variant="outline">
                            <a href={googleMapsSearchUrl(selectedMapShop)!} rel="noreferrer" target="_blank">
                              Open in Google Maps <ExternalLink className="ml-1 h-3.5 w-3.5" />
                            </a>
                          </Button>
                          <Button asChild size="sm">
                            <a href={googleMapsDirectionsUrl(selectedMapShop)!} rel="noreferrer" target="_blank">
                              Get directions <Navigation className="ml-1 h-3.5 w-3.5" />
                            </a>
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  )}
                </div>
                <div className="grid gap-3">
                  {finder.data.rows.map((shop) => (
                    <Card key={shop.slug} className="rounded-md">
                      <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
                        <div className="space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <h2 className="font-semibold">{shop.displayName}</h2>
                            {shop.verified && (
                              <span className="inline-flex items-center gap-1 text-xs text-primary">
                                <ShieldCheck className="h-3.5 w-3.5" />
                                Verified MintVault Partner
                              </span>
                            )}
                          </div>
                          <p className="flex items-center gap-1 text-sm text-muted-foreground">
                            <MapPin className="h-4 w-4" />
                            {[shop.townCity, shop.county, shop.postcode].filter(Boolean).join(", ")}
                          </p>
                          {shop.distanceKm != null && (
                            <p className="text-sm text-muted-foreground">{shop.distanceKm.toFixed(1)} km away</p>
                          )}
                          <Rating rating={shop.rating} />
                        </div>
                        <Button asChild variant="outline">
                          <Link href={`/shops/${shop.slug}`}>View shop</Link>
                        </Button>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}
