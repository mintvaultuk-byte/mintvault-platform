/**
 * Adversarial false-confidence + suggestion-only safety (Phases 1 + 4).
 * Feeds the pipeline deliberately-wrong/conflicting mock observations and proves
 * the Knowledge Engine catches them, Accept All excludes conflicts + overwrites,
 * low-confidence isn't preselected, unsupported values are never copied, and
 * human review stays mandatory. MOCK provider only — zero real calls.
 */
import { describe, it, expect } from "vitest";
import { runIdentificationPipeline, type SetLookup } from "../server/lib/card-identification/pipeline";
import { mockVisionProvider } from "../server/lib/card-identification/provider";
import { mockCardObservation, resolveRarityGuess, type RawAiCardObservation, type CardIdentificationSuggestionV1 } from "../shared/card-identification";
import { buildAcceptRows, acceptAllKeys, defaultSelected, fieldsToApply } from "../shared/card-identification-accept";

const noSets: SetLookup = async () => [];
const setWithCode = (code: string, era = "sv"): SetLookup => async () => [{ setId: code, setName: "Test Set", setCode: code, collectorNumber: null, language: "en", era, reason: "t" }];

async function run(obs: Partial<RawAiCardObservation>, setLookup: SetLookup = noSets): Promise<CardIdentificationSuggestionV1> {
  return runIdentificationPipeline({
    requestId: "adv", provider: mockVisionProvider(mockCardObservation({ languageGuess: "English", ...obs })),
    vision: { frontBase64: "x", frontMediaType: "image/jpeg" }, setLookup, frontChecksum: null, backChecksum: null, providerCostEstimate: 0.02,
  });
}

