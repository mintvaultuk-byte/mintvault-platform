/**
 * Public Partner discovery projection.
 *
 * Operational Partner/location data is deliberately not a public source. Only
 * values separately consented by a Partner Owner and approved at the exact
 * current version by Super Admin may cross this boundary.
 */
import type {
  PartnerPublicPrivacyState,
  PublicLocationPublicationBlocker,
  PublicLocationPublicationState,
  PublicPartnerLocation,
} from "@shared/public-partner";
import { partnerAdminQuery } from "./db";

export type {
  PartnerPublicPrivacyState,
  PublicLocationPublicationBlocker,
  PublicLocationPublicationState,
  PublicPartnerLocation,
} from "@shared/public-partner";

export const PUBLIC_DIRECTORY_FLAG = "public_partner_directory_enabled";
export const GOOGLE_PRESENCE_FLAG = "google_partner_presence_enabled";
export const PUBLIC_PARTNER_PROFILE_PREFIX = "/partners/location/";

export class PublicPartnerPresenceUnavailableError extends Error {
  constructor() {
    super("Public Partner discovery is temporarily unavailable");
    this.name = "PublicPartnerPresenceUnavailableError";
  }
}

export function derivePublicLocationPublicationState(input: {
  organisationStatus: unknown;
  locationStatus: unknown;
  publicDisplayName: unknown;
  profileVersion: unknown;
  profileConsentedAt: unknown;
  profileApprovedVersion: unknown;
  profileListed: unknown;
  privacyState: unknown;
  publicLocationName: unknown;
  publicStreetAddress: unknown;
  publicServiceArea: unknown;
  publicWebsite: unknown;
  publicPhone: unknown;
  publicEmail: unknown;
  mapsEnabled: unknown;
  consentedFields: unknown;
  locationVersion: unknown;
  locationConsentedAt: unknown;
  locationApprovedVersion: unknown;
  locationListed: unknown;
  directoryEnabled: unknown;
}): PublicLocationPublicationState {
  const blockers: PublicLocationPublicationBlocker[] = [];
  const profileVersion = Number(input.profileVersion);
  const locationVersion = Number(input.locationVersion);
  const profileApproved = Number(input.profileApprovedVersion) === profileVersion && profileVersion > 0;
  const locationApproved = Number(input.locationApprovedVersion) === locationVersion && locationVersion > 0;
  const partnerListed = input.profileListed === true;
  const locationListed = input.locationListed === true;

  if (input.organisationStatus !== "ACTIVE") blockers.push("ORGANISATION_NOT_ACTIVE");
  if (input.locationStatus !== "ACTIVE") blockers.push("LOCATION_NOT_ACTIVE");
  if (typeof input.publicDisplayName !== "string" || input.publicDisplayName.trim().length < 2) {
    blockers.push("PUBLIC_DISPLAY_NAME_REQUIRED");
  }
  if (!(profileVersion > 0) || !input.profileConsentedAt) blockers.push("PARTNER_CONSENT_REQUIRED");
  if (!profileApproved) blockers.push("PARTNER_APPROVAL_REQUIRED");
  if (!partnerListed) blockers.push("PARTNER_NOT_LISTED");

  if (typeof input.publicLocationName !== "string" || input.publicLocationName.trim().length < 2) {
    blockers.push("PUBLIC_LOCATION_NAME_REQUIRED");
  }
  if (!(locationVersion > 0) || !input.locationConsentedAt) blockers.push("LOCATION_CONSENT_REQUIRED");
  if (!locationApproved) blockers.push("LOCATION_APPROVAL_REQUIRED");
  if (!locationListed) blockers.push("LOCATION_NOT_LISTED");

  if (input.privacyState === "PUBLIC_STOREFRONT") {
    if (typeof input.publicStreetAddress !== "string" || input.publicStreetAddress.trim().length < 5) {
      blockers.push("PUBLIC_STREET_ADDRESS_REQUIRED");
    }
  } else if (input.privacyState === "SERVICE_AREA_PRIVATE_ADDRESS") {
    if (typeof input.publicServiceArea !== "string" || input.publicServiceArea.trim().length < 2) {
      blockers.push("PUBLIC_SERVICE_AREA_REQUIRED");
    }
    if (input.mapsEnabled === true) blockers.push("MAPS_REQUIRES_PUBLIC_STOREFRONT");
  } else {
    blockers.push("PRIVACY_CLASSIFICATION_REQUIRED");
  }
  if (input.mapsEnabled === true && input.privacyState !== "PUBLIC_STOREFRONT") {
    if (!blockers.includes("MAPS_REQUIRES_PUBLIC_STOREFRONT")) {
      blockers.push("MAPS_REQUIRES_PUBLIC_STOREFRONT");
    }
  }
  const hasContactAction =
    (input.privacyState === "PUBLIC_STOREFRONT" && input.mapsEnabled === true) ||
    (typeof input.publicWebsite === "string" && input.publicWebsite.trim().length > 0) ||
    (typeof input.publicPhone === "string" && input.publicPhone.trim().length > 0) ||
    (typeof input.publicEmail === "string" && input.publicEmail.trim().length > 0);
  if (!hasContactAction) blockers.push("PUBLIC_CONTACT_ACTION_REQUIRED");
  const consentedFields = new Set(Array.isArray(input.consentedFields) ? input.consentedFields.filter((field): field is string => typeof field === "string") : []);
  const requiredFieldConsents = [
    ...(typeof input.publicLocationName === "string" && input.publicLocationName.trim() ? ["public_location_name"] : []),
    ...(input.privacyState === "PUBLIC_STOREFRONT" ? ["public_street_address"] : []),
    ...(input.privacyState === "SERVICE_AREA_PRIVATE_ADDRESS" ? ["public_service_area"] : []),
    ...(input.mapsEnabled === true ? ["maps_enabled"] : []),
    ...(typeof input.publicWebsite === "string" && input.publicWebsite.trim() ? ["public_website"] : []),
    ...(typeof input.publicPhone === "string" && input.publicPhone.trim() ? ["public_phone"] : []),
    ...(typeof input.publicEmail === "string" && input.publicEmail.trim() ? ["public_email"] : []),
  ];
  if (requiredFieldConsents.some((field) => !consentedFields.has(field))) blockers.push("FIELD_CONSENT_REQUIRED");
  if (input.directoryEnabled !== true) blockers.push("DIRECTORY_DISABLED");

  const approvalOnly = new Set<PublicLocationPublicationBlocker>([
    "PARTNER_APPROVAL_REQUIRED",
    "PARTNER_NOT_LISTED",
    "LOCATION_APPROVAL_REQUIRED",
    "LOCATION_NOT_LISTED",
    "DIRECTORY_DISABLED",
  ]);
  const readyForApproval = blockers.every((blocker) => approvalOnly.has(blocker));
  const approved = profileApproved && locationApproved;
  return {
    readyForApproval,
    approved,
    partnerListed,
    locationListed,
    live: readyForApproval && approved && partnerListed && locationListed && input.directoryEnabled === true,
    blockingReasons: blockers,
  };
}

