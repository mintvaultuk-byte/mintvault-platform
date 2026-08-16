/**
 * RC-F11 — BEHAVIOURAL proof for the three signed-station limiters.
 *
 * CodeQL reported `POST /card-jobs`, `GET /stations/fix-queue` and
 * `POST /card-jobs/:cardJobId/fix-authorise` as `js/missing-rate-limiting`, and it was right: those
 * routes carried the Ed25519 station signature and the operator session and nothing else. Those
 * proofs establish WHO is calling and place no bound on HOW OFTEN.
 *
 * `tests/release-route-rate-limits.test.ts` pins that the limiters are WIRED, in the right ORDER,
 * after both station guards. Source order is not behaviour, so this file asserts what the budgets
 * actually DO.
 *
 * WHY THIS EXERCISES `partnerRateLimit` AND NOT `express-rate-limit`. The three limiters were
 * originally written with `rateLimit()` from express-rate-limit, matching their neighbours in
 * station-routes.ts. That store is PER-PROCESS, and production runs two Fly Machines — measured on
 * staging 2026-08-15: Machine A returned 429 while Machine B, hit immediately afterwards, still
 * served. The effective ceiling was 2x with no shared state. They now use `partnerRateLimit`, whose
 * store `mount.ts` swaps for the shared PostgreSQL one at boot (invariant I19).
 *
 * So the fleet-wide property is the thing worth testing, and the two-Machine case is modelled
 * exactly as production behaves: TWO SEPARATE limiter instances (two app processes) sharing ONE
 * store (the one database). A per-process store fails that test; the shared store passes it.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  partnerRateLimit,
  setPartnerRateLimitStore,
  MemoryRateLimitStore,
  type RateLimitStore,
} from "../server/partner/rate-limit";

/** The production budgets, mirrored from server/partner/station-routes.ts. */
const SPEC = {
  cardJob: { name: "partner-station-card-job", max: 120 },
  fixQueue: { name: "partner-station-fix-queue", max: 120 },
  fixAuthorise: { name: "partner-station-fix-authorise", max: 60 },
} as const;

const servers: Server[] = [];

/**
 * Stand up one "Machine": its own express app and its own limiter instance.
 *
 * The limiter resolves the shared module-level store at call time, so every Machine created here
 * shares whatever store the test installed — which is exactly the production topology.
 */
async function machine(which: keyof typeof SPEC) {
  const spec = SPEC[which];
  const app = express();
  app.get(
    "/probe",
    (req, _res, next) => {
      (req as unknown as { station?: { id: string } }).station = {
        id: String(req.headers["x-station"] ?? "unknown"),
      };
      next();
    },
    partnerRateLimit({
      name: spec.name,
      windowMs: 60_000,
      max: spec.max,
      failClosed: true,
      keyFn: (req) => (req as unknown as { station?: { id: string } }).station?.id ?? "unknown",
    }),
    (_req, res) => {
      res.json({ ok: true });
    }
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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

beforeEach(() => {
  // A fresh shared store per test — one "database" for the whole fleet.
  setPartnerRateLimitStore(new MemoryRateLimitStore());
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  setPartnerRateLimitStore(new MemoryRateLimitStore());
});

describe("RC-F11 — signed-station rate-limit budgets", () => {
  it("a legitimate rapid NEW-card batch stays under the limit", async () => {
    const a = await machine("cardJob");
    // 60 cards inside one minute from one bench — far beyond a realistic physical rate, since an
    // operator must place and scan each card. Every one must be served.
    expect((await fire(a, 60, "station-a")).every((s) => s === 200)).toBe(true);
  });

  it("an abusive NEW-card burst eventually 429s", async () => {
    const a = await machine("cardJob");
    const statuses = await fire(a, 130, "station-a");
    expect(statuses.slice(0, 120).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(120).every((s) => s === 429)).toBe(true);
  });

  it("one station exhausting its budget does NOT consume another station's allowance", async () => {
    const a = await machine("cardJob");
    const noisy = await fire(a, 125, "noisy-station");
    expect(noisy.filter((s) => s === 429).length).toBeGreaterThan(0);
    // A different station — in practice a different shop and a different tenant — is unaffected.
    expect((await fire(a, 20, "quiet-station")).every((s) => s === 200)).toBe(true);
  });

  it("BOTH Machines share one budget — the fleet-wide property, and the regression that matters", async () => {
    // Two limiter instances, one store: exactly two Fly Machines against one database.
    // Under the previous per-process express-rate-limit store this test FAILS, because each Machine
    // would grant a full 120 and the station would get 240.
    const a = await machine("cardJob");
    const b = await machine("cardJob");

    expect((await fire(a, 70, "station-a")).every((s) => s === 200)).toBe(true);
    // Machine B has served nothing yet, but the station has already spent 70 of its 120.
    const onB = await fire(b, 60, "station-a");
    expect(onB.slice(0, 50).every((s) => s === 200)).toBe(true);
    expect(onB.slice(50).every((s) => s === 429)).toBe(true);

    // And the ceiling is the FLEET budget, not twice it.
    expect(onB.filter((s) => s === 200).length + 70).toBe(SPEC.cardJob.max);
  });

  it("per-station isolation holds across Machines too", async () => {
    const a = await machine("cardJob");
    const b = await machine("cardJob");
    await fire(a, 125, "noisy-station");
    // Station B is untouched on the OTHER Machine — the key, not the process, is what separates them.
    expect((await fire(b, 20, "quiet-station")).every((s) => s === 200)).toBe(true);
  });

  it("the fix-queue read tolerates polling but still bounds a runaway", async () => {
    const a = await machine("fixQueue");
    expect((await fire(a, 100, "station-a")).every((s) => s === 200)).toBe(true);
    expect((await fire(a, 25, "station-a")).some((s) => s === 429)).toBe(true);
  });

  it("fix-authorise is tighter than NEW, and still far above any human rate", async () => {
    const a = await machine("fixAuthorise");
    expect((await fire(a, 60, "station-a")).every((s) => s === 200)).toBe(true);
    expect((await fire(a, 5, "station-a")).every((s) => s === 429)).toBe(true);
  });

  it("an unidentified caller cannot borrow an identified station's budget", async () => {
    // If req.station is absent the key collapses to "unknown". That bucket must be its own, not
    // shared with a real station — otherwise a flood could exhaust a real shop's allowance.
    const a = await machine("fixAuthorise");
    expect((await fire(a, 61, "unknown")).some((s) => s === 429)).toBe(true);
    expect((await fire(a, 10, "station-real")).every((s) => s === 200)).toBe(true);
  });

  it("FAILS CLOSED when the shared store is unavailable", async () => {
    // A counter that cannot be read is not a licence to proceed. This costs nothing real on these
    // routes: they all need the same database to do their work, so a store outage would have failed
    // the request anyway — it never turns a working scan into a refused one.
    const broken: RateLimitStore = {
      async hit() {
        throw new Error("synthetic store outage");
      },
    };
    const a = await machine("cardJob");
    setPartnerRateLimitStore(broken);
    const res = await fetch(`${a}/probe`, { headers: { "x-station": "station-a" } });
    expect(res.status).toBe(503);
  });
});
