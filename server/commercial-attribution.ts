/**
 * GB-04 first-party commercial attribution.
 *
 * Campaign context is deliberately tiny: controlled MintVault identifiers only,
 * no cookies, browser identifiers, IP addresses, referrers or customer data.
 * It is optional at capture time and never becomes payment authority.
 */
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { APP_BASE_URL } from "./app-url";

export const ACQUISITION_CATEGORIES = [
  "DIRECT",
  "ORGANIC",
  "PARTNER_OUTREACH",
  "CREATOR",
  "REFERRAL",
  "SOCIAL",
  "EMAIL",
  "OTHER",
] as const;

export type AcquisitionCategory = (typeof ACQUISITION_CATEGORIES)[number];

export const APPROVED_SOURCE_CODES = [
  "direct",
  "organic",
  "google",
  "bing",
  "outreach",
  "partner-outreach",
  "creator",
  "referral",
  "social",
  "email",
  "instagram",
  "tiktok",
  "youtube",
  "facebook",
  "newsletter",
  "other",
] as const;

export const APPROVED_MEDIUM_CODES = [
  "direct",
  "organic",
  "search",
  "outreach",
  "partner-outreach",
  "creator",
  "referral",
  "social",
  "email",
  "instagram",
] as const;

export const APPROVED_CAMPAIGN_CODES = [
  "gb04-launch",
  "founding-partners",
  "medway_cataclysm",
  "creator-pilot",
  "partner-outreach",
  "organic-discovery",
  "social-pilot",
  "email-pilot",
  "referral-pilot",
] as const;

export const APPROVED_VARIANT_CODES = ["cta-a", "cta-b", "variant-a", "variant-b"] as const;

export const TRACKED_LINK_TARGETS = {
  partner: "/partners",
  collector: "/submit",
} as const;

export type TrackedLinkTarget = keyof typeof TRACKED_LINK_TARGETS;

export const TRACKED_LINK_OPTIONS = {
  targets: (Object.keys(TRACKED_LINK_TARGETS) as TrackedLinkTarget[]).map((value) => ({
    value,
    label: value === "partner" ? "Partner applications" : "Collector submission",
    path: TRACKED_LINK_TARGETS[value],
  })),
  sources: APPROVED_SOURCE_CODES,
  mediums: APPROVED_MEDIUM_CODES,
  campaigns: APPROVED_CAMPAIGN_CODES,
  contents: APPROVED_VARIANT_CODES,
} as const;

export type SafeAttribution = {
  source?: string;
  medium?: string;
  campaign?: string;
  content?: string;
  term?: string;
  category: AcquisitionCategory;
};

const sourceSet = new Set<string>(APPROVED_SOURCE_CODES);
const mediumSet = new Set<string>(APPROVED_MEDIUM_CODES);
const campaignSet = new Set<string>(APPROVED_CAMPAIGN_CODES);
const variantSet = new Set<string>(APPROVED_VARIANT_CODES);

const attributionInput = z
  .object({
    utm_source: z.string().optional(),
    utm_medium: z.string().optional(),
    utm_campaign: z.string().optional(),
    utm_content: z.string().optional(),
    utm_term: z.string().optional(),
  })
  .strict();

const trackedLinkInput = z
  .object({
    target: z.enum(["partner", "collector"]),
    source: z.enum(APPROVED_SOURCE_CODES),
    medium: z.enum(APPROVED_MEDIUM_CODES),
    campaign: z.enum(APPROVED_CAMPAIGN_CODES),
    content: z.enum(APPROVED_VARIANT_CODES).optional(),
  })
  .strict();

export type TrackedCampaignLinkInput = z.infer<typeof trackedLinkInput>;

/**
 * Campaign values are MintVault-owned identifiers, never free text. Rejection
 * rather than punctuation stripping prevents an email/phone/name becoming a
 * durable lookalike value in the attribution table.
 */
function campaignToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.trim().toLowerCase();
  if (candidate.length === 0 || candidate.length > 64) return undefined;
  if (candidate.includes("@") || candidate.includes("://") || candidate.startsWith("www.")) return undefined;
  const digitCount = [...candidate].filter((character) => character >= "0" && character <= "9").length;
  if (digitCount >= 7) return undefined;
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(candidate) ? candidate : undefined;
}

