/**
 * AI Creature Designer — pure id planning + alternative-name derivation.
 * No DB, no network (planFamilyIds/deriveAlternativeNames are pure over their inputs).
 */
import { describe, it, expect } from "vitest";
import { planFamilyIds, deriveAlternativeNames } from "../server/vault-quest/lib/creature-plan";

describe("planFamilyIds", () => {
  it("assigns the next family id + 3 non-colliding card ids/collector numbers (empty set)", () => {
    const plan = planFamilyIds({ cards: [], families: [] }, "TST");
    expect(plan.familyId).toBe("TST-F01");
    expect(plan.cardIds).toEqual(["TST-001", "TST-002", "TST-003"]);
    expect(plan.collectorNumbers).toHaveLength(3);
  });
  it("advances past existing families and cards", () => {
    const plan = planFamilyIds(
      {
        families: [{ familyId: "TST-F01" }, { familyId: "TST-F07" }],
        cards: [{ cardId: "TST-005", collectorNumber: "5/12" }],
      },
      "TST",
    );
    expect(plan.familyId).toBe("TST-F08"); // max F07 + 1
    expect(plan.cardIds[0]).toBe("TST-006"); // next after 005
    // collector numerators never exceed the denominator
    for (const cn of plan.collectorNumbers) {
      const [num, denom] = cn.split("/").map(Number);
      expect(num).toBeLessThanOrEqual(denom);
    }
  });
});

describe("deriveAlternativeNames", () => {
  it("suffixes to avoid a colliding family name", () => {
    const existing = { familyNames: ["Fluffy"], characterNames: [], familyIds: [] };
    const alt = deriveAlternativeNames("Fluffy", ["Fluffy I", "Fluffy II", "Fluffy III"], existing);
    expect(alt).not.toBeNull();
    expect(alt!.familyName).not.toBe("Fluffy");
    expect(alt!.familyName.startsWith("Fluffy ")).toBe(true);
    expect(alt!.stageNames).toHaveLength(3);
  });
  it("avoids stage-name collisions too", () => {
    const existing = { familyNames: [], characterNames: ["Blob I"], familyIds: [] };
    const alt = deriveAlternativeNames("Blob", ["Blob I", "Blob II", "Blob III"], existing);
    expect(alt).not.toBeNull();
    expect(alt!.stageNames[0]).not.toBe("Blob I");
  });
});
