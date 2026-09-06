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
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

const TEST_URL = process.env.TEST_DATABASE_URL || "";

vi.mock("../server/db", () => {
  const url = process.env.TEST_DATABASE_URL || "";
  if (!url) return { db: {}, pool: { end: () => Promise.resolve(), query: () => Promise.resolve({ rows: [] }) } };
  const u = new URL(url);
  const ok =
    (u.hostname === "127.0.0.1" || u.hostname === "localhost") &&
    u.port === (process.env.MINTVAULT_TEST_PG16_PORT || "55432") &&
    u.pathname === "/mintvault_vq_phase10_local";
  if (!ok)
    throw new Error(
      `REFUSED: TEST_DATABASE_URL must be the local throwaway DB, got ${u.hostname}:${u.port}${u.pathname}`
    );
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pg = require("pg");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { drizzle } = require("drizzle-orm/node-postgres");
  const pool = new pg.Pool({ connectionString: url, ssl: false, max: 8 });
  return { db: drizzle(pool), pool };
});
vi.mock("../server/auth", () => ({ requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock("../server/anthropic-fetch", () => ({ anthropicFetch: vi.fn() }));
vi.mock("../server/r2", async (original) => ({
  ...(await original<typeof import("../server/r2")>()),
  uploadToR2: vi.fn(),
  getR2ObjectStream: vi.fn(),
}));

const run = TEST_URL ? describe : describe.skip;

import { registerVaultQuestAdminRoutes } from "../server/routes/vault-quest-admin";
import { pool } from "../server/db";
import { uploadToR2, getR2ObjectStream } from "../server/r2";
import { vqStorage } from "../server/vault-quest/storage";

const q = (s: string, a: unknown[] = []) =>
  (pool as unknown as { query: (s: string, a: unknown[]) => Promise<{ rows: unknown[] }> }).query(s, a);

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
    vi.clearAllMocks();
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

  it("actual export handlers return503 without render/upload when durable schema is absent", async () => {
    const render = vi
      .spyOn(vqStorage, "getStudioCardsBatch")
      .mockRejectedValue(new Error("synthetic rendering must not start"));
    await q("ALTER TABLE vq_export_jobs RENAME TO vq_export_jobs_unavailable_proof");
    try {
      const id = randomUUID();
      for (const path of ["/api/admin/vault-quest/proxy", "/api/admin/vault-quest/export/pack"]) {
        expect(await req("POST", path, { ids: ["synthetic-card"] })).toEqual({
          status: 503,
          json: { error: "export service temporarily unavailable" },
        });
      }
      for (const path of [
        `/api/admin/vault-quest/export/jobs/${id}`,
        `/api/admin/vault-quest/export/jobs/${id}/file`,
      ]) {
        expect(await req("GET", path)).toEqual({
          status: 503,
          json: { error: "export service temporarily unavailable" },
        });
      }
      expect(render).not.toHaveBeenCalled();
      expect(uploadToR2).not.toHaveBeenCalled();
      expect(getR2ObjectStream).not.toHaveBeenCalled();
    } finally {
      await q("ALTER TABLE vq_export_jobs_unavailable_proof RENAME TO vq_export_jobs");
      render.mockRestore();
    }
    expect((await req("GET", `/api/admin/vault-quest/export/jobs/${randomUUID()}`)).status).toBe(404);
  });

  it("actual download handler uses durable row state and only shared R2 output", async () => {
    const id = randomUUID();
    expect((await req("GET", `/api/admin/vault-quest/export/jobs/${id}/file`)).status).toBe(404);
    await q(
      "INSERT INTO vq_export_jobs(job_id,kind,owner_admin_id,idempotency_key,state,requested_count) VALUES($1,'pack','synthetic-admin',$2,'queued',3)",
      [id, id]
    );
    try {
      for (const [state, status] of [
        ["queued", 409],
        ["processing", 409],
        ["failed", 422],
        ["cancelled", 422],
        ["expired", 410],
        ["completed", 410],
        ["partial", 410],
      ]) {
        await q("UPDATE vq_export_jobs SET state=$2 WHERE job_id=$1", [id, state]);
        expect((await req("GET", `/api/admin/vault-quest/export/jobs/${id}/file`)).status).toBe(status);
      }
      expect(getR2ObjectStream).not.toHaveBeenCalled();
      for (const state of ["completed", "partial"]) {
        await q(
          "UPDATE vq_export_jobs SET state=$2, output_key='vq/exports/synthetic/pack.zip', content_type='application/zip', file_name='pack.zip', output_size=5 WHERE job_id=$1",
          [id, state]
        );
        vi.mocked(getR2ObjectStream).mockResolvedValueOnce({
          body: Readable.from([Buffer.from("proof")]),
          contentLength: 5,
          contentType: "application/zip",
        });
        const response = await fetch(`${base}/api/admin/vault-quest/export/jobs/${id}/file`);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("application/zip");
        expect(await response.text()).toBe("proof");
        expect(getR2ObjectStream).toHaveBeenLastCalledWith("vq/exports/synthetic/pack.zip");
      }
      expect(uploadToR2).not.toHaveBeenCalled();
    } finally {
      await q("DELETE FROM vq_export_jobs WHERE job_id=$1", [id]);
    }
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
    const set = await req("POST", "/api/admin/vault-quest/ops/feature-flags/generation", {
      enabled: false,
      reason: "spy test",
    });
    expect(set.status).toBe(200);
    const status = await req("GET", "/api/admin/vault-quest/ops/status");
    const gen = (status.json as { features: { feature: string; enabled: boolean }[] }).features.find(
      (f) => f.feature === "generation"
    );
    expect(gen?.enabled).toBe(false);
  });

  it("THE ESCAPE HATCH (R4-F4): the toggle route works even while 'writes' is frozen", async () => {
    // Freeze everything.
    const freeze = await req("POST", "/api/admin/vault-quest/ops/feature-flags/writes", {
      enabled: false,
      reason: "emergency freeze",
    });
    expect(freeze.status).toBe(200); // the freeze itself must land

    // Confirm the freeze actually blocks an ordinary mutating route.
    const blocked = await req("POST", "/api/admin/vault-quest/characters/GNV-DOES-NOT-EXIST/reject-candidate", {
      candidateId: 1,
    });
    expect(blocked.status).toBe(503);

    // The owner must still be able to un-freeze via the SAME toggle route.
    const unfreeze = await req("POST", "/api/admin/vault-quest/ops/feature-flags/writes", {
      enabled: true,
      reason: "un-freeze",
    });
    expect(unfreeze.status).toBe(200); // NOT 503 — this is the whole point of the exemption

    // Confirm the un-freeze actually took effect.
    const status = await req("GET", "/api/admin/vault-quest/ops/status");
    const writesFlag = (status.json as { features: { feature: string; enabled: boolean }[] }).features.find(
      (f) => f.feature === "writes"
    );
    expect(writesFlag?.enabled).toBe(true);
  });
});
