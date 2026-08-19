import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("payment control-plane load simulator", () => {
  it("passes a deterministic smoke run with webhook replays and hostile payment events", () => {
    const raw = execFileSync(
      process.execPath,
      ["scripts/payment-control-plane-load-sim.mjs", "--workflows=250", "--burst=500", "--seed=81926"],
      { cwd: process.cwd(), encoding: "utf8", maxBuffer: 5 * 1024 * 1024 }
    );
    const report = JSON.parse(raw);
    expect(report.ok).toBe(true);
    expect(report.stats.webhookGranted).toBe(250);
    expect(report.stats.reservations).toBe(250);
    expect(report.stats.duplicateWebhookRejected).toBeGreaterThan(0);
    expect(report.stats.wrongPriceRejected).toBeGreaterThan(0);
    expect(report.stats.wrongCurrencyRejected).toBeGreaterThan(0);
    expect(report.stats.wrongEnvironmentRejected).toBeGreaterThan(0);
    expect(report.stats.wrongPartnerRejected).toBeGreaterThan(0);
  });
});
