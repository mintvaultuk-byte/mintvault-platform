/**
 * Phase 13 guard: the AI rarity-suggestion surface is a CONTRACT ONLY.
 * It must make zero provider calls and consume zero credits (tests 42-43).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { suggestRarityFromImage } from "@shared/rarity-ai-suggestion";

describe("rarity AI suggestion is a no-op contract (no provider, no credits)", () => {
  it("always returns null (no automatic suggestion)", () => {
    expect(suggestRarityFromImage({ certId: "MV1", frontImageKey: "images/MV1/front.jpg" })).toBeNull();
    expect(suggestRarityFromImage({})).toBeNull();
  });

  it("the module imports no provider/network client and issues no fetch", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "shared/rarity-ai-suggestion.ts"), "utf8");
    expect(src).not.toMatch(/anthropic|higgsfield|openai|fetch\(|axios|https?:\/\//i);
  });
});
