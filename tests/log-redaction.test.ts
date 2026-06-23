import { describe, it, expect } from "vitest";
import { sanitizeResponseBodyForLog } from "../server/lib/log-redaction";

/**
 * Characterization tests for the response-body log sanitizer (Phase 0).
 *
 * These pin TODAY's behaviour (only `password` is stripped) so the Phase 1
 * widening of the deny-list is a controlled, test-driven change. The `it.todo`
 * cases below are the Phase 1 targets — fields that currently DO leak into
 * logs and must be redacted in security/redact-logs-and-errors.
 */
describe("sanitizeResponseBodyForLog (current behaviour)", () => {
  it("strips the password field", () => {
    expect(sanitizeResponseBodyForLog({ email: "a@b.com", password: "secret" })).toEqual({
      email: "a@b.com",
    });
  });

  it("does not mutate the input object", () => {
    const input = { password: "x", ok: true };
    sanitizeResponseBodyForLog(input);
    expect(input).toEqual({ password: "x", ok: true });
  });

  it("passes through a body with no sensitive fields", () => {
    expect(sanitizeResponseBodyForLog({ ok: true, id: 1 })).toEqual({ ok: true, id: 1 });
  });

  it("returns undefined / non-object input unchanged", () => {
    expect(sanitizeResponseBodyForLog(undefined)).toBeUndefined();
  });
});

describe("sanitizeResponseBodyForLog (Phase 1 targets — not yet implemented)", () => {
  // These currently FAIL by design (the fields still leak into logs today).
  // Phase 1 widens the deny-list and converts each `it.todo` into a real `it`.
  it.todo("redacts token / accessToken / refreshToken");
  it.todo("redacts email and customerEmail");
  it.todo("redacts signedUrl / uploadUrl / presigned R2 URLs");
  it.todo("redacts authorization headers and cookies if present in the body");
});
