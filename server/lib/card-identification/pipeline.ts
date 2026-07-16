/**
 * Staged identification pipeline — deterministic first, AI second, Knowledge
 * Engine validation always. Produces a CardIdentificationSuggestionV1 with every
 * field tagged confidence + evidence + validation status. NOTHING is persisted
 * or applied here — the grader accepts/changes/rejects downstream.
 *
 * Provider + set lookup are INJECTED so the pipeline runs with zero real calls
 * and zero DB in tests. The route wires the real Anthropic provider + DB set
 * search; tests wire a mock provider + stub set lookup.
 */
import {
  type CardIdentificationSuggestionV1,
  type RawAiCardObservation,
  type CardCandidate,
  type SuggestedField,
  type ConfidenceBand,
  type KnowledgeValidationResult,
  type Evidence,
  emptyField,
  evidenceSummary,
  buildRarityField,
  resolveFinishGuess,
  resolvePromoGuess,
  finishByValue,
  promoByValue,
  languageByValueOrLabel,
} from "@shared/card-identification";
import {
  parseCollectorNumber,
  parseSetCode,
  parseYear,
  detectLanguage,
  eraFromRegulationMark,
} from "@shared/card-parse";
import type { CardIdVisionProvider, VisionInput } from "./provider";

/** Resolve candidate sets from the Knowledge Engine (injected: DB in prod, stub in tests). */
export type SetLookup = (query: { setCode: string | null; name: string | null }) => Promise<CardCandidate[]>;

export interface PipelineInput {
  requestId: string;
  provider: CardIdVisionProvider;
  vision: VisionInput;
  setLookup: SetLookup;
  frontChecksum: string | null;
  backChecksum: string | null;
  imageWarnings?: string[];
  providerCostEstimate: number | null;
}

const FLAT_SCAN_UNCERTAIN_FINISHES = new Set([
  "holo",
  "reverse_holo",
  "cosmos_holo",
  "cracked_ice_holo",
  "mirror_holo",
  "crosshatch_holo",
  "confetti_holo",
  "glitter_holo",
  "textured",
  "full_texture",
  "gold_foil",
  "silver_foil",
]);

function field<T>(value: T | null, band: ConfidenceBand, source: SuggestedField<T>["source"], evidence: Evidence[], status: SuggestedField<T>["validationStatus"] = value == null ? "unknown" : "unvalidated"): SuggestedField<T> {
  return { value, confidence: value == null ? "unknown" : band, source, evidence, validationStatus: value == null ? "unknown" : status };
}

const BAND_RANK: Record<ConfidenceBand, number> = { conflict: 0, unknown: 1, low: 2, medium: 3, high: 4 };
function worst(...bands: ConfidenceBand[]): ConfidenceBand {
  const present = bands.filter((b) => b !== "unknown");
  if (present.some((b) => b === "conflict")) return "conflict";
  if (present.length === 0) return "unknown";
  return present.reduce((a, b) => (BAND_RANK[a] <= BAND_RANK[b] ? a : b));
}

