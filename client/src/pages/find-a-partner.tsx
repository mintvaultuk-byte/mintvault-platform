import { FormEvent, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ExternalLink, MapPin, Search, Store } from "lucide-react";
import { Link } from "wouter";
import SeoHead from "@/components/seo-head";
import { useFeatureFlags } from "@/hooks/use-feature-flags";
import type { PublicPartnerLocation } from "@shared/public-partner";

async function loadPartners(search: string): Promise<PublicPartnerLocation[]> {
  const query = search ? `?search=${encodeURIComponent(search)}` : "";
  const response = await fetch(`/api/public/partners${query}`);
  if (!response.ok) throw new Error(response.status === 404 ? "unavailable" : "request_failed");
  const body = (await response.json()) as { locations?: PublicPartnerLocation[] };
  return Array.isArray(body.locations) ? body.locations : [];
}

export default function FindAPartnerPage() {
  const { publicPartnerDirectoryLive } = useFeatureFlags();
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const query = useQuery({
    queryKey: ["/api/public/partners", search],
    queryFn: () => loadPartners(search),
    enabled: publicPartnerDirectoryLive,
    retry: false,
    staleTime: 0,
    gcTime: 60_000,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
  });

  const schema = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Find a MintVault Partner",
    url: "https://mintvaultuk.com/find-a-partner",
    description: "Find explicitly approved MintVault Partner shop locations in the UK.",
    mainEntity: query.data
      ? {
          "@type": "ItemList",
          numberOfItems: query.data.length,
          itemListElement: query.data.map((location, index) => ({
            "@type": "ListItem",
            position: index + 1,
            url: `https://mintvaultuk.com/partners/location/${location.publicRef}`,
            name: `${location.displayName} — ${location.locationName}`,
          })),
        }
      : undefined,
  };

  function submit(event: FormEvent) {
    event.preventDefault();
    setSearch(input.trim());
  }

  return (
    <div className="min-h-[70vh] bg-[#FAFAF8] text-[#171717]">
      <SeoHead
        title="Find a MintVault Partner | UK Grading Locations"
        description="Search approved MintVault Partner shops, view public location details, and open exact directions in Google Maps."
        canonical="/find-a-partner"
        noindex={!publicPartnerDirectoryLive}
        schema={schema}
      />
      <div className="mx-auto max-w-6xl px-5 py-12 sm:px-6 lg:py-16">
        <nav aria-label="Breadcrumb" className="mb-6 text-sm text-[#6B6253]">
          <Link href="/" className="underline underline-offset-4">Home</Link> <span aria-hidden="true">/</span>{" "}
          <span aria-current="page">Find a Partner</span>
        </nav>

        <div className="max-w-3xl">
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-[#765B00]">Public Partner Network</p>
          <h1 className="mt-3 font-display text-4xl font-semibold sm:text-5xl">Find a MintVault Partner</h1>
          <p className="mt-4 text-base leading-7 text-[#514B42]">
            Search shops that MintVault has explicitly approved for public display. Each result uses the Partner’s
            separately consented public details and never exposes an operational address by default.
          </p>
        </div>

        {!publicPartnerDirectoryLive ? (
          <section className="mt-10 rounded-xl border border-[#D8D2C7] bg-white p-6" role="status">
            <h2 className="text-xl font-semibold">Partner discovery is not available yet</h2>
            <p className="mt-2 text-[#514B42]">You can still submit cards directly to MintVault anywhere in the UK.</p>
            <Link href="/submit" className="mt-4 inline-flex min-h-11 items-center gap-2 font-semibold text-[#765B00] underline">
              Submit cards online <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </section>
        ) : (
          <>
            <form role="search" onSubmit={submit} className="mt-10 rounded-xl border border-[#D8D2C7] bg-white p-4 sm:p-5">
              <label htmlFor="partner-search" className="block text-sm font-semibold">
                Search by shop, town or postcode
              </label>
              <div className="mt-2 flex flex-col gap-3 sm:flex-row">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-3 top-3.5 h-5 w-5 text-[#6B6253]" aria-hidden="true" />
                  <input
                    id="partner-search"
                    value={input}
                    maxLength={80}
                    onChange={(event) => setInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        setSearch(input.trim());
                      }
                    }}
                    className="min-h-12 w-full rounded-md border border-[#AFA79A] bg-white pl-11 pr-3 text-base outline-none focus:ring-2 focus:ring-[#8A6A00]"
                    placeholder="Shop name, town or postcode"
                  />
                </div>
                <button type="submit" className="min-h-12 rounded-md bg-[#171717] px-6 font-semibold text-white focus:ring-2 focus:ring-[#8A6A00] focus:ring-offset-2">
                  Search
                </button>
                {search && (
                  <button
                    type="button"
                    className="min-h-12 rounded-md border border-[#AFA79A] px-5 font-semibold"
                    onClick={() => { setInput(""); setSearch(""); }}
                  >
                    Clear search
                  </button>
                )}
              </div>
            </form>

            <p className="mt-6 text-sm text-[#514B42]" aria-live="polite" aria-atomic="true">
              {query.isLoading ? "Loading Partner locations…" : query.error ? "Partner locations could not be loaded." : `${query.data?.length ?? 0} Partner location${query.data?.length === 1 ? "" : "s"} found`}
            </p>

            {query.error && (
              <button type="button" onClick={() => query.refetch()} className="mt-3 min-h-11 rounded-md border px-4 font-semibold">
                Try again
              </button>
            )}

            {!query.isLoading && !query.error && query.data?.length === 0 && (
              <section className="mt-6 rounded-xl border border-[#D8D2C7] bg-white p-6">
                <h2 className="text-xl font-semibold">No matching Partner locations</h2>
                <p className="mt-2 text-[#514B42]">Try a broader search or browse all approved locations.</p>
              </section>
            )}

            <div className="mt-6 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
              {!query.error && query.data?.map((location) => (
                <article key={location.publicRef} className="flex h-full flex-col rounded-xl border border-[#D8D2C7] bg-white p-5 shadow-sm">
                  <div className="flex items-start gap-3">
                    <Store className="mt-1 h-5 w-5 shrink-0 text-[#765B00]" aria-hidden="true" />
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wider text-[#765B00]">{location.designation}</p>
                      <h2 className="mt-1 text-xl font-semibold">{location.displayName}</h2>
                      <p className="mt-1 text-sm font-medium text-[#514B42]">{location.locationName}</p>
                    </div>
                  </div>
                  <div className="mt-4 flex gap-2 text-sm leading-6 text-[#514B42]">
                    <MapPin className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    {location.address ? <address className="not-italic">{location.address}</address> : <span>Serves {location.serviceArea}</span>}
                  </div>
                  <div className="mt-auto flex flex-wrap gap-3 pt-6">
                    <Link href={`/partners/location/${location.publicRef}`} className="inline-flex min-h-11 items-center gap-2 rounded-md bg-[#171717] px-4 py-2 text-sm font-semibold text-white">
                      View Partner <ArrowRight size={16} aria-hidden="true" />
                    </Link>
                    {location.mapsUrl && (
                      <a href={location.mapsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-2 rounded-md border border-[#AFA79A] px-4 py-2 text-sm font-semibold">
                        Google Maps <ExternalLink size={15} aria-hidden="true" />
                      </a>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </>
        )}

        <p className="mt-12 border-t border-[#D8D2C7] pt-6 text-sm text-[#514B42]">
          Run a TCG or collectibles shop? <Link href="/partners" className="font-semibold text-[#765B00] underline">Learn about Partner applications</Link>.
        </p>
      </div>
    </div>
  );
}
