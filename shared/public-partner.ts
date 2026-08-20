/** Public Partner contracts shared by the server projection and customer UI. */

export const PARTNER_PUBLIC_PRIVACY_STATES = [
  "PUBLIC_STOREFRONT",
  "SERVICE_AREA_PRIVATE_ADDRESS",
  "NOT_PUBLIC",
  "INCOMPLETE_UNVERIFIED",
] as const;

export type PartnerPublicPrivacyState = (typeof PARTNER_PUBLIC_PRIVACY_STATES)[number];

export interface PublicPartnerLocation {
  publicRef: string;
  displayName: string;
  locationName: string;
  privacyState: "PUBLIC_STOREFRONT" | "SERVICE_AREA_PRIVATE_ADDRESS";
  address: string | null;
  serviceArea: string | null;
  designation: "MintVault Partner";
  websiteUrl: string | null;
  phone: string | null;
  email: string | null;
  mapsUrl: string | null;
  cardsGraded: number | null;
  /** Exact definition of cardsGraded; never implies the Partner issued a certificate. */
  cardsGradedMeaning: "Approved cards graded by MintVault through this Partner location";
  partnerSince: string | null;
}

export type PublicLocationPublicationBlocker =
  | "ORGANISATION_NOT_ACTIVE"
  | "LOCATION_NOT_ACTIVE"
  | "PARTNER_CONSENT_REQUIRED"
  | "PARTNER_APPROVAL_REQUIRED"
  | "PARTNER_NOT_LISTED"
  | "LOCATION_CONSENT_REQUIRED"
  | "FIELD_CONSENT_REQUIRED"
  | "LOCATION_APPROVAL_REQUIRED"
  | "LOCATION_NOT_LISTED"
  | "PRIVACY_CLASSIFICATION_REQUIRED"
  | "PUBLIC_DISPLAY_NAME_REQUIRED"
  | "PUBLIC_LOCATION_NAME_REQUIRED"
  | "PUBLIC_STREET_ADDRESS_REQUIRED"
  | "PUBLIC_SERVICE_AREA_REQUIRED"
  | "PUBLIC_CONTACT_ACTION_REQUIRED"
  | "MAPS_REQUIRES_PUBLIC_STOREFRONT"
  | "DIRECTORY_DISABLED";

export interface PublicLocationPublicationState {
  readyForApproval: boolean;
  approved: boolean;
  partnerListed: boolean;
  locationListed: boolean;
  live: boolean;
  blockingReasons: PublicLocationPublicationBlocker[];
}

export interface AuthenticatedPublicProfileRow {
  id: string;
  publicRef: string;
  operationalName: string;
  operationalAddress: string | null;
  status: string;
  privacyState: PartnerPublicPrivacyState;
  publicLocationName: string | null;
  publicStreetAddress: string | null;
  publicServiceArea: string | null;
  publicWebsite: string | null;
  publicPhone: string | null;
  publicEmail: string | null;
  mapsEnabled: boolean;
  consentedFields: string[];
  version: number;
  consentedAt: string | null;
  approvedVersion: number | null;
  approvedAt: string | null;
  publication: PublicLocationPublicationState;
  publicUrl: string;
  preview: PublicPartnerLocation | null;
}

export interface AuthenticatedPublicProfileStatus {
  available: boolean;
  owner: boolean;
  profile: {
    publicDisplayName: string | null;
    version: number;
    consentedAt: string | null;
    approvedVersion: number | null;
    approvedAt: string | null;
    listed: boolean;
  } | null;
  locations: AuthenticatedPublicProfileRow[];
}
