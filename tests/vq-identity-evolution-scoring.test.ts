/**
 * scoreCharacterIdentity's evolution-difference extension (Stage 2/3 differentiation
 * fix). Mocks anthropicFetch so this never makes a real network call — proves:
 *   - no evolutionPrevPng supplied → no evolutionDifference field at all (existing
 *     identity / pose-diversity callers are completely unaffected)
 *   - evolutionPrevPng supplied + vision reports a LOW evolutionDifference → verdict fail
 *   - evolutionPrevPng supplied + vision reports a HIGH evolutionDifference → verdict pass
 *   - the identity score/breakdown are computed independently of evolutionDifference in
 *     both directions (a failed evolution-difference doesn't drag down identity, and a
 *     failed identity doesn't drag down evolution-difference)
 *   - masterPng (pose-diversity) and evolutionPrevPng (evolution-difference) can both be
 *     supplied at once without interfering with each other (mutually exclusive in
 *     practice — action_pose vs master_portrait — but the function itself must not
 *     assume that)
 *   - the vision prompt sent only asks for/labels a "PREVIOUS EVOLUTION STAGE" and an
 *     evolutionDifference field when evolutionPrevPng is actually supplied
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const anthropicFetchMock = vi.hoisted(() => vi.fn());
vi.mock("../server/anthropic-fetch", () => ({ anthropicFetch: anthropicFetchMock }));

import { scoreCharacterIdentity } from "../server/vault-quest/ai/identity";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const CHARACTER = { characterName: "Flammro", bodyShape: "quadrupedal", colours: "ember orange", markings: "flame tuft", eyes: "amber", tailAccessories: "fire tail", stageNumber: 2, element: "Flame" };

function mockAnthropicResponse(json: Record<string, unknown>) {
  anthropicFetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ content: [{ text: JSON.stringify(json) }] }),
  } as Response);
}

describe("scoreCharacterIdentity — evolution-difference extension", () => {
  const OLD_KEY = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => {
    anthropicFetchMock.mockClear();
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  });

  it("NO evolutionPrevPng supplied → evolutionDifference is absent (existing identity/pose-diversity callers unaffected)", async () => {
    mockAnthropicResponse({ bodyShape: 95, colours: 95, markings: 95, eyes: 95, silhouette: 95, accessories: 95, familyTraits: 95, stageTraits: 95, overall: 95, notes: "great match" });
    const result = await scoreCharacterIdentity(TINY_PNG, [TINY_PNG], CHARACTER);
    expect(result).not.toBeNull();
    expect(result?.evolutionDifference).toBeUndefined();
    expect(result?.verdict).toBe("pass");

    const sentBody = anthropicFetchMock.mock.calls[0][0] as { messages: { content: { type: string; text?: string }[] }[] };
    const textParts = sentBody.messages[0].content.filter((c) => c.type === "text").map((c) => c.text ?? "").join(" ");
    expect(textParts).not.toMatch(/PREVIOUS EVOLUTION STAGE/);
    expect(textParts).not.toMatch(/evolutionDifference/);
  });

  it("evolutionPrevPng supplied + LOW evolutionDifference reported → verdict FAILS", async () => {
    mockAnthropicResponse({ bodyShape: 90, colours: 92, markings: 88, eyes: 91, silhouette: 85, accessories: 89, familyTraits: 90, stageTraits: 60, overall: 88, evolutionDifference: 15, notes: "near-identical form to the previous stage, only a minor tail change" });
    const result = await scoreCharacterIdentity(TINY_PNG, [TINY_PNG], CHARACTER, { evolutionPrevPng: TINY_PNG });
    expect(result?.verdict).toBe("pass"); // identity itself is fine
    expect(result?.evolutionDifference?.verdict).toBe("fail"); // but barely evolved from the previous stage — independent gate fails
    expect(result?.evolutionDifference?.difference).toBe(15);
    expect(result?.evolutionDifference?.stageNumber).toBe(2);
  });

  it("evolutionPrevPng supplied + HIGH evolutionDifference reported → verdict PASSES", async () => {
    mockAnthropicResponse({ bodyShape: 88, colours: 90, markings: 87, eyes: 89, silhouette: 80, accessories: 85, familyTraits: 91, stageTraits: 88, overall: 87, evolutionDifference: 82, notes: "substantially larger body, clearly different silhouette, developed horns" });
    const result = await scoreCharacterIdentity(TINY_PNG, [TINY_PNG], CHARACTER, { evolutionPrevPng: TINY_PNG });
    expect(result?.verdict).toBe("pass");
    expect(result?.evolutionDifference?.verdict).toBe("pass");
    expect(result?.evolutionDifference?.difference).toBe(82);

    const sentBody = anthropicFetchMock.mock.calls[0][0] as { messages: { content: { type: string; text?: string }[] }[] };
    const textParts = sentBody.messages[0].content.filter((c) => c.type === "text").map((c) => c.text ?? "").join(" ");
    expect(textParts).toMatch(/PREVIOUS EVOLUTION STAGE/);
    expect(textParts).toMatch(/evolutionDifference/);
  });

  it("independence: a FAILED identity score with a PASSING evolution-difference still reports both independently", async () => {
    mockAnthropicResponse({ bodyShape: 35, colours: 30, markings: 25, eyes: 40, silhouette: 45, accessories: 40, familyTraits: 35, stageTraits: 50, overall: 38, evolutionDifference: 88, notes: "wrong colour palette entirely, but clearly a much larger and more developed form" });
    const result = await scoreCharacterIdentity(TINY_PNG, [TINY_PNG], CHARACTER, { evolutionPrevPng: TINY_PNG });
    expect(result?.verdict).toBe("reject"); // identity fails (below the 70 default threshold)
    expect(result?.evolutionDifference?.verdict).toBe("pass"); // evolution gate is independent — still passes on its own
  });

  it("stage 3 uses the stricter stage-3 threshold via the character's own stageNumber", async () => {
    mockAnthropicResponse({ bodyShape: 90, colours: 92, markings: 90, eyes: 91, silhouette: 88, accessories: 89, familyTraits: 90, stageTraits: 92, overall: 90, evolutionDifference: 58, notes: "developed, but not the strongest leap" });
    const result = await scoreCharacterIdentity(TINY_PNG, [TINY_PNG], { ...CHARACTER, stageNumber: 3 }, { evolutionPrevPng: TINY_PNG });
    expect(result?.evolutionDifference?.threshold).toBe(60);
    expect(result?.evolutionDifference?.verdict).toBe("fail"); // 58 clears stage 2's 55 but not stage 3's 60
  });

  it("masterPng (pose-diversity) and evolutionPrevPng (evolution-difference) can both be supplied without interfering", async () => {
    mockAnthropicResponse({ bodyShape: 90, colours: 91, markings: 89, eyes: 92, silhouette: 85, accessories: 88, familyTraits: 90, stageTraits: 87, overall: 89, poseDifference: 70, evolutionDifference: 75, notes: "both dynamic and evolved" });
    const result = await scoreCharacterIdentity(TINY_PNG, [TINY_PNG], CHARACTER, { masterPng: TINY_PNG, evolutionPrevPng: TINY_PNG });
    expect(result?.poseDiversity?.verdict).toBe("pass");
    expect(result?.evolutionDifference?.verdict).toBe("pass");
  });

  it("scorer unavailable (no API key) still returns null regardless of evolutionPrevPng — fail-open preserved", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const result = await scoreCharacterIdentity(TINY_PNG, [TINY_PNG], CHARACTER, { evolutionPrevPng: TINY_PNG });
    expect(result).toBeNull();
    expect(anthropicFetchMock).not.toHaveBeenCalled();
    process.env.ANTHROPIC_API_KEY = OLD_KEY;
  });
});
