/**
 * Phase 2 — backend regression tests for the pure write-sanitisation + card-
 * numbering helpers. These lock the security-relevant behaviour (client cannot
 * set scope/identity columns; numerics are coerced; card ids never collide
 * across sets) without needing a live database.
 */
import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { sanitizeWrite, intOrNull, nextCardNumFrom, isCandidateReferencedInPack, referencePackMergeJson } from "../server/vault-quest/lib/write-sanitize";
import { assertVqWriteKey, assertVqReadKey } from "../server/vault-quest/lib/vq-keys";
import { validVqCardId, isCandidateKeyForCard } from "../server/vault-quest/ai/higgsfield";
import { validateArtwork } from "../server/vault-quest/upload-guard";
import { vqChargedCredits } from "../shared/vq-schema";

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

describe("isCandidateReferencedInPack — reject-candidate dangling guard", () => {
  it("returns true when a pack slot's candidateId matches", () => {
    const pack = { master_portrait: { candidateId: 57, r2Key: "vq/..." }, action_pose: { candidateId: 12 } };
    expect(isCandidateReferencedInPack(pack, 57)).toBe(true);
    expect(isCandidateReferencedInPack(pack, 12)).toBe(true);
  });
  it("returns false for an unreferenced candidate and for empty/null packs", () => {
    const pack = { master_portrait: { candidateId: 57 } };
    expect(isCandidateReferencedInPack(pack, 99)).toBe(false);
    expect(isCandidateReferencedInPack({}, 1)).toBe(false);
    expect(isCandidateReferencedInPack(null, 1)).toBe(false);
    expect(isCandidateReferencedInPack(undefined, 1)).toBe(false);
  });
  it("ignores slots with a null/absent candidateId (manual uploads)", () => {
    const pack = { master_portrait: { candidateId: null, r2Key: "vq/..." }, action_pose: null };
    expect(isCandidateReferencedInPack(pack, 57)).toBe(false);
  });
});

describe("referencePackMergeJson — atomic reference-pack merge payload (DATA-01)", () => {
  it("emits exactly one top-level reference-type key with the slot fields", () => {
    const s = referencePackMergeJson("action_pose", "vq/characters/X/approved/action_pose.png", 12, 88, "2026-07-10T00:00:00.000Z");
    const parsed = JSON.parse(s);
    expect(Object.keys(parsed)).toEqual(["action_pose"]);
    expect(parsed.action_pose).toEqual({ r2Key: "vq/characters/X/approved/action_pose.png", candidateId: 12, approvedAt: "2026-07-10T00:00:00.000Z", identityScore: 88 });
  });
  it("never contains a sibling type — a concurrent approve of another type can't be clobbered", () => {
    const parsed = JSON.parse(referencePackMergeJson("master_portrait", "k", null, null, "t"));
    expect(parsed).not.toHaveProperty("action_pose");
    expect(parsed.master_portrait.candidateId).toBeNull();
    expect(parsed.master_portrait.identityScore).toBeNull();
  });
});

describe("vqChargedCredits — honest spend counter (FE-03 / PROV-05)", () => {
  it("counts auto-rejected and bg-rejected images (all were billed)", () => {
    // 1 kept + 1 identity-reject + 1 bg-reject = 3 billed @ nano_banana(1) = 3
    const resp = { created: [{ model: "nano_banana" }], autoRejected: 1, bgRejected: 1 };
    expect(vqChargedCredits(resp, "z_image")).toBe(3);
  });
  it("uses the model the server actually used (ref upgrade), not the requested one", () => {
    // requested z_image(0.15) but server upgraded to nano_banana(1) for references
    const resp = { created: [{ model: "nano_banana" }], autoRejected: 0, bgRejected: 0 };
    expect(vqChargedCredits(resp, "z_image")).toBe(1);
  });
  it("falls back to the requested model when nothing was created (all rejected)", () => {
    const resp = { created: [], autoRejected: 2, bgRejected: 1 };
    expect(vqChargedCredits(resp, "nano_banana")).toBe(3); // 3 billed @ 1
  });
  it("handles a missing created array", () => {
    expect(vqChargedCredits({ autoRejected: 0, bgRejected: 0 }, "z_image")).toBe(0);
  });
});

// ── Phase 5 — storage-layer hardening ───────────────────────────────────────

describe("assertVqWriteKey — write-key isolation (unchanged after lib/vq-keys extraction)", () => {
  it("accepts keys inside the VQ write prefixes", () => {
    expect(assertVqWriteKey("vq/art/GNV-001/main.png")).toBe("vq/art/GNV-001/main.png");
    expect(assertVqWriteKey("vq/characters/GNV-F03-S2/approved/master_portrait.png")).toContain("vq/characters/");
    expect(assertVqWriteKey("vq/art-candidates/GNV-001/123-abc.png")).toContain("vq/art-candidates/");
  });
  it("blocks grading/customer prefixes and traversal", () => {
    expect(() => assertVqWriteKey("images/MV1/front.jpg")).toThrow(/blocked R2 write/);
    expect(() => assertVqWriteKey("labels/MV5/both.pdf")).toThrow();
    expect(() => assertVqWriteKey("vq/art/../images/MV1/front.png")).toThrow();
    expect(() => assertVqWriteKey("/vq/art/GNV-001/main.png")).toThrow();
    expect(() => assertVqWriteKey("vq/art\\GNV-001\\main.png")).toThrow();
  });
});

