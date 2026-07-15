import { afterEach, describe, expect, it } from "vitest";
import express, { type NextFunction, type Request, type Response } from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  createGraderEditSubmissionRateLimit,
  GRADER_EDIT_SUBMISSION_RATE_LIMIT_MAX,
} from "../server/lib/rate-limiters";

function fakeRequireGrade(req: Request, res: Response, next: NextFunction) {
  const state = String(req.header("x-staff-state") || "");
  if (!state) return res.status(401).json({ error: "Unauthorized" });
  if (state !== "grade") return res.status(403).json({ error: "Forbidden: missing 'grade' capability" });
  const staffId = req.header("x-staff-id") || "staff-1";
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
  run: (ctx: { base: string; workCount: () => number }) => Promise<T>
): Promise<T> {
  const app = express();
  app.use(express.json());
  let handlerWork = 0;
  app.post(
    "/api/grader/certificates/:id/edit-submission",
    fakeRequireGrade,
    createGraderEditSubmissionRateLimit({ windowMs: 60_000, max }),
    (_req, res) => {
      handlerWork += 1;
      return res.json({ ok: true, gradingStatus: "pending_review", changed: [] });
    }
  );

  let server: Server | undefined;
  try {
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return await run({ base, workCount: () => handlerWork });
  } finally {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function post(base: string, staffState = "grade", staffId = "staff-1") {
  const headers: Record<string, string> = {};
  if (staffState) headers["x-staff-state"] = staffState;
  if (staffId) headers["x-staff-id"] = staffId;
  return fetch(`${base}/api/grader/certificates/123/edit-submission`, {
    method: "POST",
    headers,
    body: JSON.stringify({ grade: "9" }),
  });
}

describe("grader edit-submission rate limit", () => {
  afterEach(() => {
    // Each test creates a fresh express-rate-limit instance, so no store reset is needed.
  });

  it("allows requests below the threshold", async () => {
    await withApp(2, async ({ base, workCount }) => {
      expect((await post(base)).status).toBe(200);
      expect((await post(base)).status).toBe(200);
      expect(workCount()).toBe(2);
    });
  });

  it("returns 429 with rate-limit headers above the threshold before handler work", async () => {
    await withApp(2, async ({ base, workCount }) => {
      expect((await post(base)).status).toBe(200);
      expect((await post(base)).status).toBe(200);
      const blocked = await post(base);
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("retry-after") || blocked.headers.get("ratelimit")).toBeTruthy();
      expect(await blocked.json()).toEqual({
        error: "Too many edit attempts — please slow down and try again shortly.",
      });
      expect(workCount()).toBe(2);
    });
  });

  it("keeps unauthenticated and wrong-role responses unchanged below the threshold", async () => {
    await withApp(2, async ({ base, workCount }) => {
      expect((await post(base, "")).status).toBe(401);
      expect((await post(base, "scan")).status).toBe(403);
      expect(workCount()).toBe(0);
    });
  });

  it("uses the authenticated staff id as the rate-limit key", async () => {
    await withApp(1, async ({ base, workCount }) => {
      expect((await post(base, "grade", "staff-a")).status).toBe(200);
      expect((await post(base, "grade", "staff-a")).status).toBe(429);
      expect((await post(base, "grade", "staff-b")).status).toBe(200);
      expect(workCount()).toBe(2);
    });
  });

  it("does not block realistic edit-submission usage under the production threshold", async () => {
    await withApp(GRADER_EDIT_SUBMISSION_RATE_LIMIT_MAX, async ({ base, workCount }) => {
      for (let i = 0; i < 10; i += 1) {
        expect((await post(base)).status).toBe(200);
      }
      expect(workCount()).toBe(10);
    });
  });
});
