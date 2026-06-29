import { describe, it, expect, vi } from "vitest";
import { requireAdmin } from "../server/auth";

/**
 * First authorization test in the codebase (Phase 0). server/auth.ts imports
 * only express types + crypto, so the admin gate is testable with fake
 * req/res/next objects — no database, no app boot.
 *
 * requireAdmin contract (server/auth.ts):
 *   - internal __graderProxy flag           -> next()
 *   - session.isAdmin                        -> next()
 *   - logged-in grader (session.isGrader)    -> 403 (explicit role denial)
 *   - anyone else (no/!admin session)        -> 401
 */

function mockRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body: any) => {
    res.body = body;
    return res;
  });
  return res;
}

describe("requireAdmin", () => {
  it("returns 401 when there is no session", () => {
    const res = mockRes();
    const next = vi.fn();
    requireAdmin({ session: undefined } as any, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("returns 401 for an authenticated non-admin (e.g. magic-link customer)", () => {
    const res = mockRes();
    const next = vi.fn();
    requireAdmin({ session: { customerEmail: "c@example.com" } } as any, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("returns 403 (not 401) for a logged-in grader — explicit role denial", () => {
    const res = mockRes();
    const next = vi.fn();
    requireAdmin({ session: { isGrader: true } } as any, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("calls next() for an admin session and sets no status", () => {
    const res = mockRes();
    const next = vi.fn();
    requireAdmin({ session: { isAdmin: true } } as any, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("honours the internal grader-proxy flag even over a grader session", () => {
    const res = mockRes();
    const next = vi.fn();
    requireAdmin({ session: { isGrader: true }, __graderProxy: true } as any, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
