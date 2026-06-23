import { describe, it, expect } from "vitest";
import { sanitizeResponseBodyForLog, REDACTED } from "../server/lib/log-redaction";

/**
 * Phase 1 contract for the response-body log sanitizer. Sensitive fields are
 * redacted (key preserved, value replaced) by KEY name and by VALUE shape,
 * recursively through nested objects and arrays. Input is never mutated.
 */
describe("sanitizeResponseBodyForLog", () => {
  it("redacts the password field", () => {
    expect(sanitizeResponseBodyForLog({ id: 1, password: "secret" })).toEqual({ id: 1, password: REDACTED });
  });

  it("does not mutate the input object", () => {
    const input = { password: "x", ok: true };
    sanitizeResponseBodyForLog(input);
    expect(input).toEqual({ password: "x", ok: true });
  });

  it("passes through a body with no sensitive fields", () => {
    expect(sanitizeResponseBodyForLog({ ok: true, id: 1, certId: "MV1", grade: 9 })).toEqual({
      ok: true,
      id: 1,
      certId: "MV1",
      grade: 9,
    });
  });

  it("returns undefined / non-object input unchanged", () => {
    expect(sanitizeResponseBodyForLog(undefined)).toBeUndefined();
  });

  // ── Phase 1 targets ──────────────────────────────────────────────────────
  it("redacts token / accessToken / refreshToken (by key)", () => {
    const out = sanitizeResponseBodyForLog({ token: "abc", accessToken: "x", refreshToken: "y", ok: true });
    expect(out).toEqual({ token: REDACTED, accessToken: REDACTED, refreshToken: REDACTED, ok: true });
  });

  it("redacts email and customerEmail (by key)", () => {
    const out = sanitizeResponseBodyForLog({ customerEmail: "a@b.com", email: "c@d.com", name: "Ada" });
    expect(out).toEqual({ customerEmail: REDACTED, email: REDACTED, name: "Ada" });
  });

  it("redacts a Stripe client secret and signature (by key)", () => {
    const out = sanitizeResponseBodyForLog({ clientSecret: "pi_123_secret_456", signature: "whsig", amount: 500 });
    expect(out).toEqual({ clientSecret: REDACTED, signature: REDACTED, amount: 500 });
  });

  it("redacts a presigned R2/S3 URL by value shape, even under a benign key", () => {
    const signed = "https://bucket.r2.cloudflarestorage.com/img/front.jpg?X-Amz-Signature=deadbeef&X-Amz-Expires=3600";
    const out = sanitizeResponseBodyForLog({ frontImage: signed, plain: "https://mintvaultuk.com/cert/MV1" });
    expect(out).toEqual({ frontImage: REDACTED, plain: "https://mintvaultuk.com/cert/MV1" });
  });

  it("redacts a JWT and an email found in a free-text value", () => {
    const jwt = "eyJhbGciOiJ.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4";
    const out = sanitizeResponseBodyForLog({ jwt, note: "sent to user@example.com" });
    expect(out.jwt).toBe(REDACTED);
    expect(out.note).toBe(REDACTED);
  });

  it("recurses into nested objects and arrays", () => {
    const out = sanitizeResponseBodyForLog({
      submissions: [
        { id: 1, customerEmail: "a@b.com", grade: 10 },
        { id: 2, customerEmail: "c@d.com", grade: 9 },
      ],
      meta: { sessionToken: "tok", count: 2 },
    });
    expect(out).toEqual({
      submissions: [
        { id: 1, customerEmail: REDACTED, grade: 10 },
        { id: 2, customerEmail: REDACTED, grade: 9 },
      ],
      meta: { sessionToken: REDACTED, count: 2 },
    });
  });

  it("does not redact a benign object shared across sibling fields (no false cycle)", () => {
    const shared = { label: "common", n: 1 };
    const out = sanitizeResponseBodyForLog({ a: shared, b: shared });
    expect(out).toEqual({ a: { label: "common", n: 1 }, b: { label: "common", n: 1 } });
  });

  it("does not throw on a true cycle and redacts the back-reference", () => {
    const node: any = { name: "root" };
    node.self = node;
    const out = sanitizeResponseBodyForLog(node);
    expect(out.name).toBe("root");
    expect(out.self).toBe(REDACTED);
  });

  it("preserves Date values (does not explode them into {})", () => {
    const d = new Date("2026-06-23T00:00:00.000Z");
    const out = sanitizeResponseBodyForLog({ createdAt: d, ok: true });
    expect(out.createdAt).toBe(d);
    expect(out.ok).toBe(true);
  });

  it("leaves short ids/uuids and ordinary urls intact (no over-redaction)", () => {
    const out = sanitizeResponseBodyForLog({
      certId: "MV12345",
      uuid: "550e8400-e29b-41d4-a716-446655440000",
      link: "https://mintvaultuk.com/cert/MV1",
    });
    expect(out).toEqual({
      certId: "MV12345",
      uuid: "550e8400-e29b-41d4-a716-446655440000",
      link: "https://mintvaultuk.com/cert/MV1",
    });
  });
});
