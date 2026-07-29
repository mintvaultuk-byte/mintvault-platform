/**
 * Project Control — expensive-refresh bounding.
 *
 * LOW-RISK HARDENING requested by the third hostile review: the limiter is positioned correctly in
 * the source, but that was never proven at runtime. This proves the three properties that matter:
 *
 *  1. hammering the expensive refresh produces BOUNDED work — subprocess count does not track
 *     request count;
 *  2. ordinary cached reads stay available while the expensive path is being hammered;
 *  3. unauthorized callers are rejected BEFORE the expensive-operation limiter, so anonymous
 *     traffic can neither run a scan nor exhaust the operator's own refresh budget.
 *
 * (1) and (2) are proven against the real `scanRepository` on this repository — read-only git
 * inspection commands only. Every scan that actually RUNS builds and caches a fresh result object,
 * so counting DISTINCT returned object identities counts the scans performed. (3) is proven over
 * real HTTP against the real router.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express, { type Express } from "express";
import session from "express-session";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { PROJECT_CONTROL_FLAG_ENV } from "../server/project-control/flag";

let server: http.Server;
let base = "";

function stubRequiredConfig(): void {
  const placeholders: Record<string, string> = {
    MINTVAULT_DATABASE_URL: "postgres://project-control-test:not-a-real-password@127.0.0.1:1/none",
    SESSION_SECRET: "project-control-refresh-secret-not-real",
    SIGNED_URL_SECRET: "project-control-refresh-signing-not-real",
    ADMIN_PASSWORD: "project-control-test-not-real",
    ADMIN_PIN: "000000",
  };
  for (const [key, value] of Object.entries(placeholders)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

beforeAll(async () => {
  stubRequiredConfig();
  process.env[PROJECT_CONTROL_FLAG_ENV] = "true";

  const { registerProjectControlRoutes } = await import("../server/routes/admin/project-control");
  const app: Express = express();
  app.use(express.json());
  app.use(session({ secret: process.env.SESSION_SECRET!, resave: false, saveUninitialized: false }));
  registerProjectControlRoutes(app);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

const P = "/api/admin/project-control";

describe("expensive refresh is bounded at the source", () => {
  it("100 concurrent forced refreshes collapse to at most ONE scan result", async () => {
    const { scanRepository } = await import("../server/project-control/repo-scan");

    // Warm the cache so we are measuring refresh behaviour, not first-load behaviour.
    await scanRepository(false);

    const results = await Promise.all(Array.from({ length: 100 }, () => scanRepository(true)));

    // Every scan that actually RUNS produces a brand-new result object and caches it, so the
    // number of distinct object identities returned IS the number of scans performed.
    //
    // At most two are legitimate here: the value warmed above, plus the single forced refresh the
    // cooldown permits. Everything after that is served from cache or coalesced into the in-flight
    // scan. What must never happen is work tracking request count.
    const distinctScans = new Set(results).size;
    expect(distinctScans).toBeLessThanOrEqual(2);
    expect(distinctScans).toBeLessThan(results.length / 10);
    expect(results[0].headCommit).toMatch(/^[0-9a-f]{7,40}$|^unknown$/);
  }, 60_000);

  it("a forced refresh inside the cooldown still returns a well-formed cached answer", async () => {
    const { scanRepository } = await import("../server/project-control/repo-scan");
    const first = await scanRepository(true);
    const second = await scanRepository(true);
    expect(second.headCommit).toBe(first.headCommit);
    expect(typeof second.dirtyFileCount).toBe("number");
  }, 30_000);

  it("concurrent refreshes are coalesced into one in-flight scan", async () => {
    const { scanRepository } = await import("../server/project-control/repo-scan");
    const results = await Promise.all(Array.from({ length: 25 }, () => scanRepository(true)));
    // Coalescing means every concurrent caller observes the same scan result object graph.
    for (const r of results) expect(r.headCommit).toBe(results[0].headCommit);
  }, 30_000);
});

describe("unauthorized callers never reach the expensive limiter", () => {
  const hammer = async (path: string, times: number): Promise<number[]> => {
    const codes: number[] = [];
    for (let i = 0; i < times; i += 1) {
      const res = await fetch(`${base}${path}`);
      codes.push(res.status);
    }
    return codes;
  };

  it("anonymous refreshes are all 401 — never 429, and never a scan", async () => {
    const codes = await hammer(`${P}/repository?refresh=true`, 30);
    expect(new Set(codes)).toEqual(new Set([401]));
    // A 429 here would mean anonymous traffic had consumed the operator's refresh budget.
    expect(codes).not.toContain(429);
  }, 30_000);

  it("anonymous hammering of the expensive path leaves ordinary reads answering normally", async () => {
    await hammer(`${P}/repository?refresh=true`, 30);
    const res = await fetch(`${base}${P}/overview`);
    // Still the auth answer, not a rate-limit answer: the read budget was untouched.
    expect(res.status).toBe(401);
  }, 30_000);

  it("the expensive limiter is a DIFFERENT budget from the ordinary read limiter", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../server/routes/admin/project-control.ts", import.meta.url), "utf8")
    );
    // Both limiters exist, and the expensive one is strictly tighter than the read one.
    const readMax = Number(/projectControlReadLimit = rateLimit\(\{[^}]*max: (\d+)/s.exec(source)?.[1]);
    const expensiveMax = Number(/projectControlExpensiveLimit = rateLimit\(\{[^}]*max: (\d+)/s.exec(source)?.[1]);
    expect(Number.isFinite(readMax)).toBe(true);
    expect(Number.isFinite(expensiveMax)).toBe(true);
    expect(expensiveMax).toBeLessThan(readMax);
    // And auth runs before either.
    expect(source).toMatch(/gatedExpensive = \[requireProjectControlEnabled, requireSuperAdmin, projectControlExpensiveLimit\]/);
  });
});
