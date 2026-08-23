/**
 * BATCHED PARTNER READINESS FACTS — one query for a page of shops.
 *
 * Extracted from the Command Centre adapter so the Partner Network shops projection can answer
 * "what is the ONE next thing to do for this shop?" using the SAME authority. Before this, the
 * Shops table and Needs Attention derived blockers from raw projection counts and ranked them
 * themselves, which is a second calculation over one question — and two calculations disagree.
 *
 * Nothing here DECIDES anything. It gathers facts; `derivePartnerOperationalReadiness` decides, and
 * `readiness.nextAction` selects. The only judgement in this file is which facts to fetch.
 */
import { partnerAdminQuery } from "./db";
import type { PartnerReadinessFacts } from "./operational-readiness";
import { isCompletePartnerDeliveryAddress, isValidPartnerPostcode } from "@shared/partner-delivery-address";
import { hasValidPartnerOperationalContact } from "@shared/partner-operational-contact";

export type ReadinessFactRow = {
  partner_id: string;
  org_status: string;
  owner_status: string | null;
  password_configured: boolean | null;
  invitation_valid: boolean | null;
  mfa_required: boolean | null;
  mfa_configured: boolean | null;
  location_eligible: boolean | null;
  location_address: string | null;
  address_line1: string | null;
  address_line2: string | null;
  address_city: string | null;
  address_postcode: string | null;
  address_country: string | null;
  profile_postcode: string | null;
  profile_country: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_active: boolean | null;
  contact_primary: boolean | null;
  contact_type: string | null;
  station_enrolled: number | string;
  station_approved_active: number | string;
  station_pending: number | string;
  scanner_connected: boolean | null;
  last_seen_at: unknown;
  calibration_status: string | null;
  current_calibration_id: string | null;
  current_profile_revision_id: string | null;
  app_version: string | null;
  minimum_supported_version: string | null;
  wallet_tenant_id: string | null;
  wallet_balance: number | string | null;
  /**
   * Present only when the caller asked for staff (`withStaff`). The Command Centre snapshot does
   * NOT ask, and must keep not asking: it deliberately reports staff as UNKNOWN so a bulk
   * projection can never claim a shop is ready on a question it did not put.
   */
  staff_scan_capable: number | string | null;
  staff_location_scoped_without_location: number | string | null;
};


