import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSubmissionBySubmissionId = vi.hoisted(() => vi.fn());

vi.mock("../server/storage", () => ({
  storage: { getSubmissionBySubmissionId },
}));
vi.mock("../server/db", () => ({
  db: {
    execute: vi.fn(async () => ({ rows: [] })),
    transaction: vi.fn(),
  },
}));

import { registerSubmissionRoutes } from "../server/routes/submissions";

const servers: Server[] = [];

async function mount(): Promise<string> {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  registerSubmissionRoutes(app);
  const server = http.createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function track(base: string, submissionId: string, email: string, ip: string): Promise<Response> {
  return fetch(`${base}/api/submissions/${submissionId}/track`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ email }),
  });
}

beforeEach(() => {
  getSubmissionBySubmissionId.mockReset();
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("public submission tracking enumeration resistance", () => {
  it("returns one indistinguishable response for an unknown sequential id and a wrong email", async () => {
    const base = await mount();
    getSubmissionBySubmissionId.mockImplementation(async (submissionId: string) =>
      submissionId === "MV-SUB-000002"
        ? {
            submissionId,
            customerEmail: "victim@example.test",
            status: "in_grading",
            serviceTier: "express",
            cardCount: 4,
            returnTracking: "PRIVATE-TRACKING",
          }
        : undefined
    );

    const missing = await track(base, "MV-SUB-000001", "attacker@example.test", "203.0.113.10");
    const mismatch = await track(base, "MV-SUB-000002", "attacker@example.test", "203.0.113.10");

    expect(missing.status).toBe(404);
    expect(mismatch.status).toBe(404);
    expect(await missing.json()).toEqual(await mismatch.json());
    expect(
      JSON.stringify(await track(base, "MV-SUB-000002", "victim@example.test", "203.0.113.12").then((r) => r.json()))
    ).toContain("PRIVATE-TRACKING");
  });

  it("rate-limits a sequential-id sweep before the next database lookup", async () => {
    const base = await mount();
    getSubmissionBySubmissionId.mockResolvedValue(undefined);

    for (let index = 1; index <= 60; index += 1) {
      const response = await track(
        base,
        `MV-SUB-${String(index).padStart(6, "0")}`,
        "attacker@example.test",
        "203.0.113.11"
      );
      expect(response.status).toBe(404);
    }
    expect(getSubmissionBySubmissionId).toHaveBeenCalledTimes(60);

    const blocked = await track(base, "MV-SUB-000061", "attacker@example.test", "203.0.113.11");
    expect(blocked.status).toBe(429);
    expect(getSubmissionBySubmissionId).toHaveBeenCalledTimes(60);
  });
});
