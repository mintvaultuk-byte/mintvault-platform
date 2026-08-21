import { createHash } from "node:crypto";
import { partnerAdminQuery, withPartnerAdminReadBudget } from "../partner/db";
import { getPartnerReadVisibility, getPartnerStationReadVisibility } from "../partner/dashboard-visibility";
import {
  getNetworkSummary,
  listConnectorExceptionCandidates,
  listPartnersForDashboard,
} from "../partner/dashboard-service";
import { getFleetStationLifecycleSummary } from "../partner/station-service";
import { derivePartnerOperationalReadiness, type PartnerReadinessFacts } from "../partner/operational-readiness";
import { normaliseCommandCentreTimestamp } from "./timestamp";

const PARTNER_SOURCE_BUDGET_MS = 650;
const PARTNER_SNAPSHOT_BUDGET_MS = 1_200;

export type PartnerReadResult =
  | {
      available: true;
      network: Record<string, number> | null;
      networkReasonCode?: string;
      wallet: Record<string, number> | null;
      walletReasonCode?: string;
      station: Record<string, number> | null;
      stationReasonCode?: string;
      connectorCount: number | null;
      connectorReasonCode?: string;
      onboardingBlocked: Array<{ id: string; timestamp: string }> | null;
      onboardingReasonCode?: string;
      onboardingFailureStatus?: "UNKNOWN" | "UNAVAILABLE" | "ERROR";
      connectorCandidates: Array<{ id: string; timestamp: string }>;
    }
  | { available: false; reasonCode: string; visibilityFailure: boolean; failureStatus: "UNAVAILABLE" | "ERROR" };

function opaqueCandidateId(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 24);
}

function missingRelation(error: unknown): boolean {
  return (error as { code?: string })?.code === "42P01";
}

function availableMetricNumber(metric: unknown): number | null {
  if (
    typeof metric === "object" &&
    metric !== null &&
    (metric as { available?: unknown }).available === true &&
    typeof (metric as { value?: unknown }).value === "number" &&
    Number.isFinite((metric as { value: number }).value)
  ) {
    return (metric as { value: number }).value;
  }
  return null;
}

