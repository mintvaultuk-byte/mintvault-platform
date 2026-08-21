/** Partner-owned public drafts and Super-Admin exact-version publication. */
import type { PoolClient } from "pg";
import type {
  AuthenticatedPublicProfileRow,
  AuthenticatedPublicProfileStatus,
  PartnerPublicPrivacyState,
} from "@shared/public-partner";
import type { PartnerPrincipal } from "./session";
import { withPartnerAdminTransaction, withTenant } from "./db";
import { readEmergencyState, isHardStopped } from "./emergency";
import { writePartnerAudit } from "./audit";
import {
  PUBLIC_DIRECTORY_FLAG,
  PUBLIC_PARTNER_PROFILE_PREFIX,
  derivePublicLocationPublicationState,
  getPublicPartnerLocationPreviews,
  safePublicEmail,
  safePublicPhone,
  safePublicWebsite,
} from "./public-presence-service";

export class PublicPublicationError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) {
    super(message);
    this.name = "PublicPublicationError";
  }
}

type PublicationRow = {
  id: string;
  public_ref: string;
  operational_name: string;
  operational_address: string | null;
  location_status: string;
  organisation_status: string;
  public_display_name: string | null;
  profile_version: number | null;
  profile_consented_at: string | null;
  profile_approved_version: number | null;
  profile_approved_at: string | null;
  profile_listed: boolean | null;
  privacy_state: PartnerPublicPrivacyState | null;
  public_location_name: string | null;
  public_street_address: string | null;
  public_service_area: string | null;
  public_website: string | null;
  public_phone: string | null;
  public_email: string | null;
  maps_enabled: boolean | null;
  consented_fields: string[] | null;
  location_version: number | null;
  location_consented_at: string | null;
  location_approved_version: number | null;
  location_approved_at: string | null;
  location_listed: boolean | null;
  directory_enabled: boolean;
};

async function schemaAvailable(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ ready: boolean }>(
    `SELECT to_regclass('public.partner_public_profiles') IS NOT NULL
         AND to_regclass('public.partner_location_publications') IS NOT NULL AS ready`
  );
  return result.rows[0]?.ready === true;
}

