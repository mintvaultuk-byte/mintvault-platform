/**
 * Card identification — shared contract, KE validation, spend gate, and the full
 * pipeline with a MOCK provider + stub set lookup (ZERO real calls, ZERO credits).
 * Covers contract (17-21), knowledge validation (22-30), spend (9-16 pure parts).
 */
import { describe, it, expect } from "vitest";
import {
  resolveRarityGuess,
  resolveFinishGuess,
  resolvePromoGuess,
  symbolMatchesRarity,
  buildRarityField,
  bandFromScore,
  evidenceSummary,
  mockCardObservation,
  rarityByValue,
  type CardCandidate,
} from "../shared/card-identification";
import { runIdentificationPipeline, type SetLookup } from "../server/lib/card-identification/pipeline";
import { mockVisionProvider, unavailableProvider, ProviderUnavailableError, selectProvider, IDENTIFY_MODEL } from "../server/lib/card-identification/provider";
import { spendDecision, DEFAULT_IDENTIFY_CEILINGS, IDENTIFY_COST_ESTIMATE_USD } from "../server/lib/card-identification/spend";

const noSets: SetLookup = async () => [];
const oneSet = (c: Partial<CardCandidate>): SetLookup => async () => [{ setId: "sv8", setName: "Surging Sparks", setCode: "sv8", collectorNumber: null, language: "en", era: "sv", reason: "test", ...c }];

describe("contract: AI guess → canonical resolution", () => {
  it("resolves rarity codes + aliases to canonical values", () => {
    expect(resolveRarityGuess("SIR")?.value).toBe("special_illustration_rare");
    expect(resolveRarityGuess("two gold stars")?.value).toBe("special_illustration_rare");
    expect(resolveRarityGuess("Ultra Rare")?.value).toBe("ultra_rare");
    expect(resolveRarityGuess("nonsense")).toBeNull();
  });
  it("resolves finishes + promos/subsets separately", () => {
    expect(resolveFinishGuess("reverse holo")).toBe("reverse_holo");
    expect(resolvePromoGuess("black star promo")).toMatchObject({ value: "black_star_promo", kind: "promo" });
    expect(resolvePromoGuess("trainer gallery")).toMatchObject({ value: "trainer_gallery", kind: "subset" });
  });
  it("bandFromScore + evidence summary are bounded (no chain-of-thought)", () => {
    expect(bandFromScore(0.9)).toBe("high");
    expect(bandFromScore(0.6)).toBe("medium");
    expect(bandFromScore(0)).toBe("unknown");
    expect(evidenceSummary("ocr_text", "x".repeat(500)).summary.length).toBeLessThanOrEqual(140);
  });
});

describe("symbol/rarity anti-hallucination (Phase 5/7)", () => {
  it("flags a gold-star rarity claimed with SILVER stars as a conflict", () => {
    const sir = rarityByValue("special_illustration_rare")!; // ★★ gold
    expect(symbolMatchesRarity(sir, "silver", 2)).toBe(false);
    expect(symbolMatchesRarity(sir, "gold", 2)).toBe(true);
    expect(symbolMatchesRarity(sir, null, null)).toBeNull();
  });
  it("buildRarityField marks region/era/symbol conflicts", () => {
    // Double Rare is western + sv only.
    const wrongRegion = buildRarityField("Double Rare", "black", 2, "japan", "sv");
    expect(wrongRegion.rarityCode.validationStatus).toBe("conflict");
    expect(wrongRegion.rarityCode.confidence).toBe("conflict");
    const ok = buildRarityField("Double Rare", "black", 2, "western", "sv");
    expect(ok.rarityCode.validationStatus).toBe("validated");
    expect(ok.colour).toBe("black");
    expect(ok.count).toBe(2);
  });
});

