import { afterEach, describe, expect, it } from "vitest";
import {
  classifyGrowthService,
  clearGrowthRuntimeTelemetry,
  getApplicationHealthSnapshot,
  getRuntimeRequestSnapshot,
  recordApplicationOutcome,
  recordGrowthRequest,
} from "../server/growth-runtime-telemetry";
import { deriveDatabasePoolPressure } from "../server/growth-intelligence-service";

afterEach(clearGrowthRuntimeTelemetry);

describe("GB-04D bounded application telemetry", () => {
  it("classifies only fixed service families and stores no request path", () => {
    expect(classifyGrowthService("/api/create-payment-intent")).toBe("payments");
    expect(classifyGrowthService("/api/partner/auth/login")).toBe("partnerApi");
    expect(classifyGrowthService("/api/admin/scanner/capture-sessions/next")).toBe("scannerApi");
    expect(classifyGrowthService("/api/users/123?email=private@example.com")).toBeNull();

    recordGrowthRequest("/api/users/123?email=private@example.com", 200, 12, 1_000);
    expect(JSON.stringify(getRuntimeRequestSnapshot(1_000))).not.toMatch(/users|email|example|123/);
  });

  it("reports real process request rate, p95 and 5xx without calling requests people", () => {
    const now = Date.parse("2026-08-20T12:00:00.000Z");
    for (let index = 0; index < 20; index += 1) {
      recordGrowthRequest("/api/health", index === 19 ? 503 : 200, index + 1, now - index * 1_000);
    }
    const snapshot = getRuntimeRequestSnapshot(now);
    expect(snapshot).toMatchObject({
      scope: "CURRENT_APPLICATION_PROCESS",
      requestsLast5Minutes: 20,
      requestsLastHour: 20,
      requestsPerMinute: 4,
      p95LatencyMs: 19,
      fiveXCount: 1,
      fiveXRatePercent: 5,
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/visitor|people|session|identity/i);
  });

  it("excludes expected auth/customer 4xx outcomes from platform failure health", () => {
    const now = Date.parse("2026-08-20T12:00:00.000Z");
    recordGrowthRequest("/api/partner/auth/login", 401, 20, now - 4_000);
    recordGrowthRequest("/api/partner/auth/login", 403, 20, now - 3_000);
    recordGrowthRequest("/api/partner/customers", 200, 20, now - 2_000);
    recordGrowthRequest("/api/partner/customers", 200, 20, now - 1_000);
    recordGrowthRequest("/api/partner/customers", 200, 20, now);
    expect(getApplicationHealthSnapshot("partnerApi", now)).toMatchObject({
      status: "GREEN",
      successful: 3,
      expectedRejections: 2,
      platformFailures: 0,
      classifiedAttempts: 3,
    });
  });

  it("keeps small samples unknown and records actual provider failures", () => {
    const now = Date.parse("2026-08-20T12:00:00.000Z");
    recordApplicationOutcome("email", "SUCCESS", now - 1_000);
    expect(getApplicationHealthSnapshot("email", now).status).toBe("UNKNOWN");
    recordApplicationOutcome("email", "PLATFORM_FAILURE", now);
    expect(getApplicationHealthSnapshot("email", now)).toMatchObject({
      status: "AMBER",
      successful: 1,
      platformFailures: 1,
      platformFailureRatePercent: 50,
    });
  });

  it("derives application-pool pressure without claiming Neon compute health", () => {
    const now = "2026-08-20T12:00:00.000Z";
    expect(deriveDatabasePoolPressure({ total: 4, idle: 3, waiting: 0, max: 8 }, now)).toMatchObject({
      state: "REAL",
      status: "GREEN",
      value: "1/8 active · 0 waiting",
    });
    expect(deriveDatabasePoolPressure({ total: 8, idle: 0, waiting: 1, max: 8 }, now)).toMatchObject({
      status: "RED",
    });
  });
});