const PUBLIC_REF_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/;
function isControlCharacter(char: string): boolean {
  const code = char.charCodeAt(0);
  return code <= 31 || code === 127;
}
function containsControlCharacter(value: string): boolean {
  return Array.from(value).some(isControlCharacter);
}
export function cleanPublicText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return Array.from(value)
    .map((char) => (isControlCharacter(char) ? " " : char))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function safePublicWebsite(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048 || containsControlCharacter(value)) return null;
  try {
    const parsed = new URL(value.trim());
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || !parsed.hostname) return null;
    if (parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function safePublicPhone(value: unknown): string | null {
  const phone = cleanPublicText(value, 40);
  return phone.length >= 5 && /^[+0-9().\-\s]+$/.test(phone) ? phone : null;
}
export function safePublicEmail(value: unknown): string | null {
  const email = cleanPublicText(value, 254).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}
export function googleMapsAddressUrl(address: unknown): string | null {
  const clean = cleanPublicText(address, 500);
  return clean.length < 5 ? null : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(clean)}`;
}

const GOOGLE_MAPS_HOSTS = new Set(["google.com", "www.google.com", "maps.google.com", "maps.app.goo.gl"]);
export function preferredGoogleMapsUrl(input: {
  mapsUri?: unknown;
  placeId?: unknown;
  address?: unknown;
  businessName?: unknown;
}): string | null {
  if (typeof input.mapsUri === "string" && input.mapsUri.length <= 2048 && !containsControlCharacter(input.mapsUri)) {
    try {
      const url = new URL(input.mapsUri.trim());
      if (url.protocol === "https:" && GOOGLE_MAPS_HOSTS.has(url.hostname.toLowerCase()) && !url.username && !url.password) {
        return url.toString();
      }
    } catch {
      // Continue to the safe deterministic fallbacks.
    }
  }
  const placeId = cleanPublicText(input.placeId, 255);
  if (/^[A-Za-z0-9_-]{5,255}$/.test(placeId)) {
    const query = cleanPublicText(input.businessName, 160) || cleanPublicText(input.address, 500) || "Google Business";
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}&query_place_id=${encodeURIComponent(placeId)}`;
  }
  return googleMapsAddressUrl(input.address);
}