describe("provider selection (Phase 11) — never a real call without a key", () => {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  it("selectProvider returns the unavailable provider when no key is set", () => {
    delete process.env.ANTHROPIC_API_KEY;
    const p = selectProvider();
    expect(p.name).toBe("none");
    expect(p.spends).toBe(false);
    if (savedKey) process.env.ANTHROPIC_API_KEY = savedKey;
  });
  it("the unavailable provider throws instead of spending", async () => {
    await expect(unavailableProvider.identify({ frontBase64: "x", frontMediaType: "image/jpeg" })).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
  it("the mock provider spends nothing and reports zero cost", async () => {
    const p = mockVisionProvider(mockCardObservation({ rarityGuess: "SIR" }));
    expect(p.spends).toBe(false);
    const r = await p.identify({ frontBase64: "x", frontMediaType: "image/jpeg" });
    expect(r.actualCostUsd).toBe(0);
  });
});

describe("pipeline (mock provider + stub lookup) — validated suggestion", () => {
  it("assembles a structured suggestion; needsHumanReview is ALWAYS true; unknown fields null", async () => {
    const provider = mockVisionProvider(
      mockCardObservation({ cardName: "Pikachu ex", collectorNumberText: "176/191", setCodeGuess: "SV8", rarityGuess: "Special Illustration Rare", printedSymbolColourGuess: "gold", printedSymbolCountGuess: 2, languageGuess: "English" }),
    );
    const s = await runIdentificationPipeline({
      requestId: "r1", provider, vision: { frontBase64: "x", frontMediaType: "image/jpeg" }, setLookup: oneSet({}), frontChecksum: "fc", backChecksum: null, providerCostEstimate: 0.02,
    });
    expect(s.needsHumanReview).toBe(true);
    expect(s.contractVersion).toBe("v1");
    expect(s.collectorNumber.value).toBe("176");
    expect(s.collectorNumberTotal.value).toBe("191");
    expect(s.setId.value).toBe("sv8");
    expect(s.rarityCode.value).toBe("special_illustration_rare");
    expect(s.printedSymbolColour.value).toBe("gold");
    expect(s.overallConfidence).not.toBe("conflict");
    // A field the model didn't see stays unknown/null.
    expect(s.promoType.value).toBeNull();
    expect(s.promoType.confidence).toBe("unknown");
  });

  it("surfaces a symbol conflict and blocks high overall confidence", async () => {
    const provider = mockVisionProvider(mockCardObservation({ rarityGuess: "Special Illustration Rare", printedSymbolColourGuess: "silver", printedSymbolCountGuess: 2, languageGuess: "English" }));
    const s = await runIdentificationPipeline({ requestId: "r2", provider, vision: { frontBase64: "x", frontMediaType: "image/jpeg" }, setLookup: noSets, frontChecksum: null, backChecksum: null, providerCostEstimate: 0.02 });
    expect(s.rarityCode.validationStatus).toBe("conflict");
    expect(s.overallConfidence).toBe("conflict");
    expect(s.knowledgeValidation.conflicts.length).toBeGreaterThan(0);
  });

  it("derives subset from TG/GG collector number deterministically", async () => {
    const provider = mockVisionProvider(mockCardObservation({ collectorNumberText: "TG12/TG30", languageGuess: "English" }));
    const s = await runIdentificationPipeline({ requestId: "r3", provider, vision: { frontBase64: "x", frontMediaType: "image/jpeg" }, setLookup: noSets, frontChecksum: null, backChecksum: null, providerCostEstimate: 0.02 });
    expect(s.subsetName.value).toBe("trainer_gallery");
    expect(s.subsetName.source).toBe("deterministic");
  });

  it("marks reflective/textured finishes as requiring physical inspection", async () => {
    const provider = mockVisionProvider(mockCardObservation({ finishGuess: "reverse holo", languageGuess: "English" }));
    const s = await runIdentificationPipeline({ requestId: "r4", provider, vision: { frontBase64: "x", frontMediaType: "image/jpeg" }, setLookup: noSets, frontChecksum: null, backChecksum: null, providerCostEstimate: 0.02 });
    expect(s.finishVariant.value).toBe("reverse_holo");
    expect(s.finishVariant.finishConfirmation).toBe("requires_physical_inspection");
    expect(s.warnings.join(" ")).toMatch(/flat scan/i);
  });

  it("evidence is short and carries no chain-of-thought", async () => {
    const provider = mockVisionProvider(mockCardObservation({ rarityGuess: "SIR", evidenceNotes: ["saw two gold stars bottom-right"], languageGuess: "English" }));
    const s = await runIdentificationPipeline({ requestId: "r5", provider, vision: { frontBase64: "x", frontMediaType: "image/jpeg" }, setLookup: noSets, frontChecksum: null, backChecksum: null, providerCostEstimate: 0.02 });
    for (const e of s.evidence) expect(e.summary.length).toBeLessThanOrEqual(140);
    expect(JSON.stringify(s)).not.toMatch(/reasoning|chain.of.thought|because I|step 1/i);
  });
});

describe("spend gate (pure)", () => {
  it("allows under ceiling, refuses at daily/hourly limits, and when disabled", () => {
    expect(spendDecision({ callsToday: 0, callsThisHour: 0 }).allowed).toBe(true);
    expect(spendDecision({ callsToday: DEFAULT_IDENTIFY_CEILINGS.maxPerDay, callsThisHour: 0 })).toMatchObject({ allowed: false, reason: "daily_ceiling" });
    expect(spendDecision({ callsToday: 0, callsThisHour: DEFAULT_IDENTIFY_CEILINGS.maxPerHour })).toMatchObject({ allowed: false, reason: "hourly_limit" });
    expect(spendDecision({ callsToday: 0, callsThisHour: 0 }, { ...DEFAULT_IDENTIFY_CEILINGS, disabled: true })).toMatchObject({ allowed: false, reason: "disabled" });
    expect(spendDecision({ callsToday: 0, callsThisHour: 0 }).estimateUsd).toBe(IDENTIFY_COST_ESTIMATE_USD);
  });
});

describe("model choice is the cheap Haiku vision path", () => {
  it("uses claude-haiku-4-5", () => {
    expect(IDENTIFY_MODEL).toContain("haiku");
  });
});
