import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  visibility: vi.fn(),
  stationVisibility: vi.fn(),
  summary: vi.fn(),
  connectors: vi.fn(),
  partners: vi.fn(),
  station: vi.fn(),
  partnerQuery: vi.fn(),
  derive: vi.fn(),
  budget: vi.fn(),
}));
vi.mock("../server/partner/dashboard-visibility", () => ({
  getPartnerReadVisibility: mocks.visibility,
  getPartnerStationReadVisibility: mocks.stationVisibility,
}));
vi.mock("../server/partner/dashboard-service", () => ({
  getNetworkSummary: mocks.summary,
  listConnectorExceptionCandidates: mocks.connectors,
  listPartnersForDashboard: mocks.partners,
}));
vi.mock("../server/partner/station-service", () => ({ getFleetStationLifecycleSummary: mocks.station }));
vi.mock("../server/partner/db", () => ({
  partnerAdminQuery: mocks.partnerQuery,
  withPartnerAdminReadBudget: mocks.budget,
}));
vi.mock("../server/partner/operational-readiness", () => ({ derivePartnerOperationalReadiness: mocks.derive }));

import { readPartnerDashboard } from "../server/command-centre/partner-read-adapter";

const partner = (id: string) => ({ partnerId: id, lastActivityAt: "2026-08-19T02:00:00.000Z" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.budget.mockImplementation((operation: () => Promise<unknown>) => operation());
  mocks.visibility.mockResolvedValue({ ok: true, walletSchema: true });
  mocks.stationVisibility.mockResolvedValue({ ok: true, profileRevisionSchema: true });
  mocks.summary.mockResolvedValue({
    shops: { active: 1, onboarding: 0, suspended: 0 },
    security: { openAlerts: 0 },
    credits: {
      totalAvailable: { available: true, value: 5 },
      totalReserved: { available: true, value: 1 },
      consumedThisMonth: { available: true, value: 2 },
    },
    corrections: { openEscalations: 1 },
  });
  mocks.station.mockResolvedValue({ PENDING: 0, ACTIVE: 1, SUSPENDED: 0, REVOKED: 0 });
  mocks.connectors.mockResolvedValue([]);
  mocks.partners.mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 100, totalPages: 1 });
  mocks.partnerQuery.mockImplementation(async (query: string) =>
    query.includes("FROM partner_feature_flags")
      ? {
          rows: [
            { flag: "partner_portal_enabled", enabled: true },
            { flag: "partner_login_enabled", enabled: true },
            { flag: "partner_emergency_stop", enabled: false },
          ],
        }
      : { rows: [] }
  );
  mocks.derive.mockReturnValue({ dimensions: { organisation: { status: "PASS" } } });
});