export function isValidPublicPartnerRef(value: unknown): value is string {
  return typeof value === "string" && PUBLIC_REF_RE.test(value);
}

interface PublicPartnerRow {
  tenant_id: string;
  location_id: string;
  public_ref: string;
  display_name: string | null;
  location_name: string | null;
  privacy_state: PartnerPublicPrivacyState;
  address: string | null;
  service_area: string | null;
  website: string | null;
  phone: string | null;
  email: string | null;
  maps_enabled: boolean;
  cards_graded: string | number;
}

type GoogleSnapshot = {
  google_place_id: string | null;
  google_maps_uri: string | null;
  business_name: string | null;
};

function toPublicLocation(row: PublicPartnerRow, google?: GoogleSnapshot): PublicPartnerLocation | null {
  const publicRef = cleanPublicText(row.public_ref, 128);
  const displayName = cleanPublicText(row.display_name, 160);
  const locationName = cleanPublicText(row.location_name, 120);
  if (!isValidPublicPartnerRef(publicRef) || !displayName || !locationName) return null;
  if (row.privacy_state !== "PUBLIC_STOREFRONT" && row.privacy_state !== "SERVICE_AREA_PRIVATE_ADDRESS") return null;

  const address = row.privacy_state === "PUBLIC_STOREFRONT" ? cleanPublicText(row.address, 500) : "";
  const serviceArea = row.privacy_state === "SERVICE_AREA_PRIVATE_ADDRESS" ? cleanPublicText(row.service_area, 160) : "";
  if (row.privacy_state === "PUBLIC_STOREFRONT" && address.length < 5) return null;
  if (row.privacy_state === "SERVICE_AREA_PRIVATE_ADDRESS" && serviceArea.length < 2) return null;
  const mapsUrl = row.maps_enabled && address
    ? preferredGoogleMapsUrl({
        mapsUri: google?.google_maps_uri,
        placeId: google?.google_place_id,
        businessName: google?.business_name,
        address,
      })
    : null;
  const count = Number(row.cards_graded);
  return {
    publicRef,
    displayName,
    locationName,
    privacyState: row.privacy_state,
    address: address || null,
    serviceArea: serviceArea || null,
    designation: "MintVault Partner",
    websiteUrl: safePublicWebsite(row.website),
    phone: safePublicPhone(row.phone),
    email: safePublicEmail(row.email),
    mapsUrl,
    cardsGraded: Number.isSafeInteger(count) && count >= 0 ? count : null,
    cardsGradedMeaning: "Approved cards graded by MintVault through this Partner location",
    partnerSince: null,
  };
}

