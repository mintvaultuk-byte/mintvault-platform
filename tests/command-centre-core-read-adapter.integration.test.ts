import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  responses: [] as Array<Array<Record<string, unknown>>>,
  execute: vi.fn(),
}));

vi.mock("../server/db", () => ({ db: { execute: runtime.execute } }));
vi.mock("../server/command-centre/partner-read-adapter", () => ({
  readPartnerDashboard: vi.fn(async () => ({
    available: true,
    network: { active: 1, pending: 0, suspended: 0, alerts: 0 },
    wallet: { available: 10, reserved: 2, consumed: 1 },
    station: { PENDING: 0, ACTIVE: 1, SUSPENDED: 0, REVOKED: 0 },
    connectorCount: 0,
    onboardingBlocked: [],
    connectorCandidates: [],
  })),
}));

import { composeCommandCentreDashboard } from "../server/command-centre/dashboard-service";

function loadDateBackedCoreRows() {
  runtime.responses = [
    [
      { status: "new", n: "2" },
      { status: "ready_to_return", n: "3" },
      { status: "completed", n: "5" },
    ],
    [{ count: "2", amount: "50.00", non_gbp: "0" }],
    [{ n: "1" }],
    [{ id: "scan-1", received_at: new Date("2026-08-19T05:00:00.000Z") }],
    [{ n: "0" }],
    [{ n: "1" }],
    [{ id: "review-1", graded_at: new Date("2026-08-19T02:00:00.000Z") }],
    [{ id: "print-1", created_at: new Date("2026-08-19T01:00:00.000Z"), total_count: "1" }],
    [{ id: "transfer-1", disputed_at: new Date("2026-08-19T03:00:00.000Z"), total_count: "1" }],
  ];
}

beforeEach(() => {
  runtime.execute.mockReset();
  runtime.execute.mockImplementation(async () => ({ rows: runtime.responses.shift() ?? [] }));
  loadDateBackedCoreRows();
});

describe("Command Centre core read adapter", () => {
  it("normalises PostgreSQL Date rows before emitting globally ordered attention", async () => {
    const dashboard = await composeCommandCentreDashboard("today");

    expect(runtime.execute).toHaveBeenCalledTimes(9);
    expect(dashboard.kpis["non-terminal-submissions"]).toMatchObject({ status: "VALUE", value: 5 });
    const emitted = dashboard.attention.filter((item) => [
      "ATT-PRINT-BATCH-EXCEPTION",
      "ATT-GRADE-REVIEW-PENDING",
      "ATT-OWNERSHIP-DISPUTE",
    ].includes(item.ruleId));
    expect(emitted.map((item) => item.asOf)).toEqual([
      "2026-08-19T01:00:00.000Z",
      "2026-08-19T02:00:00.000Z",
      "2026-08-19T03:00:00.000Z",
    ]);
    expect(emitted.every((item) => /^\d{4}-\d{2}-\d{2}T.*\.\d{3}Z$/.test(item.asOf))).toBe(true);
  });
});
