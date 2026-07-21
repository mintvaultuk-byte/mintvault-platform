import { describe, expect, it } from "vitest";
import express, { type NextFunction, type Request, type Response } from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createGraderCertificateGradingReadRateLimit,
  createGraderCertificateImagesReadRateLimit,
  createGraderCorrectionHistoryReadRateLimit,
} from "../server/lib/rate-limiters";

function fakeRequireGrade(req: Request, res: Response, next: NextFunction) {
  const state = String(req.header("x-staff-state") || "");
  if (!state) return res.status(401).json({ error: "Unauthorized" });
  if (state !== "grade") return res.status(403).json({ error: "Forbidden: missing 'grade' capability" });
  const staffId = req.header("x-staff-id") || "grader-1";
  (req as Request & { session: Record<string, unknown> }).session = {
    isStaff: true,
    staffId,
    graderId: staffId,
    capGrade: true,
  };
  return next();
}

async function withApp<T>(
  max: number,
  run: (ctx: {
    base: string;
    work: { images: number; grading: number; corrections: number; r2: number; db: number };
  }) => Promise<T>
): Promise<T> {
  const app = express();
  const work = { images: 0, grading: 0, corrections: 0, r2: 0, db: 0 };
  app.get(
    "/api/grader/certificates/:id/images",
    fakeRequireGrade,
    createGraderCertificateImagesReadRateLimit({ windowMs: 60_000, max }),
    (_req, res) => {
      work.images += 1;
      work.r2 += 1;
      return res.json({ urls: {} });
    }
  );
  app.get(
    "/api/grader/certificates/:id/grading",
    fakeRequireGrade,
    createGraderCertificateGradingReadRateLimit({ windowMs: 60_000, max }),
    (_req, res) => {
      work.grading += 1;
      work.db += 1;
      return res.json({ grade: "9" });
    }
  );
  app.get(
    "/api/grader/certificates/:id/corrections",
    fakeRequireGrade,
    createGraderCorrectionHistoryReadRateLimit({ windowMs: 60_000, max }),
    (_req, res) => {
      work.corrections += 1;
      work.db += 1;
      return res.json({ corrected: true, changes: [] });
    }
  );

  let server: Server | undefined;
  try {
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return await run({ base, work });
  } finally {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function get(base: string, route: "images" | "grading" | "corrections", state = "grade", staffId = "grader-1") {
  const headers: Record<string, string> = {};
  if (state) headers["x-staff-state"] = state;
  if (staffId) headers["x-staff-id"] = staffId;
  return fetch(`${base}/api/grader/certificates/123/${route}`, { headers });
}

describe("grader certificate read rate limits", () => {
  it("installs the three dedicated limiters after capability authorization on the real routes", () => {
    const routes = readFileSync(join(process.cwd(), "server/routes/grader.ts"), "utf8");
    expect(routes).toMatch(
      /"\/api\/grader\/certificates\/:id\/images",\s*requireCapability\("grade"\),\s*graderCertificateImagesReadRateLimit/
    );
    expect(routes).toMatch(
      /"\/api\/grader\/certificates\/:id\/grading",\s*requireCapability\("grade"\),\s*graderCertificateGradingReadRateLimit/
    );
    expect(routes).toMatch(
      /"\/api\/grader\/certificates\/:id\/corrections",\s*requireCapability\("grade"\),\s*graderCorrectionHistoryReadRateLimit/
    );
  });

  it("allows authorized reads below the limit and returns route-specific 429s before work", async () => {
    await withApp(1, async ({ base, work }) => {
      for (const [route, message] of [
        ["images", "Too many certificate image requests — please slow down and try again shortly."],
        ["grading", "Too many grading requests — please slow down and try again shortly."],
        ["corrections", "Too many correction-history requests — please slow down and try again shortly."],
      ] as const) {
        expect((await get(base, route)).status).toBe(200);
        const blocked = await get(base, route);
        expect(blocked.status).toBe(429);
        expect(blocked.headers.get("retry-after") || blocked.headers.get("ratelimit")).toBeTruthy();
        expect(await blocked.json()).toEqual({ error: message });
      }
      expect(work).toEqual({ images: 1, grading: 1, corrections: 1, r2: 1, db: 2 });
    });
  });

  it("keeps each route budget independent and keys authorized callers separately", async () => {
    await withApp(1, async ({ base, work }) => {
      expect((await get(base, "images", "grade", "grader-a")).status).toBe(200);
      expect((await get(base, "images", "grade", "grader-a")).status).toBe(429);
      expect((await get(base, "grading", "grade", "grader-a")).status).toBe(200);
      expect((await get(base, "corrections", "grade", "grader-a")).status).toBe(200);
      expect((await get(base, "images", "grade", "grader-b")).status).toBe(200);
      expect(work).toEqual({ images: 2, grading: 1, corrections: 1, r2: 2, db: 2 });
    });
  });

  it("keeps unauthenticated and non-grader callers blocked without consuming grade-cap budgets or reaching R2/DB work", async () => {
    await withApp(1, async ({ base, work }) => {
      expect((await get(base, "corrections", "")).status).toBe(401);
      expect((await get(base, "corrections", "scan")).status).toBe(403);
      expect(work).toEqual({ images: 0, grading: 0, corrections: 0, r2: 0, db: 0 });
      expect((await get(base, "corrections", "grade", "grader-a")).status).toBe(200);
      expect(work).toEqual({ images: 0, grading: 0, corrections: 1, r2: 0, db: 1 });
    });
  });
});