export async function runIdentificationPipeline(input: PipelineInput): Promise<CardIdentificationSuggestionV1> {
  const warnings = [...(input.imageWarnings ?? [])];

  // ── Provider call (the only spend; may throw ProviderUnavailableError) ──────
  const { observation, actualCostUsd } = await input.provider.identify(input.vision);
  const obs: RawAiCardObservation = observation;

  // ── Deterministic extraction (AI text is the source, parse is deterministic) ─
  const parsedNumber = parseCollectorNumber(obs.collectorNumberText);
  const parsedSetCode = parseSetCode(obs.setCodeGuess);
  const langText = [obs.languageGuess, obs.cardName, obs.visibleStampText].filter(Boolean).join(" ");
  const lang = detectLanguage(langText || obs.languageGuess);
  const resolvedLang = lang.language ?? languageByValueOrLabel(obs.languageGuess)?.value ?? null;
  const region = resolvedLang ? (languageByValueOrLabel(resolvedLang)?.region ?? null) : null;

  // ── Set resolution via Knowledge Engine ─────────────────────────────────────
  const candidates = await input.setLookup({ setCode: parsedSetCode, name: obs.setNameGuess ?? null });
  const topSet = candidates[0] ?? null;
  const setResolved = Boolean(topSet);
  const setCodeMatchesSet = parsedSetCode && topSet?.setCode ? parsedSetCode === topSet.setCode : parsedSetCode ? false : null;

  // Era from the resolved set is authoritative; else a regulation-mark hint.
  // (Set-era enrichment happens in setLookup, which may set candidate.era.)
  const effectiveEra = topSet?.era ?? eraFromRegulationMark(obs.regulationMark);

  // ── Rarity (validated vs catalogue: symbol match + region/era compat) ───────
  const rarityBuilt = buildRarityField(obs.rarityGuess, obs.printedSymbolColourGuess, obs.printedSymbolCountGuess ?? null, region, effectiveEra);

  // ── Finish (flat scan can't prove reflective/textured finishes) ─────────────
  const finishValue = resolveFinishGuess(obs.finishGuess);
  const finishConfirmation = finishValue
    ? FLAT_SCAN_UNCERTAIN_FINISHES.has(finishValue)
      ? "requires_physical_inspection"
      : "likely"
    : "unknown";
  const finishField: SuggestedField<string> & { finishConfirmation: typeof finishConfirmation } = {
    ...field(finishValue, finishValue ? "medium" : "unknown", finishValue ? "ai" : "none", finishValue ? [evidenceSummary("ai_visual_inference", `finish: ${obs.finishGuess}`)] : [], finishValue ? "validated" : "unknown"),
    finishConfirmation,
  };
  if (finishConfirmation === "requires_physical_inspection") {
    warnings.push(`Finish "${finishByValue(finishValue!)?.label}" can't be confirmed from a flat scan — verify by hand.`);
  }

  // ── Promo / subset (from stamp text OR collector-number prefix) ─────────────
  const promoGuess = resolvePromoGuess(obs.promoGuess ?? obs.visibleStampText);
  const subsetFromNumber =
    parsedNumber.subsetPrefix === "TG" ? "trainer_gallery" : parsedNumber.subsetPrefix === "GG" ? "galarian_gallery" : parsedNumber.subsetPrefix === "SV" ? "shiny_vault" : null;
  const promoType = promoGuess?.kind === "promo" ? promoGuess.value : null;
  const subsetName = promoGuess?.kind === "subset" ? promoGuess.value : subsetFromNumber;

  // ── Knowledge validation summary ────────────────────────────────────────────
  const conflicts: string[] = [];
  if (rarityBuilt.rarityCode.validationStatus === "conflict") conflicts.push(rarityBuilt.rarityCode.evidence.find((e) => e.kind === "visible_star_symbol")?.summary ?? "rarity/symbol conflict");
  const knowledgeValidation: KnowledgeValidationResult = {
    setResolved,
    setCodeMatchesSet,
    languageRegionCompatible: region != null ? true : null,
    eraCompatible: rarityBuilt.rarityCode.value ? rarityBuilt.rarityCode.validationStatus !== "conflict" : null,
    collectorNumberCompatible: parsedNumber.number ? true : null,
    rarityCompatible: rarityBuilt.rarityCode.value ? rarityBuilt.rarityCode.validationStatus === "validated" : null,
    finishCompatible: finishValue ? true : null,
    promoCompatible: promoType || subsetName ? true : null,
    symbolMatchesRarity: rarityBuilt.rarityCode.value ? rarityBuilt.rarityCode.validationStatus !== "conflict" : null,
    conflicts,
  };

  // ── Assemble fields ─────────────────────────────────────────────────────────
  const gameField = field<string>(obs.game === "pokemon" ? "pokemon" : obs.game ?? null, obs.game === "pokemon" ? "high" : "low", "ai", obs.game ? [evidenceSummary("ai_visual_inference", `game: ${obs.game}`)] : []);
  const collectorNumber = field<string>(parsedNumber.number, parsedNumber.number ? "high" : "unknown", "deterministic", parsedNumber.number ? [evidenceSummary("visible_collector_number", parsedNumber.raw)] : [], "validated");
  const collectorTotal = field<string>(parsedNumber.total, parsedNumber.total ? "high" : "unknown", "deterministic", parsedNumber.total ? [evidenceSummary("visible_collector_number", `total ${parsedNumber.total}`)] : [], "validated");

  const setId = field<string>(topSet?.setId ?? null, setResolved ? "high" : "unknown", "knowledge_engine", topSet ? [evidenceSummary("knowledge_engine_match", `matched ${topSet.setName ?? topSet.setId}`)] : [], setResolved ? "validated" : "unknown");
  const setName = field<string>(topSet?.setName ?? obs.setNameGuess ?? null, setResolved ? "high" : obs.setNameGuess ? "low" : "unknown", topSet ? "knowledge_engine" : "ai", topSet ? [evidenceSummary("knowledge_engine_match", topSet.setName ?? "")] : obs.setNameGuess ? [evidenceSummary("ai_visual_inference", obs.setNameGuess)] : [], setResolved ? "validated" : obs.setNameGuess ? "unvalidated" : "unknown");
  const setCodeField = field<string>(topSet?.setCode ?? parsedSetCode, topSet?.setCode ? "high" : parsedSetCode ? "medium" : "unknown", parsedSetCode ? "deterministic" : "knowledge_engine", parsedSetCode ? [evidenceSummary("visible_set_code", parsedSetCode)] : topSet?.setCode ? [evidenceSummary("knowledge_engine_match", topSet.setCode)] : [], setCodeMatchesSet === false ? "conflict" : topSet?.setCode || parsedSetCode ? "validated" : "unknown");
  if (setCodeMatchesSet === false) conflicts.push(`Printed set code ${parsedSetCode} doesn't match the matched set (${topSet?.setCode})`);

  const languageField = field<string>(resolvedLang, resolvedLang ? (lang.confidence === "high" ? "high" : lang.confidence === "medium" ? "medium" : "low") : "unknown", "deterministic", [evidenceSummary("ocr_text", lang.evidence)], resolvedLang ? "validated" : "unknown");
  if (lang.alternatives.length) warnings.push(`Language ambiguous — alternatives: ${lang.alternatives.join(", ")}`);
  const regionField = field<string>(region, region ? "medium" : "unknown", "deterministic", region ? [evidenceSummary("knowledge_engine_match", `region ${region} from language`)] : [], region ? "validated" : "unknown");
  const eraField = field<string>(effectiveEra, effectiveEra ? "medium" : "unknown", "deterministic", effectiveEra ? [evidenceSummary("ocr_text", `regulation mark → ${effectiveEra}`)] : [], effectiveEra ? "validated" : "unknown");

  const rarityLabelField = field<string>(rarityBuilt.label, rarityBuilt.rarityCode.confidence, "knowledge_engine", []);
  const symbolField = field<string>(rarityBuilt.symbol, rarityBuilt.rarityCode.confidence, "knowledge_engine", []);
  const symbolCountField = field<number>(rarityBuilt.count, rarityBuilt.rarityCode.confidence, "knowledge_engine", []);
  const symbolColourField = field<string>(rarityBuilt.colour, rarityBuilt.rarityCode.confidence, "knowledge_engine", []);

  const promoField = field<string>(promoType, promoType ? "medium" : "unknown", "ai", promoType ? [evidenceSummary("visible_promo_stamp", promoByValue(promoType)?.label ?? "")] : [], promoType ? "validated" : "unknown");
  const subsetField = field<string>(subsetName, subsetName ? (subsetFromNumber ? "high" : "medium") : "unknown", subsetFromNumber ? "deterministic" : "ai", subsetName ? [evidenceSummary(subsetFromNumber ? "visible_collector_number" : "visible_promo_stamp", promoByValue(subsetName)?.label ?? subsetName)] : [], subsetName ? "validated" : "unknown");

  const overallConfidence = worst(setId.confidence, rarityBuilt.rarityCode.confidence, collectorNumber.confidence);

  const evidence: Evidence[] = [
    ...(topSet ? [evidenceSummary("knowledge_engine_match", `Set: ${topSet.setName ?? topSet.setId}`)] : []),
    ...(parsedNumber.number ? [evidenceSummary("visible_collector_number", `Number: ${parsedNumber.raw}`)] : []),
    ...(rarityBuilt.label ? [evidenceSummary("visible_star_symbol", `Rarity: ${rarityBuilt.label}`)] : []),
    ...(obs.evidenceNotes ?? []).slice(0, 3).map((n) => evidenceSummary("ai_visual_inference", n)),
  ];

  return {
    contractVersion: "v1",
    requestId: input.requestId,
    provider: input.provider.name,
    model: input.provider.model,
    createdAt: new Date().toISOString(),
    frontImageChecksum: input.frontChecksum,
    backImageChecksum: input.backChecksum,
    game: gameField,
    cardName: field<string>(obs.cardName ?? null, obs.cardName ? "medium" : "unknown", "ai", obs.cardName ? [evidenceSummary("ai_visual_inference", obs.cardName)] : []),
    year: field<string>(parseYear(obs.year), obs.year ? "medium" : "unknown", "deterministic", obs.year ? [evidenceSummary("ocr_text", `year ${obs.year}`)] : []),
    setId,
    setName,
    setCode: setCodeField,
    collectorNumber,
    collectorNumberTotal: collectorTotal,
    language: languageField,
    region: regionField,
    era: eraField,
    rarityCode: rarityBuilt.rarityCode,
    rarityLabel: rarityLabelField,
    printedSymbol: symbolField,
    printedSymbolCount: symbolCountField,
    printedSymbolColour: symbolColourField,
    finishVariant: finishField,
    promoType: promoField,
    subsetName: subsetField,
    legacyVariantSuggestion: emptyField<string>(),
    overallConfidence: conflicts.length ? "conflict" : overallConfidence,
    needsHumanReview: true,
    warnings,
    evidence,
    alternatives: candidates.slice(1, 5),
    knowledgeValidation: { ...knowledgeValidation, conflicts },
    providerCostEstimate: input.providerCostEstimate,
    actualProviderCost: actualCostUsd,
  };
}
