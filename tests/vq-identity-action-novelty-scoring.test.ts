/**
 * scoreCharacterIdentity's actionNovelty extension (Action Reference REPLACEMENT).
 * Mocks anthropicFetch so this never makes a real network call — proves:
 *   - no existingActionPng supplied → no actionNovelty field (existing callers unaffected)
 *   - existingActionPng + LOW actionDifference → actionNovelty verdict fail
 *   - existingActionPng + HIGH actionDifference → actionNovelty verdict pass
 *   - the actionNovelty score is independent of identity AND of poseDiversity: a pose
 *     can be very different from the Master (poseDiversity pass) yet nearly identical
 *     to the existing action (actionNovelty fail), reported side by side
 *   - the vision prompt only asks for/labels an "EXISTING APPROVED ACTION POSE" and an
 *     actionDifference field when existingActionPng is actually supplied
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const anthropicFetchMock = vi.hoisted(() => vi.fn());
vi.mock("../server/anthropic-fetch", () => ({ anthropicFetch: anthropicFetchMock }));

import { scoreCharacterIdentity } from "../server/vault-quest/ai/identity";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const CHARACTER = { characterName: "Flamora", bodyShape: "quadrupedal", colours: "ember orange", markings: "flame tuft", eyes: "amber", tailAccessories: "fire tail", stageNumber: 3, element: "Blaze" };

function mockAnthropicResponse(json: Record<string, unknown>) {
  anthropicFetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ content: [{ text: JSON.stringify(json) }] }),
  } as Response);
}

describe("scoreCharacterIdentity — actionNovelty (replacement) extension", () => {
  const OLD_KEY = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => {
    anthropicFetchMock.mockClear();
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
    delete process.env.VQ_ACTION_REPLACEMENT_DIFF_MIN; // default 65
  });

  it("NO existingActionPng → actionNovelty is absent; prompt never mentions the existing action", async () => {
    mockAnthropicResponse({ bodyShape: 95, colours: 95, markings: 95, eyes: 95, silhouette: 95, accessories: 95, familyTraits: 95, stageTraits: 95, overall: 95, poseDifference: 80, notes: "ok" });
    const result = await scoreCharacterIdentity(TINY_PNG, [TINY_PNG], CHARACTER, { masterPng: TINY_PNG });
    expect(result?.poseDiversity?.verdict).toBe("pass");
    expect(result?.actionNovelty).toBeUndefined();

    const sentBody = anthropicFetchMock.mock.calls[0][0] as { messages: { content: { type: string; text?: string }[] }[] };
    const textParts = sentBody.messages[0].content.filter((c) => c.type === "text").map((c) => c.text ?? "").join(" ");
    expect(textParts).not.toMatch(/EXISTING APPROVED ACTION POSE/);
    expect(textParts).not.toMatch(/actionDifference/);
  });

  it("existingActionPng + LOW actionDifference → actionNovelty FAILS", async () => {
    mockAnthropicResponse({ bodyShape: 92, colours: 92, markings: 92, eyes: 92, silhouette: 88, accessories: 90, familyTraits: 92, stageTraits: 90, overall: 91, poseDifference: 85, actionDifference: 20, notes: "same running pose as the existing action" });
    const result = await scoreCharacterIdentity(TINY_PNG, [TINY_PNG], CHARACTER, { masterPng: TINY_PNG, existingActionPng: TINY_PNG });
    expect(result?.verdict).toBe("pass"); // identity fine
    expect(result?.poseDiversity?.verdict).toBe("pass"); // clearly different from the neutral Master
    expect(result?.actionNovelty?.verdict).toBe("fail"); // but nearly identical to the EXISTING action
    expect(result?.actionNovelty?.difference).toBe(20);
    expect(result?.actionNovelty?.threshold).toBe(65);
  });

  it("existingActionPng + HIGH actionDifference → actionNovelty PASSES; prompt labels the existing action", async () => {
    mockAnthropicResponse({ bodyShape: 90, colours: 91, markings: 89, eyes: 92, silhouette: 84, accessories: 88, familyTraits: 90, stageTraits: 88, overall: 89, poseDifference: 80, actionDifference: 82, notes: "a clearly different roaring action" });
    const result = await scoreCharacterIdentity(TINY_PNG, [TINY_PNG], CHARACTER, { masterPng: TINY_PNG, existingActionPng: TINY_PNG });
    expect(result?.actionNovelty?.verdict).toBe("pass");
    expect(result?.actionNovelty?.difference).toBe(82);

    const sentBody = anthropicFetchMock.mock.calls[0][0] as { messages: { content: { type: string; text?: string }[] }[] };
    const textParts = sentBody.messages[0].content.filter((c) => c.type === "text").map((c) => c.text ?? "").join(" ");
    expect(textParts).toMatch(/EXISTING APPROVED ACTION POSE/);
    expect(textParts).toMatch(/actionDifference/);
  });

  it("independence: high poseDifference-from-Master but low actionDifference-from-existing are reported separately", async () => {
    mockAnthropicResponse({ bodyShape: 90, colours: 90, markings: 90, eyes: 90, silhouette: 85, accessories: 90, familyTraits: 90, stageTraits: 90, overall: 90, poseDifference: 90, actionDifference: 30, notes: "dynamic vs master, but same as existing action" });
    const result = await scoreCharacterIdentity(TINY_PNG, [TINY_PNG], CHARACTER, { masterPng: TINY_PNG, existingActionPng: TINY_PNG });
    expect(result?.poseDiversity?.verdict).toBe("pass"); // 90 ≥ 55
    expect(result?.actionNovelty?.verdict).toBe("fail"); // 30 < 65
  });

  it("scorer unavailable (no API key) returns null regardless of existingActionPng", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const result = await scoreCharacterIdentity(TINY_PNG, [TINY_PNG], CHARACTER, { masterPng: TINY_PNG, existingActionPng: TINY_PNG });
    expect(result).toBeNull();
    expect(anthropicFetchMock).not.toHaveBeenCalled();
    process.env.ANTHROPIC_API_KEY = OLD_KEY;
  });
});
