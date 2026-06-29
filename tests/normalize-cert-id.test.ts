import { describe, it, expect } from "vitest";

// The canonical normalizer now lives in a dependency-free shared module
// (server/lib/cert-id.ts), so this test exercises the REAL implementation
// directly — no re-implementation, no Express/DB pulled in.
import { normalizeCertId, certNumberFromId } from "../server/lib/cert-id";

describe("normalizeCertId", () => {
  it("strips leading zeros and dash", () => {
    expect(normalizeCertId("MV-0000000001")).toBe("MV1");
  });

  it("handles already-normalised IDs", () => {
    expect(normalizeCertId("MV1")).toBe("MV1");
  });

  it("handles no dash variant", () => {
    expect(normalizeCertId("MV0000000042")).toBe("MV42");
  });

  it("is case-insensitive", () => {
    expect(normalizeCertId("mv-0000000005")).toBe("MV5");
  });

  it("returns non-matching input unchanged", () => {
    expect(normalizeCertId("PSA-123")).toBe("PSA-123");
    expect(normalizeCertId("random")).toBe("random");
  });

  it("handles large cert numbers", () => {
    expect(normalizeCertId("MV-0000999999")).toBe("MV999999");
  });

  it("preserves cert number with no leading zeros", () => {
    expect(normalizeCertId("MV123")).toBe("MV123");
    expect(normalizeCertId("MV-123")).toBe("MV123");
  });

  it("normalizes leading-zero variants identically (with/without dash)", () => {
    expect(normalizeCertId("MV000123")).toBe("MV123");
    expect(normalizeCertId("MV-000123")).toBe("MV123");
  });

  it("normalizes an all-zero id to MV0 (keeps one digit)", () => {
    expect(normalizeCertId("MV000")).toBe("MV0");
    expect(normalizeCertId("MV0")).toBe("MV0");
    expect(normalizeCertId("MV-0000000000")).toBe("MV0");
  });

  it("does NOT hang on a long malformed zero-only input (ReDoS guard)", () => {
    // The old /^MV-?0*(\d+)$/i backtracked ~O(n^2) on this; the new helper is
    // length-bounded + non-overlapping, so it returns effectively instantly.
    const evil = "MV" + "0".repeat(200_000) + "x"; // not an MV-number → passthrough
    const start = Date.now();
    expect(normalizeCertId(evil)).toBe(evil);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("certNumberFromId returns the stripped number, or null for non-MV ids", () => {
    expect(certNumberFromId("MV-0000000042")).toBe("42");
    expect(certNumberFromId("MV000")).toBe("0");
    expect(certNumberFromId("PSA-1")).toBeNull();
    expect(certNumberFromId("")).toBeNull();
  });
});
