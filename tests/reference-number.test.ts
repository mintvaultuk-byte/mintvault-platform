import { describe, it, expect, vi } from "vitest";

// Mock the db module before importing reference-number (it imports db at top level)
vi.mock("../server/db", () => ({ db: {} }));

const { generateReferenceNumber } = await import("../server/reference-number");

describe("generateReferenceNumber", () => {
  it("returns XXXX-XXXX-XXXX format", () => {
    const ref = generateReferenceNumber();
    expect(ref).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it("excludes ambiguous characters I, O, 0, 1", () => {
    for (let i = 0; i < 50; i++) {
      const ref = generateReferenceNumber().replace(/-/g, "");
      expect(ref).not.toMatch(/[IO01]/);
    }
  });

  it("produces unique values", () => {
    const refs = new Set(Array.from({ length: 100 }, () => generateReferenceNumber()));
    expect(refs.size).toBe(100);
  });

  it("has exactly 14 chars including dashes", () => {
    expect(generateReferenceNumber()).toHaveLength(14);
  });
});