async function googleMapSnapshots(refs: string[]): Promise<Map<string, GoogleSnapshot>> {
  if (refs.length === 0) return new Map();
  try {
    const capability = await partnerAdminQuery<{ ready: boolean }>(
      `SELECT COALESCE((SELECT enabled FROM partner_feature_flags
                        WHERE flag=$1 AND tenant_id IS NULL AND location_id IS NULL
                        ORDER BY updated_at DESC,id DESC LIMIT 1),false)
              AND to_regclass('public.partner_google_profile_cache') IS NOT NULL
              AND to_regclass('public.partner_google_connections') IS NOT NULL AS ready`,
      [GOOGLE_PRESENCE_FLAG]
    );
    if (capability.rows[0]?.ready !== true) return new Map();
    const { rows } = await partnerAdminQuery<{
      public_ref: string;
      google_place_id: string | null;
      google_maps_uri: string | null;
      business_name: string | null;
    }>(
      `SELECT l.public_ref,c.google_place_id,c.google_maps_uri,c.business_name
         FROM partner_google_profile_cache c
         JOIN partner_google_connections g ON g.id=c.connection_id AND g.tenant_id=c.tenant_id
         JOIN partner_locations l ON l.id=c.location_id AND l.tenant_id=c.tenant_id
        WHERE l.public_ref=ANY($1::text[]) AND g.connection_status='CONNECTED' AND c.expires_at > now()`,
      [refs]
    );
    return new Map(rows.map((row) => [String(row.public_ref).toLowerCase(), row]));
  } catch {
    // Google is optional. Explicitly consented public address links remain usable.
    return new Map();
  }
}

const ELIGIBLE_PUBLIC_PARTNER_SQL = `
  WITH latest_global AS (
    SELECT enabled FROM partner_feature_flags
     WHERE flag=$1 AND tenant_id IS NULL AND location_id IS NULL
     ORDER BY updated_at DESC,id DESC LIMIT 1
  ), eligible AS (
    SELECT l.tenant_id,l.id AS location_id,l.public_ref,
           pp.public_display_name AS display_name,
           lp.public_location_name AS location_name,
           lp.privacy_state,
           lp.public_street_address AS address,
           lp.public_service_area AS service_area,
           lp.public_website AS website,
           lp.public_phone AS phone,
           lp.public_email AS email,
           lp.maps_enabled,
           COALESCE(cc.cards_graded,0)::text AS cards_graded
      FROM partner_location_publications lp
      JOIN partner_locations l ON l.tenant_id=lp.tenant_id AND l.id=lp.location_id
      JOIN partner_organisations o ON o.id=l.tenant_id AND o.id=l.partner_id
      JOIN partner_public_profiles pp ON pp.tenant_id=l.tenant_id
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS cards_graded FROM certificates c
         WHERE c.origin_type='PARTNER' AND c.origin_partner_id=l.tenant_id AND c.origin_location_id=l.id
           AND c.status='active' AND c.deleted_at IS NULL AND c.grade IS NOT NULL AND c.grade_approved_at IS NOT NULL
      ) cc ON TRUE
     WHERE (SELECT enabled FROM latest_global) IS TRUE
       AND o.status='ACTIVE' AND l.status='ACTIVE'
       AND pp.listed IS TRUE AND pp.version > 0 AND pp.consented_at IS NOT NULL
       AND pp.approved_version=pp.version AND pp.approved_at IS NOT NULL
       AND lp.listed IS TRUE AND lp.version > 0 AND lp.consented_at IS NOT NULL
       AND lp.approved_version=lp.version AND lp.approved_at IS NOT NULL
       AND 'public_location_name'=ANY(lp.consented_fields)
       AND length(trim(pp.public_display_name)) BETWEEN 2 AND 160
       AND length(trim(lp.public_location_name)) BETWEEN 2 AND 120
       AND (
         (lp.privacy_state='PUBLIC_STOREFRONT'
           AND 'public_street_address'=ANY(lp.consented_fields)
           AND length(trim(lp.public_street_address)) BETWEEN 5 AND 500)
         OR
         (lp.privacy_state='SERVICE_AREA_PRIVATE_ADDRESS'
           AND 'public_service_area'=ANY(lp.consented_fields)
           AND length(trim(lp.public_service_area)) BETWEEN 2 AND 160
           AND lp.public_street_address IS NULL AND lp.maps_enabled IS FALSE)
       )
       AND (lp.public_website IS NULL OR 'public_website'=ANY(lp.consented_fields))
       AND (lp.public_phone IS NULL OR 'public_phone'=ANY(lp.consented_fields))
       AND (lp.public_email IS NULL OR 'public_email'=ANY(lp.consented_fields))
       AND (lp.maps_enabled IS FALSE OR 'maps_enabled'=ANY(lp.consented_fields))
       AND (lp.maps_enabled IS TRUE OR lp.public_website IS NOT NULL OR lp.public_phone IS NOT NULL OR lp.public_email IS NOT NULL)
  )`;