describe("Command Centre Partner adapter boundary", () => {
  it("fails the onboarding KPI closed before any per-row work when the 100-row source is incomplete", async () => {
    mocks.partners.mockResolvedValue({
      rows: Array.from({ length: 100 }, (_, index) =>
        partner(`00000000-0000-0000-0000-${String(index).padStart(12, "0")}`)
      ),
      total: 101,
      page: 1,
      pageSize: 100,
      totalPages: 2,
    });
    const result = await readPartnerDashboard();
    expect(result).toMatchObject({
      available: true,
      onboardingBlocked: null,
      onboardingReasonCode: "PARTNER_ONBOARDING_ADAPTER_ERROR",
    });
    expect(mocks.partnerQuery).not.toHaveBeenCalled();
  });

  it("normalises node-postgres Date connector timestamps and suppresses malformed candidates", async () => {
    mocks.connectors.mockResolvedValue([
      { id: "connector-date", updatedAt: new Date("2026-08-19T03:00:00.000Z") },
      { id: "connector-bad", updatedAt: "not-a-date" },
    ]);
    const result = await readPartnerDashboard();
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.connectorCandidates).toHaveLength(1);
    expect(result.connectorCandidates[0].timestamp).toBe("2026-08-19T03:00:00.000Z");
    expect(result.connectorCandidates[0].id).toMatch(/^[a-f0-9]{24}$/);
  });

  it("uses one set-based facts query and the canonical readiness decision for a complete page", async () => {
    const id = "00000000-0000-0000-0000-000000000001";
    mocks.partners.mockResolvedValue({ rows: [partner(id)], total: 1, page: 1, pageSize: 100, totalPages: 1 });
    mocks.partnerQuery.mockImplementation(async (query: string) =>
      query.includes("FROM partner_feature_flags")
        ? {
            rows: [
              { flag: "partner_portal_enabled", enabled: true },
              { flag: "partner_login_enabled", enabled: true },
              { flag: "partner_emergency_stop", enabled: false },
            ],
          }
        : {
            rows: [
              {
                partner_id: id,
                org_status: "ACTIVE",
                owner_status: null,
                password_configured: false,
                invitation_valid: false,
                mfa_required: false,
                mfa_configured: false,
                location_eligible: false,
                station_enrolled: 0,
                station_approved_active: 0,
                station_pending: 0,
                scanner_connected: null,
                last_seen_at: null,
                calibration_status: null,
                current_calibration_id: null,
                current_profile_revision_id: null,
                app_version: null,
                minimum_supported_version: null,
                wallet_tenant_id: null,
                wallet_balance: null,
              },
            ],
          }
    );
    mocks.derive.mockReturnValue({ dimensions: { owner: { status: "BLOCKED" } } });
    const result = await readPartnerDashboard();
    expect(mocks.partnerQuery).toHaveBeenCalledTimes(2);
    expect(
      mocks.partnerQuery.mock.calls.filter(([query]) => String(query).includes("FROM partner_organisations"))
    ).toHaveLength(1);
    expect(mocks.derive).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      available: true,
      wallet: { available: 5, reserved: 1, consumed: 2 },
      onboardingBlocked: [{ id, timestamp: "2026-08-19T02:00:00.000Z" }],
    });
  });

  it("fails onboarding truth closed when the global flag source is unreadable", async () => {
    const id = "00000000-0000-0000-0000-000000000001";
    mocks.partners.mockResolvedValue({ rows: [partner(id)], total: 1, page: 1, pageSize: 100, totalPages: 1 });
    mocks.partnerQuery.mockImplementation(async (query: string) => {
      if (query.includes("FROM partner_feature_flags")) throw new Error("flag source unavailable");
      return { rows: [] };
    });

    const result = await readPartnerDashboard();
    expect(result).toMatchObject({
      available: true,
      onboardingBlocked: null,
      onboardingReasonCode: "PARTNER_ONBOARDING_ADAPTER_ERROR",
    });
    expect(mocks.derive).not.toHaveBeenCalled();
  });

  it("passes unreadable wallet authority to readiness as UNKNOWN rather than NO_WALLET", async () => {
    const id = "00000000-0000-0000-0000-000000000001";
    mocks.visibility.mockResolvedValue({ ok: true, walletSchema: false });
    mocks.partners.mockResolvedValue({ rows: [partner(id)], total: 1, page: 1, pageSize: 100, totalPages: 1 });
    mocks.partnerQuery.mockImplementation(async (query: string) =>
      query.includes("FROM partner_feature_flags")
        ? {
            rows: [
              { flag: "partner_portal_enabled", enabled: true },
              { flag: "partner_login_enabled", enabled: true },
              { flag: "partner_emergency_stop", enabled: false },
            ],
          }
        : {
            rows: [
              {
                partner_id: id,
                org_status: "ACTIVE",
                owner_status: null,
                password_configured: false,
                invitation_valid: false,
                mfa_required: false,
                mfa_configured: false,
                location_eligible: false,
                station_enrolled: 0,
                station_approved_active: 0,
                station_pending: 0,
                scanner_connected: null,
                last_seen_at: null,
                calibration_status: null,
                current_calibration_id: null,
                current_profile_revision_id: null,
                app_version: null,
                minimum_supported_version: null,
                wallet_tenant_id: null,
                wallet_balance: null,
              },
            ],
          }
    );

    await readPartnerDashboard();

    expect(mocks.derive).toHaveBeenCalledWith(expect.objectContaining({ credits: null }));
    const factsQuery = String(
      mocks.partnerQuery.mock.calls.find(([query]) => String(query).includes("FROM partner_organisations"))?.[0]
    );
    expect(factsQuery).not.toContain("partner_wallet_balances");
    expect(factsQuery).toContain("NULL::text AS wallet_tenant_id");
  });

  it("omits the optional profile-revision column and passes UNKNOWN when migration 0091 is absent", async () => {
    const id = "00000000-0000-0000-0000-000000000001";
    mocks.stationVisibility.mockResolvedValue({ ok: true, profileRevisionSchema: false });
    mocks.partners.mockResolvedValue({ rows: [partner(id)], total: 1, page: 1, pageSize: 100, totalPages: 1 });
    mocks.partnerQuery.mockImplementation(async (query: string) =>
      query.includes("FROM partner_feature_flags")
        ? {
            rows: [
              { flag: "partner_portal_enabled", enabled: true },
              { flag: "partner_login_enabled", enabled: true },
              { flag: "partner_emergency_stop", enabled: false },
            ],
          }
        : {
            rows: [
              {
                partner_id: id,
                org_status: "ACTIVE",
                owner_status: "ACTIVE",
                password_configured: true,
                invitation_valid: false,
                mfa_required: true,
                mfa_configured: true,
                location_eligible: true,
                station_enrolled: 1,
                station_approved_active: 1,
                station_pending: 0,
                scanner_connected: true,
                last_seen_at: "2026-08-19T22:00:00.000Z",
                calibration_status: "VALID",
                current_calibration_id: "00000000-0000-0000-0000-000000000002",
                current_profile_revision_id: null,
                app_version: "1.0.0",
                minimum_supported_version: "1.0.0",
                wallet_tenant_id: id,
                wallet_balance: 10,
              },
            ],
          }
    );

    mocks.derive.mockReturnValue({ dimensions: { scanner: { status: "UNKNOWN" } } });
    const result = await readPartnerDashboard();

    const factsQuery = String(
      mocks.partnerQuery.mock.calls.find(([query]) => String(query).includes("FROM partner_organisations"))?.[0]
    );
    expect(factsQuery).not.toContain("s.current_profile_revision_id");
    expect(factsQuery).toContain("NULL::uuid AS current_profile_revision_id");
    expect(mocks.derive).toHaveBeenCalledWith(
      expect.objectContaining({
        station: expect.objectContaining({
          active: expect.objectContaining({ currentProfileRevisionId: undefined }),
        }),
      })
    );
    expect(result).toMatchObject({
      available: true,
      onboardingBlocked: null,
      onboardingReasonCode: "PARTNER_ONBOARDING_READINESS_UNKNOWN",
      onboardingFailureStatus: "UNKNOWN",
    });
  });
});