describe("assertVqReadKey — read-key isolation (R1-KEY-01)", () => {
  it("accepts any key inside the vq/ keyspace", () => {
    expect(assertVqReadKey("vq/art/GNV-001/main.png")).toBe("vq/art/GNV-001/main.png");
    expect(assertVqReadKey("vq/characters/X/candidates/1-2.png")).toContain("vq/characters/");
  });
  it("blocks traversal out of vq/ into grading/customer objects (shared bucket)", () => {
    expect(() => assertVqReadKey("vq/art/../../images/MV1/front.jpg")).toThrow(/blocked R2 read/);
    expect(() => assertVqReadKey("vq/art-candidates/GNV-001/../../images/MV1/front.png")).toThrow();
  });
  it("blocks non-vq prefixes, leading slash, backslash and control chars", () => {
    expect(() => assertVqReadKey("images/MV1/front.jpg")).toThrow();
    expect(() => assertVqReadKey("/vq/art/GNV-001/main.png")).toThrow();
    expect(() => assertVqReadKey("vq/art\\x")).toThrow();
    expect(() => assertVqReadKey("vq/art/\x00/x.png")).toThrow();
  });
});

describe("isCandidateKeyForCard — rejects path traversal (R1-KEY-02)", () => {
  it("accepts a legitimate candidate key for the card", () => {
    expect(isCandidateKeyForCard("vq/art-candidates/GNV-001/123-abc.png", "GNV-001")).toBe(true);
  });
  it("rejects a `..` escape even though the prefix and char-class would match", () => {
    // The regex permits `.` and `/`, so without the explicit `..` guard this key
    // (prefix-valid, regex-valid) would read a customer scan under a normalising layer.
    expect(isCandidateKeyForCard("vq/art-candidates/GNV-001/../../images/MV1/front.png", "GNV-001")).toBe(false);
  });
  it("rejects a candidate key that belongs to a different card", () => {
    expect(isCandidateKeyForCard("vq/art-candidates/GNV-002/123-abc.png", "GNV-001")).toBe(false);
  });
});

describe("validVqCardId — rejects `..` traversal ids (R1-KEY-05)", () => {
  it("accepts real card and character ids", () => {
    expect(validVqCardId("GNV-001")).toBe(true);
    expect(validVqCardId("GNV-F03-S2")).toBe(true);
  });
  it("rejects ids containing `..` or that would escape a derived key", () => {
    expect(validVqCardId("a..b")).toBe(false);
    expect(validVqCardId("GNV-../x")).toBe(false);
  });
  it("still rejects empty and out-of-class ids", () => {
    expect(validVqCardId("")).toBe(false);
    expect(validVqCardId("../etc")).toBe(false);
    expect(validVqCardId("a b")).toBe(false);
  });
});

describe("sanitizeWrite — rejects cross-system R2 keys on production columns (R1-KEY-03)", () => {
  it("throws when an R2-key column is set to a grading/customer key", () => {
    expect(() => sanitizeWrite({ fileR2Key: "images/MV1/front.jpg" })).toThrow(/vq\//);
    expect(() => sanitizeWrite({ artworkR2Key: "labels/MV5/both.pdf" })).toThrow();
    expect(() => sanitizeWrite({ setLogoR2Key: "certificates/MV1.pdf" })).toThrow();
  });
  it("allows a valid vq/ key and treats blank/undefined as clearing the field", () => {
    expect(sanitizeWrite({ fileR2Key: "vq/art/GNV-001/main.png" }).fileR2Key).toBe("vq/art/GNV-001/main.png");
    expect(sanitizeWrite({ artworkR2Key: "" }).artworkR2Key).toBe("");
    expect(sanitizeWrite({ mockupR2Key: "  " }).mockupR2Key).toBe("  ");
    expect(sanitizeWrite({ printPdfR2Key: null }).printPdfR2Key).toBeNull();
  });
});

describe("validateArtwork — dimension/pixel ceiling (R2-UP-01)", () => {
  const mkPng = (w: number, h: number) =>
    sharp({ create: { width: w, height: h, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();

  it("accepts a normal in-range image", async () => {
    const r = await validateArtwork(await mkPng(256, 256));
    expect(r.ok).toBe(true);
    expect(r.format).toBe("png");
  });
  it("rejects an image whose side exceeds the max dimension (decompression-bomb guard)", async () => {
    // 8193×64 is tiny in memory but its declared width is over the 8192px ceiling.
    const r = await validateArtwork(await mkPng(8193, 64));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/too large/);
  });
  it("still rejects too-small and non-image inputs", async () => {
    expect((await validateArtwork(await mkPng(32, 32))).ok).toBe(false);
    expect((await validateArtwork(Buffer.from("not an image"))).ok).toBe(false);
  });
});
