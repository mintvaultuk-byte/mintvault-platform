import { describe, it, expect, vi } from "vitest";
import { isCrossOriginViolation, csrfOriginCheck } from "../server/lib/csrf-origin";

describe("isCrossOriginViolation (pure decision)", () => {
  const host = "mintvaultuk.com";

  it("allows safe methods regardless of origin", () => {
    expect(isCrossOriginViolation({ method: "GET", origin: "https://evil.com", host })).toBe(false);
    expect(isCrossOriginViolation({ method: "HEAD", origin: "https://evil.com", host })).toBe(false);
  });

  it("allows same-origin state-changing requests", () => {
    expect(isCrossOriginViolation({ method: "POST", origin: "https://mintvaultuk.com", host })).toBe(false);
  });

  it("blocks cross-origin state-changing requests (Origin mismatch)", () => {
    expect(isCrossOriginViolation({ method: "POST", origin: "https://evil.com", host })).toBe(true);
    expect(isCrossOriginViolation({ method: "DELETE", origin: "https://evil.com", host })).toBe(true);
  });

  it("falls back to Referer when Origin is absent", () => {
    expect(isCrossOriginViolation({ method: "POST", referer: "https://mintvaultuk.com/admin", host })).toBe(false);
    expect(isCrossOriginViolation({ method: "POST", referer: "https://evil.com/x", host })).toBe(true);
  });

  it("allows requests with neither Origin nor Referer (non-browser client)", () => {
    expect(isCrossOriginViolation({ method: "POST", host })).toBe(false);
  });

  it("blocks a malformed / null Origin (cannot verify)", () => {
    expect(isCrossOriginViolation({ method: "POST", origin: "null", host })).toBe(true);
    expect(isCrossOriginViolation({ method: "POST", origin: "%%%", host })).toBe(true);
  });

  it("handles host:port consistently (dev localhost)", () => {
    expect(isCrossOriginViolation({ method: "POST", origin: "http://127.0.0.1:5000", host: "127.0.0.1:5000" })).toBe(
      false
    );
  });

  it("does not block when there is no Host header to compare", () => {
    expect(isCrossOriginViolation({ method: "POST", origin: "https://evil.com", host: "" })).toBe(false);
  });
});

describe("csrfOriginCheck (middleware)", () => {
  function ctx(overrides: any = {}) {
    const req: any = {
      method: "POST",
      path: "/api/admin/submissions/1/status",
      headers: { host: "mintvaultuk.com" },
      ...overrides,
    };
    const res: any = { statusCode: 200 };
    res.status = vi.fn((c: number) => {
      res.statusCode = c;
      return res;
    });
    res.json = vi.fn((b: any) => {
      res.body = b;
      return res;
    });
    const next = vi.fn();
    return { req, res, next };
  }

  it("blocks a cross-origin admin POST with 403", () => {
    const { req, res, next } = ctx({ headers: { host: "mintvaultuk.com", origin: "https://evil.com" } });
    csrfOriginCheck(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("allows a same-origin admin POST", () => {
    const { req, res, next } = ctx({ headers: { host: "mintvaultuk.com", origin: "https://mintvaultuk.com" } });
    csrfOriginCheck(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("exempts the Stripe webhook path", () => {
    const { req, res, next } = ctx({
      path: "/api/stripe/webhook",
      headers: { host: "x", origin: "https://stripe.com" },
    });
    csrfOriginCheck(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("exempts requests carrying an X-Scanner-Token", () => {
    const { req, res, next } = ctx({
      headers: { host: "mintvaultuk.com", origin: "https://evil.com", "x-scanner-token": "tok" },
    });
    csrfOriginCheck(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("ignores safe methods", () => {
    const { req, res, next } = ctx({ method: "GET", headers: { host: "mintvaultuk.com", origin: "https://evil.com" } });
    csrfOriginCheck(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
