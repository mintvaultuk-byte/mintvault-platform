import { ExternalLink, Globe, Mail, MapPin, Phone, ShieldCheck } from "lucide-react";
import type { PublicPartnerLocation } from "@shared/public-partner";

/** The one customer-visible profile renderer. Authenticated previews mount this
 * exact component, so there is no second approximation that can hide a leak. */
export function PublicPartnerProfileView({ location }: { location: PublicPartnerLocation }) {
  const telephoneHref = location.phone ? `tel:${location.phone.replace(/[^+\d]/g, "")}` : null;
  return (
    <div className="grid gap-8 lg:grid-cols-[1.45fr_0.8fr]">
      <div>
        <p className="inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] text-[#765B00]">
          <ShieldCheck className="h-5 w-5" aria-hidden="true" /> {location.designation}
        </p>
        <h1 className="mt-4 font-display text-4xl font-semibold sm:text-5xl">{location.displayName}</h1>
        <p className="mt-3 text-xl text-[#514B42]">{location.locationName}</p>

        <section aria-labelledby="partner-contact-heading" className="mt-10 rounded-xl border border-[#D8D2C7] bg-white p-6">
          <h2 id="partner-contact-heading" className="text-2xl font-semibold">
            {location.address ? "Visit this Partner" : "Contact this Partner"}
          </h2>
          {location.address && (
            <address className="mt-4 flex gap-3 not-italic leading-7 text-[#3F3A33]">
              <MapPin className="mt-1 h-5 w-5 shrink-0 text-[#765B00]" aria-hidden="true" /> {location.address}
            </address>
          )}
          {location.serviceArea && (
            <p className="mt-4 flex gap-3 leading-7 text-[#3F3A33]">
              <MapPin className="mt-1 h-5 w-5 shrink-0 text-[#765B00]" aria-hidden="true" /> Serves {location.serviceArea}. The operating address is private.
            </p>
          )}
          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            {location.mapsUrl && (
              <a href={location.mapsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md bg-[#171717] px-5 py-3 font-semibold text-white">
                Get directions <ExternalLink size={16} aria-hidden="true" />
              </a>
            )}
            {location.websiteUrl && (
              <a href={location.websiteUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md border border-[#AFA79A] px-5 py-3 font-semibold">
                Visit website <Globe size={16} aria-hidden="true" />
              </a>
            )}
            {location.phone && telephoneHref && (
              <a href={telephoneHref} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md border border-[#AFA79A] px-5 py-3 font-semibold">
                Call shop <Phone size={16} aria-hidden="true" />
              </a>
            )}
            {location.email && (
              <a href={`mailto:${location.email}`} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md border border-[#AFA79A] px-5 py-3 font-semibold">
                Contact shop <Mail size={16} aria-hidden="true" />
              </a>
            )}
          </div>
          {!location.mapsUrl && !location.websiteUrl && !location.phone && !location.email && (
            <p className="mt-6 text-sm text-[#514B42]">No public contact action is currently available for this location.</p>
          )}
        </section>
      </div>

      <aside className="rounded-xl border border-[#D8D2C7] bg-white p-6 lg:self-start" aria-label="Partner details">
        <h2 className="text-lg font-semibold">MintVault Partner details</h2>
        <dl className="mt-5 space-y-4 text-sm">
          <div><dt className="font-semibold">Public status</dt><dd className="mt-1 text-[#514B42]">Approved Partner location</dd></div>
          {location.cardsGraded != null && (
            <div>
              <dt className="font-semibold">Cards graded through this MintVault Partner</dt>
              <dd className="mt-1 text-2xl font-semibold">{location.cardsGraded.toLocaleString("en-GB")}</dd>
            </div>
          )}
        </dl>
        <p className="mt-6 border-t border-[#D8D2C7] pt-5 text-xs leading-5 text-[#6B6253]">
          {location.cardsGradedMeaning}. MintVault approves the resulting grades and certificates. Ratings and opening hours are omitted because no approved authority is connected.
        </p>
      </aside>
    </div>
  );
}
