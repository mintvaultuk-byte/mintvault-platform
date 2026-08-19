import { describe, expect, it, vi } from "vitest";

vi.mock("../server/command-centre/core-read-adapter", () => ({
  readCoreOperationalSnapshot: vi.fn(async () => ({
    submissions: { value: { unknownStatus: false, nonTerminal: 2, paid: { count: 1, amount: 25, nonGbp: 0 } } },
    scan: { value: { queue: 1, candidates: [] } },
    grading: { value: 3 },
    review: { value: { count: 1, candidates: [{ id: "certificate-1", timestamp: "2026-08-19T00:00:00.000Z" }] } },
    print: { value: { count: 0, candidates: [] } },
    transfer: { value: { count: 0, candidates: [] } },
  })),
}));

vi.mock("../server/command-centre/partner-read-adapter", () => ({
  readPartnerDashboard: vi.fn(async () => ({
    available: true,
    network: { active: 1, pending: 0, suspended: 0, alerts: 0 },
    wallet: { available: 10, reserved: 2, consumed: 1 },
    station: { PENDING: 2, ACTIVE: 1, SUSPENDED: 0, REVOKED: 0 },
    connectorCount: 0,
    onboardingBlocked: [],
    connectorCandidates: [],
  })),
}));

import { composeCommandCentreDashboard } from "../server/command-centre/dashboard-service";
import { readCoreOperationalSnapshot } from "../server/command-centre/core-read-adapter";
import { readPartnerDashboard } from "../server/command-centre/partner-read-adapter";
import { normaliseCommandCentreTimestamp } from "../server/command-centre/timestamp";