export async function listReadinessFacts(
  partnerIds: readonly string[],
  walletSchema: boolean,
  profileRevisionSchema: boolean,
  withStaff = false
): Promise<ReadinessFactRow[]> {
  if (partnerIds.length === 0) return [];
  const walletProjection = walletSchema
    ? "wallet.tenant_id::text AS wallet_tenant_id, wallet.balance AS wallet_balance"
    : "NULL::text AS wallet_tenant_id, NULL::numeric AS wallet_balance";
  const walletJoin = walletSchema ? "LEFT JOIN partner_wallet_balances wallet ON wallet.tenant_id=o.id" : "";
  const profileRevisionProjection = profileRevisionSchema
    ? "active.current_profile_revision_id"
    : "NULL::uuid AS current_profile_revision_id";
  /*
   * STAFF, only when asked for.
   *
   * `scan_capable` counts ACTIVE users who can actually work a Scanner. `location_scoped_without_
   * location` counts ACTIVE users holding a location-scoped role with no authorised location — the
   * condition that silently stops a Scanner being set up for them.
   *
   * Opt-in because the Command Centre snapshot must keep answering UNKNOWN here. Adding it there
   * would change what that surface's blocked-partner rollup reports, and nothing asked for that.
   */
  const staffProjection = withStaff
    ? `COALESCE(staff.scan_capable, 0)::int AS staff_scan_capable,
            COALESCE(staff.location_scoped_without_location, 0)::int AS staff_location_scoped_without_location`
    : "NULL::int AS staff_scan_capable, NULL::int AS staff_location_scoped_without_location";
  const staffJoin = withStaff
    ? `LEFT JOIN LATERAL (
         SELECT count(*) FILTER (
                  WHERE u.status = 'ACTIVE' AND EXISTS (
                    SELECT 1 FROM partner_user_roles ur
                    JOIN partner_roles r ON r.id = ur.role_id
                    WHERE ur.tenant_id = u.tenant_id AND ur.user_id = u.id
                      AND r.code IN ('PARTNER_OWNER','PARTNER_MANAGER','PARTNER_OPERATOR')
                  )
                ) AS scan_capable,
                count(*) FILTER (
                  WHERE u.status = 'ACTIVE'
                    AND EXISTS (
                      SELECT 1 FROM partner_user_roles ur
                      JOIN partner_roles r ON r.id = ur.role_id
                      WHERE ur.tenant_id = u.tenant_id AND ur.user_id = u.id
                        AND r.code = 'PARTNER_OPERATOR'
                    )
                    AND NOT EXISTS (
                      SELECT 1 FROM partner_user_locations ul
                      JOIN partner_locations pl ON pl.id = ul.location_id AND pl.tenant_id = ul.tenant_id
                      WHERE ul.tenant_id = u.tenant_id AND ul.user_id = u.id AND pl.status = 'ACTIVE'
                    )
                ) AS location_scoped_without_location
           FROM partner_users u
          WHERE u.tenant_id = o.id
       ) staff ON true`
    : "";
  const result = await partnerAdminQuery<ReadinessFactRow>(
    `SELECT o.id::text AS partner_id, o.status AS org_status,
            owner.user_status AS owner_status,
            owner.password_configured, owner.invitation_valid,
            owner.mfa_required, owner.mfa_configured, owner.location_eligible,
            main.address AS location_address,
            main.address_line1, main.address_line2, main.address_city,
            main.address_postcode, main.address_country,
            profile.address_postcode AS profile_postcode, profile.address_country AS profile_country,
            operations.full_name AS contact_name, operations.email AS contact_email,
            operations.active AS contact_active, operations.is_primary AS contact_primary,
            operations.contact_type,
            COALESCE(station.enrolled, 0)::int AS station_enrolled,
            COALESCE(station.approved_active, 0)::int AS station_approved_active,
            COALESCE(station.pending_approval, 0)::int AS station_pending,
            active.scanner_connected, active.last_seen_at, active.calibration_status,
            active.current_calibration_id, ${profileRevisionProjection},
            active.app_version, active.minimum_supported_version,
            ${walletProjection},
            ${staffProjection}
       FROM partner_organisations o
       LEFT JOIN LATERAL (
         SELECT u.status AS user_status,
                (u.password_hash IS NOT NULL AND u.password_set_at IS NOT NULL) AS password_configured,
                (i.status IN ('PENDING','SENT','DELIVERY_FAILED') AND i.expires_at > now()) AS invitation_valid,
                u.mfa_required,
                EXISTS (SELECT 1 FROM partner_mfa_methods m
                         WHERE m.tenant_id=u.tenant_id AND m.user_id=u.id AND m.method='totp'
                           AND m.status='ACTIVE' AND m.secret_ref IS NOT NULL) AS mfa_configured,
                EXISTS (
                  SELECT 1 FROM partner_locations l
                  LEFT JOIN partner_user_locations ul
                    ON ul.tenant_id=l.tenant_id AND ul.location_id=l.id AND ul.user_id=u.id
                  WHERE l.tenant_id=u.tenant_id AND l.status='ACTIVE'
                    AND (ul.user_id IS NOT NULL OR EXISTS (
                      SELECT 1 FROM partner_user_roles ur
                      JOIN partner_roles r ON r.id=ur.role_id
                      WHERE ur.tenant_id=u.tenant_id AND ur.user_id=u.id
                        AND r.code IN ('PARTNER_OWNER','PARTNER_MANAGER','PARTNER_FINANCE_VIEWER')
                    ))
                ) AS location_eligible
           FROM partner_users u
           LEFT JOIN LATERAL (
             SELECT status, expires_at FROM partner_invitations pi
              WHERE pi.tenant_id=u.tenant_id AND pi.user_id=u.id
              ORDER BY pi.created_at DESC LIMIT 1
           ) i ON true
          WHERE u.tenant_id=o.id
          ORDER BY
            (u.status <> 'REVOKED' AND EXISTS (
              SELECT 1 FROM partner_user_roles our
              JOIN partner_roles role ON role.id=our.role_id
              WHERE our.tenant_id=u.tenant_id AND our.user_id=u.id AND role.code='PARTNER_OWNER'
            )) DESC,
            (u.status <> 'REVOKED') DESC,
            u.created_at DESC, u.email ASC
          LIMIT 1
       ) owner ON true
       LEFT JOIN LATERAL (
         SELECT l.address, l.address_line1, l.address_line2, l.address_city,
                l.address_postcode, l.address_country
           FROM partner_locations l
          WHERE l.tenant_id=o.id AND l.status='ACTIVE'
          ORDER BY (lower(btrim(l.name)) = 'main location') DESC, l.created_at ASC, l.id ASC
          LIMIT 1
       ) main ON true
       LEFT JOIN partner_profiles profile ON profile.tenant_id=o.id
       LEFT JOIN LATERAL (
         SELECT c.full_name, c.email, c.active, c.is_primary, c.contact_type
           FROM partner_contacts c
          WHERE c.tenant_id=o.id AND c.active AND c.is_primary AND c.contact_type='operations'
          ORDER BY c.created_at ASC, c.id ASC
          LIMIT 1
       ) operations ON true
       LEFT JOIN LATERAL (
         SELECT count(*) FILTER (WHERE s.status <> 'REVOKED') AS enrolled,
                count(*) FILTER (WHERE s.status='ACTIVE' AND s.approved_at IS NOT NULL AND l.status='ACTIVE') AS approved_active,
                count(*) FILTER (WHERE s.status='PENDING' AND s.approved_at IS NULL) AS pending_approval
           FROM partner_stations s
           LEFT JOIN partner_locations l ON l.id=s.location_id AND l.tenant_id=s.tenant_id
          WHERE s.tenant_id=o.id
       ) station ON true
       LEFT JOIN LATERAL (
         SELECT s.scanner_connected, s.last_seen_at, s.calibration_status,
                s.current_calibration_id,
                ${profileRevisionSchema ? "s.current_profile_revision_id," : ""}
                s.app_version, s.minimum_supported_version
           FROM partner_stations s
           JOIN partner_locations l ON l.id=s.location_id AND l.tenant_id=s.tenant_id AND l.status='ACTIVE'
          WHERE s.tenant_id=o.id AND s.status='ACTIVE' AND s.approved_at IS NOT NULL
          ORDER BY s.last_seen_at DESC NULLS LAST LIMIT 1
       ) active ON true
       ${walletJoin}
       ${staffJoin}
      WHERE o.id = ANY($1::uuid[])
      ORDER BY o.created_at ASC, o.id ASC`,
    [partnerIds]
  );
  return result.rows;
}


