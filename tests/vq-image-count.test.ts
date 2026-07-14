/**
 * One-image-per-request enforcement (Phase 3A item 1) — pure unit coverage.
 */
import { describe, it, expect } from "vitest";
import { validateSingleImageCount } from "../server/vault-quest/lib/vq-image-count";

describe("validateSingleImageCount", () => {
  it("missing (undefined) normalizes to 1 — the existing client never sends this field", () => {
    expect(validateSingleImageCount(undefined)).toEqual({ ok: true, count: 1 });
  });
  it("explicit 1 is accepted", () => {
    expect(validateSingleImageCount(1)).toEqual({ ok: true, count: 1 });
  });
  it("0 is rejected", () => {
    expect(validateSingleImageCount(0).ok).toBe(false);
  });
  it("2 is rejected", () => {
    expect(validateSingleImageCount(2).ok).toBe(false);
  });
  it("a negative number is rejected", () => {
    expect(validateSingleImageCount(-1).ok).toBe(false);
  });
  it("a non-numeric string is rejected", () => {
    expect(validateSingleImageCount("two").ok).toBe(false);
  });
  it("a numeric string other than '1' is rejected", () => {
    expect(validateSingleImageCount("3").ok).toBe(false);
  });
  it("explicit null is rejected (not treated the same as absent)", () => {
    expect(validateSingleImageCount(null).ok).toBe(false);
  });
  it("a non-integer number is rejected", () => {
    expect(validateSingleImageCount(1.5).ok).toBe(false);
  });
  it("an object/array is rejected", () => {
    expect(validateSingleImageCount({}).ok).toBe(false);
    expect(validateSingleImageCount([1]).ok).toBe(false);
  });
});
