/**
 * Phase 10A verification — regression tests for the corrective commit.
 *   R2-F1: isUndefinedTableOrColumn also degrades on 42703 (partial migration).
 *   R1-F2: effectiveCreditsPerImage prices a non-ref-capable model at its upgrade floor.
 * Pure units — no DB/provider/env.
 */
import { describe, it, expect, vi } from "vitest";
// production-storage imports server/db (which requires MINTVAULT_DATABASE_URL); the
// functions under test are pure, so stub the DB to keep this a no-connection unit test.
vi.mock("../server/db", () => ({ db: {}, pool: { end: () => Promise.resolve() } }));
import { isUndefinedTable, isUndefinedTableOrColumn } from "../server/vault-quest/production-storage";
import { effectiveCreditsPerImage, higgsfieldCreditsPerImage } from "../server/vault-quest/ai/higgsfield";

describe("isUndefinedTableOrColumn — degrade on partial migration (R2-F1)", () => {
  it("matches 42P01 (table absent) AND 42703 (column absent)", () => {
    expect(isUndefinedTableOrColumn({ code: "42P01" })).toBe(true);
    expect(isUndefinedTableOrColumn({ code: "42703" })).toBe(true);
  });
  it("walks the Drizzle-wrapped cause chain", () => {
    expect(isUndefinedTableOrColumn({ code: "XX", cause: { code: "42703" } })).toBe(true);
  });
  it("does NOT match unrelated errors (still throws real bugs)", () => {
    expect(isUndefinedTableOrColumn({ code: "23505" })).toBe(false);
    expect(isUndefinedTableOrColumn(new Error("boom"))).toBe(false);
  });
  it("strict isUndefinedTable stays table-only (42703 NOT swallowed there)", () => {
    expect(isUndefinedTable({ code: "42703" })).toBe(false);
    expect(isUndefinedTable({ code: "42P01" })).toBe(true);
  });
});

describe("effectiveCreditsPerImage — price the upgraded model (R1-F2)", () => {
  it("non-ref-capable z_image is priced at its nano_banana upgrade floor, not 0.15", () => {
    expect(higgsfieldCreditsPerImage("z_image")).toBe(0.15); // requested-model price (undercount)
    expect(effectiveCreditsPerImage("z_image")).toBe(1); // effective (upgraded) price
    expect(effectiveCreditsPerImage("z_image")).toBeGreaterThan(higgsfieldCreditsPerImage("z_image"));
  });
  it("ref-capable models keep their own price", () => {
    expect(effectiveCreditsPerImage("nano_banana")).toBe(1);
    expect(effectiveCreditsPerImage("nano_banana_pro")).toBe(2);
  });
  it("an unknown/non-ref-capable model floors at nano_banana (never undercounts)", () => {
    expect(effectiveCreditsPerImage("some_cheap_model")).toBe(1);
  });
});
