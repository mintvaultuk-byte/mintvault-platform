import { createHash } from "node:crypto";
import { getPartnerReadVisibility, getPartnerStationReadVisibility } from "../partner/dashboard-visibility";
import {
  getNetworkSummary,
  listConnectorExceptionCandidates,
  listPartnersForDashboard,
} from "../partner/dashboard-service";
import { getFleetStationLifecycleSummary } from "../partner/station-service";
import { getPartnerOnboardingReadiness } from "../partner/partner-management-service";

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
      connectorCandidates: Array<{ id: string; timestamp: string }>;
    }
  | { available: false; reasonCode: string; visibilityFailure: boolean; failureStatus: "UNAVAILABLE" | "ERROR" };

function opaqueCandidateId(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 24);
}

function missingRelation(error: unknown): boolean {
  return (error as { code?: string })?.code === "42P01";
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<U>,
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

async function readOnboardingCandidates(
  walletSchema: boolean,
): Promise<Array<{ id: string; timestamp: string }>> {
  const partnerPage = await listPartnersForDashboard(
    { sort: "created_at", direction: "asc" },
    1,
    100,
    walletSchema,
  );
  const readiness = await mapWithConcurrency(partnerPage.rows, 6, async (partner) => {
    const result = await getPartnerOnboardingReadiness(partner.partnerId);
    return {
      id: partner.partnerId,
      timestamp: partner.lastActivityAt ?? "",
      blocked: Object.values(result.operational.dimensions).some(
        (dimension) => dimension.status === "BLOCKED",
      ),
    };
  });
  return readiness.filter((candidate) => candidate.blocked).map(({ id, timestamp }) => ({ id, timestamp }));
}

/**
 * The sole Partner adapter boundary. It first proves cross-tenant visibility,
 * then reuses existing Partner services and returns only aggregate values and
 * opaque server-side policy candidates.
 */
export async function readPartnerDashboard(): Promise<PartnerReadResult> {
  let visibility;
  try {
    visibility = await getPartnerReadVisibility();
  } catch {
    return { available: false, reasonCode: "PARTNER_VISIBILITY_CHECK_ERROR", visibilityFailure: false, failureStatus: "ERROR" };
  }

  if (!visibility.ok) {
    return { available: false, reasonCode: visibility.code, visibilityFailure: true, failureStatus: "UNAVAILABLE" };
  }

  try {
    const stationVisibility = await getPartnerStationReadVisibility().catch(() => ({
      ok: false as const,
      code: "PARTNER_ADMIN_RLS_VISIBILITY_UNAVAILABLE" as const,
    }));
    const [summaryResult, stationResult, connectorResult, onboardingResult] = await Promise.all([
      getNetworkSummary(visibility.walletSchema).then(
        (value) => ({ value }),
        () => ({ error: "PARTNER_SUMMARY_ADAPTER_ERROR" }),
      ),
      stationVisibility.ok
        ? getFleetStationLifecycleSummary().then(
          (value) => ({ value }),
          (error) => ({
            error: missingRelation(error)
              ? "PARTNER_STATION_SCHEMA_UNAVAILABLE"
              : "PARTNER_STATION_ADAPTER_ERROR",
          }),
        )
        : Promise.resolve({
          error: stationVisibility.code === "PARTNER_ADMIN_SCHEMA_UNAVAILABLE"
            ? "PARTNER_STATION_SCHEMA_UNAVAILABLE"
            : "PARTNER_STATION_RLS_UNAVAILABLE",
        }),
      listConnectorExceptionCandidates(100).then(
        (value) => ({ value }),
        () => ({ error: "PARTNER_CONNECTOR_ADAPTER_ERROR" }),
      ),
      readOnboardingCandidates(visibility.walletSchema).then(
        (value) => ({ value }),
        () => ({ error: "PARTNER_ONBOARDING_ADAPTER_ERROR" }),
      ),
    ]);
    const summary = "value" in summaryResult ? summaryResult.value : null;
    const totalAvailable = summary?.credits.totalAvailable;
    const totalReserved = summary?.credits.totalReserved;
    const wallet =
      typeof totalAvailable === "number" && typeof totalReserved === "number"
        ? {
            available: totalAvailable,
            reserved: totalReserved,
            consumed:
              typeof summary?.credits.consumedThisMonth === "number"
                ? summary.credits.consumedThisMonth
                : 0,
          }
        : null;

    return {
      available: true,
      network: summary ? {
        active: summary.shops.active,
        pending: summary.shops.onboarding,
        suspended: summary.shops.suspended,
        alerts: summary.security.openAlerts,
      } : null,
      networkReasonCode: "error" in summaryResult ? summaryResult.error : undefined,
      wallet,
      walletReasonCode: "error" in summaryResult ? summaryResult.error : undefined,
      station: "value" in stationResult ? stationResult.value : null,
      stationReasonCode: "error" in stationResult ? stationResult.error : undefined,
      connectorCount: "value" in connectorResult && summary ? summary.corrections.openEscalations : null,
      connectorReasonCode: "error" in connectorResult ? connectorResult.error : "error" in summaryResult ? summaryResult.error : undefined,
      onboardingBlocked: "value" in onboardingResult ? onboardingResult.value : null,
      onboardingReasonCode: "error" in onboardingResult ? onboardingResult.error : undefined,
      connectorCandidates: ("value" in connectorResult ? connectorResult.value : []).map((candidate) => ({
        id: opaqueCandidateId(candidate.id),
        timestamp: candidate.updatedAt,
      })),
    };
  } catch (error) {
    return {
      available: false,
      reasonCode: missingRelation(error)
        ? "PARTNER_SOURCE_SCHEMA_UNAVAILABLE"
        : "PARTNER_ADAPTER_ERROR",
      visibilityFailure: false,
      failureStatus: "ERROR",
    };
  }
}
