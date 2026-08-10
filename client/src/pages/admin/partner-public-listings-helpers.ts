/**
 * Super Admin public-listing UI — pure helpers.
 *
 * The server and the 0058 trigger remain authoritative. These helpers only prevent an operator
 * from sending an obviously malformed request and make the existing lifecycle legible.
 */
export const PUBLIC_LISTING_STATUSES = ["DRAFT", "PENDING_REVIEW", "ACTIVE", "PAUSED", "SUSPENDED", "REMOVED"] as const;
export type PublicListingStatus = (typeof PUBLIC_LISTING_STATUSES)[number];

const LISTING_TRANSITIONS: Record<PublicListingStatus, readonly PublicListingStatus[]> = {
  DRAFT: ["PENDING_REVIEW", "REMOVED"],
  PENDING_REVIEW: ["ACTIVE", "DRAFT", "REMOVED"],
  ACTIVE: ["PAUSED", "SUSPENDED", "REMOVED"],
  PAUSED: ["ACTIVE", "SUSPENDED", "REMOVED"],
  SUSPENDED: ["ACTIVE", "REMOVED"],
  REMOVED: [],
};

export function isPublicListingStatus(value: string): value is PublicListingStatus {
  return (PUBLIC_LISTING_STATUSES as readonly string[]).includes(value);
}

/** Browser labels only; the API and database revalidate the transition. */
export function nextListingStatuses(value: string): PublicListingStatus[] {
  return isPublicListingStatus(value) ? [...LISTING_TRANSITIONS[value]] : [];
}

export function listingStatusLabel(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function listingReasonValid(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 500;
}

export function publicListingSlugValid(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 3 && trimmed.length <= 120 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(trimmed);
}

export type Coordinates = { latitude: number | null; longitude: number | null };

/** Both coordinates must be present or absent; a map pin must never be half-real. */
export function parseCoordinatePair(latitude: string, longitude: string): Coordinates | null {
  const lat = latitude.trim();
  const lng = longitude.trim();
  if (!lat && !lng) return { latitude: null, longitude: null };
  if (!lat || !lng) return null;
  const parsedLat = Number(lat);
  const parsedLng = Number(lng);
  if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLng)) return null;
  if (parsedLat < -90 || parsedLat > 90 || parsedLng < -180 || parsedLng > 180) return null;
  return { latitude: parsedLat, longitude: parsedLng };
}

export function ratingOverrideValid(rating: string, label: string, reason: string): boolean {
  if (!listingReasonValid(reason)) return false;
  const text = label.trim();
  if (text.length > 500) return false;
  const raw = rating.trim();
  if (!raw) return text.length > 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 5;
}
