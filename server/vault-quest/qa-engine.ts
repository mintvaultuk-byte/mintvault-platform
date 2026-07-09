// =============================================================================
// VAULT QUEST — QA engine (Phase 9)
// Evaluates a card end-to-end: resolves variant inheritance, runs the LOCKED
// render engine's QA (via renderCard — never touching lib/qa.ts), adds Studio
// checks, and computes the workflow gates + readiness. Single evaluator used by
// the editor, the approve/export gates, and batch QA.
// =============================================================================
import type { VqCardRow } from "@shared/vq-schema";
import type { QaIssue } from "./lib/types";
import { renderCard, type RenderCardInput } from "./render-service";
import { VQ_ELEMENTS_NEEDS_APPROVAL } from "./lib/vq-constants";
import {
  type VqGates,
  type VqStatus,
  isVqStatus,
  isApprovedPlus,
  derivedBucket,
  readinessScore,
} from "@shared/vq-workflow";

const SUPPORT_TYPES = new Set(["Tactic", "Relic", "Vault", "Collector", "Place"]);

/** Overlay a variant's null gameplay with its base card's values (resolve-on-read). */
export function resolveVariant(card: VqCardRow, base: VqCardRow | null): VqCardRow {
  if (!base) return card;
  const pick = <T>(own: T, from: T): T => (own === null || own === undefined ? from : own);
  return {
    ...card,
    stageNumber: pick(card.stageNumber, base.stageNumber),
    lifeStage: pick(card.lifeStage, base.lifeStage),
    familyId: pick(card.familyId, base.familyId),
    health: pick(card.health, base.health),
    guard: pick(card.guard, base.guard),
    shift: pick(card.shift, base.shift),
    attack1Name: pick(card.attack1Name, base.attack1Name),
    attack1Cost: pick(card.attack1Cost, base.attack1Cost),
    attack1Damage: pick(card.attack1Damage, base.attack1Damage),
    attack1Effect: pick(card.attack1Effect, base.attack1Effect),
    attack2Name: pick(card.attack2Name, base.attack2Name),
    attack2Cost: pick(card.attack2Cost, base.attack2Cost),
    attack2Damage: pick(card.attack2Damage, base.attack2Damage),
    attack2Effect: pick(card.attack2Effect, base.attack2Effect),
    vulnerability: pick(card.vulnerability, base.vulnerability),
    keywords: card.keywords && card.keywords.length ? card.keywords : base.keywords,
  };
}

/** VqCardRow (+ derived previousStage) → the render engine's camelCase input. */
export function cardRowToRenderInput(card: VqCardRow, previousStage: string | null, familyName?: string | null): RenderCardInput {
  return {
    cardId: card.cardId, collectorNumber: card.collectorNumber, name: card.name, displayName: card.displayName,
    cardType: card.cardType, element: card.element, rarity: card.rarity, familyId: card.familyId, familyName: familyName ?? null,
    stageNumber: card.stageNumber, lifeStage: card.lifeStage, previousStage,
    health: card.health, guard: card.guard, shift: card.shift,
    attack1Name: card.attack1Name, attack1Cost: card.attack1Cost, attack1Damage: card.attack1Damage, attack1Effect: card.attack1Effect,
    attack2Name: card.attack2Name, attack2Cost: card.attack2Cost, attack2Damage: card.attack2Damage, attack2Effect: card.attack2Effect,
    vulnerability: card.vulnerability, keywords: card.keywords, setCode: card.setCode, language: card.language, year: card.year, edition: card.edition,
  };
}

export interface CardEvaluation {
  cardId: string;
  status: VqStatus;
  renderStatus: "pass" | "reject";
  qa: QaIssue[];
  suggestions: string[];
  gates: VqGates;
  readiness: number;
  bucket: VqStatus;
  exportEligible: boolean;
}

export interface EvaluateInput {
  card: VqCardRow;
  previousStage: string | null;
  familyName?: string | null;
  base: VqCardRow | null;
  mainArt?: Buffer;
  prevArt?: Buffer;
}

/** Full evaluation (runs the render QA). */
export async function evaluateCard(input: EvaluateInput): Promise<CardEvaluation> {
  const { card, previousStage, familyName, base } = input;
  const status: VqStatus = isVqStatus(card.status) ? card.status : "draft";
  const resolved = card.baseCardId ? resolveVariant(card, base) : card;
  const renderInput = cardRowToRenderInput(resolved, previousStage, familyName);

  const { qa } = await renderCard(renderInput, { mainArt: input.mainArt, prevArt: input.prevArt }, "preview");
  const issues: QaIssue[] = [...qa.issues];
  const suggestions: string[] = [];

  // ---- Studio-level checks (on top of the render engine's data + rendered QA) ----
  const isSupport = SUPPORT_TYPES.has(card.cardType);
  const identityOk = !!(card.cardId && card.collectorNumber && card.name && card.cardType && card.element && card.rarity);
  if (!identityOk) suggestions.push("Complete the identity fields (id / collector / name / type / element / rarity).");

  const gameplayOk = isSupport
    ? true
    : resolved.health != null && !!resolved.attack1Name && resolved.attack1Damage != null;
  if (!gameplayOk && !isSupport) {
    if (resolved.health == null) suggestions.push("Set Health.");
    if (!resolved.attack1Name || resolved.attack1Damage == null) suggestions.push("Add at least one attack (name + damage).");
  }

  if (card.baseCardId && !base) {
    issues.push({ level: "reject", field: "baseCardId", message: `variant references base "${card.baseCardId}" which was not found` });
  }
  if (VQ_ELEMENTS_NEEDS_APPROVAL.has(card.element) && !issues.some((i) => i.field === "element" && /NEEDS_APPROVAL/.test(i.message))) {
    issues.push({ level: "warn", field: "element", message: `element "${card.element}" is NEEDS_APPROVAL — placeholder palette/crest` });
  }
  const artworkPresent = !!card.artR2Key;
  if (!artworkPresent) suggestions.push("Upload the main artwork.");

  const renderStatus: "pass" | "reject" = qa.status;
  const hasBlockingQa = issues.some((i) => i.level === "reject");
  const gates: VqGates = {
    dataComplete: identityOk && gameplayOk,
    artworkPresent,
    renderPasses: renderStatus !== "reject" && !hasBlockingQa,
    hasBlockingQa,
    isVariant: !!card.baseCardId,
    baseApproved: !!base && isApprovedPlus(base.status),
  };

  return {
    cardId: card.cardId,
    status,
    renderStatus,
    qa: issues,
    suggestions,
    gates,
    readiness: readinessScore(status, gates),
    bucket: derivedBucket(status, gates),
    exportEligible: gates.renderPasses && (isApprovedPlus(status) || status === "ready_for_review"),
  };
}