export async function readGlobalReadinessFlags(): Promise<{
  portalEnabled: boolean;
  loginFlagEnabled: boolean;
  emergencyStop: boolean;
}> {
  const flags = ["partner_portal_enabled", "partner_login_enabled", "partner_emergency_stop"] as const;
  const result = await partnerAdminQuery<{ flag: string; enabled: boolean }>(
    `SELECT DISTINCT ON (flag) flag, enabled
       FROM partner_feature_flags
      WHERE flag = ANY($1::text[]) AND tenant_id IS NULL AND location_id IS NULL
      ORDER BY flag, updated_at DESC, id DESC`,
    [flags]
  );
  const enabled = new Map(result.rows.map((row) => [row.flag, row.enabled === true]));
  return {
    portalEnabled: enabled.get("partner_portal_enabled") === true,
    loginFlagEnabled: enabled.get("partner_login_enabled") === true,
    emergencyStop: enabled.get("partner_emergency_stop") === true,
  };
}


/**
 * One fact row -> the readiness facts contract. Lifted verbatim from the Command Centre adapter so
 * the two paths cannot drift; the only difference is that `staff` and `testCard` are parameters
 * rather than hard-coded nulls.
 */
export function toReadinessFacts(
  row: ReadinessFactRow,
  globals: { portalEnabled: boolean; loginFlagEnabled: boolean; emergencyStop: boolean },
  options: { walletSchema: boolean; profileRevisionSchema: boolean; nowMs: number; withStaff: boolean }
): PartnerReadinessFacts {
  const activeStation =
    row.calibration_status === null
      ? null
      : {
          scannerConnected: row.scanner_connected === true,
          lastSeenAt: row.last_seen_at == null ? null : new Date(row.last_seen_at as string | number | Date).toISOString(),
          calibrationStatus: row.calibration_status,
          currentCalibrationId: row.current_calibration_id,
          currentProfileRevisionId: options.profileRevisionSchema ? row.current_profile_revision_id : undefined,
          appVersion: row.app_version,
          minimumSupportedVersion: row.minimum_supported_version,
        };
  return {
    /*
     * UNKNOWN, never PASS, when the caller did not ask for staff. An unasked question must not
     * resolve to green — that is the whole discipline this contract exists to keep.
     */
    staff:
      options.withStaff && row.staff_scan_capable !== null
        ? {
            scanCapableCount: Number(row.staff_scan_capable),
            locationScopedWithoutLocation: Number(row.staff_location_scoped_without_location ?? 0),
          }
        : null,
    /*
     * The onboarding TEST CARD is never answered in bulk. It needs the Card Job lifecycle and the
     * per-card accepted-sides read, which is a per-shop query, and an N+1 across a page of shops is
     * not worth it for a column. It stays UNKNOWN here, which is honest: the shops table reports
     * whether a shop can GRADE, and the onboarding page — which loads full readiness for one shop —
     * is where the test card is answered.
     */
    testCard: null,
    orgStatus: row.org_status,
    portalEnabled: globals.portalEnabled,
    loginFlagEnabled: globals.loginFlagEnabled,
    emergencyStop: globals.emergencyStop,
    owner:
      row.owner_status === null
        ? null
        : {
            userStatus: row.owner_status,
            passwordConfigured: row.password_configured === true,
            invitationValid: row.invitation_valid === true,
            mfaRequired: row.mfa_required === true,
            mfaConfigured: row.mfa_configured === true,
          },
    locationEligible: row.location_eligible === true,
    deliveryAddressReady: (() => {
      const hasStructured = [
        row.address_line1,
        row.address_line2,
        row.address_city,
        row.address_postcode,
        row.address_country,
      ].some((value) => value != null);
      if (hasStructured) {
        return isCompletePartnerDeliveryAddress({
          line1: row.address_line1,
          line2: row.address_line2,
          city: row.address_city,
          postcode: row.address_postcode,
          country: row.address_country,
        });
      }
      return (
        (row.location_address?.trim().length ?? 0) >= 12 &&
        !!row.profile_postcode &&
        !!row.profile_country &&
        isValidPartnerPostcode(row.profile_postcode, row.profile_country)
      );
    })(),
    operationsContactReady: hasValidPartnerOperationalContact({
      fullName: row.contact_name,
      email: row.contact_email,
      active: row.contact_active,
      primary: row.contact_primary,
      type: row.contact_type,
    }),
    station: {
      enrolledCount: Number(row.station_enrolled),
      approvedActiveCount: Number(row.station_approved_active),
      pendingApprovalCount: Number(row.station_pending),
      active: activeStation,
    },
    credits: !options.walletSchema
      ? null
      : row.wallet_tenant_id === null
        ? "NO_WALLET"
        : row.wallet_balance === null
          ? null
          : Number(row.wallet_balance),
    nowMs: options.nowMs,
  };
}
