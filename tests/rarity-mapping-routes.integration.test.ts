/**
 * Permission + wiring proof for the rarity-mapping admin routes (tests 31-33).
 *
 * Exercises the REAL requireAdmin gate (401 no session, 403 grader) as a unit —
 * these branches are synchronous and touch no DB — and statically asserts every
 * route is behind requireAdmin, with the mutations additionally rate-limited.
 */
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Keep the db import inert (no Neon connect) — the gate paths under test never
// query it. Mirrors the local-DB guard used by the other integration tests.
vi.mock("../server/db", () => {
  const url = process.env.TEST_DATABASE_URL || "";
  return {
    db: {},
    pool: { end: () => Promise.resolve(), query: () => Promise.resolve({ rows: [] }) },
    __url: url,
  };
});

import { requireAdmin } from "../server/auth";

interface MockRes {
  statusCode: number | null;
  body: unknown;
  status: (c: number) => MockRes;
  json: (b: unknown) => MockRes;
}
function makeRes(): MockRes {
  const res: MockRes = {
    statusCode: null,
    body: null,
    status(c: number) {
      res.statusCode = c;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    },
  };
  return res;
}

describe("requireAdmin gate on the rarity-mapping routes", () => {
  it("returns 401 when there is no session (test 32)", async () => {
    const res = makeRes();
    const next = vi.fn();
    await requireAdmin({ session: undefined } as never, res as never, next as never);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 for a logged-in grader (test 33)", async () => {
    const res = makeRes();
    const next = vi.fn();
    await requireAdmin({ session: { isGrader: true } } as never, res as never, next as never);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });
});

describe("every rarity-mapping route is admin-gated; mutations are rate-limited (test 31)", () => {
  const src = fs.readFileSync(path.resolve(process.cwd(), "server/routes/rarity-mapping.ts"), "utf8");

  it("the read routes require admin", () => {
    expect(src).toMatch(/app\.get\("\/api\/admin\/rarity-mapping-reviews",\s*requireAdmin/);
    expect(src).toMatch(/app\.get\("\/api\/admin\/rarity-preferences",\s*requireAdmin/);
  });

  it("the mutation routes carry the rate limiter BEFORE requireAdmin", () => {
    expect(src).toMatch(/app\.post\("\/api\/admin\/rarity-mapping-reviews\/decision",\s*rarityMutationLimit,\s*requireAdmin/);
    expect(src).toMatch(/app\.put\("\/api\/admin\/rarity-preferences",\s*rarityMutationLimit,\s*requireAdmin/);
  });

  it("no route is registered without requireAdmin", () => {
    const routeLines = src.split("\n").filter((l) => /app\.(get|post|put|patch|delete)\(/.test(l));
    expect(routeLines.length).toBeGreaterThan(0);
    for (const line of routeLines) {
      expect(line, `route missing requireAdmin: ${line.trim()}`).toMatch(/requireAdmin/);
    }
  });
});
