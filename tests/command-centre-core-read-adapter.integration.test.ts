import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  active: 0,
  peak: 0,
  destroyed: 0,
}));

vi.mock("../server/db", () => ({
  pool: { connect: runtime.connect },
}));
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

beforeEach(() => {
  runtime.query.mockReset();
  runtime.connect.mockReset();
  runtime.active = 0;
  runtime.peak = 0;
  runtime.destroyed = 0;
  runtime.query.mockImplementation(async (query: string) => {
    if (/^(BEGIN|SET LOCAL|COMMIT|ROLLBACK)/.test(query)) return { rows: [] };
    if (query.includes("GROUP BY status"))
      return {
        rows: [
          { status: "new", n: "2" },
          { status: "ready_to_return", n: "3" },
          { status: "completed", n: "5" },
        ],
      };
    if (query.includes("payment_status = 'paid'")) return { rows: [{ count: "2", amount: "50.00", non_gbp: "0" }] };
    if (query.includes("GROUP BY scan_status")) return { rows: [{ n: "1" }] };
    if (query.includes("scan_status = 'unassigned' ORDER"))
      return { rows: [{ id: "scan-1", received_at: new Date("2026-08-19T05:00:00.000Z") }] };
    if (query.includes("grader_status IN")) return { rows: [{ n: "0" }] };
    if (query.includes("count(*)::bigint AS n FROM certificates") && query.includes("pending_review"))
      return { rows: [{ n: "1" }] };
    if (query.includes("graded_at FROM certificates"))
      return { rows: [{ id: "review-1", graded_at: new Date("2026-08-19T02:00:00.000Z") }] };
    if (query.includes("FROM print_batches"))
      return { rows: [{ id: "print-1", created_at: new Date("2026-08-19T01:00:00.000Z"), total_count: "1" }] };
    if (query.includes("FROM transfer_verifications"))
      return { rows: [{ id: "transfer-1", disputed_at: new Date("2026-08-19T03:00:00.000Z"), total_count: "1" }] };
    throw new Error(`unexpected query: ${query}`);
  });
  runtime.connect.mockImplementation(
    (
      callback: (
        error: Error | undefined,
        client?: { query: typeof runtime.query },
        release?: (destroy?: boolean) => void
      ) => void
    ) => {
      runtime.active += 1;
      runtime.peak = Math.max(runtime.peak, runtime.active);
      let released = false;
      callback(undefined, { query: runtime.query }, (destroy?: boolean) => {
        if (!released) {
          released = true;
          runtime.active -= 1;
          if (destroy) runtime.destroyed += 1;
        }
      });
    }
  );
});

describe("Command Centre core read adapter", () => {
  it("normalises Date rows, preserves ordering, and never occupies more than three primary clients", async () => {
    const dashboard = await composeCommandCentreDashboard("today");
    const dataQueries = runtime.query.mock.calls.filter(
      ([query]) => !/^(BEGIN|SET LOCAL|COMMIT|ROLLBACK)/.test(String(query))
    );
    expect(dataQueries).toHaveLength(9);
    expect(runtime.peak).toBeLessThanOrEqual(3);
    expect(
      runtime.query.mock.calls.filter(([query]) => String(query).startsWith("SET LOCAL statement_timeout"))
    ).toHaveLength(6);
    expect(runtime.active).toBe(0);
    expect(dashboard.kpis["non-terminal-submissions"]).toMatchObject({ status: "VALUE", value: 5 });
    const emitted = dashboard.attention.filter((item) =>
      ["ATT-PRINT-BATCH-EXCEPTION", "ATT-GRADE-REVIEW-PENDING", "ATT-OWNERSHIP-DISPUTE"].includes(item.ruleId)
    );
    expect(emitted.map((item) => item.asOf)).toEqual([
      "2026-08-19T01:00:00.000Z",
      "2026-08-19T02:00:00.000Z",
      "2026-08-19T03:00:00.000Z",
    ]);
  });

  it("destroys every active database client on timeout so no work remains after the response", async () => {
    runtime.query.mockImplementation((query: string) =>
      /^(BEGIN|SET LOCAL|ROLLBACK)/.test(query) ? Promise.resolve({ rows: [] }) : new Promise(() => {})
    );
    const started = Date.now();
    const dashboard = await composeCommandCentreDashboard("today");
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(runtime.peak).toBeLessThanOrEqual(3);
    expect(runtime.destroyed).toBe(6);
    expect(runtime.active).toBe(0);
    expect(dashboard.kpis["paid-submissions-recorded"]).toMatchObject({
      status: "ERROR",
      reasonCode: "CORE_SOURCE_TIMEOUT",
    });
  });

  it("includes transaction setup in the hard deadline", async () => {
    runtime.query.mockImplementation((query: string) =>
      query === "BEGIN READ ONLY" ? new Promise(() => {}) : Promise.resolve({ rows: [] })
    );
    const started = Date.now();
    await composeCommandCentreDashboard("today");
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(runtime.destroyed).toBe(6);
    expect(runtime.active).toBe(0);
  });

  it("uses one absolute snapshot deadline across delayed acquisition and both worker waves", async () => {
    runtime.query.mockImplementation((query: string) =>
      /^(BEGIN|SET LOCAL|ROLLBACK)/.test(query) ? Promise.resolve({ rows: [] }) : new Promise(() => {})
    );
    runtime.connect.mockImplementation(
      (
        callback: (
          error: Error | undefined,
          client?: { query: typeof runtime.query },
          release?: (destroy?: boolean) => void
        ) => void
      ) => {
        setTimeout(() => {
          runtime.active += 1;
          runtime.peak = Math.max(runtime.peak, runtime.active);
          let released = false;
          callback(undefined, { query: runtime.query }, (destroy?: boolean) => {
            if (!released) {
              released = true;
              runtime.active -= 1;
              if (destroy) runtime.destroyed += 1;
            }
          });
        }, 500);
      }
    );

    const started = Date.now();
    await composeCommandCentreDashboard("today");
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(runtime.destroyed).toBe(6);
    expect(runtime.active).toBe(0);
  });
});