describe("Command Centre dashboard composition", () => {
  it("returns all locked KPI envelopes and the generic privacy-safe station attention", async () => {
    const dashboard = await composeCommandCentreDashboard("today");

    expect(Object.keys(dashboard.kpis)).toHaveLength(12);
    expect(dashboard.kpis["station-lifecycle-state"]).toMatchObject({
      status: "VALUE",
      value: { PENDING: 2, ACTIVE: 1, SUSPENDED: 0, REVOKED: 0 },
    });
    const stationAttention = dashboard.attention.find((item) => item.ruleId === "ATT-STATION-PENDING");
    expect(stationAttention).toEqual({
      ruleId: "ATT-STATION-PENDING",
      itemId: "station-lifecycle-pending",
      title: "Station lifecycle pending",
      reason: "Station lifecycle work requires attention.",
      severity: "MEDIUM",
      source: "partner-station-service",
      asOf: expect.any(String),
      freshnessSeconds: 300,
      deepLink: "/admin/partners/stations",
    });
    expect(JSON.stringify(stationAttention)).not.toMatch(
      /stationCode|tenantId|locationId|device|appVersion|scannerConnected|secret/i
    );
  });

  it("omits the station attention for an authoritative zero and never converts a station source failure to zero", async () => {
    vi.mocked(readPartnerDashboard)
      .mockResolvedValueOnce({
        available: true,
        network: { active: 1, pending: 0, suspended: 0, alerts: 0 },
        wallet: { available: 10, reserved: 2, consumed: 1 },
        station: { PENDING: 0, ACTIVE: 0, SUSPENDED: 0, REVOKED: 0 },
        connectorCount: 0,
        onboardingBlocked: [],
        connectorCandidates: [],
      })
      .mockResolvedValueOnce({
        available: true,
        network: { active: 1, pending: 0, suspended: 0, alerts: 0 },
        wallet: { available: 10, reserved: 2, consumed: 1 },
        station: null,
        stationReasonCode: "PARTNER_STATION_SCHEMA_UNAVAILABLE",
        connectorCount: 0,
        onboardingBlocked: [],
        connectorCandidates: [],
      });

    const zero = await composeCommandCentreDashboard("today");
    const unavailable = await composeCommandCentreDashboard("today");

    expect(zero.kpis["station-lifecycle-state"]).toMatchObject({
      status: "ZERO",
      authoritativeZero: true,
    });
    expect(zero.attention.some((item) => item.ruleId === "ATT-STATION-PENDING")).toBe(false);
    expect(unavailable.kpis["station-lifecycle-state"]).toEqual(
      expect.objectContaining({
        status: "UNAVAILABLE",
        reasonCode: "PARTNER_STATION_SCHEMA_UNAVAILABLE",
      })
    );
    expect(unavailable.kpis["station-lifecycle-state"]).not.toHaveProperty("value");
    expect(unavailable.attention.some((item) => item.ruleId === "ATT-STATION-PENDING")).toBe(false);
  });

  it("preserves UNKNOWN when any Partner readiness fact is undecidable", async () => {
    vi.mocked(readPartnerDashboard).mockResolvedValueOnce({
      available: true,
      network: { active: 1, pending: 0, suspended: 0, alerts: 0 },
      wallet: { available: 10, reserved: 2, consumed: 1 },
      station: { PENDING: 0, ACTIVE: 1, SUSPENDED: 0, REVOKED: 0 },
      connectorCount: 0,
      onboardingBlocked: null,
      onboardingReasonCode: "PARTNER_ONBOARDING_READINESS_UNKNOWN",
      onboardingFailureStatus: "UNKNOWN",
      connectorCandidates: [],
    });

    const dashboard = await composeCommandCentreDashboard("today");

    expect(dashboard.kpis["partner-onboarding-blocked"]).toEqual(
      expect.objectContaining({
        status: "UNKNOWN",
        reasonCode: "PARTNER_ONBOARDING_READINESS_UNKNOWN",
      })
    );
    expect(dashboard.kpis["partner-onboarding-blocked"]).not.toHaveProperty("value");
  });

  it("degrades an individual core source without changing unrelated canonical KPI envelopes", async () => {
    vi.mocked(readCoreOperationalSnapshot).mockResolvedValueOnce({
      submissions: { value: { unknownStatus: false, nonTerminal: 2, paid: { count: 1, amount: 25, nonGbp: 0 } } },
      scan: { error: "CORE_SOURCE_TIMEOUT" },
      grading: { value: 3 },
      review: { value: { count: 0, candidates: [] } },
      print: { value: { count: 0, candidates: [] } },
      transfer: { value: { count: 0, candidates: [] } },
    });
    const dashboard = await composeCommandCentreDashboard("today");
    expect(dashboard.kpis["scan-queue-backlog"]).toMatchObject({ status: "ERROR", reasonCode: "CORE_SOURCE_TIMEOUT" });
    expect(dashboard.kpis["grading-queue-backlog"]).toMatchObject({ status: "VALUE", value: 3 });
    expect(dashboard.attention.some((item) => item.ruleId === "ATT-SCAN-UNASSIGNED")).toBe(false);
  });

  it("classifies a thrown Partner visibility probe as ERROR, not a typed unavailable source", async () => {
    vi.mocked(readPartnerDashboard).mockResolvedValueOnce({
      available: false,
      reasonCode: "PARTNER_VISIBILITY_CHECK_ERROR",
      visibilityFailure: false,
      failureStatus: "ERROR",
    });
    const dashboard = await composeCommandCentreDashboard("today");
    expect(dashboard.kpis["partner-network-state"]).toMatchObject({
      status: "ERROR",
      reasonCode: "PARTNER_VISIBILITY_CHECK_ERROR",
    });
    expect(dashboard.attention.some((item) => item.ruleId === "ATT-PARTNER-VISIBILITY")).toBe(false);
  });

  it("returns a partial dashboard instead of hanging when a source exceeds the source budget", async () => {
    vi.mocked(readPartnerDashboard).mockImplementationOnce(() => new Promise(() => undefined));
    const startedAt = performance.now();
    const dashboard = await composeCommandCentreDashboard("today");

    expect(performance.now() - startedAt).toBeLessThan(1_900);
    expect(dashboard.kpis["partner-network-state"]).toMatchObject({
      status: "ERROR",
      reasonCode: "PARTNER_ADAPTER_ERROR",
    });
    expect(dashboard.kpis["grading-queue-backlog"]).toMatchObject({
      status: "VALUE",
      value: 3,
    });
  });

  it("preserves canonical candidate timestamps for deterministic oldest-first attention ordering", async () => {
    vi.mocked(readPartnerDashboard).mockResolvedValueOnce({
      available: true,
      network: { active: 1, pending: 0, suspended: 0, alerts: 0 },
      wallet: { available: 10, reserved: 2, consumed: 1 },
      station: { PENDING: 0, ACTIVE: 1, SUSPENDED: 0, REVOKED: 0 },
      connectorCount: 2,
      onboardingBlocked: [],
      connectorCandidates: [
        { id: "opaque-later", timestamp: "2026-08-19T02:00:00.000Z" },
        { id: "opaque-earlier", timestamp: "2026-08-19T01:00:00.000Z" },
      ],
    });
    vi.mocked(readCoreOperationalSnapshot).mockResolvedValueOnce({
      submissions: { value: { unknownStatus: false, nonTerminal: 0, paid: { count: 0, amount: 0, nonGbp: 0 } } },
      scan: { value: { queue: 0, candidates: [] } },
      grading: { value: 0 },
      review: { value: { count: 0, candidates: [] } },
      print: { value: { count: 0, candidates: [] } },
      transfer: { value: { count: 0, candidates: [] } },
    });
    const connectorItems = (await composeCommandCentreDashboard("today")).attention.filter(
      (item) => item.ruleId === "ATT-CONNECTOR-EXCEPTION"
    );
    expect(connectorItems.map((item) => item.asOf)).toEqual(["2026-08-19T01:00:00.000Z", "2026-08-19T02:00:00.000Z"]);
  });

  it("orders Date-backed core attention candidates globally oldest-first after ISO normalisation", async () => {
    vi.mocked(readPartnerDashboard).mockResolvedValueOnce({
      available: true,
      network: { active: 1, pending: 0, suspended: 0, alerts: 0 },
      wallet: { available: 10, reserved: 2, consumed: 1 },
      station: { PENDING: 0, ACTIVE: 1, SUSPENDED: 0, REVOKED: 0 },
      connectorCount: 1,
      onboardingBlocked: [],
      connectorCandidates: [
        { id: "connector", timestamp: normaliseCommandCentreTimestamp(new Date("2026-08-19T04:00:00.000Z"))! },
      ],
    });
    vi.mocked(readCoreOperationalSnapshot).mockResolvedValueOnce({
      submissions: { value: { unknownStatus: false, nonTerminal: 0, paid: { count: 0, amount: 0, nonGbp: 0 } } },
      scan: { value: { queue: 0, candidates: [] } },
      grading: { value: 0 },
      review: {
        value: {
          count: 1,
          candidates: [
            { id: "review", timestamp: normaliseCommandCentreTimestamp(new Date("2026-08-19T02:00:00.000Z"))! },
          ],
        },
      },
      print: {
        value: {
          count: 1,
          candidates: [
            { id: "print", timestamp: normaliseCommandCentreTimestamp(new Date("2026-08-19T01:00:00.000Z"))! },
          ],
        },
      },
      transfer: {
        value: {
          count: 1,
          candidates: [
            { id: "transfer", timestamp: normaliseCommandCentreTimestamp(new Date("2026-08-19T03:00:00.000Z"))! },
          ],
        },
      },
    });

    const highAttention = (await composeCommandCentreDashboard("today")).attention.filter(
      (item) => item.severity === "HIGH"
    );
    expect(highAttention.map((item) => item.asOf)).toEqual([
      "2026-08-19T01:00:00.000Z",
      "2026-08-19T02:00:00.000Z",
      "2026-08-19T03:00:00.000Z",
      "2026-08-19T04:00:00.000Z",
    ]);
  });

  it("labels every authoritative all-zero record envelope ZERO without flattening its value", async () => {
    vi.mocked(readPartnerDashboard).mockResolvedValueOnce({
      available: true,
      network: { active: 0, pending: 0, suspended: 0, alerts: 0 },
      wallet: { available: 0, reserved: 0, consumed: 0 },
      station: { PENDING: 0, ACTIVE: 0, SUSPENDED: 0, REVOKED: 0 },
      connectorCount: 0,
      onboardingBlocked: [],
      connectorCandidates: [],
    });
    vi.mocked(readCoreOperationalSnapshot).mockResolvedValueOnce({
      submissions: { value: { unknownStatus: false, nonTerminal: 0, paid: { count: 0, amount: 0, nonGbp: 0 } } },
      scan: { value: { queue: 0, candidates: [] } },
      grading: { value: 0 },
      review: { value: { count: 0, candidates: [] } },
      print: { value: { count: 0, candidates: [] } },
      transfer: { value: { count: 0, candidates: [] } },
    });
    const dashboard = await composeCommandCentreDashboard("today");
    expect(dashboard.kpis["partner-network-state"]).toMatchObject({
      status: "ZERO",
      authoritativeZero: true,
      value: { active: 0, pending: 0, suspended: 0, alerts: 0 },
    });
    expect(dashboard.kpis["partner-credit-projection"]).toMatchObject({ status: "ZERO", authoritativeZero: true });
    expect(dashboard.kpis["paid-submissions-recorded"]).toMatchObject({
      status: "ZERO",
      authoritativeZero: true,
      value: { count: 0, amount: 0 },
    });
  });
});
