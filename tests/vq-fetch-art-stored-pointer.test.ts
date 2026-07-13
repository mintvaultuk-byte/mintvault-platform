/**
 * Phase 10A-6 (R5-F1) — the core reader fix, isolated: fetchArt must resolve the
 * STORED pointer value, never re-derive vqArtKey(cardId, slot). This is also the
 * read-only regression proof that existing (legacy, pre-revision) cards keep
 * displaying the exact same artwork before and after this change — the flat key
 * that was always in the column is exactly what gets read, unchanged.
 *
 * Each test uses bounded, single-shot mocks (mockResolvedValueOnce/
 * mockImplementationOnce) matched exactly to the number of R2 reads fetchArt
 * performs for that input — precise per-call assertions, and no open-ended
 * mockResolvedValue/mockImplementation left active across test boundaries.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getR2BufferMock = vi.hoisted(() => vi.fn());
vi.mock("../server/r2", () => ({ getR2Buffer: getR2BufferMock }));

import { fetchArt, vqArtKey } from "../server/vault-quest/render-saved";

beforeEach(() => getR2BufferMock.mockReset());

describe("fetchArt — resolves the STORED pointer, never re-derives (R5-F1)", () => {
  it("LEGACY record: artR2Key already holds the old flat key — read EXACTLY that key (regression proof)", async () => {
    const legacyKey = vqArtKey("GNV-001", "main"); // what every pre-revision record already stores
    getR2BufferMock.mockResolvedValueOnce(Buffer.from("legacy-bytes"));
    const result = await fetchArt({ cardId: "GNV-001", artR2Key: legacyKey });
    expect(getR2BufferMock).toHaveBeenCalledTimes(1);
    expect(getR2BufferMock).toHaveBeenCalledWith(legacyKey); // same key as before this change
    expect(result.mainArt?.toString()).toBe("legacy-bytes");
  });

  it("REVISIONED record: artR2Key holds an immutable versioned key — read THAT key, not the re-derived flat path", async () => {
    const revisionedKey = "vq/art/GNV-002/main/9f6c2e10-uuid.png";
    getR2BufferMock.mockResolvedValueOnce(Buffer.from("revisioned-bytes"));
    const result = await fetchArt({ cardId: "GNV-002", artR2Key: revisionedKey });
    expect(getR2BufferMock).toHaveBeenCalledTimes(1);
    expect(getR2BufferMock).toHaveBeenCalledWith(revisionedKey);
    expect(getR2BufferMock).not.toHaveBeenCalledWith(vqArtKey("GNV-002", "main")); // THE bug this fixes
    expect(result.mainArt?.toString()).toBe("revisioned-bytes");
  });

  it("prev slot: same fix applies independently", async () => {
    const revisionedPrevKey = "vq/art/GNV-003/prev/abc-uuid.png";
    getR2BufferMock.mockResolvedValueOnce(Buffer.from("prev-bytes"));
    const result = await fetchArt({ cardId: "GNV-003", prevArtR2Key: revisionedPrevKey });
    expect(getR2BufferMock).toHaveBeenCalledTimes(1);
    expect(getR2BufferMock).toHaveBeenCalledWith(revisionedPrevKey);
    expect(result.prevArt?.toString()).toBe("prev-bytes");
  });

  it("no artR2Key at all → no R2 call for that slot (art-less card costs 0 R2 calls, unchanged behavior)", async () => {
    const result = await fetchArt({ cardId: "GNV-004" });
    expect(getR2BufferMock).not.toHaveBeenCalled();
    expect(result.mainArt).toBeUndefined();
    expect(result.prevArt).toBeUndefined();
  });

  it("main and prev resolve completely independently (mixed legacy + revisioned on the same card)", async () => {
    getR2BufferMock.mockImplementationOnce(async (key: string) => Buffer.from(key));
    getR2BufferMock.mockImplementationOnce(async (key: string) => Buffer.from(key));
    const result = await fetchArt({
      cardId: "GNV-006",
      artR2Key: "vq/art/GNV-006/main.png", // legacy, untouched
      prevArtR2Key: "vq/art/GNV-006/prev/new-uuid.png", // revisioned
    });
    expect(getR2BufferMock).toHaveBeenCalledTimes(2);
    expect(result.mainArt?.toString()).toBe("vq/art/GNV-006/main.png");
    expect(result.prevArt?.toString()).toBe("vq/art/GNV-006/prev/new-uuid.png");
  });

  it("a valid candidate key for THIS card still takes priority over the stored pointer (re-roll preview)", async () => {
    const candidateKey = `vq/art-candidates/GNV-005/${Date.now()}-abc.png`;
    getR2BufferMock.mockResolvedValueOnce(Buffer.from("candidate-bytes"));
    const result = await fetchArt({ cardId: "GNV-005", artR2Key: "vq/art/GNV-005/main/old-uuid.png", artCandidateKey: candidateKey });
    expect(getR2BufferMock).toHaveBeenCalledTimes(1);
    expect(getR2BufferMock).toHaveBeenCalledWith(candidateKey);
    expect(result.mainArt?.toString()).toBe("candidate-bytes");
  });
});
