import { createHash, randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

export const PARTNER_APPLICATION_STATUSES = ["NEW", "CONTACTED", "QUALIFIED", "NOT_A_FIT", "ONBOARDING"] as const;
export const PARTNER_APPLICATION_PRIVACY_NOTICE_VERSION = "v1.0-2026-08-19";
export type PartnerApplicationStatus = (typeof PARTNER_APPLICATION_STATUSES)[number];

export const BUSINESS_TYPES = ["tcg_card_shop", "collectibles_retailer", "hobby_store", "online_retailer", "other"] as const;
export const TCG_CATEGORIES = ["Pokemon", "Yu-Gi-Oh!", "Magic: The Gathering", "One Piece", "Sports", "Other"] as const;
export const DEMAND_BANDS = ["exploring", "under_25", "25_50", "51_100", "101_250", "250_plus"] as const;

function isSafeWebPresence(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password && !!url.hostname;
  } catch {
    return false;
  }
}

const optionalPhone = z
  .string()
  .trim()
  .max(40, "Phone number is too long")
  .refine((value) => value.length === 0 || /^[+0-9().\-\s]+$/.test(value), "Phone number contains unsupported characters")
  .optional();

export const partnerApplicationSchema = z
  .object({
    businessName: z.string().trim().min(2, "Business name is required").max(160, "Business name is too long"),
    contactName: z.string().trim().min(2, "Contact name is required").max(120, "Contact name is too long"),
    email: z.string().trim().email("Enter a valid email address").max(254, "Email address is too long"),
    city: z.string().trim().min(2, "Town or city is required").max(120, "Town or city is too long"),
    postcode: z
      .string()
      .trim()
      .max(10, "Postcode is too long")
      .refine((value) => /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(value), "Enter a valid UK postcode"),
    businessType: z.enum(BUSINESS_TYPES),
    webPresence: z
      .string()
      .trim()
      .min(8, "A website or primary business social profile is required")
      .max(500, "Website or social profile is too long")
      .refine(isSafeWebPresence, "Enter a full http(s) website or social-profile URL"),
    interestReason: z.string().trim().min(20, "Tell us briefly why your shop is interested").max(1500, "Interest reason is too long"),
    phone: optionalPhone,
    physicalRetail: z.boolean().optional(),
    categories: z.array(z.enum(TCG_CATEGORIES)).max(TCG_CATEGORIES.length, "Too many categories selected").default([]),
    demandBand: z.enum(DEMAND_BANDS).optional(),
    existingGradingSubmissions: z.enum(["yes", "no", "not_currently"]).optional(),
    privacyAcknowledged: z.literal(true, { errorMap: () => ({ message: "Please acknowledge the Privacy Notice" }) }),
    attribution: z
      .object({
        route: z.string().trim().max(120).optional(),
        utmSource: z.string().trim().max(180).optional(),
        utmMedium: z.string().trim().max(180).optional(),
        utmCampaign: z.string().trim().max(180).optional(),
        utmContent: z.string().trim().max(180).optional(),
        referrer: z.string().trim().max(2000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type PartnerApplicationInput = {
  businessName: string;
  contactName: string;
  email: string;
  city: string;
  postcode: string;
  businessType: (typeof BUSINESS_TYPES)[number];
  webPresence: string;
  interestReason: string;
  phone?: string;
  physicalRetail?: boolean;
  categories: (typeof TCG_CATEGORIES)[number][];
  demandBand?: (typeof DEMAND_BANDS)[number];
  existingGradingSubmissions?: "yes" | "no" | "not_currently";
  privacyAcknowledged: true;
  attribution?: {
    route?: string;
    utmSource?: string;
    utmMedium?: string;
    utmCampaign?: string;
    utmContent?: string;
    referrer?: string;
  };
};

export type SafeAttribution = {
  route: "/partners";
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  referrerOrigin?: string;
};

function cleanAttributionValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const withoutControls = Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("");
  const cleaned = withoutControls
    .replace(/[^\p{L}\p{N} ._\-/]/gu, "")
    .trim()
    .slice(0, 120);
  return cleaned || undefined;
}

function safeReferrerOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return url.origin.slice(0, 200);
  } catch {
    return undefined;
  }
}

/**
 * Source data is treated as untrusted. The public route is fixed server-side;
 * query strings, hashes and referrer paths are deliberately never retained.
 */
export function sanitizePartnerAttribution(input: PartnerApplicationInput["attribution"]): SafeAttribution {
  return {
    route: "/partners",
    ...(cleanAttributionValue(input?.utmSource) ? { utmSource: cleanAttributionValue(input?.utmSource) } : {}),
    ...(cleanAttributionValue(input?.utmMedium) ? { utmMedium: cleanAttributionValue(input?.utmMedium) } : {}),
    ...(cleanAttributionValue(input?.utmCampaign) ? { utmCampaign: cleanAttributionValue(input?.utmCampaign) } : {}),
    ...(cleanAttributionValue(input?.utmContent) ? { utmContent: cleanAttributionValue(input?.utmContent) } : {}),
    ...(safeReferrerOrigin(input?.referrer) ? { referrerOrigin: safeReferrerOrigin(input?.referrer) } : {}),
  };
}

export function createPartnerApplicationId(): string {
  return randomUUID();
}

/** A one-way duplicate key; neither public responses nor audit rows disclose the input values. */
export function partnerApplicationDedupeKey(input: Pick<PartnerApplicationInput, "businessName" | "email">): string {
  const normalized = `${input.businessName.trim().toLocaleLowerCase("en-GB")}\n${input.email.trim().toLocaleLowerCase("en-GB")}`;
  return createHash("sha256").update(normalized).digest("hex");
}

type QueryResult = { rows: unknown[] };
export type PartnerApplicationPersistence = {
  transaction<T>(operation: (execute: (query: SQL) => Promise<QueryResult>) => Promise<T>): Promise<T>;
};

/**
 * Performs only the durable, auditable lead write. Notification is deliberately
 * outside this transaction and handled afterward so a Resend failure cannot
 * lose an accepted application.
 */
export async function persistPartnerApplication(
  persistence: PartnerApplicationPersistence,
  application: PartnerApplicationInput,
  attribution: SafeAttribution
): Promise<{ leadId: string; created: boolean }> {
  const dedupeKey = partnerApplicationDedupeKey(application);
  return persistence.transaction(async (execute) => {
    const leadId = createPartnerApplicationId();
    const inserted = await execute(sql`
      INSERT INTO partner_applications (
        id, business_name, contact_name, email, city, postcode, business_type,
        web_presence, interest_reason, phone, physical_retail, categories,
        demand_band, existing_grading_submissions, privacy_acknowledged_at,
        privacy_notice_version, source, attribution, status, dedupe_key
      ) VALUES (
        ${leadId}, ${application.businessName}, ${application.contactName}, ${application.email},
        ${application.city}, ${application.postcode.toUpperCase().replace(/\s+/g, " ")}, ${application.businessType},
        ${application.webPresence}, ${application.interestReason}, ${application.phone || null},
        ${application.physicalRetail ?? null}, ${application.categories}, ${application.demandBand ?? null},
        ${application.existingGradingSubmissions ?? null}, NOW(), ${PARTNER_APPLICATION_PRIVACY_NOTICE_VERSION},
        'partners_page', ${JSON.stringify(attribution)}::jsonb, 'NEW', ${dedupeKey}
      )
      ON CONFLICT (dedupe_key) WHERE deleted_at IS NULL DO NOTHING
      RETURNING id
    `);
    const insertedId = (inserted.rows[0] as { id?: string } | undefined)?.id;
    if (!insertedId) {
      const existing = await execute(sql`
        SELECT id FROM partner_applications
        WHERE dedupe_key = ${dedupeKey} AND deleted_at IS NULL
        LIMIT 1
      `);
      const existingId = (existing.rows[0] as { id?: string } | undefined)?.id;
      if (!existingId) throw new Error("Partner application duplicate lookup failed");
      return { leadId: existingId, created: false };
    }

    await execute(sql`
      INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
      VALUES ('partner_application', ${insertedId}, 'created', NULL,
        ${JSON.stringify({ source: "partners_page", status: "NEW" })}::jsonb)
    `);
    return { leadId: insertedId, created: true };
  });
}