async function observedPartnerRead<T>(
  source: string,
  snapshotDeadlineAt: number,
  operation: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  try {
    const remainingMs = Math.min(PARTNER_SOURCE_BUDGET_MS, snapshotDeadlineAt - startedAt);
    if (remainingMs <= 0) throw new Error("PARTNER_READ_TIMEOUT");
    const value = await withPartnerAdminReadBudget(operation, remainingMs);
    console.info(`[command-centre-source] source=${source} outcome=ok duration_ms=${Date.now() - startedAt}`);
    return value;
  } catch (error) {
    const outcome =
      (error as Error).message === "PARTNER_READ_TIMEOUT" ? "PARTNER_READ_TIMEOUT" : "PARTNER_SOURCE_ERROR";
    console.warn(`[command-centre-source] source=${source} outcome=${outcome} duration_ms=${Date.now() - startedAt}`);
    throw error;
  }
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<U>
): Promise<U[]> {
  const output: U[] = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < values.length) {
      const index = cursor++;
      output[index] = await mapper(values[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return output;
}

type ReadinessFactRow = {
  partner_id: string;
  org_status: string;
  owner_status: string | null;
  password_configured: boolean | null;
  invitation_valid: boolean | null;
  mfa_required: boolean | null;
  mfa_configured: boolean | null;
  location_eligible: boolean | null;
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
};

async function listReadinessFacts(
  partnerIds: readonly string[],
  walletSchema: boolean,
  profileRevisionSchema: boolean
): Promise<ReadinessFactRow[]> {
  if (partnerIds.length === 0) return [];
  const walletProjection = walletSchema
    ? "wallet.tenant_id::text AS wallet_tenant_id, wallet.balance AS wallet_balance"
    : "NULL::text AS wallet_tenant_id, NULL::numeric AS wallet_balance";
  const walletJoin = walletSchema ? "LEFT JOIN partner_wallet_balances wallet ON wallet.tenant_id=o.id" : "";
  const profileRevisionProjection = profileRevisionSchema
    ? "active.current_profile_revision_id"
    : "NULL::uuid AS current_profile_revision_id";
  const result = await partnerAdminQuery<ReadinessFactRow>(
    `SELECT o.id::text AS partner_id, o.status AS org_status,
            owner.user_status AS owner_status,
            owner.password_configured, owner.invitation_valid,
            owner.mfa_required, owner.mfa_configured, owner.location_eligible,
            COALESCE(station.enrolled, 0)::int AS station_enrolled,
            COALESCE(station.approved_active, 0)::int AS station_approved_active,
            COALESCE(station.pending_approval, 0)::int AS station_pending,
            active.scanner_connected, active.last_seen_at, active.calibration_status,
            active.current_calibration_id, ${profileRevisionProjection},
            active.app_version, active.minimum_supported_version,
            ${walletProjection}
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
      WHERE o.id = ANY($1::uuid[])
      ORDER BY o.created_at ASC, o.id ASC`,
    [partnerIds]
  );
  return result.rows;
}

async function readGlobalReadinessFlags(): Promise<{
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

async function readOnboardingCandidates(
  walletSchema: boolean,
  profileRevisionSchema: boolean
): Promise<Array<{ id: string; timestamp: string }> | null> {
  const partnerPage = await listPartnersForDashboard({ sort: "created_at", direction: "asc" }, 1, 100, walletSchema);
  if (partnerPage.total > partnerPage.rows.length) {
    throw new Error("PARTNER_ONBOARDING_SOURCE_TRUNCATED");
  }

  const [globalFlags, facts] = await Promise.all([
    readGlobalReadinessFlags(),
    listReadinessFacts(
      partnerPage.rows.map((partner) => partner.partnerId),
      walletSchema,
      profileRevisionSchema
    ),
  ]);
  const { portalEnabled, loginFlagEnabled, emergencyStop } = globalFlags;
  const factByPartner = new Map(facts.map((row) => [row.partner_id, row]));
  const nowMs = Date.now();
  let hasUnknownReadiness = false;
  const blockedPartners = partnerPage.rows.flatMap((partner) => {
    const row = factByPartner.get(partner.partnerId);
    if (!row) throw new Error("PARTNER_ONBOARDING_FACT_MISSING");
    const activeStation =
      row.calibration_status === null
        ? null
        : {
            scannerConnected: row.scanner_connected === true,
            lastSeenAt: normaliseCommandCentreTimestamp(row.last_seen_at),
            calibrationStatus: row.calibration_status,
            currentCalibrationId: row.current_calibration_id,
            currentProfileRevisionId: profileRevisionSchema ? row.current_profile_revision_id : undefined,
            appVersion: row.app_version,
            minimumSupportedVersion: row.minimum_supported_version,
          };
    const factsForPartner: PartnerReadinessFacts = {
      orgStatus: row.org_status,
      portalEnabled,
      loginFlagEnabled,
      emergencyStop,
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
      station: {
        enrolledCount: Number(row.station_enrolled),
        approvedActiveCount: Number(row.station_approved_active),
        pendingApprovalCount: Number(row.station_pending),
        active: activeStation,
      },
      credits: !walletSchema
        ? null
        : row.wallet_tenant_id === null
          ? "NO_WALLET"
          : row.wallet_balance === null
            ? null
            : Number(row.wallet_balance),
      nowMs,
    };
    const readiness = derivePartnerOperationalReadiness(factsForPartner);
    if (Object.values(readiness.dimensions).some((dimension) => dimension.status === "UNKNOWN")) {
      hasUnknownReadiness = true;
      return [];
    }
    const blocked = Object.values(readiness.dimensions).some((dimension) => dimension.status === "BLOCKED");
    return blocked ? [{ id: partner.partnerId, timestamp: partner.lastActivityAt ?? "" }] : [];
  });
  return hasUnknownReadiness ? null : blockedPartners;
}

/**
 * The sole Partner adapter boundary. It first proves cross-tenant visibility,
 * then reuses existing Partner services and returns only aggregate values and
 * opaque server-side policy candidates.
 */
async function readPartnerDashboardUnshared(): Promise<PartnerReadResult> {
  const snapshotDeadlineAt = Date.now() + PARTNER_SNAPSHOT_BUDGET_MS;
  const [visibilityResult, stationVisibilityResult] = await Promise.allSettled([
    observedPartnerRead("partner-visibility", snapshotDeadlineAt, getPartnerReadVisibility),
    observedPartnerRead("partner-station-visibility", snapshotDeadlineAt, getPartnerStationReadVisibility),
  ]);
  if (visibilityResult.status === "rejected") {
    return {
      available: false,
      reasonCode: "PARTNER_VISIBILITY_CHECK_ERROR",
      visibilityFailure: false,
      failureStatus: "ERROR",
    };
  }
  const visibility = visibilityResult.value;

  if (!visibility.ok) {
    return { available: false, reasonCode: visibility.code, visibilityFailure: true, failureStatus: "UNAVAILABLE" };
  }

  try {
    const stationVisibility =
      stationVisibilityResult.status === "fulfilled"
        ? stationVisibilityResult.value
        : ({ ok: false as const, code: "PARTNER_ADMIN_RLS_VISIBILITY_UNAVAILABLE" as const } as const);
    const sourceTasks: Array<() => Promise<{ value: unknown } | { error: string }>> = [
      () =>
        observedPartnerRead("partner-summary", snapshotDeadlineAt, () =>
          getNetworkSummary(visibility.walletSchema)
        ).then(
          (value) => ({ value }),
          () => ({ error: "PARTNER_SUMMARY_ADAPTER_ERROR" })
        ),
      () =>
        stationVisibility.ok
          ? observedPartnerRead("partner-station", snapshotDeadlineAt, getFleetStationLifecycleSummary).then(
              (value) => ({ value }),
              (error) => ({
                error: missingRelation(error) ? "PARTNER_STATION_SCHEMA_UNAVAILABLE" : "PARTNER_STATION_ADAPTER_ERROR",
              })
            )
          : Promise.resolve({
              error:
                stationVisibility.code === "PARTNER_ADMIN_SCHEMA_UNAVAILABLE"
                  ? "PARTNER_STATION_SCHEMA_UNAVAILABLE"
                  : "PARTNER_STATION_RLS_UNAVAILABLE",
            }),
      () =>
        observedPartnerRead("partner-connector", snapshotDeadlineAt, () => listConnectorExceptionCandidates(100)).then(
          (value) => ({ value }),
          () => ({ error: "PARTNER_CONNECTOR_ADAPTER_ERROR" })
        ),
      () =>
        observedPartnerRead("partner-onboarding", snapshotDeadlineAt, () =>
          readOnboardingCandidates(
            visibility.walletSchema,
            stationVisibility.ok && stationVisibility.profileRevisionSchema
          )
        ).then(
          (value) => ({ value }),
          () => ({ error: "PARTNER_ONBOARDING_ADAPTER_ERROR" })
        ),
    ];
    const sourceResults = await mapWithConcurrency(sourceTasks, 2, (task) => task());
    const summaryResult = sourceResults[0] as
      { value: Awaited<ReturnType<typeof getNetworkSummary>> } | { error: string };
    const stationResult = sourceResults[1] as
      { value: Awaited<ReturnType<typeof getFleetStationLifecycleSummary>> } | { error: string };
    const connectorResult = sourceResults[2] as
      { value: Awaited<ReturnType<typeof listConnectorExceptionCandidates>> } | { error: string };
    const onboardingResult = sourceResults[3] as
      { value: Awaited<ReturnType<typeof readOnboardingCandidates>> } | { error: string };
    const summary = "value" in summaryResult ? summaryResult.value : null;
    const totalAvailable = availableMetricNumber(summary?.credits.totalAvailable);
    const totalReserved = availableMetricNumber(summary?.credits.totalReserved);
    const consumedThisMonth = availableMetricNumber(summary?.credits.consumedThisMonth);
    const wallet =
      totalAvailable !== null && totalReserved !== null && consumedThisMonth !== null
        ? {
            available: totalAvailable,
            reserved: totalReserved,
            consumed: consumedThisMonth,
          }
        : null;

    return {
      available: true,
      network: summary
        ? {
            active: summary.shops.active,
            pending: summary.shops.onboarding,
            suspended: summary.shops.suspended,
            alerts: summary.security.openAlerts,
          }
        : null,
      networkReasonCode: "error" in summaryResult ? summaryResult.error : undefined,
      wallet,
      walletReasonCode: "error" in summaryResult ? summaryResult.error : undefined,
      station: "value" in stationResult ? stationResult.value : null,
      stationReasonCode: "error" in stationResult ? stationResult.error : undefined,
      connectorCount: "value" in connectorResult && summary ? summary.corrections.openEscalations : null,
      connectorReasonCode:
        "error" in connectorResult ? connectorResult.error : "error" in summaryResult ? summaryResult.error : undefined,
      onboardingBlocked: "value" in onboardingResult ? onboardingResult.value : null,
      onboardingReasonCode:
        "value" in onboardingResult && onboardingResult.value === null
          ? "PARTNER_ONBOARDING_READINESS_UNKNOWN"
          : "error" in onboardingResult
            ? onboardingResult.error
            : undefined,
      onboardingFailureStatus:
        "value" in onboardingResult && onboardingResult.value === null
          ? "UNKNOWN"
          : "error" in onboardingResult
            ? "UNAVAILABLE"
            : undefined,
      connectorCandidates: ("value" in connectorResult ? connectorResult.value : []).flatMap(
        (candidate: { id: string; updatedAt: unknown }) => {
          const timestamp = normaliseCommandCentreTimestamp(candidate.updatedAt);
          return timestamp ? [{ id: opaqueCandidateId(candidate.id), timestamp }] : [];
        }
      ),
    };
  } catch (error) {
    return {
      available: false,
      reasonCode: missingRelation(error) ? "PARTNER_SOURCE_SCHEMA_UNAVAILABLE" : "PARTNER_ADAPTER_ERROR",
      visibilityFailure: false,
      failureStatus: "ERROR",
    };
  }
}

let partnerReadInFlight: Promise<PartnerReadResult> | null = null;

/** Share the actual bounded work across concurrent dashboard requests, including after callers time out. */
export function readPartnerDashboard(): Promise<PartnerReadResult> {
  if (!partnerReadInFlight) {
    partnerReadInFlight = readPartnerDashboardUnshared().finally(() => {
      partnerReadInFlight = null;
    });
  }
  return partnerReadInFlight;
}
