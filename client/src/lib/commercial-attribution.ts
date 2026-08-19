/** Query-only campaign continuity for GB-04. Nothing is stored in the browser. */
export const ATTRIBUTION_QUERY_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
] as const;

export type ClientAttribution = Partial<Record<(typeof ATTRIBUTION_QUERY_KEYS)[number], string>>;

const ALLOWED_BY_KEY: Record<(typeof ATTRIBUTION_QUERY_KEYS)[number], ReadonlySet<string>> = {
  utm_source: new Set([
    "direct", "organic", "google", "bing", "outreach", "partner-outreach", "creator", "referral", "social", "email",
    "instagram", "tiktok", "youtube", "facebook", "newsletter", "other",
  ]),
  utm_medium: new Set(["direct", "organic", "search", "outreach", "partner-outreach", "creator", "referral", "social", "email", "instagram"]),
  utm_campaign: new Set([
    "gb04-launch", "founding-partners", "medway_cataclysm", "creator-pilot", "partner-outreach", "organic-discovery",
    "social-pilot", "email-pilot", "referral-pilot",
  ]),
  utm_content: new Set(["cta-a", "cta-b", "variant-a", "variant-b"]),
  utm_term: new Set(["cta-a", "cta-b", "variant-a", "variant-b"]),
};

/** Mirrors the server's token-only privacy boundary before continuity occurs. */
export function cleanClientAttributionValue(value: string | null, allowed: ReadonlySet<string>): string | undefined {
  if (!value) return undefined;
  const candidate = value.trim().toLowerCase();
  if (candidate.length === 0 || candidate.length > 64) return undefined;
  if (candidate.includes("@") || candidate.includes("://") || candidate.startsWith("www.")) return undefined;
  const digitCount = [...candidate].filter((character) => character >= "0" && character <= "9").length;
  if (digitCount >= 7) return undefined;
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(candidate) && allowed.has(candidate) ? candidate : undefined;
}

export function attributionFromSearch(search: string): ClientAttribution {
  const params = new URLSearchParams(search);
  return ATTRIBUTION_QUERY_KEYS.reduce<ClientAttribution>((result, key) => {
    const value = cleanClientAttributionValue(params.get(key), ALLOWED_BY_KEY[key]);
    if (value) result[key] = value;
    return result;
  }, {});
}

export function submitUrlWithAttribution(destination: string, sourceSearch: string): string {
  const target = new URL(destination, window.location.origin);
  const attribution = attributionFromSearch(sourceSearch);
  for (const [key, value] of Object.entries(attribution)) {
    if (!target.searchParams.has(key)) target.searchParams.set(key, value);
  }
  return `${target.pathname}${target.search}${target.hash}`;
}
