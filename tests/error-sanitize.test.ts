import { describe, it, expect } from "vitest";
import {
  clientErrorMessage,
  newRequestId,
  errorEnvelope,
  errorDetailsAllowed,
  safeErrorSummary,
} from "../server/lib/error-sanitize";

describe("clientErrorMessage", () => {
  it("collapses 5xx to a generic message in production", () => {
    expect(clientErrorMessage(500, 'relation "users" does not exist', true)).toBe("Internal Server Error");
    expect(clientErrorMessage(503, "Neon connection timeout at ec2-1-2-3-4...", true)).toBe("Internal Server Error");
  });
  it("keeps 5xx detail in non-production", () => {
    expect(clientErrorMessage(500, "boom detail", false)).toBe("boom detail");
  });
  it("passes 4xx messages through unchanged in production", () => {
    expect(clientErrorMessage(400, "Invalid certId", true)).toBe("Invalid certId");
    expect(clientErrorMessage(403, "Forbidden", true)).toBe("Forbidden");
  });
  it("treats malformed (undefined/NaN) status as 500 — generic in production", () => {
    expect(clientErrorMessage(undefined, "leaky detail", true)).toBe("Internal Server Error");
    expect(clientErrorMessage(NaN, "leaky detail", true)).toBe("Internal Server Error");
    expect(clientErrorMessage(undefined, "leaky detail", false)).toBe("leaky detail");
  });
});

describe("errorDetailsAllowed", () => {
  it("is true ONLY for development + DEBUG_ERROR_DETAILS=true", () => {
    expect(errorDetailsAllowed("development", "true")).toBe(true);
  });
  it("production ignores the flag entirely", () => {
    expect(errorDetailsAllowed("production", "true")).toBe(false);
  });
  it("is false in development without the flag", () => {
    expect(errorDetailsAllowed("development", "false")).toBe(false);
    expect(errorDetailsAllowed("development", undefined)).toBe(false);
  });
  it("is false when env is unset", () => {
    expect(errorDetailsAllowed(undefined, "true")).toBe(false);
  });
});

describe("errorEnvelope", () => {
  it("collapses any 5xx body (error/message/detail/details/debug) to a strict envelope by default (all envs)", () => {
    const bodies: unknown[] = [
      { error: 'relation "users" does not exist' },
      { message: "ENOENT: no such file" },
      { error: "Seed failed.", detail: "SQL: secret" },
      { error: "Grading failed", details: "stacktrace at /app/server/x" },
      { ok: false, debug: "host=ec2-1-2-3-4 db=prod_main" },
      { whatever: "x", nested: { stack: "boom" } },
    ];
    for (const body of bodies) {
      const r = errorEnvelope(500, body);
      expect(r.scrubbed).toBe(true);
      expect(r.body).toEqual({ error: "Internal Server Error", requestId: r.requestId });
      expect(Object.keys(r.body as object).sort()).toEqual(["error", "requestId"]);
    }
  });

  it("a mixed body cannot retain a secret detail field", () => {
    const r = errorEnvelope(500, { error: "safe", detail: "secret" });
    expect((r.body as Record<string, unknown>).detail).toBeUndefined();
    expect(JSON.stringify(r.body)).not.toContain("secret");
  });

  it("prefers the supplied requestId (correlation with X-Request-ID)", () => {
    const r = errorEnvelope(500, { message: "boom", requestId: "body-id" }, { requestId: "req-id" });
    expect(r.requestId).toBe("req-id");
    expect(r.body).toEqual({ error: "Internal Server Error", requestId: "req-id" });
  });

  it("falls back to an existing body requestId, then a generated one", () => {
    expect(errorEnvelope(500, { error: "x", requestId: "body-id" }).requestId).toBe("body-id");
    expect(errorEnvelope(500, { error: "x" }).requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("passes 5xx through untouched when detail is explicitly allowed (debug)", () => {
    const body = { error: "boom", detail: "dev detail" };
    const r = errorEnvelope(500, body, { allowDetails: true });
    expect(r.scrubbed).toBe(false);
    expect(r.body).toBe(body);
  });

  it("leaves 4xx responses unchanged", () => {
    const body = { error: "Invalid certId", detail: "field x" };
    const r = errorEnvelope(400, body);
    expect(r.scrubbed).toBe(false);
    expect(r.body).toBe(body);
  });

  it("does not mutate the input", () => {
    const input = { error: "x", detail: "secret" };
    errorEnvelope(500, input);
    expect(input).toEqual({ error: "x", detail: "secret" });
  });

  it("never exposes the original error text anywhere in the result", () => {
    const canary = "CANARY-SECRET-zzz999";
    const r = errorEnvelope(500, { error: "oops", detail: canary, message: canary, debug: canary });
    expect(JSON.stringify(r)).not.toContain(canary);
  });

  it("scrubs array and primitive 5xx bodies too", () => {
    expect(errorEnvelope(500, ["secret"]).body).toEqual({
      error: "Internal Server Error",
      requestId: expect.any(String),
    });
    expect(errorEnvelope(503, "raw text").body).toEqual({
      error: "Internal Server Error",
      requestId: expect.any(String),
    });
  });
});

describe("safeErrorSummary", () => {
  it("includes the error class name and a provider-independent code", () => {
    const err = Object.assign(new Error("password authentication failed for user mv"), { code: "ECONNREFUSED" });
    const s = safeErrorSummary(err);
    expect(s.name).toBe("Error");
    expect(s.code).toBe("ECONNREFUSED");
  });

  it("accepts a numeric driver code (e.g. Postgres SQLSTATE)", () => {
    expect(safeErrorSummary({ name: "DatabaseError", code: 23505 }).code).toBe("23505");
  });

  it("NEVER includes the raw message, stack, or any sensitive substring", () => {
    const err = Object.assign(
      new Error("connect to postgres://user:pw@ec2-1-2-3-4/db failed; token=abc; a@b.com; /app/x"),
      {
        code: "ENOTFOUND",
        stack: "Error: secret\n at /app/server/db.ts:1",
      }
    );
    const json = JSON.stringify(safeErrorSummary(err, { requestId: "r1", operation: "GET /api/x" }));
    for (const leak of ["postgres://", "pw@", "token=", "a@b.com", "/app/", "secret", "stack"]) {
      expect(json).not.toContain(leak);
    }
  });

  it("carries operation + requestId from context, omits an unsafe code", () => {
    const s = safeErrorSummary({ name: "X", code: "has spaces and @!" }, { operation: "POST /y", requestId: "r2" });
    expect(s).toEqual({ name: "X", operation: "POST /y", requestId: "r2" });
    expect(s.code).toBeUndefined();
  });

  it("handles non-Error inputs without throwing", () => {
    expect(safeErrorSummary("a string").name).toBe("String");
    expect(safeErrorSummary(null).name).toBe("Error");
    expect(safeErrorSummary(undefined).name).toBe("Error");
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
