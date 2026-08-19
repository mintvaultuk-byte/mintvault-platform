/**
 * Public Partner discovery projection.
 *
 * This is intentionally independent from every Super Admin/Partner DTO. The
 * query names every selected field, applies publication and lifecycle gates in
 * SQL, and returns no internal identifiers. A missing table/flag/DB connection
 * fails closed; public exposure must never be the fallback error behaviour.
 */
import { partnerAdminQuery } from "./db";

export const PUBLIC_DIRECTORY_FLAG = "public_partner_directory_enabled";
export const PUBLIC_LOCATION_FLAG = "partner_location_public_profile_enabled";
export const PUBLIC_PARTNER_PROFILE_PREFIX = "/partners/location/";

/** Keep the approved-name rule identical everywhere that reports publication
 * readiness. A legal name is deliberately absent: it is private company data,
 * not an implicit public identity. The aliases are fixed by the three
 * server-owned queries that consume this expression. */
export const PUBLIC_APPROVED_DISPLAY_NAME_SQL = `COALESCE(
  NULLIF(trim(CASE WHEN b.branding_status = 'ready' THEN b.display_name END), ''),
  NULLIF(trim(p.trading_name), '')
)`;

export type PublicLocationPublicationBlocker =
  | "ORGANISATION_NOT_ACTIVE"
  | "LOCATION_NOT_ACTIVE"
  | "LOCATION_NAME_REQUIRED"
  | "ADDRESS_REQUIRED"
  | "APPROVED_DISPLAY_NAME_REQUIRED"
  | "NOT_APPROVED_FOR_PUBLICATION"
  | "DIRECTORY_DISABLED";

export interface PublicLocationPublicationState {
  /** Content and lifecycle requirements are complete. */
  ready: boolean;
  configured: boolean;
  live: boolean;
  blockingReasons: PublicLocationPublicationBlocker[];
}

/** Authoritative publication decision shared by the public projection and the
 * two authenticated status surfaces. Callers must supply the approved display
 * name selected by PUBLIC_APPROVED_DISPLAY_NAME_SQL. */
export function derivePublicLocationPublicationState(input: {
  organisationStatus: unknown;
  locationStatus: unknown;
  locationName: unknown;
  address: unknown;
  approvedDisplayName: unknown;
  configured: unknown;
  directoryEnabled: unknown;
}): PublicLocationPublicationState {
  const blockers: PublicLocationPublicationBlocker[] = [];
  if (input.organisationStatus !== "ACTIVE") blockers.push("ORGANISATION_NOT_ACTIVE");
  if (input.locationStatus !== "ACTIVE") blockers.push("LOCATION_NOT_ACTIVE");
  if (typeof input.locationName !== "string" || input.locationName.trim().length < 2) {
    blockers.push("LOCATION_NAME_REQUIRED");
  }
  if (typeof input.address !== "string" || input.address.trim().length < 5) blockers.push("ADDRESS_REQUIRED");
  if (typeof input.approvedDisplayName !== "string" || input.approvedDisplayName.trim().length === 0) {
    blockers.push("APPROVED_DISPLAY_NAME_REQUIRED");
  }
  const ready = blockers.length === 0;
  const configured = input.configured === true;
  if (!configured) blockers.push("NOT_APPROVED_FOR_PUBLICATION");
  if (input.directoryEnabled !== true) blockers.push("DIRECTORY_DISABLED");
  return { ready, configured, live: ready && configured && input.directoryEnabled === true, blockingReasons: blockers };
}

const PUBLIC_REF_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/;
function isControlCharacter(char: string): boolean {
  const code = char.charCodeAt(0);
  return code <= 31 || code === 127;
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some(isControlCharacter);
}

export interface PublicPartnerLocation {
  publicRef: string;
  displayName: string;
  locationName: string;
  address: string;
  designation: "MintVault Partner";
  websiteUrl: string | null;
  phone: string | null;
  email: string | null;
  mapsUrl: string;
  cardsGraded: number | null;
  partnerSince: string | null;
}

interface PublicPartnerRow {
  public_ref: string;
  display_name: string;
  location_name: string;
  address: string;
  website: string | null;
  phone: string | null;
  email: string | null;
  partner_since: string | null;
  cards_graded: string | number;
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return Array.from(value)
    .map((char) => (isControlCharacter(char) ? " " : char))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Only safe absolute web URLs become public CTAs. Invalid persisted values
 * are omitted rather than repaired or returned to the browser. */
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
  const phone = cleanText(value, 40);
  return phone.length >= 5 && /^[+0-9().\-\s]+$/.test(phone) ? phone : null;
}

