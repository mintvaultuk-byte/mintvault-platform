/**
 * AI Creature Designer — PURE id planning + alternative-name derivation.
 *
 * No DB, no storage, no network: split out of creature-designer.ts (which imports the
 * storage layer) so these can be unit-tested in isolation. Mirrors the collision-safe
 * id/collector logic in generate.ts.
 */
import { nextCardNumFrom } from "./write-sanitize";
import { collisionReport, type ExistingNames } from "@shared/vq-creature-concept";

const pad3 = (n: number) => String(n).padStart(3, "0");

function nextFamilyNum(families: { familyId: string }[]): number {
  let max = 0;
  for (const f of families) {
    const m = /F(\d+)/.exec(f.familyId ?? "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

function nextCollector(cards: { collectorNumber: string | null }[], count: number): { start: number; denom: number } {
  let maxN = 0;
  let denom = 0;
  for (const c of cards) {
    const m = /^(\d+)\s*\/\s*(\d+)$/.exec(c.collectorNumber ?? "");
    if (m) {
      maxN = Math.max(maxN, Number(m[1]));
      denom = Math.max(denom, Number(m[2]));
    }
  }
  const start = maxN + 1;
  return { start, denom: Math.max(denom, cards.length, start + count - 1) };
}

export interface ExistingRow {
  cards: { cardId: string; collectorNumber: string | null }[];
  families: { familyId: string }[];
}

export interface PlannedIds {
  familyId: string;
  cardIds: string[]; // 3
  collectorNumbers: string[]; // 3
}

/** PURE: plan a non-colliding family id + 3 card ids + 3 collector numbers. */
export function planFamilyIds(existing: ExistingRow, setCode: string): PlannedIds {
  const familyId = `${setCode}-F${String(nextFamilyNum(existing.families)).padStart(2, "0")}`;
  const num0 = nextCardNumFrom(existing.cards, setCode);
  const col = nextCollector(existing.cards, 3);
  const cardIds = [0, 1, 2].map((i) => `${setCode}-${pad3(num0 + i)}`);
  const collectorNumbers = [0, 1, 2].map((i) => `${col.start + i}/${col.denom}`);
  return { familyId, cardIds, collectorNumbers };
}

const ALT_SUFFIXES = ["Prime", "Nova", "Echo", "Vale", "Wynn", "Mira", "Orin", "Sable", "Thorn", "Zephyr"];

/** PURE: derive non-colliding family + stage names by appending an evocative suffix. */
export function deriveAlternativeNames(
  familyName: string,
  stageNames: string[],
  existing: ExistingNames,
): { familyName: string; stageNames: string[] } | null {
  for (const suffix of ALT_SUFFIXES) {
    const newFamily = `${familyName} ${suffix}`.trim();
    const newStages = stageNames.map((n) => `${n} ${suffix}`.trim());
    if (!collisionReport(existing, { familyName: newFamily, stageNames: newStages }).collides) {
      return { familyName: newFamily, stageNames: newStages };
    }
  }
  return null;
}