async function isOwner(client: PoolClient, userId: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM partner_user_roles ur
      JOIN partner_roles r ON r.id=ur.role_id
     WHERE ur.user_id=$1 AND r.code='PARTNER_OWNER' LIMIT 1`,
    [userId]
  );
  return result.rowCount === 1;
}

const STATUS_SQL = `
  SELECT l.id,l.public_ref,l.name AS operational_name,l.address AS operational_address,
         l.status AS location_status,o.status AS organisation_status,
         pp.public_display_name,pp.version AS profile_version,pp.consented_at AS profile_consented_at,
         pp.approved_version AS profile_approved_version,pp.approved_at AS profile_approved_at,
         pp.listed AS profile_listed,
         lp.privacy_state,lp.public_location_name,lp.public_street_address,lp.public_service_area,
         lp.public_website,lp.public_phone,lp.public_email,lp.maps_enabled,lp.consented_fields,
         lp.version AS location_version,lp.consented_at AS location_consented_at,
         lp.approved_version AS location_approved_version,lp.approved_at AS location_approved_at,
         lp.listed AS location_listed,
         COALESCE((SELECT enabled FROM partner_feature_flags
                    WHERE flag=$2 AND tenant_id IS NULL AND location_id IS NULL
                    ORDER BY updated_at DESC,id DESC LIMIT 1),false) AS directory_enabled
    FROM partner_locations l
    JOIN partner_organisations o ON o.id=l.tenant_id AND o.id=l.partner_id
    LEFT JOIN partner_public_profiles pp ON pp.tenant_id=l.tenant_id
    LEFT JOIN partner_location_publications lp ON lp.tenant_id=l.tenant_id AND lp.location_id=l.id
   WHERE l.tenant_id=$1`;

function statusFromRows(
  available: boolean,
  owner: boolean,
  rows: PublicationRow[],
  previews: Map<string, import("@shared/public-partner").PublicPartnerLocation>
): AuthenticatedPublicProfileStatus {
  if (!available) return { available: false, owner, profile: null, locations: [] };
  const first = rows[0];
  return {
    available: true,
    owner,
    profile: first
      ? {
          publicDisplayName: first.public_display_name,
          version: Number(first.profile_version ?? 0),
          consentedAt: first.profile_consented_at,
          approvedVersion: first.profile_approved_version == null ? null : Number(first.profile_approved_version),
          approvedAt: first.profile_approved_at,
          listed: first.profile_listed === true,
        }
      : null,
    locations: rows.map((row): AuthenticatedPublicProfileRow => {
      const publication = derivePublicLocationPublicationState({
        organisationStatus: row.organisation_status,
        locationStatus: row.location_status,
        publicDisplayName: row.public_display_name,
        profileVersion: row.profile_version ?? 0,
        profileConsentedAt: row.profile_consented_at,
        profileApprovedVersion: row.profile_approved_version,
        profileListed: row.profile_listed === true,
        privacyState: row.privacy_state ?? "INCOMPLETE_UNVERIFIED",
        publicLocationName: row.public_location_name,
        publicStreetAddress: row.public_street_address,
        publicServiceArea: row.public_service_area,
        publicWebsite: row.public_website,
        publicPhone: row.public_phone,
        publicEmail: row.public_email,
        mapsEnabled: row.maps_enabled === true,
        consentedFields: row.consented_fields ?? [],
        locationVersion: row.location_version ?? 0,
        locationConsentedAt: row.location_consented_at,
        locationApprovedVersion: row.location_approved_version,
        locationListed: row.location_listed === true,
        directoryEnabled: row.directory_enabled,
      });
      return {
        id: row.id,
        publicRef: row.public_ref,
        operationalName: row.operational_name,
        operationalAddress: row.operational_address,
        status: row.location_status,
        privacyState: row.privacy_state ?? "INCOMPLETE_UNVERIFIED",
        publicLocationName: row.public_location_name,
        publicStreetAddress: row.public_street_address,
        publicServiceArea: row.public_service_area,
        publicWebsite: row.public_website,
        publicPhone: row.public_phone,
        publicEmail: row.public_email,
        mapsEnabled: row.maps_enabled === true,
        consentedFields: row.consented_fields ?? [],
        version: Number(row.location_version ?? 0),
        consentedAt: row.location_consented_at,
        approvedVersion: row.location_approved_version == null ? null : Number(row.location_approved_version),
        approvedAt: row.location_approved_at,
        publication,
        publicUrl: `${PUBLIC_PARTNER_PROFILE_PREFIX}${encodeURIComponent(row.public_ref)}`,
        preview: previews.get(row.id) ?? null,
      };
    }),
  };
}

export async function getPartnerPublicProfileStatus(principal: PartnerPrincipal): Promise<AuthenticatedPublicProfileStatus> {
  const result = await withTenant({ tenantId: principal.tenantId }, async (client) => {
    const owner = await isOwner(client, principal.userId);
    if (!(await schemaAvailable(client))) return { available: false, owner, rows: [] as PublicationRow[] };
    const access = principal.orgWide
      ? "TRUE"
      : "EXISTS (SELECT 1 FROM partner_user_locations pul WHERE pul.location_id=l.id AND pul.user_id=$3)";
    const params = principal.orgWide
      ? [principal.tenantId, PUBLIC_DIRECTORY_FLAG]
      : [principal.tenantId, PUBLIC_DIRECTORY_FLAG, principal.userId];
    const rows = await client.query<PublicationRow>(
      `${STATUS_SQL} AND ${access} ORDER BY (l.status='ACTIVE') DESC,l.name,l.id`,
      params
    );
    return { available: true, owner, rows: rows.rows };
  });
  if (!result.available) return statusFromRows(false, result.owner, [], new Map());
  const previews = await getPublicPartnerLocationPreviews(principal.tenantId, result.rows.map((row) => row.id));
  return statusFromRows(true, result.owner, result.rows, previews);
}

export async function getAdminPublicProfileStatus(tenantId: string): Promise<AuthenticatedPublicProfileStatus> {
  return withPartnerAdminTransaction(async (client) => {
    if (!(await schemaAvailable(client))) return statusFromRows(false, false, [], new Map());
    const result = await client.query<PublicationRow>(`${STATUS_SQL} ORDER BY (l.status='ACTIVE') DESC,l.name,l.id`, [tenantId, PUBLIC_DIRECTORY_FLAG]);
    // The preview query intentionally runs after this short read transaction so
    // it uses the one canonical mapper and never widens the admin DTO.
    return statusFromRows(true, false, result.rows, new Map());
  }).then(async (status) => {
    if (!status.available) return status;
    const previews = await getPublicPartnerLocationPreviews(tenantId, status.locations.map((location) => location.id));
    const byId = new Map(status.locations.map((location) => [location.id, location]));
    for (const [id, preview] of previews) {
      const row = byId.get(id);
      if (row) row.preview = preview;
    }
    return status;
  });
}

function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function requiredText(value: unknown, min: number, max: number, label: string): string {
  if (typeof value !== "string" || hasAsciiControl(value)) {
    throw new PublicPublicationError("VALIDATION_ERROR", 400, `${label} is not valid.`);
  }
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length < min) throw new PublicPublicationError("VALIDATION_ERROR", 400, `${label} is required.`);
  if (clean.length > max) throw new PublicPublicationError("VALIDATION_ERROR", 400, `${label} must be ${max} characters or fewer.`);
  return clean;
}
function optionalText(value: unknown, max: number, label = "Value"): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || hasAsciiControl(value)) {
    throw new PublicPublicationError("VALIDATION_ERROR", 400, `${label} is not valid.`);
  }
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length > max) throw new PublicPublicationError("VALIDATION_ERROR", 400, `${label} must be ${max} characters or fewer.`);
  return clean || null;
}
function optionalValidated(
  value: unknown,
  parser: (candidate: unknown) => string | null,
  label: string,
  max: number
): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.length > max) {
    throw new PublicPublicationError("VALIDATION_ERROR", 400, `${label} is not valid.`);
  }
  const parsed = parser(value);
  if (!parsed) throw new PublicPublicationError("VALIDATION_ERROR", 400, `${label} is not valid.`);
  return parsed;
}

export interface PartnerPublicDraftInput {
  expectedProfileVersion: unknown;
  expectedLocationVersion: unknown;
  publicDisplayName: unknown;
  privacyState: unknown;
  publicLocationName: unknown;
  publicStreetAddress?: unknown;
  publicServiceArea?: unknown;
  publicWebsite?: unknown;
  publicPhone?: unknown;
  publicEmail?: unknown;
  mapsEnabled?: unknown;
  attested?: unknown;
}

export async function savePartnerPublicDraft(
  principal: PartnerPrincipal,
  locationId: string,
  input: PartnerPublicDraftInput
): Promise<void> {
  if (
    !Number.isInteger(input.expectedProfileVersion) ||
    Number(input.expectedProfileVersion) < 0 ||
    !Number.isInteger(input.expectedLocationVersion) ||
    Number(input.expectedLocationVersion) < 0
  ) {
    throw new PublicPublicationError(
      "VALIDATION_ERROR",
      400,
      "The exact profile and location versions are required before saving."
    );
  }
  const expectedProfileVersion = Number(input.expectedProfileVersion);
  const expectedLocationVersion = Number(input.expectedLocationVersion);
  if (input.attested !== true) {
    throw new PublicPublicationError("ATTESTATION_REQUIRED", 400, "Confirm that every selected value is safe to publish.");
  }
  const privacyState = input.privacyState as PartnerPublicPrivacyState;
  if (!["PUBLIC_STOREFRONT", "SERVICE_AREA_PRIVATE_ADDRESS", "NOT_PUBLIC", "INCOMPLETE_UNVERIFIED"].includes(privacyState)) {
    throw new PublicPublicationError("VALIDATION_ERROR", 400, "Choose a valid public-location privacy state.");
  }
  if (typeof input.mapsEnabled !== "boolean") {
    throw new PublicPublicationError("VALIDATION_ERROR", 400, "Maps permission must be true or false.");
  }
  const displayName = requiredText(input.publicDisplayName, 2, 160, "Public business name");
  const locationName = optionalText(input.publicLocationName, 120, "Public location name");
  const street = optionalText(input.publicStreetAddress, 500, "Public storefront address");
  const area = optionalText(input.publicServiceArea, 160, "Public service area");
  const website = optionalValidated(input.publicWebsite, safePublicWebsite, "Website URL", 2048);
  const phone = optionalValidated(input.publicPhone, safePublicPhone, "Phone number", 40);
  const email = optionalValidated(input.publicEmail, safePublicEmail, "Email address", 254);
  let mapsEnabled = input.mapsEnabled;
  if (privacyState === "PUBLIC_STOREFRONT") {
    requiredText(locationName, 2, 120, "Public location name");
    requiredText(street, 5, 500, "Public storefront address");
  }
  if (privacyState === "SERVICE_AREA_PRIVATE_ADDRESS") {
    requiredText(locationName, 2, 120, "Public location name");
    requiredText(area, 2, 160, "Public service area");
    mapsEnabled = false;
  }
  if (privacyState === "NOT_PUBLIC" || privacyState === "INCOMPLETE_UNVERIFIED") mapsEnabled = false;
  const publicStreet = privacyState === "PUBLIC_STOREFRONT" ? street : null;
  const publicArea = privacyState === "SERVICE_AREA_PRIVATE_ADDRESS" ? area : null;
  const consentedFields = [
    ...(locationName ? ["public_location_name"] : []),
    ...(publicStreet ? ["public_street_address"] : []),
    ...(publicArea ? ["public_service_area"] : []),
    ...(website ? ["public_website"] : []),
    ...(phone ? ["public_phone"] : []),
    ...(email ? ["public_email"] : []),
    ...(mapsEnabled ? ["maps_enabled"] : []),
  ];

  await withTenant({ tenantId: principal.tenantId, locationId }, async (client) => {
    if (!(await schemaAvailable(client))) throw new PublicPublicationError("SCHEMA_UNAVAILABLE", 503, "Public profiles are not ready yet.");
    if (!(await isOwner(client, principal.userId))) {
      throw new PublicPublicationError("FORBIDDEN", 403, "Only a Partner Owner may attest public details.");
    }
    const target = await client.query<{ status: string }>(
      "SELECT status FROM partner_locations WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
      [principal.tenantId, locationId]
    );
    if (target.rowCount !== 1) throw new PublicPublicationError("NOT_FOUND", 404, "Location not found.");
    const emergency = await readEmergencyState(client, { tenantId: principal.tenantId, locationId });
    if (isHardStopped(emergency) || emergency.viewOnly || emergency.sensitiveDisabled) {
      throw new PublicPublicationError("OPERATION_FROZEN", 423, "Public-profile changes are paused for this location.");
    }

    const existing = await client.query<{ public_display_name: string; version: number; consented_at: string | null }>(
      "SELECT public_display_name,version,consented_at FROM partner_public_profiles WHERE tenant_id=$1 FOR UPDATE",
      [principal.tenantId]
    );
    const existingLocation = await client.query<{ version: number }>(
      `SELECT version FROM partner_location_publications
        WHERE tenant_id=$1 AND location_id=$2 FOR UPDATE`,
      [principal.tenantId, locationId]
    );
    if (
      Number(existing.rows[0]?.version ?? 0) !== expectedProfileVersion ||
      Number(existingLocation.rows[0]?.version ?? 0) !== expectedLocationVersion
    ) {
      throw new PublicPublicationError(
        "STALE_DRAFT",
        409,
        "Public details changed in another location form. Refresh before attesting this exact version."
      );
    }
    const profileChanged = existing.rowCount !== 1 || existing.rows[0].public_display_name !== displayName || !existing.rows[0].consented_at;
    if (existing.rowCount === 0) {
      await client.query(
        `INSERT INTO partner_public_profiles
          (tenant_id,public_display_name,version,consented_by,consented_at,listed)
         VALUES ($1,$2,1,$3,now(),false)`,
        [principal.tenantId, displayName, principal.userId]
      );
    } else if (profileChanged) {
      await client.query(
        `UPDATE partner_public_profiles SET public_display_name=$2,version=version+1,
                consented_by=$3,consented_at=now(),approved_version=NULL,approved_by=NULL,
                approved_at=NULL,listed=false,updated_at=now() WHERE tenant_id=$1`,
        [principal.tenantId, displayName, principal.userId]
      );
      // A shared public identity change invalidates every location approval.
      await client.query(
        `UPDATE partner_location_publications SET listed=false,updated_at=now() WHERE tenant_id=$1`,
        [principal.tenantId]
      );
    }

    await client.query(
      `INSERT INTO partner_location_publications
        (tenant_id,location_id,privacy_state,public_location_name,public_street_address,public_service_area,
         public_website,public_phone,public_email,maps_enabled,consented_fields,version,consented_by,consented_at,listed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12,now(),false)
       ON CONFLICT (tenant_id,location_id) DO UPDATE SET
         privacy_state=EXCLUDED.privacy_state,public_location_name=EXCLUDED.public_location_name,
         public_street_address=EXCLUDED.public_street_address,public_service_area=EXCLUDED.public_service_area,
         public_website=EXCLUDED.public_website,public_phone=EXCLUDED.public_phone,
         public_email=EXCLUDED.public_email,maps_enabled=EXCLUDED.maps_enabled,
         consented_fields=EXCLUDED.consented_fields,version=partner_location_publications.version+1,
         consented_by=EXCLUDED.consented_by,consented_at=now(),approved_version=NULL,
         approved_by=NULL,approved_at=NULL,listed=false,updated_at=now()`,
      [
        principal.tenantId, locationId, privacyState, locationName, publicStreet, publicArea,
        website, phone, email, mapsEnabled, consentedFields, principal.userId,
      ]
    );
    await writePartnerAudit(client, {
      tenantId: principal.tenantId,
      locationId,
      actorUserId: principal.userId,
      sessionId: principal.sessionId,
      action: "partner_public_profile_attested",
      recordType: "partner_location_publication",
      recordId: locationId,
      after: {
        privacyState,
        consentedFields,
        hasPublicWebsite: !!website,
        hasPublicPhone: !!phone,
        hasPublicEmail: !!email,
        mapsEnabled,
      },
      reason: "Partner Owner attested exact public fields",
    });
  });
}

export async function setAdminPublicPublication(input: {
  tenantId: string;
  locationId: string;
  enabled: boolean;
  expectedProfileVersion?: number;
  expectedLocationVersion?: number;
  reason: string;
  adminEmail: string;
}): Promise<void> {
  if (typeof input.enabled !== "boolean") throw new PublicPublicationError("VALIDATION_ERROR", 400, "Enabled must be true or false.");
  if (typeof input.reason !== "string" || hasAsciiControl(input.reason)) {
    throw new PublicPublicationError("VALIDATION_ERROR", 400, "A valid publication reason is required.");
  }
  const reason = input.reason.trim();
  if (!reason || reason.length > 500) {
    throw new PublicPublicationError("VALIDATION_ERROR", 400, "A publication reason of 1-500 characters is required.");
  }

  await withPartnerAdminTransaction(async (client) => {
    if (!(await schemaAvailable(client))) throw new PublicPublicationError("SCHEMA_UNAVAILABLE", 503, "Public profiles are not ready yet.");
    const target = await client.query(
      "SELECT 1 FROM partner_locations WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
      [input.tenantId, input.locationId]
    );
    if (target.rowCount !== 1) throw new PublicPublicationError("NOT_FOUND", 404, "Location not found.");
    await client.query("SELECT 1 FROM partner_public_profiles WHERE tenant_id=$1 FOR UPDATE", [input.tenantId]);
    await client.query(
      "SELECT 1 FROM partner_location_publications WHERE tenant_id=$1 AND location_id=$2 FOR UPDATE",
      [input.tenantId, input.locationId]
    );
    const result = await client.query<PublicationRow>(`${STATUS_SQL} AND l.id=$3`, [
      input.tenantId,
      PUBLIC_DIRECTORY_FLAG,
      input.locationId,
    ]);
    const row = result.rows[0];
    if (!row) throw new PublicPublicationError("NOT_READY", 409, "Partner consent is required before publication.");
    if (input.enabled) {
      if (
        !Number.isInteger(input.expectedProfileVersion) ||
        !Number.isInteger(input.expectedLocationVersion) ||
        Number(row.profile_version) !== input.expectedProfileVersion ||
        Number(row.location_version) !== input.expectedLocationVersion
      ) {
        throw new PublicPublicationError(
          "STALE_PREVIEW",
          409,
          "The Partner changed this public profile after it was reviewed. Refresh and review the exact current preview."
        );
      }
      const readiness = derivePublicLocationPublicationState({
        organisationStatus: row.organisation_status,
        locationStatus: row.location_status,
        publicDisplayName: row.public_display_name,
        profileVersion: row.profile_version ?? 0,
        profileConsentedAt: row.profile_consented_at,
        profileApprovedVersion: row.profile_approved_version,
        profileListed: row.profile_listed === true,
        privacyState: row.privacy_state ?? "INCOMPLETE_UNVERIFIED",
        publicLocationName: row.public_location_name,
        publicStreetAddress: row.public_street_address,
        publicServiceArea: row.public_service_area,
        publicWebsite: row.public_website,
        publicPhone: row.public_phone,
        publicEmail: row.public_email,
        mapsEnabled: row.maps_enabled === true,
        consentedFields: row.consented_fields ?? [],
        locationVersion: row.location_version ?? 0,
        locationConsentedAt: row.location_consented_at,
        locationApprovedVersion: row.location_approved_version,
        locationListed: row.location_listed === true,
        directoryEnabled: true,
      });
      if (!readiness.readyForApproval) {
        throw new PublicPublicationError("NOT_READY", 409, `Public profile is not ready: ${readiness.blockingReasons.join(", ")}`);
      }
      const profileApproval = await client.query(
        `UPDATE partner_public_profiles SET approved_version=version,approved_by=$2,
                approved_at=now(),listed=true,updated_at=now()
          WHERE tenant_id=$1 AND version=$3`,
        [input.tenantId, input.adminEmail, input.expectedProfileVersion]
      );
      const locationApproval = await client.query(
        `UPDATE partner_location_publications SET approved_version=version,approved_by=$3,
                approved_at=now(),listed=true,updated_at=now()
          WHERE tenant_id=$1 AND location_id=$2 AND version=$4`,
        [input.tenantId, input.locationId, input.adminEmail, input.expectedLocationVersion]
      );
      if (profileApproval.rowCount !== 1 || locationApproval.rowCount !== 1) {
        throw new PublicPublicationError(
          "STALE_PREVIEW",
          409,
          "The Partner changed this public profile after it was reviewed. Refresh and review the exact current preview."
        );
      }
    } else {
      await client.query(
        `UPDATE partner_location_publications SET listed=false,updated_at=now()
          WHERE tenant_id=$1 AND location_id=$2`,
        [input.tenantId, input.locationId]
      );
      await client.query(
        `UPDATE partner_public_profiles SET listed=EXISTS(
           SELECT 1 FROM partner_location_publications WHERE tenant_id=$1 AND listed=true
         ),updated_at=now() WHERE tenant_id=$1`,
        [input.tenantId]
      );
    }
    await client.query(
      `INSERT INTO partner_audit_events
        (tenant_id,location_id,action,record_type,record_id,reason,after_value)
       VALUES ($1,$2::uuid,$3,'partner_location_publication',$2::text,$4,$5)`,
      [
        input.tenantId,
        input.locationId,
        input.enabled ? "partner_public_profile_published" : "partner_public_profile_unpublished",
        reason,
        JSON.stringify({
          by: input.adminEmail,
          enabled: input.enabled,
          expectedProfileVersion: input.enabled ? input.expectedProfileVersion : undefined,
          expectedLocationVersion: input.enabled ? input.expectedLocationVersion : undefined,
        }),
      ]
    );
  });
}