export async function getPublicPartnerDirectoryState(): Promise<"ENABLED" | "DISABLED"> {
  try {
    const { rows } = await partnerAdminQuery<{ enabled: boolean }>(
      `SELECT enabled FROM partner_feature_flags
        WHERE flag=$1 AND tenant_id IS NULL AND location_id IS NULL
        ORDER BY updated_at DESC,id DESC LIMIT 1`,
      [PUBLIC_DIRECTORY_FLAG]
    );
    return rows[0]?.enabled === true ? "ENABLED" : "DISABLED";
  } catch {
    throw new PublicPartnerPresenceUnavailableError();
  }
}

/** Fail-closed convenience for non-HTTP feature presentation only. */
export async function isPublicPartnerDirectoryEnabled(): Promise<boolean> {
  try {
    return (await getPublicPartnerDirectoryState()) === "ENABLED";
  } catch {
    return false;
  }
}

export async function listPublicPartnerLocations(input?: {
  search?: string | null;
  limit?: number;
}): Promise<PublicPartnerLocation[]> {
  const search = cleanPublicText(input?.search ?? "", 80);
  const limit = Math.max(1, Math.min(100, Number.isFinite(input?.limit) ? Number(input?.limit) : 60));
  let rows: PublicPartnerRow[];
  try {
    const result = await partnerAdminQuery<PublicPartnerRow>(
      `${ELIGIBLE_PUBLIC_PARTNER_SQL}
       SELECT tenant_id,location_id,public_ref,display_name,location_name,privacy_state,address,service_area,
              website,phone,email,maps_enabled,cards_graded
         FROM eligible
        WHERE $2='' OR position(lower($2) in lower(display_name || ' ' || location_name || ' ' ||
              COALESCE(address,'') || ' ' || COALESCE(service_area,''))) > 0
        ORDER BY display_name,location_name,public_ref LIMIT $3`,
      [PUBLIC_DIRECTORY_FLAG, search, limit]
    );
    rows = result.rows;
  } catch {
    throw new PublicPartnerPresenceUnavailableError();
  }
  const snapshots = await googleMapSnapshots(rows.filter((r) => r.maps_enabled).map((r) => r.public_ref));
  return rows
    .map((row) => toPublicLocation(row, snapshots.get(String(row.public_ref).toLowerCase())))
    .filter((row): row is PublicPartnerLocation => row !== null);
}

export async function getPublicPartnerLocation(publicRef: string): Promise<PublicPartnerLocation | null> {
  if (!isValidPublicPartnerRef(publicRef)) return null;
  let rows: PublicPartnerRow[];
  try {
    const result = await partnerAdminQuery<PublicPartnerRow>(
      `${ELIGIBLE_PUBLIC_PARTNER_SQL}
       SELECT tenant_id,location_id,public_ref,display_name,location_name,privacy_state,address,service_area,
              website,phone,email,maps_enabled,cards_graded
         FROM eligible WHERE lower(public_ref)=lower($2) LIMIT 1`,
      [PUBLIC_DIRECTORY_FLAG, publicRef]
    );
    rows = result.rows;
  } catch {
    throw new PublicPartnerPresenceUnavailableError();
  }
  if (rows.length !== 1) return null;
  const snapshots = await googleMapSnapshots(rows[0].maps_enabled ? [rows[0].public_ref] : []);
  return toPublicLocation(rows[0], snapshots.get(String(rows[0].public_ref).toLowerCase()));
}