export function cleanAttributionValue(value: unknown, allowed: ReadonlySet<string>): string | undefined {
  const token = campaignToken(value);
  return token && allowed.has(token) ? token : undefined;
}

export function isApprovedCampaignCode(value: unknown): value is (typeof APPROVED_CAMPAIGN_CODES)[number] {
  return cleanAttributionValue(value, campaignSet) !== undefined;
}

export function deriveAcquisitionCategory(source?: string, medium?: string): AcquisitionCategory {
  const value = `${source ?? ""} ${medium ?? ""}`.toLowerCase();
  if (!value.trim()) return "DIRECT";
  if (/(organic|seo|search)/.test(value)) return "ORGANIC";
  if (/(partner|outreach|retailer|shop)/.test(value)) return "PARTNER_OUTREACH";
  if (/(creator|influencer|ambassador)/.test(value)) return "CREATOR";
  if (/(referral|refer)/.test(value)) return "REFERRAL";
  if (/(social|instagram|tiktok|youtube|facebook|xtwitter|twitter)/.test(value)) return "SOCIAL";
  if (/(email|newsletter)/.test(value)) return "EMAIL";
  if (/direct/.test(value)) return "DIRECT";
  return "OTHER";
}

export function normaliseAttribution(input: unknown): SafeAttribution {
  const parsed = attributionInput.safeParse(input);
  const value = parsed.success ? parsed.data : {};
  const source = cleanAttributionValue(value.utm_source, sourceSet);
  const medium = cleanAttributionValue(value.utm_medium, mediumSet);
  const campaign = cleanAttributionValue(value.utm_campaign, campaignSet);
  const content = cleanAttributionValue(value.utm_content, variantSet);
  const term = cleanAttributionValue(value.utm_term, variantSet);
  return { source, medium, campaign, content, term, category: deriveAcquisitionCategory(source, medium) };
}

/** The server owns both the MintVault route and every emitted campaign token. */
export function generateTrackedCampaignLink(input: unknown): { url: string; attribution: SafeAttribution } {
  const parsed = trackedLinkInput.parse(input);
  const url = new URL(TRACKED_LINK_TARGETS[parsed.target], APP_BASE_URL);
  url.searchParams.set("utm_source", parsed.source);
  url.searchParams.set("utm_medium", parsed.medium);
  url.searchParams.set("utm_campaign", parsed.campaign);
  if (parsed.content) url.searchParams.set("utm_content", parsed.content);
  const attribution = normaliseAttribution({
    utm_source: parsed.source,
    utm_medium: parsed.medium,
    utm_campaign: parsed.campaign,
    utm_content: parsed.content,
  });
  return { url: url.toString(), attribution };
}

type QueryExecutor = { execute(query: SQL): Promise<{ rows: unknown[] }> };

/**
 * Optional persistence remains isolated from submission creation. A failure
 * here is logged by the caller and must never interrupt checkout or payment.
 */
export async function recordSubmissionAttribution(
  submissionId: number,
  input: unknown,
  executor?: QueryExecutor
): Promise<void> {
  const attribution = normaliseAttribution(input);
  // An absent acquisition reference is not evidence of a direct visit. Leave
  // the submission unlinked so reporting can state the honest UNATTRIBUTED
  // zero/unknown boundary rather than manufacturing a Direct classification.
  if (!attribution.source && !attribution.medium && !attribution.campaign && !attribution.content && !attribution.term) return;
  const runner = executor ?? (await import("./db")).db;
  await runner.execute(sql`
    INSERT INTO submission_acquisition
      (submission_id, acquisition_category, utm_source, utm_medium, utm_campaign, utm_content, utm_term)
    VALUES (
      ${submissionId}, ${attribution.category}, ${attribution.source ?? null}, ${attribution.medium ?? null},
      ${attribution.campaign ?? null}, ${attribution.content ?? null}, ${attribution.term ?? null}
    )
    ON CONFLICT (submission_id) DO NOTHING
  `);
}
