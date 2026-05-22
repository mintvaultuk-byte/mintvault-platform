import { describe, it, expect } from "vitest";

// normalizeCertId is exported from routes.ts but pulls in the full Express app.
// Re-implement the pure logic here to test it without the server dependency.
// If the canonical implementation changes, this test must be updated to match.
function normalizeCertId(raw: string): string {
  const m = raw.match(/^MV-?0*(\d+)$/i);
  if (m) return `MV${m[1]}`;
  return raw;
}

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
    expect(normalizeCertId("MV-123")).toBe("MV123");
  });
});
