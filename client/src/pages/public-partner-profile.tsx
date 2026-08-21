import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { Link } from "wouter";
import SeoHead from "@/components/seo-head";
import { PublicPartnerProfileView } from "@/components/public-partner-profile-view";
import type { PublicPartnerLocation } from "@shared/public-partner";

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
  const errorKind = query.error instanceof Error ? query.error.message : null;

  if (query.isLoading) {
    return <div className="min-h-[60vh] bg-[#FAFAF8] px-6 py-16 text-[#171717]" role="status">Loading Partner profile…</div>;
  }
  if (errorKind === "request_failed") {
    return (
      <div className="min-h-[60vh] bg-[#FAFAF8] px-6 py-16 text-[#171717]">
        <SeoHead title="Partner profile temporarily unavailable | MintVault UK" description="This Partner profile is temporarily unavailable." noindex />
        <div className="mx-auto max-w-3xl" role="alert" aria-live="assertive">
          <h1 className="text-3xl font-semibold">Partner profile temporarily unavailable</h1>
          <p className="mt-3 text-[#514B42]">The public directory could not be reached. This does not mean the Partner was removed or made private.</p>
          <button
            type="button"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
            className="mt-6 min-h-11 rounded-md border border-[#AFA79A] px-5 font-semibold disabled:opacity-60"
          >
            {query.isFetching ? "Trying again…" : "Try again"}
          </button>
          <Link href="/find-a-partner" className="ml-4 mt-6 inline-flex min-h-11 items-center gap-2 font-semibold text-[#765B00] underline">
            <ArrowLeft size={16} aria-hidden="true" /> Back to Partner search
          </Link>
        </div>
      </div>
    );
  }
  if (!location || errorKind === "not_found") {
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
  const description = location.address
    ? `${location.displayName} is an approved MintVault Partner location at ${location.address}. View public shop details.`
    : `${location.displayName} is an approved MintVault Partner serving ${location.serviceArea}. View public contact details.`;
  const canonical = `/partners/location/${location.publicRef}`;
  const localBusiness: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    name: location.displayName,
    url: `https://mintvaultuk.com${canonical}`,
    parentOrganization: { "@type": "Organization", name: "MintVault UK", url: "https://mintvaultuk.com" },
  };
  if (location.address) localBusiness.address = { "@type": "PostalAddress", streetAddress: location.address, addressCountry: "GB" };
  if (location.serviceArea) localBusiness.areaServed = location.serviceArea;
  if (location.mapsUrl) localBusiness.hasMap = location.mapsUrl;
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

        <PublicPartnerProfileView location={location} />
      </div>
    </div>
  );
}