describe("false-confidence / hallucination (Phase 4)", () => {
  it("SIR claimed with SILVER stars → conflict, high confidence overridden", async () => {
    const s = await run({ rarityGuess: "Special Illustration Rare", printedSymbolColourGuess: "silver", printedSymbolCountGuess: 2, modelConfidence: 0.99 });
    expect(s.rarityCode.validationStatus).toBe("conflict");
    expect(s.overallConfidence).toBe("conflict");
  });
  it("Ultra Rare claimed with GOLD stars → conflict", async () => {
    const s = await run({ rarityGuess: "Ultra Rare", printedSymbolColourGuess: "gold", printedSymbolCountGuess: 2 });
    expect(s.rarityCode.validationStatus).toBe("conflict");
  });
  it("SAR/AR resolve region-appropriately: JP card → jp_* tier, western card → EN tier (not merged)", () => {
    // The 'SAR'/'AR' codes exist in both an EN and a JP tier — region disambiguates.
    expect(resolveRarityGuess("SAR", "japan")?.value).toBe("jp_special_art_rare");
    expect(resolveRarityGuess("SAR", "western")?.value).toBe("special_illustration_rare");
    expect(resolveRarityGuess("AR", "japan")?.value).toBe("jp_art_rare");
    expect(resolveRarityGuess("AR", "western")?.value).toBe("illustration_rare");
    // SIR is English-only and always the EN tier.
    expect(resolveRarityGuess("SIR")?.value).toBe("special_illustration_rare");
  });
  it("Trainer Gallery vs Galarian Gallery from the collector number", async () => {
    expect((await run({ collectorNumberText: "TG12/TG30" })).subsetName.value).toBe("trainer_gallery");
    expect((await run({ collectorNumberText: "GG35/GG70" })).subsetName.value).toBe("galarian_gallery");
  });
  it("Black Star Promo (promo) stays separate from an ordinary Rare (rarity)", async () => {
    const s = await run({ promoGuess: "black star promo", rarityGuess: "Rare" });
    expect(s.promoType.value).toBe("black_star_promo");
    expect(s.rarityCode.value).toBe("rare");
  });
  it("Poké Ball vs Master Ball reverse resolve distinctly + need physical check", async () => {
    const pb = await run({ finishGuess: "poke ball reverse" });
    const mb = await run({ finishGuess: "master ball reverse" });
    expect(pb.finishVariant.value).toBe("pokeball_reverse");
    expect(mb.finishVariant.value).toBe("masterball_reverse");
    expect(mb.finishVariant.finishConfirmation).toBe("requires_physical_inspection");
  });
  it("texture claimed from a flat scan is marked requires_physical_inspection", async () => {
    const s = await run({ finishGuess: "textured" });
    expect(s.finishVariant.finishConfirmation).toBe("requires_physical_inspection");
  });
  it("an unknown set code does not resolve a set (no invention)", async () => {
    const s = await run({ setCodeGuess: "zz999", setNameGuess: "Nonexistent" }, noSets);
    expect(s.setId.value).toBeNull();
    expect(s.knowledgeValidation.setResolved).toBe(false);
  });
  it("a printed code that mismatches the matched set is a conflict", async () => {
    // AI reads 'sv7' but the KE match is 'sv8' → setCode conflict.
    const s = await run({ setCodeGuess: "sv7" }, setWithCode("sv8"));
    expect(s.setCode.validationStatus).toBe("conflict");
    expect(s.knowledgeValidation.conflicts.join(" ")).toMatch(/doesn't match/i);
  });
  it("Simplified vs Traditional Chinese stays unresolved (unknown language + warning)", async () => {
    const s = await run({ languageGuess: "寶可夢", cardName: "寶可夢" });
    expect(s.language.value).toBeNull();
    expect(s.warnings.join(" ")).toMatch(/ambiguous/i);
  });
  it("unsupported custom rarity/finish values resolve to null (never invented)", async () => {
    const s = await run({ rarityGuess: "SUPER MEGA ULTRA RARE", finishGuess: "sparkly rainbow shimmer" });
    expect(s.rarityCode.value).toBeNull();
    expect(s.finishVariant.value).toBeNull();
  });
  it("needsHumanReview can never be false", async () => {
    const s = await run({ rarityGuess: "SIR", printedSymbolColourGuess: "gold", printedSymbolCountGuess: 2 });
    expect(s.needsHumanReview).toBe(true);
  });
});

describe("suggestion-only accept logic (Phase 1 / 14) — pure", () => {
  it("Accept All copies ONLY validated, non-conflicting, non-overwriting fields", async () => {
    const s = await run({ rarityGuess: "SIR", printedSymbolColourGuess: "silver", printedSymbolCountGuess: 2, collectorNumberText: "10/100", cardName: "Pikachu" });
    const rows = buildAcceptRows(s, {});
    const keys = acceptAllKeys(rows);
    expect(keys).not.toContain("rarityCode"); // conflict excluded
    expect(keys).toContain("cardNumber"); // clean deterministic value included
  });
  it("a conflict field + a low-confidence field are NOT preselected", async () => {
    const s = await run({ rarityGuess: "SIR", printedSymbolColourGuess: "silver", printedSymbolCountGuess: 2 });
    const rows = buildAcceptRows(s, {});
    const pre = defaultSelected(rows);
    expect(pre.rarityCode).toBe(false);
  });
  it("an existing form value is NOT in Accept All (needs explicit overwrite tick)", async () => {
    const s = await run({ cardName: "Charizard" });
    const rows = buildAcceptRows(s, { cardName: "Existing Name" });
    expect(acceptAllKeys(rows)).not.toContain("cardName");
    expect(rows.find((r) => r.formKey === "cardName")?.wouldOverwrite).toBe(true);
  });
  it("unknown fields are never rows (never copied)", async () => {
    const s = await run({ cardName: "Pikachu" }); // no rarity/finish/promo seen
    const rows = buildAcceptRows(s, {});
    expect(rows.some((r) => r.formKey === "rarityCode")).toBe(false);
    expect(rows.some((r) => r.formKey === "promoType")).toBe(false);
  });
  it("fieldsToApply returns only the chosen keys' values (draft copy, never a save)", async () => {
    const s = await run({ collectorNumberText: "10/100", cardName: "Pikachu" });
    const rows = buildAcceptRows(s, {});
    const applied = fieldsToApply(rows, ["cardNumber"]);
    expect(applied).toEqual({ cardNumber: "10" });
    expect(applied.cardName).toBeUndefined();
  });
});
