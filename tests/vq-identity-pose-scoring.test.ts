/**
 * scoreCharacterIdentity's pose-diversity extension (Action Reference fix).
 * Mocks anthropicFetch so this never makes a real network call — proves:
 *   - no masterPng supplied → no poseDiversity field at all (master_portrait,
 *     face_closeup, colour_sheet, turnaround_sheet generations are UNAFFECTED)
 *   - masterPng supplied + vision reports a low poseDifference → verdict fail
 *   - masterPng supplied + vision reports a high poseDifference → verdict pass
 *   - the identity score/breakdown are computed independently of poseDifference
 *     in both directions (a failed pose doesn't drag down identity, and a
 *     failed identity doesn't drag down pose)
 *   - the vision prompt sent only asks for/labels a "MASTER REFERENCE" and a
 *     poseDifference field when masterPng is actually supplied
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const anthropicFetchMock = vi.hoisted(() => vi.fn());
vi.mock("../server/anthropic-fetch", () => ({ anthropicFetch: anthropicFetchMock }));

import { scoreCharacterIdentity } from "../server/vault-quest/ai/identity";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const CHARACTER = { characterName: "Testmander", bodyShape: "lizard", colours: "green/orange", markings: "flame tail tip", eyes: "amber", tailAccessories: "none", stageNumber: 1, element: "Flame" };

function mockAnthropicResponse(json: Record<string, unknown>) {
  anthropicFetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ content: [{ text: JSON.stringify(json) }] }),
  } as Response);
}

describe("scoreCharacterIdentity — pose-diversity extension", () => {
  const OLD_KEY = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => {
    anthropicFetchMock.mockClear();
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  });

  it("NO masterPng supplied → poseDiversity is absent (master/face/colour/turnaround generations unaffected)", async () => {
    mockAnthropicResponse({ bodyShape: 95, colours: 95, markings: 95, eyes: 95, silhouette: 95, accessories: 95, familyTraits: 95, stageTraits: 95, overall: 95, notes: "great match" });
    const result = await scoreCharacterIdentity(TINY_PNG, [TINY_PNG], CHARACTER);
    expect(result).not.toBeNull();
    expect(result?.poseDiversity).toBeUndefined();
    expect(result?.verdict).toBe("pass");

    // The prompt sent must NOT mention the master-reference pose-comparison framing
    const sentBody = anthropicFetchMock.mock.calls[0][0] as { messages: { content: { type: string; text?: string }[] }[] };
    const textParts = sentBody.messages[0].content.filter((c) => c.type === "text").map((c) => c.text ?? "").join(" ");
    expect(textParts).not.toMatch(/MASTER REFERENCE/);
    expect(textParts).not.toMatch(/poseDifference/);
  });

  it("masterPng supplied + LOW poseDifference reported → poseDiversity verdict FAILS", async () => {
    mockAnthropicResponse({ bodyShape: 98, colours: 98, markings: 98, eyes: 98, silhouette: 98, accessories: 98, familyTraits: 98, stageTraits: 98, overall: 98, poseDifference: 12, notes: "near-identical stance to the master" });
    const result = await scoreCharacterIdentity(TINY_PNG, [TINY_PNG], CHARACTER, { masterPng: TINY_PNG });
    expect(result?.verdict).toBe("pass"); // identity itself is fine
    expect(result?.poseDiversity?.verdict).toBe("fail"); // but the pose is a near-duplicate — independent gate fails
    expect(result?.poseDiversity?.difference).toBe(12);
  });

  it("masterPng supplied + HIGH poseDifference reported → poseDiversity verdict PASSES", async () => {
    mockAnthropicResponse({ bodyShape: 92, colours: 90, markings: 91, eyes: 93, silhouette: 88, accessories: 90, familyTraits: 92, stageTraits: 90, overall: 91, poseDifference: 82, notes: "dynamic leaping action pose, same creature" });
    const result = await scoreCharacterIdentity(TINY_PNG, [TINY_PNG], CHARACTER, { masterPng: TINY_PNG });
    expect(result?.verdict).toBe("pass");
    expect(result?.poseDiversity?.verdict).toBe("pass");
    expect(result?.poseDiversity?.difference).toBe(82);

    // The prompt DOES reference the master-comparison framing this time
    const sentBody = anthropicFetchMock.mock.calls[0][0] as { messages: { content: { type: string; text?: string }[] }[] };
    const textParts = sentBody.messages[0].content.filter((c) => c.type === "text").map((c) => c.text ?? "").join(" ");
    expect(textParts).toMatch(/MASTER REFERENCE/);
    expect(textParts).toMatch(/poseDifference/);
  });

  it("independence: a FAILED identity score with a PASSING pose still reports both independently", async () => {
    mockAnthropicResponse({ bodyShape: 40, colours: 35, markings: 30, eyes: 45, silhouette: 40, accessories: 50, familyTraits: 40, stageTraits: 45, overall: 40, poseDifference: 88, notes: "looks like a different creature entirely, but definitely a dynamic pose" });
    const result = await scoreCharacterIdentity(TINY_PNG, [TINY_PNG], CHARACTER, { masterPng: TINY_PNG });
    expect(result?.verdict).toBe("reject"); // identity fails (below the 70 default threshold)
    expect(result?.poseDiversity?.verdict).toBe("pass"); // pose gate is independent — still passes on its own
  });

  it("scorer unavailable (no API key) still returns null regardless of masterPng — fail-open preserved", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const result = await scoreCharacterIdentity(TINY_PNG, [TINY_PNG], CHARACTER, { masterPng: TINY_PNG });
    expect(result).toBeNull();
    expect(anthropicFetchMock).not.toHaveBeenCalled();
    process.env.ANTHROPIC_API_KEY = OLD_KEY;
  });
});
