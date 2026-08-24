/**
 * Phase 10A-5 — END-TO-END proof that the ops routes work correctly against the
 * REAL router, especially the escape hatch: the feature-flag toggle route must
 * remain reachable even when "writes" is frozen (R4-F4) — an emergency freeze
 * must never trap the owner unable to un-freeze it.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const TEST_URL = process.env.TEST_DATABASE_URL || "";

vi.mock("../server/db", () => {
  const url = process.env.TEST_DATABASE_URL || "";
  if (!url) return { db: {}, pool: { end: () => Promise.resolve(), query: () => Promise.resolve({ rows: [] }) } };
  const u = new URL(url);
  const ok = (u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.port === (process.env.MINTVAULT_TEST_PG16_PORT || "55432") && u.pathname === "/mintvault_vq_phase10_local";
  if (!ok) throw new Error(`REFUSED: TEST_DATABASE_URL must be the local throwaway DB, got ${u.hostname}:${u.port}${u.pathname}`);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pg = require("pg");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { drizzle } = require("drizzle-orm/node-postgres");
  const pool = new pg.Pool({ connectionString: url, ssl: false, max: 8 });
  return { db: drizzle(pool), pool };
});
vi.mock("../server/auth", () => ({ requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock("../server/anthropic-fetch", () => ({ anthropicFetch: vi.fn() }));

const run = TEST_URL ? describe : describe.skip;

import { registerVaultQuestAdminRoutes } from "../server/routes/vault-quest-admin";
import { pool } from "../server/db";

const q = (s: string, a: unknown[] = []) => (pool as unknown as { query: (s: string, a: unknown[]) => Promise<{ rows: unknown[] }> }).query(s, a);

let server: Server;
let base = "";

async function req(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

run("ops routes — real router", () => {
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    registerVaultQuestAdminRoutes(app);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        resolve();
      });
    });
  });
  beforeEach(async () => {
    await q("DELETE FROM vq_feature_flags", []);
  });
  afterAll(async () => {
    await q("DELETE FROM vq_feature_flags", []);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await (pool as unknown as { end: () => Promise<void> }).end();
  });

  it("GET /ops/status returns a well-formed snapshot", async () => {
    const r = await req("GET", "/api/admin/vault-quest/ops/status");
    expect(r.status).toBe(200);
    const body = r.json as { features?: unknown[]; providers?: unknown[]; machineId?: string };
    expect(Array.isArray(body.features)).toBe(true);
    expect(Array.isArray(body.providers)).toBe(true);
    expect(body.machineId).toBeTruthy();
  });

  it("POST /ops/feature-flags/:feature rejects an unknown feature name", async () => {
    const r = await req("POST", "/api/admin/vault-quest/ops/feature-flags/bogus", { enabled: false });
    expect(r.status).toBe(400);
  });

  it("POST /ops/feature-flags/:feature rejects a missing 'enabled' field", async () => {
    const r = await req("POST", "/api/admin/vault-quest/ops/feature-flags/generation", { reason: "x" });
    expect(r.status).toBe(400);
  });

  it("toggling generation OFF via the route is reflected in /ops/status", async () => {
    const set = await req("POST", "/api/admin/vault-quest/ops/feature-flags/generation", { enabled: false, reason: "spy test" });
    expect(set.status).toBe(200);
    const status = await req("GET", "/api/admin/vault-quest/ops/status");
    const gen = (status.json as { features: { feature: string; enabled: boolean }[] }).features.find((f) => f.feature === "generation");
    expect(gen?.enabled).toBe(false);
  });

  it("THE ESCAPE HATCH (R4-F4): the toggle route works even while 'writes' is frozen", async () => {
    // Freeze everything.
    const freeze = await req("POST", "/api/admin/vault-quest/ops/feature-flags/writes", { enabled: false, reason: "emergency freeze" });
    expect(freeze.status).toBe(200); // the freeze itself must land

    // Confirm the freeze actually blocks an ordinary mutating route.
    const blocked = await req("POST", "/api/admin/vault-quest/characters/GNV-DOES-NOT-EXIST/reject-candidate", { candidateId: 1 });
    expect(blocked.status).toBe(503);

    // The owner must still be able to un-freeze via the SAME toggle route.
    const unfreeze = await req("POST", "/api/admin/vault-quest/ops/feature-flags/writes", { enabled: true, reason: "un-freeze" });
    expect(unfreeze.status).toBe(200); // NOT 503 — this is the whole point of the exemption

    // Confirm the un-freeze actually took effect.
    const status = await req("GET", "/api/admin/vault-quest/ops/status");
    const writesFlag = (status.json as { features: { feature: string; enabled: boolean }[] }).features.find((f) => f.feature === "writes");
    expect(writesFlag?.enabled).toBe(true);
  });
});