export function safePublicEmail(value: unknown): string | null {
  const email = cleanText(value, 254).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

export function googleMapsAddressUrl(address: unknown): string | null {
  const clean = cleanText(address, 500);
  if (clean.length < 5) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(clean)}`;
}

const GOOGLE_MAPS_HOSTS = new Set(["google.com", "www.google.com", "maps.google.com", "maps.app.goo.gl"]);

/** Exact Google listing URI → Place ID search → address search. Persisted
 * provider values are still treated as untrusted and must pass this allowlist. */
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
      // Continue to the deterministic Place ID/address fallbacks.
    }
  }
  const placeId = cleanText(input.placeId, 255);
  if (/^[A-Za-z0-9_-]{5,255}$/.test(placeId)) {
    const query = cleanText(input.businessName, 160) || cleanText(input.address, 500) || "Google Business";
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}&query_place_id=${encodeURIComponent(placeId)}`;
  }
  return googleMapsAddressUrl(input.address);
}

export function isValidPublicPartnerRef(value: unknown): value is string {
  return typeof value === "string" && PUBLIC_REF_RE.test(value);
}

function toPublicLocation(
  row: PublicPartnerRow,
  google?: { google_place_id: string | null; google_maps_uri: string | null; business_name: string | null }
): PublicPartnerLocation | null {
  const publicRef = cleanText(row.public_ref, 128);
  const displayName = cleanText(row.display_name, 160);
  const locationName = cleanText(row.location_name, 120);
  const address = cleanText(row.address, 500);
  const mapsUrl = preferredGoogleMapsUrl({
    mapsUri: google?.google_maps_uri,
    placeId: google?.google_place_id,
    businessName: google?.business_name,
    address,
  });
  if (!isValidPublicPartnerRef(publicRef) || !displayName || !locationName || !address || !mapsUrl) return null;
  const count = Number(row.cards_graded);
  return {
    publicRef,
    displayName,
    locationName,
    address,
    designation: "MintVault Partner",
    websiteUrl: safePublicWebsite(row.website),
    phone: safePublicPhone(row.phone),
    email: safePublicEmail(row.email),
    mapsUrl,
    cardsGraded: Number.isSafeInteger(count) && count > 0 ? count : null,
    partnerSince: /^\d{4}-\d{2}-\d{2}$/.test(String(row.partner_since ?? ""))
      ? String(row.partner_since)
      : null,
  };
}

async function googleMapSnapshots(
  refs: string[]
): Promise<Map<string, { google_place_id: string | null; google_maps_uri: string | null; business_name: string | null }>> {
  if (refs.length === 0) return new Map();
  try {
    const readiness = await partnerAdminQuery<{ ready: boolean }>(
      "SELECT to_regclass('public.partner_google_profile_cache') IS NOT NULL AND to_regclass('public.partner_google_connections') IS NOT NULL AS ready"
    );
    if (readiness.rows[0]?.ready !== true) return new Map();
    const { rows } = await partnerAdminQuery<{
      public_ref: string;
      google_place_id: string | null;
      google_maps_uri: string | null;
      business_name: string | null;
    }>(
      `SELECT l.public_ref,c.google_place_id,c.google_maps_uri,c.business_name
         FROM partner_google_profile_cache c
         JOIN partner_google_connections g ON g.id=c.connection_id
         JOIN partner_locations l ON l.id=c.location_id AND l.tenant_id=c.tenant_id
        WHERE l.public_ref=ANY($1::text[]) AND g.connection_status='CONNECTED' AND c.expires_at > now()`,
      [refs]
    );
    return new Map(rows.map((row) => [String(row.public_ref).toLowerCase(), row]));
  } catch {
    return new Map();
  }
}

const ELIGIBLE_PUBLIC_PARTNER_SQL = `
  WITH latest_global AS (
    SELECT enabled
      FROM partner_feature_flags
     WHERE flag = $1 AND tenant_id IS NULL AND location_id IS NULL
     ORDER BY updated_at DESC, id DESC
     LIMIT 1
  ), eligible AS (
    SELECT
      l.public_ref,
      ${PUBLIC_APPROVED_DISPLAY_NAME_SQL} AS display_name,
      trim(l.name) AS location_name,
      trim(l.address) AS address,
      COALESCE(
        NULLIF(trim(CASE WHEN b.branding_status = 'ready' THEN b.support_website END), ''),
        NULLIF(trim(p.website), '')
      ) AS website,
      NULLIF(trim(p.primary_phone), '') AS phone,
      NULLIF(trim(CASE WHEN b.branding_status = 'ready' THEN b.support_email END), '') AS email,
      p.onboarding_date::text AS partner_since,
      COALESCE(cert_stats.cards_graded, 0)::text AS cards_graded
    FROM partner_locations l
    JOIN partner_organisations o ON o.id = l.tenant_id AND o.id = l.partner_id
    LEFT JOIN partner_profiles p ON p.tenant_id = o.id
    LEFT JOIN partner_branding b ON b.tenant_id = o.id
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS cards_graded
        FROM certificates c
       WHERE c.origin_location_id = l.id
         AND c.origin_type = 'PARTNER'
         AND status = 'active'
         AND deleted_at IS NULL
         AND grade IS NOT NULL
         AND grade_approved_at IS NOT NULL
    ) cert_stats ON TRUE
   WHERE (SELECT enabled FROM latest_global) IS TRUE
     AND o.status = 'ACTIVE'
     AND l.status = 'ACTIVE'
     AND length(trim(l.name)) >= 2
     AND length(trim(COALESCE(l.address, ''))) >= 5
     AND ${PUBLIC_APPROVED_DISPLAY_NAME_SQL} IS NOT NULL
     AND (
       SELECT f.enabled
         FROM partner_feature_flags f
        WHERE f.flag = $2
          AND f.tenant_id = l.tenant_id
          AND f.location_id = l.id
        ORDER BY f.updated_at DESC, f.id DESC
        LIMIT 1
     ) IS TRUE
  )`;

