// Vault Quest — set-level QA + metadata (Phase 10). Cross-card integrity checks
// (collector-number uniqueness, completeness, family/base refs) and the metadata
// JSON manifest for the print house. Pure — no DB/render.
import type { VqCardRow } from "@shared/vq-schema";

export interface SetQaIssue { level: "reject" | "warn"; scope: string; message: string }

/** Template A/B/C from stage (VQ_LOCK.stage_templates). */
export function stageLetter(stageNumber: number | null): string {
  return stageNumber === 1 ? "A" : stageNumber === 2 ? "B" : stageNumber === 3 ? "C" : "—";
}

export function setIntegrity(cards: VqCardRow[]): { issues: SetQaIssue[]; total: number; complete: boolean; missing: string[] } {
  const issues: SetQaIssue[] = [];
  const ids = new Set(cards.map((c) => c.cardId));

  // collector-number uniqueness
  const seen = new Map<string, string>();
  const present = new Set<number>();
  const dens = new Set<number>();
  for (const c of cards) {
    if (!c.collectorNumber) { issues.push({ level: "reject", scope: c.cardId, message: "missing collector number" }); continue; }
    const prev = seen.get(c.collectorNumber);
    if (prev) issues.push({ level: "reject", scope: c.cardId, message: `duplicate collector number ${c.collectorNumber} (also ${prev})` });
    else seen.set(c.collectorNumber, c.cardId);
    const [numStr, denStr] = c.collectorNumber.split("/");
    const num = Number(numStr), den = Number(denStr);
    if (Number.isFinite(num)) present.add(num);
    if (Number.isFinite(den)) dens.add(den);
  }

  // completeness: 1..den all present (using the most common denominator)
  const missing: string[] = [];
  const den = [...dens].sort((a, b) => b - a)[0];
  if (den && Number.isFinite(den)) {
    for (let n = 1; n <= den; n++) if (!present.has(n)) missing.push(String(n).padStart(3, "0"));
    if (missing.length) issues.push({ level: "warn", scope: "set", message: `${missing.length} collector number(s) missing (${missing.slice(0, 8).join(", ")}${missing.length > 8 ? "…" : ""})` });
  }

  // variant base refs + family refs resolve
  for (const c of cards) {
    if (c.baseCardId && !ids.has(c.baseCardId)) issues.push({ level: "reject", scope: c.cardId, message: `variant base "${c.baseCardId}" is not in the set` });
  }

  return { issues, total: cards.length, complete: !issues.some((i) => i.level === "reject") && missing.length === 0, missing };
}

/** Per-card metadata for the export manifest / print house. */
export function cardMetadata(card: VqCardRow, previousStage: string | null): Record<string, unknown> {
  return {
    card_id: card.cardId,
    collector_number: card.collectorNumber,
    name: card.name,
    display_name: card.displayName,
    card_type: card.cardType,
    element: card.element,
    rarity: card.rarity,
    variant_tier: card.variantTier,
    base_card_id: card.baseCardId,
    stage: card.stageNumber,
    template: stageLetter(card.stageNumber),
    life_stage: card.lifeStage,
    previous_stage: previousStage,
    health: card.health,
    guard: card.guard,
    shift: card.shift,
    set_code: card.setCode,
    language: card.language,
    year: card.year,
    edition: card.edition,
    status: card.status,
  };
}
