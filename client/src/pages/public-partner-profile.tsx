import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Globe, Mail, MapPin, Phone, ShieldCheck } from "lucide-react";
import { Link } from "wouter";
import SeoHead from "@/components/seo-head";
import type { PublicPartnerLocation } from "./find-a-partner";

async function loadPartner(publicRef: string): Promise<PublicPartnerLocation> {
  const response = await fetch(`/api/public/partners/${encodeURIComponent(publicRef)}`);
  if (!response.ok) throw new Error(response.status === 404 ? "not_found" : "request_failed");
  const body = (await response.json()) as { location: PublicPartnerLocation };
  return body.location;
}

export default function PublicPartnerProfilePage({ params }: { params: { publicRef: string } }) {
  const query = useQuery({
    queryKey: ["/api/public/partners", params.publicRef],
    queryFn: () => loadPartner(params.publicRef),
    retry: false,
    staleTime: 0,
    gcTime: 60_000,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
  });
  const location = query.data;

  if (query.isLoading) {
    return <div className="min-h-[60vh] bg-[#FAFAF8] px-6 py-16 text-[#171717]" role="status">Loading Partner profile…</div>;
  }
  if (!location || query.error) {
    return (
      <div className="min-h-[60vh] bg-[#FAFAF8] px-6 py-16 text-[#171717]">
        <SeoHead title="Partner not found | MintVault UK" description="This Partner profile is not available." noindex />
        <div className="mx-auto max-w-3xl">
          <h1 className="text-3xl font-semibold">Partner profile not available</h1>
          <p className="mt-3 text-[#514B42]">The location may be private, inactive, or no longer listed.</p>
          <Link href="/find-a-partner" className="mt-6 inline-flex min-h-11 items-center gap-2 font-semibold text-[#765B00] underline">
            <ArrowLeft size={16} aria-hidden="true" /> Find another Partner
          </Link>
        </div>
      </div>
    );
  }

  const title = `${location.displayName} — ${location.locationName} | MintVault Partner`;
  const description = `${location.displayName} is an approved MintVault Partner location at ${location.address}. Get directions and public shop contact details.`;
  const canonical = `/partners/location/${location.publicRef}`;
  const localBusiness: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    name: location.displayName,
    url: `https://mintvaultuk.com${canonical}`,
    address: { "@type": "PostalAddress", streetAddress: location.address, addressCountry: "GB" },
    hasMap: location.mapsUrl,
    parentOrganization: { "@type": "Organization", name: "MintVault UK", url: "https://mintvaultuk.com" },
  };
  if (location.phone) localBusiness.telephone = location.phone;
  if (location.email) localBusiness.email = location.email;
  if (location.websiteUrl) localBusiness.sameAs = [location.websiteUrl];

  return (
    <div className="min-h-[70vh] bg-[#FAFAF8] text-[#171717]">
      <SeoHead title={title} description={description} canonical={canonical} ogType="business.business" schema={[
        localBusiness,
        {
          "@context": "https://schema.org",
          "@type": "BreadcrumbList",
          itemListElement: [
            { "@type": "ListItem", position: 1, name: "Home", item: "https://mintvaultuk.com" },
            { "@type": "ListItem", position: 2, name: "Find a Partner", item: "https://mintvaultuk.com/find-a-partner" },
            { "@type": "ListItem", position: 3, name: location.locationName },
          ],
        },
      ]} />

      <div className="mx-auto max-w-5xl px-5 py-12 sm:px-6 lg:py-16">
        <nav aria-label="Breadcrumb" className="mb-8 text-sm text-[#6B6253]">
          <Link href="/" className="underline">Home</Link> <span aria-hidden="true">/</span>{" "}
          <Link href="/find-a-partner" className="underline">Find a Partner</Link> <span aria-hidden="true">/</span>{" "}
          <span aria-current="page">{location.locationName}</span>
        </nav>

        <div className="grid gap-8 lg:grid-cols-[1.45fr_0.8fr]">
          <div>
            <p className="inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] text-[#765B00]">
              <ShieldCheck className="h-5 w-5" aria-hidden="true" /> {location.designation}
            </p>
            <h1 className="mt-4 font-display text-4xl font-semibold sm:text-5xl">{location.displayName}</h1>
            <p className="mt-3 text-xl text-[#514B42]">{location.locationName}</p>

            <section aria-labelledby="visit-heading" className="mt-10 rounded-xl border border-[#D8D2C7] bg-white p-6">
              <h2 id="visit-heading" className="text-2xl font-semibold">Visit this Partner</h2>
              <address className="mt-4 flex gap-3 not-italic leading-7 text-[#3F3A33]">
                <MapPin className="mt-1 h-5 w-5 shrink-0 text-[#765B00]" aria-hidden="true" /> {location.address}
              </address>
              <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                <a href={location.mapsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md bg-[#171717] px-5 py-3 font-semibold text-white">
                  Get directions <ExternalLink size={16} aria-hidden="true" />
                </a>
                {location.websiteUrl && (
                  <a href={location.websiteUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md border border-[#AFA79A] px-5 py-3 font-semibold">
                    Visit website <Globe size={16} aria-hidden="true" />
                  </a>
                )}
                {location.phone && (
                  <a href={`tel:${location.phone.replace(/[^+\d]/g, "")}`} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md border border-[#AFA79A] px-5 py-3 font-semibold">
                    Contact shop <Phone size={16} aria-hidden="true" />
                  </a>
                )}
                {location.email && (
                  <a href={`mailto:${location.email}`} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md border border-[#AFA79A] px-5 py-3 font-semibold">
                    Email shop <Mail size={16} aria-hidden="true" />
                  </a>
                )}
              </div>
            </section>
          </div>

          <aside className="rounded-xl border border-[#D8D2C7] bg-white p-6 lg:self-start" aria-label="Partner details">
            <h2 className="text-lg font-semibold">MintVault Partner details</h2>
            <dl className="mt-5 space-y-4 text-sm">
              <div><dt className="font-semibold">Public status</dt><dd className="mt-1 text-[#514B42]">Approved Partner location</dd></div>
              {location.partnerSince && <div><dt className="font-semibold">Partner since</dt><dd className="mt-1 text-[#514B42]">{new Date(`${location.partnerSince}T00:00:00Z`).getUTCFullYear()}</dd></div>}
              {location.cardsGraded != null && <div><dt className="font-semibold">Cards graded here</dt><dd className="mt-1 text-2xl font-semibold">{location.cardsGraded.toLocaleString("en-GB")}</dd></div>}
            </dl>
            <p className="mt-6 border-t border-[#D8D2C7] pt-5 text-xs leading-5 text-[#6B6253]">
              Public details come from MintVault’s approved Partner and certificate-origin records. Ratings and opening hours are omitted unless an authoritative source is connected.
            </p>
          </aside>
        </div>
      </div>
    </div>
  );
}
