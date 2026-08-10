import { useQuery } from "@tanstack/react-query";
import { Link, useRoute } from "wouter";
import { ExternalLink, Mail, MapPin, Navigation, Phone, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  googleMapsDirectionsUrl,
  googleMapsSearchUrl,
  PublicShopCoordinateMap,
} from "@/components/partner/public-shop-coordinate-map";
import { partnerErrorMessage, publicPartnerShops } from "@/lib/partner-api";

export default function ShopProfilePage() {
  const [, params] = useRoute("/shops/:slug");
  const slug = params?.slug ?? "";
  const profile = useQuery({
    queryKey: ["/api/shops", slug],
    queryFn: () => publicPartnerShops.detail(slug),
    enabled: slug.length > 0,
  });

  if (profile.isLoading)
    return <main className="mx-auto max-w-5xl px-4 py-12 text-sm text-muted-foreground">Loading shop profile…</main>;
  if (profile.error || !profile.data)
    return (
      <main className="mx-auto max-w-5xl px-4 py-12">
        <p role="alert" className="text-sm text-destructive">
          {profile.error ? partnerErrorMessage(profile.error) : "Shop not found."}
        </p>
        <Button asChild className="mt-4" variant="outline">
          <Link href="/shops">Back to shop finder</Link>
        </Button>
      </main>
    );

  const shop = profile.data;
  const address = [shop.addressLine1, shop.addressLine2, shop.townCity, shop.county, shop.postcode]
    .filter(Boolean)
    .join(", ");
  const googleMaps = googleMapsSearchUrl(shop);
  const directions = googleMapsDirectionsUrl(shop);
  return (
    <main className="mx-auto max-w-5xl px-4 py-10 sm:py-14" data-testid="shop-profile-page">
      <Link href="/shops" className="text-sm text-primary">
        Back to shop finder
      </Link>
      <div className="mt-5 grid gap-6 lg:grid-cols-[1.4fr_0.8fr]">
        <section>
          <p className="text-xs font-semibold uppercase text-primary">MintVault Partner Network</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <h1 className="text-3xl font-semibold">{shop.displayName}</h1>
            {shop.verified && (
              <span className="inline-flex items-center gap-1 text-sm text-primary">
                <ShieldCheck className="h-4 w-4" />
                Verified MintVault Partner
              </span>
            )}
          </div>
          {shop.description && <p className="mt-5 whitespace-pre-wrap text-muted-foreground">{shop.description}</p>}
          <Card className="mt-6 rounded-md">
            <CardHeader>
              <CardTitle className="text-base">MintVault Quality Rating</CardTitle>
            </CardHeader>
            <CardContent>
              {shop.rating.available ? (
                <p>
                  <span className="text-2xl font-semibold">{shop.rating.rating?.toFixed(1)} / 5</span>
                  <span className="ml-2 text-sm text-muted-foreground">
                    {shop.rating.label} · based on {shop.rating.sampleSize} graded cards
                  </span>
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {shop.rating.label} · {shop.rating.sampleSize} of {shop.rating.minimumSample} cards graded
                </p>
              )}
            </CardContent>
          </Card>
          <section className="mt-8">
            <h2 className="text-lg font-semibold">Recently graded cards</h2>
            {shop.recentCards.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">No recent eligible cards are published yet.</p>
            ) : (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {shop.recentCards.map((card) => (
                  <Card key={card.certId} className="rounded-md">
                    <CardContent className="flex gap-3 p-3">
                      {card.frontImageUrl && (
                        <img src={card.frontImageUrl} alt="" className="h-20 w-14 rounded object-cover" />
                      )}
                      <div>
                        <Link href={`/cert/${card.certId}`} className="font-medium hover:text-primary">
                          {card.cardName || card.certId}
                        </Link>
                        <p className="text-sm text-muted-foreground">
                          {[card.cardSet, card.cardNumber, card.cardYear].filter(Boolean).join(" · ")}
                        </p>
                        {card.grade && <p className="mt-1 text-sm">Grade {card.grade}</p>}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </section>
        </section>
        <aside>
          <Card className="rounded-md">
            <CardHeader>
              <CardTitle className="text-base">Visit or contact</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <p className="flex gap-2">
                <MapPin className="h-4 w-4 shrink-0 text-primary" />
                {address || "Address available on request"}
              </p>
              <PublicShopCoordinateMap shops={[shop]} />
              {googleMaps && (
                <a href={googleMaps} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-primary">
                  <MapPin className="h-4 w-4" />
                  Open in Google Maps
                </a>
              )}
              {directions && (
                <a href={directions} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-primary">
                  <Navigation className="h-4 w-4" />
                  Get directions
                </a>
              )}
              {shop.distanceKm != null && <p>{shop.distanceKm.toFixed(1)} km away</p>}
              {shop.openingInfo && (
                <p>
                  <span className="font-medium">Opening hours</span>
                  <br />
                  {shop.openingInfo}
                </p>
              )}
              {shop.phone && (
                <a href={`tel:${shop.phone}`} className="flex items-center gap-2 text-primary">
                  <Phone className="h-4 w-4" />
                  {shop.phone}
                </a>
              )}
              {shop.email && (
                <a href={`mailto:${shop.email}`} className="flex items-center gap-2 text-primary">
                  <Mail className="h-4 w-4" />
                  {shop.email}
                </a>
              )}
              {shop.website && (
                <a
                  href={shop.website}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 text-primary"
                >
                  Website <ExternalLink className="h-4 w-4" />
                </a>
              )}
            </CardContent>
          </Card>
        </aside>
      </div>
    </main>
  );
}