/** Authenticated preview uses the identical mapper but deliberately bypasses
 * only lifecycle/listing/global publication gates. The route owns tenancy. */
export async function getPublicPartnerLocationPreviews(
  tenantId: string,
  locationIds: string[]
): Promise<Map<string, PublicPartnerLocation>> {
  if (locationIds.length === 0) return new Map();
  let rows: PublicPartnerRow[];
  try {
    const result = await partnerAdminQuery<PublicPartnerRow>(
      `WITH certificate_counts AS (
         SELECT origin_partner_id,origin_location_id,count(*)::int AS cards_graded
           FROM certificates
          WHERE origin_type='PARTNER' AND origin_partner_id=$1 AND origin_location_id=ANY($2::uuid[])
            AND status='active' AND deleted_at IS NULL AND grade IS NOT NULL AND grade_approved_at IS NOT NULL
          GROUP BY origin_partner_id,origin_location_id
       )
       SELECT l.tenant_id,l.id AS location_id,l.public_ref,pp.public_display_name AS display_name,
              lp.public_location_name AS location_name,lp.privacy_state,
              lp.public_street_address AS address,lp.public_service_area AS service_area,
              lp.public_website AS website,lp.public_phone AS phone,lp.public_email AS email,
              lp.maps_enabled,COALESCE(cc.cards_graded,0)::text AS cards_graded
         FROM partner_locations l
         LEFT JOIN partner_public_profiles pp ON pp.tenant_id=l.tenant_id
         LEFT JOIN partner_location_publications lp ON lp.tenant_id=l.tenant_id AND lp.location_id=l.id
         LEFT JOIN certificate_counts cc ON cc.origin_partner_id=l.tenant_id AND cc.origin_location_id=l.id
        WHERE l.tenant_id=$1 AND l.id=ANY($2::uuid[])`,
      [tenantId, locationIds]
    );
    rows = result.rows;
  } catch {
    throw new PublicPartnerPresenceUnavailableError();
  }
  const snapshots = await googleMapSnapshots(rows.filter((row) => row.maps_enabled).map((row) => row.public_ref));
  const previews = new Map<string, PublicPartnerLocation>();
  for (const row of rows) {
    const preview = toPublicLocation(row, snapshots.get(String(row.public_ref).toLowerCase()));
    if (preview) previews.set(row.location_id, preview);
  }
  return previews;
}

export async function getPublicPartnerLocationPreview(tenantId: string, locationId: string): Promise<PublicPartnerLocation | null> {
  return (await getPublicPartnerLocationPreviews(tenantId, [locationId])).get(locationId) ?? null;
}

export async function getPublicPartnerSitemapPaths(): Promise<string[]> {
  let rows: Array<{ public_ref: string }>;
  try {
    const result = await partnerAdminQuery<{ public_ref: string }>(
      `${ELIGIBLE_PUBLIC_PARTNER_SQL} SELECT public_ref FROM eligible ORDER BY public_ref LIMIT 5000`,
      [PUBLIC_DIRECTORY_FLAG]
    );
    rows = result.rows;
  } catch {
    throw new PublicPartnerPresenceUnavailableError();
  }
  if (rows.length === 0 && (await getPublicPartnerDirectoryState()) === "DISABLED") return [];
  return [
    "/find-a-partner",
    ...rows.map((row) => row.public_ref).filter(isValidPublicPartnerRef)
      .map((publicRef) => `${PUBLIC_PARTNER_PROFILE_PREFIX}${publicRef}`),
  ];
}
