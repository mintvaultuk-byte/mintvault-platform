/**
 * One transport-free definition of a shop's delivery address. New first-shop
 * onboarding writes these values to the existing `partner_locations` record;
 * no profile or client-only shadow address is introduced.
 */
export interface PartnerDeliveryAddressInput {
  line1: string;
  line2?: string | null;
  city: string;
  postcode: string;
  country: string;
}
export interface PartnerDeliveryAddress extends Required<Omit<PartnerDeliveryAddressInput, "line2">> {
  line2: string | null;
}

const UK = /^(?:UNITED KINGDOM|UK|GB|GREAT BRITAIN)$/i;
const UK_POSTCODE = /^(?:GIR 0AA|[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2})$/;

export function normalisePartnerPostcode(value: string): string {
  const compact = value.trim().toUpperCase().replace(/\s+/g, "");
  return compact.length > 3 ? `${compact.slice(0, -3)} ${compact.slice(-3)}` : compact;
}

export function isValidPartnerPostcode(postcode: string, country: string): boolean {
  const value = normalisePartnerPostcode(postcode);
  if (UK.test(country.trim())) return UK_POSTCODE.test(value);
  // Country-specific postal databases are not embedded in the client. For a
  // non-UK shop, require a real bounded alphanumeric postal identifier rather
  // than pretending that a UK-only regex validates the world.
  return /^[A-Z0-9][A-Z0-9 .-]{1,30}[A-Z0-9]$/.test(value);
}

function field(value: string | null | undefined, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

/** Null means invalid or incomplete. This is deliberately strict and side-effect free. */
export function normalisePartnerDeliveryAddress(input: PartnerDeliveryAddressInput): PartnerDeliveryAddress | null {
  const line1 = field(input.line1, 200);
  const city = field(input.city, 120);
  const country = field(input.country, 120);
  const rawPostcode = field(input.postcode, 32);
  const line2 = input.line2 == null || input.line2.trim() === "" ? null : field(input.line2, 200);
  if (!line1 || !city || !country || !rawPostcode || (input.line2 != null && input.line2.trim() !== "" && !line2)) return null;
  const postcode = normalisePartnerPostcode(rawPostcode);
  if (!isValidPartnerPostcode(postcode, country)) return null;
  return { line1, line2, city, postcode, country };
}

export function formatPartnerDeliveryAddress(address: PartnerDeliveryAddress): string {
  return [address.line1, address.line2, address.city, address.postcode, address.country].filter(Boolean).join(", ");
}

export function isCompletePartnerDeliveryAddress(value: {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  postcode?: string | null;
  country?: string | null;
}): boolean {
  return (
    normalisePartnerDeliveryAddress({
      line1: value.line1 ?? "",
      line2: value.line2 ?? null,
      city: value.city ?? "",
      postcode: value.postcode ?? "",
      country: value.country ?? "",
    }) !== null
  );
}
