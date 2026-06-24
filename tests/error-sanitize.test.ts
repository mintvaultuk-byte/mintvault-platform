import { describe, it, expect } from "vitest";
import { clientErrorMessage, newRequestId, productionErrorEnvelope } from "../server/lib/error-sanitize";

describe("clientErrorMessage", () => {
  it("collapses 5xx to a generic message in production", () => {
    expect(clientErrorMessage(500, 'relation "users" does not exist', true)).toBe("Internal Server Error");
    expect(clientErrorMessage(503, "Neon connection timeout at ec2-1-2-3-4...", true)).toBe("Internal Server Error");
  });

  it("keeps 5xx detail in non-production", () => {
    expect(clientErrorMessage(500, "boom detail", false)).toBe("boom detail");
  });

  it("passes 4xx messages through unchanged in production (client-actionable)", () => {
    expect(clientErrorMessage(400, "Invalid certId", true)).toBe("Invalid certId");
    expect(clientErrorMessage(403, "Forbidden", true)).toBe("Forbidden");
    expect(clientErrorMessage(404, "Not found", true)).toBe("Not found");
  });

  it("falls back to a generic message when none is provided", () => {
    expect(clientErrorMessage(500, undefined, false)).toBe("Internal Server Error");
    expect(clientErrorMessage(500, "", true)).toBe("Internal Server Error");
  });

  it("treats malformed (undefined/NaN) status as 500 — generic in production", () => {
    expect(clientErrorMessage(undefined, "leaky detail", true)).toBe("Internal Server Error");
    expect(clientErrorMessage(NaN, "leaky detail", true)).toBe("Internal Server Error");
    // non-prod still shows detail
    expect(clientErrorMessage(undefined, "leaky detail", false)).toBe("leaky detail");
  });
});

describe("productionErrorEnvelope", () => {
  const prod = (status: number, body: unknown) => productionErrorEnvelope(status, body, true);

  it("collapses any 5xx body (error/message/detail/details/debug/arbitrary) to a strict envelope", () => {
    const bodies: unknown[] = [
      { error: 'relation "users" does not exist' },
      { message: "ENOENT: no such file" },
      { error: "Seed failed.", detail: "SQL: secret" },
      { error: "Grading failed", details: "stacktrace at /app/server/x" },
      { ok: false, debug: "host=ec2-1-2-3-4 db=prod_main" },
      { whatever: "x", nested: { stack: "boom" } },
    ];
    for (const body of bodies) {
      const r = prod(500, body);
      expect(r.scrubbed).toBe(true);
      expect(r.body).toEqual({ error: "Internal Server Error", requestId: r.requestId });
      // strict: ONLY error + requestId — nothing else survives
      expect(Object.keys(r.body as object).sort()).toEqual(["error", "requestId"]);
    }
  });

  it("a mixed body cannot retain a secret detail field", () => {
    const r = prod(500, { error: "safe", detail: "secret" });
    expect((r.body as Record<string, unknown>).detail).toBeUndefined();
    expect(JSON.stringify(r.body)).not.toContain("secret");
  });

  it("preserves an existing requestId", () => {
    const r = prod(500, { message: "boom", requestId: "abc-123" });
    expect(r.requestId).toBe("abc-123");
    expect(r.body).toEqual({ error: "Internal Server Error", requestId: "abc-123" });
  });

  it("generates a requestId when none is present", () => {
    expect(prod(500, { error: "x" }).requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("does not mutate the input", () => {
    const input = { error: "x", detail: "secret" };
    prod(500, input);
    expect(input).toEqual({ error: "x", detail: "secret" });
  });

  it("never exposes the original error text anywhere in the result (cannot be logged)", () => {
    const canary = "CANARY-SECRET-zzz999";
    const r = prod(500, { error: "oops", detail: canary, message: canary, debug: canary });
    expect(JSON.stringify(r)).not.toContain(canary);
  });

  it("leaves 4xx responses unchanged in production (client-actionable)", () => {
    const body = { error: "Invalid certId", detail: "field x" };
    const r = productionErrorEnvelope(400, body, true);
    expect(r.scrubbed).toBe(false);
    expect(r.body).toBe(body);
  });

  it("leaves non-production responses unchanged (dev keeps detail)", () => {
    const body = { error: "boom", detail: "dev detail" };
    const r = productionErrorEnvelope(500, body, false);
    expect(r.scrubbed).toBe(false);
    expect(r.body).toBe(body);
  });

  it("scrubs array and primitive 5xx bodies too (no leak via non-object body)", () => {
    expect(productionErrorEnvelope(500, ["secret"], true).body).toEqual({
      error: "Internal Server Error",
      requestId: expect.any(String),
    });
    expect(productionErrorEnvelope(503, "raw text", true).body).toEqual({
      error: "Internal Server Error",
      requestId: expect.any(String),
    });
  });
});

describe("newRequestId", () => {
  it("returns a unique uuid each call", () => {
    const a = newRequestId();
    const b = newRequestId();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });
});