/** Global rollout state only. An error or missing row is OFF. */
export async function isPublicPartnerDirectoryEnabled(): Promise<boolean> {
  try {
    const { rows } = await partnerAdminQuery<{ enabled: boolean }>(
      `SELECT enabled FROM partner_feature_flags
        WHERE flag=$1 AND tenant_id IS NULL AND location_id IS NULL
        ORDER BY updated_at DESC, id DESC LIMIT 1`,
      [PUBLIC_DIRECTORY_FLAG]
    );
    return rows.length === 1 && rows[0].enabled === true;
  } catch {
    return false;
  }
}

export async function listPublicPartnerLocations(input?: {
  search?: string | null;
  limit?: number;
}): Promise<PublicPartnerLocation[]> {
  const search = cleanText(input?.search ?? "", 80);
  const limit = Math.max(1, Math.min(100, Number.isFinite(input?.limit) ? Number(input?.limit) : 60));
  try {
    const { rows } = await partnerAdminQuery<PublicPartnerRow>(
      `${ELIGIBLE_PUBLIC_PARTNER_SQL}
       SELECT public_ref, display_name, location_name, address, website, phone, email, partner_since, cards_graded
         FROM eligible
        WHERE $3 = '' OR position(lower($3) in lower(display_name || ' ' || location_name || ' ' || address)) > 0
        ORDER BY display_name, location_name, public_ref
        LIMIT $4`,
      [PUBLIC_DIRECTORY_FLAG, PUBLIC_LOCATION_FLAG, search, limit]
    );
    const snapshots = await googleMapSnapshots(rows.map((row) => row.public_ref));
    return rows
      .map((row) => toPublicLocation(row, snapshots.get(String(row.public_ref).toLowerCase())))
      .filter((row): row is PublicPartnerLocation => row !== null);
  } catch {
    return [];
  }
}

export async function getPublicPartnerLocation(publicRef: string): Promise<PublicPartnerLocation | null> {
  if (!isValidPublicPartnerRef(publicRef)) return null;
  try {
    const { rows } = await partnerAdminQuery<PublicPartnerRow>(
      `${ELIGIBLE_PUBLIC_PARTNER_SQL}
       SELECT public_ref, display_name, location_name, address, website, phone, email, partner_since, cards_graded
         FROM eligible
        WHERE lower(public_ref) = lower($3)
        LIMIT 1`,
      [PUBLIC_DIRECTORY_FLAG, PUBLIC_LOCATION_FLAG, publicRef]
    );
    if (rows.length !== 1) return null;
    const snapshots = await googleMapSnapshots([rows[0].public_ref]);
    return toPublicLocation(rows[0], snapshots.get(String(rows[0].public_ref).toLowerCase()));
  } catch {
    return null;
  }
}

export async function getPublicPartnerSitemapPaths(): Promise<string[]> {
  try {
    const { rows } = await partnerAdminQuery<{ public_ref: string }>(
      `${ELIGIBLE_PUBLIC_PARTNER_SQL}
       SELECT public_ref FROM eligible ORDER BY public_ref LIMIT 5000`,
      [PUBLIC_DIRECTORY_FLAG, PUBLIC_LOCATION_FLAG]
    );
    if (rows.length === 0 && !(await isPublicPartnerDirectoryEnabled())) return [];
    return [
      "/find-a-partner",
      ...rows
        .map((row) => row.public_ref)
        .filter(isValidPublicPartnerRef)
        .map((publicRef) => `${PUBLIC_PARTNER_PROFILE_PREFIX}${publicRef}`),
    ];
  } catch {
    return [];
  }
}
