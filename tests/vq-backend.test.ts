/**
 * Phase 2 — backend regression tests for the pure write-sanitisation + card-
 * numbering helpers. These lock the security-relevant behaviour (client cannot
 * set scope/identity columns; numerics are coerced; card ids never collide
 * across sets) without needing a live database.
 */
import { describe, it, expect } from "vitest";
import { sanitizeWrite, intOrNull, nextCardNumFrom } from "../server/vault-quest/lib/write-sanitize";

describe("sanitizeWrite — mass-assignment guard", () => {
  it("strips setCode so a body cannot escape the URL's set scope", () => {
    const out = sanitizeWrite({ setCode: "OTHER", name: "Booster" });
    expect(out).not.toHaveProperty("setCode");
    expect(out.name).toBe("Booster");
  });

  it("strips id / revision / timestamps (server-owned columns)", () => {
    const out = sanitizeWrite({ id: 5, revision: 9, revisionNumber: 3, createdAt: "x", updatedAt: "y", type: "booster_box" });
    expect(out).toEqual({ type: "booster_box" });
  });

  it("keeps legitimate admin fields (status / approvalStatus / locked / checklist)", () => {
    const out = sanitizeWrite({ status: "completed", approvalStatus: "approved", locked: true, checklist: { bleed: true } });
    expect(out).toEqual({ status: "completed", approvalStatus: "approved", locked: true, checklist: { bleed: true } });
  });

  it('coerces empty-string integer fields to null (no Postgres 22P02 → 500)', () => {
    const out = sanitizeWrite({ cardCount: "", releaseYear: "2026", boosterSize: "abc", printQuantity: 500 });
    expect(out.cardCount).toBeNull();
    expect(out.releaseYear).toBe(2026);
    expect(out.boosterSize).toBeNull();
    expect(out.printQuantity).toBe(500);
  });

  it("does not coerce non-integer text fields that merely look numeric", () => {
    const out = sanitizeWrite({ sku: "123", barcode: "000123" });
    expect(out.sku).toBe("123");
    expect(out.barcode).toBe("000123");
  });
});

describe("intOrNull", () => {
  it("maps empty / null / NaN to null and passes finite numbers", () => {
    expect(intOrNull("")).toBeNull();
    expect(intOrNull(null)).toBeNull();
    expect(intOrNull(undefined)).toBeNull();
    expect(intOrNull("abc")).toBeNull();
    expect(intOrNull("7")).toBe(7);
    expect(intOrNull(0)).toBe(0);
    expect(intOrNull(-3)).toBe(-3);
  });
});

describe("nextCardNumFrom — set-scoped card numbering", () => {
  it("uses the passed setCode prefix, not a hardcoded one", () => {
    const cards = [{ cardId: "ABC-001" }, { cardId: "ABC-004" }, { cardId: "GNV-099" }];
    expect(nextCardNumFrom(cards, "ABC")).toBe(5); // ignores the GNV row
    expect(nextCardNumFrom(cards, "GNV")).toBe(100);
  });

  it("returns 1 for an empty set", () => {
    expect(nextCardNumFrom([], "GNV")).toBe(1);
  });

  it("escapes regex-special characters in the set code", () => {
    const cards = [{ cardId: "A.B-002" }];
    expect(nextCardNumFrom(cards, "A.B")).toBe(3);
    // A literal dot must not act as a wildcard that would also match "AXB-...".
    expect(nextCardNumFrom([{ cardId: "AXB-050" }], "A.B")).toBe(1);
  });
});
