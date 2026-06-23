import { describe, it, expect } from "vitest";
import { clientErrorMessage, newRequestId, scrubServerErrorBody } from "../server/lib/error-sanitize";

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

describe("scrubServerErrorBody", () => {
  it("replaces an error field with a generic message + requestId", () => {
    const r = scrubServerErrorBody({ error: 'relation "users" does not exist' });
    expect(r).not.toBeNull();
    expect(r!.body.error).toBe("Internal Server Error");
    expect(typeof r!.body.requestId).toBe("string");
    expect(r!.original).toBe('relation "users" does not exist');
    expect(r!.alreadyHandled).toBe(false);
  });

  it("replaces a message field and preserves other fields", () => {
    const r = scrubServerErrorBody({ ok: false, message: "ENOENT: no such file" });
    expect(r!.body).toMatchObject({ ok: false, message: "Internal Server Error" });
    expect(r!.body.requestId).toBeDefined();
  });

  it("preserves an existing requestId and marks alreadyHandled (central handler case)", () => {
    const r = scrubServerErrorBody({ message: "boom", requestId: "abc-123" });
    expect(r!.requestId).toBe("abc-123");
    expect(r!.alreadyHandled).toBe(true);
  });

  it("returns null when there is no error/message to scrub", () => {
    expect(scrubServerErrorBody({ ok: true, data: [1, 2, 3] })).toBeNull();
  });

  it("does not mutate the input", () => {
    const input = { error: "secret detail" };
    scrubServerErrorBody(input);
    expect(input).toEqual({ error: "secret detail" });
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
