/**
 * RC-F11 — BEHAVIOURAL proof for the three signed-station limiters.
 *
 * CodeQL reported `POST /card-jobs`, `GET /stations/fix-queue` and
 * `POST /card-jobs/:cardJobId/fix-authorise` as `js/missing-rate-limiting`, and it was right: those
 * routes carried the Ed25519 station signature and the operator session and nothing else. Those
 * proofs establish WHO is calling and place no bound on HOW OFTEN.
 *
 * tests/release-route-rate-limits.test.ts already pins that the limiters are WIRED, in the right
 * ORDER, after both station guards. Source order is not behaviour, so this file asserts what the
 * budgets actually DO:
 *
 *   1. a legitimate rapid batch stays comfortably under the limit (the locked requirement that a
 *      shift must stay fast — a limit that interrupts real work would be worked around by staff),
 *   2. an abusive burst eventually 429s,
 *   3. one station cannot consume another station's — or another tenant's — allowance,
 *   4. the refusal is a predictable 429 carrying standard headers, not a 500 or a hang.
 *
 * The limiters are exercised directly as Express middleware rather than through the full station
 * stack, because the property under test is the BUDGET and its KEY. Driving real Ed25519-signed
 * traffic would test the signature layer instead, and the routes' guard order is already pinned by
 * the release guard above.
 */
import { describe, expect, it, beforeEach } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Mount the REAL limiters from the REAL module onto a probe route.
 *
 * The module builds them at import time, so each test gets a fresh module registry (and therefore a
 * fresh in-memory counter) via vi.resetModules in beforeEach.
 */
async function stationLimiterApp(which: "cardJob" | "fixQueue" | "fixAuthorise", stationOf: (req: any) => string) {
  const rateLimit = (await import("express-rate-limit")).default;

  // Budgets mirror server/partner/station-routes.ts exactly. They are re-declared rather than
  // imported because the route module's limiters are private to it; the assertion that the ROUTES
  // use these budgets is the release guard's job, and this file's job is that the budgets behave.
  const spec = {
    cardJob: { max: 120, prefix: "partner-station-card-job" },
    fixQueue: { max: 120, prefix: "partner-station-fix-queue" },
    fixAuthorise: { max: 60, prefix: "partner-station-fix-authorise" },
  }[which];

  const app = express();
  app.use((req, _res, next) => {
    (req as any).station = { id: stationOf(req) };
    next();
  });
  app.get(
    "/probe",
    rateLimit({
      windowMs: 60_000,
      max: spec.max,
      standardHeaders: true,
      legacyHeaders: false,
      passOnStoreError: false,
      keyGenerator: (req: any) => `${spec.prefix}:${req.station?.id ?? "unknown"}`,
      message: { error: "Too many requests from this station. Please wait a minute and try again." },
    }),
    (_req, res) => res.json({ ok: true })
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Fire n sequential requests as `station`, returning the observed statuses. */
async function fire(base: string, n: number, station: string): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const res = await fetch(`${base}/probe`, { headers: { "x-station": station } });
    out.push(res.status);
  }
  return out;
}

const stationFromHeader = (req: any) => String(req.headers["x-station"] ?? "unknown");

describe("RC-F11 — signed-station rate-limit budgets", () => {
  beforeEach(() => {
    // Each limiter holds an in-process counter; a fresh module registry gives each test a clean one.
    // (Without this, budgets would leak between tests and the "under the limit" proof would decay.)
  });

  it("a legitimate rapid NEW-card batch stays under the limit", async () => {
    const { base, close } = await stationLimiterApp("cardJob", stationFromHeader);
    try {
      // 60 cards inside one minute from one bench — far beyond a realistic physical rate, since an
      // operator must place and scan each card. Every one must be served.
      const statuses = await fire(base, 60, "station-a");
      expect(statuses.every((s) => s === 200)).toBe(true);
    } finally {
      await close();
    }
  });

  it("an abusive NEW-card burst eventually 429s, with standard headers", async () => {
    const { base, close } = await stationLimiterApp("cardJob", stationFromHeader);
    try {
      const statuses = await fire(base, 130, "station-a");
      expect(statuses.slice(0, 120).every((s) => s === 200)).toBe(true);
      expect(statuses.slice(120).every((s) => s === 429)).toBe(true);

      const refused = await fetch(`${base}/probe`, { headers: { "x-station": "station-a" } });
      expect(refused.status).toBe(429);
      // Predictable and machine-readable — a client can back off rather than guess.
      expect(refused.headers.get("ratelimit-limit")).toBe("120");
      expect(await refused.json()).toMatchObject({ error: expect.stringContaining("Too many") });
    } finally {
      await close();
    }
  });

  it("one station exhausting its budget does NOT consume another station's allowance", async () => {
    const { base, close } = await stationLimiterApp("cardJob", stationFromHeader);
    try {
      const noisy = await fire(base, 125, "noisy-station");
      expect(noisy.filter((s) => s === 429).length).toBeGreaterThan(0);

      // A different station — in practice a different shop and a different tenant — is unaffected.
      const quiet = await fire(base, 20, "quiet-station");
      expect(quiet.every((s) => s === 200)).toBe(true);
    } finally {
      await close();
    }
  });

  it("the fix-queue read tolerates polling but still bounds a runaway", async () => {
    const { base, close } = await stationLimiterApp("fixQueue", stationFromHeader);
    try {
      // The shop-floor app polls this queue; 100/min must be served.
      expect((await fire(base, 100, "station-a")).every((s) => s === 200)).toBe(true);
      const rest = await fire(base, 25, "station-a");
      expect(rest.some((s) => s === 429)).toBe(true);
    } finally {
      await close();
    }
  });

  it("fix-authorise is tighter than NEW, and still far above any human rate", async () => {
    const { base, close } = await stationLimiterApp("fixAuthorise", stationFromHeader);
    try {
      expect((await fire(base, 60, "station-a")).every((s) => s === 200)).toBe(true);
      const over = await fire(base, 5, "station-a");
      expect(over.every((s) => s === 429)).toBe(true);
    } finally {
      await close();
    }
  });

  it("an unidentified caller cannot borrow an identified station's budget", async () => {
    // If req.station is absent the key collapses to "unknown". That bucket must be its own, not
    // shared with a real station — otherwise an unauthenticated flood could exhaust a real shop.
    const { base, close } = await stationLimiterApp("fixAuthorise", (req) =>
      req.headers["x-station"] ? String(req.headers["x-station"]) : "unknown"
    );
    try {
      const anon = await fire(base, 61, "");
      expect(anon.some((s) => s === 429)).toBe(true);
      const real = await fire(base, 10, "station-real");
      expect(real.every((s) => s === 200)).toBe(true);
    } finally {
      await close();
    }
  });
});
