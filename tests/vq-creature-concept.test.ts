/**
 * AI Creature Designer — pure shared concept model (validation, inspiration,
 * collision). No network, no DB.
 */
import { describe, it, expect } from "vitest";
import {
  validateFamilyConcept,
  pickRandomInspiration,
  RANDOM_INSPIRATION_IDEAS,
  collisionReport,
  applyConceptField,
  CONCEPT_STAGE_DRAWABLE_KEYS,
  type FamilyConcept,
  type StageConcept,
} from "../shared/vq-creature-concept";

function stage(n: 1 | 2 | 3, over: Partial<StageConcept> = {}): StageConcept {
  const drawable = Object.fromEntries(CONCEPT_STAGE_DRAWABLE_KEYS.map((k) => [k, `${k}-${n}`]));
  return {
    stageNumber: n,
    name: `Stagey${n}`,
    shortDescription: "short",
    signatureAbility: "ability",
    flavourText: "flavour",
    ...(drawable as Record<(typeof CONCEPT_STAGE_DRAWABLE_KEYS)[number], string>),
    ...over,
  } as StageConcept;
}
function fullConcept(over: Partial<FamilyConcept["family"]> = {}): FamilyConcept {
  return {
    family: { name: "Fammy", element: "Flame", theme: "t", evolutionDirection: "e", palette: "p", sharedTraits: "s", lore: "l", ...over },
    stages: [stage(1), stage(2), stage(3)],
  };
}

describe("validateFamilyConcept", () => {
  it("passes a fully-populated 3-stage concept", () => {
    expect(validateFamilyConcept(fullConcept())).toEqual({ ok: true, missing: [] });
  });
  it("reports a missing family field", () => {
    const c = fullConcept({ lore: "  " });
    const r = validateFamilyConcept(c);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain("family.lore");
  });
  it("reports a missing stage drawable field", () => {
    const c = fullConcept();
    (c.stages[1] as unknown as Record<string, string>).masterArtworkPrompt = "";
    const r = validateFamilyConcept(c);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain("stages[1].masterArtworkPrompt");
  });
  it("rejects the wrong number of stages", () => {
    const c = fullConcept();
    c.stages = [stage(1), stage(2)];
    expect(validateFamilyConcept(c).ok).toBe(false);
  });
  it("null/garbage → not ok", () => {
    expect(validateFamilyConcept(null).ok).toBe(false);
  });
});

describe("pickRandomInspiration", () => {
  it("is index-based and wraps", () => {
    expect(pickRandomInspiration(0)).toBe(RANDOM_INSPIRATION_IDEAS[0]);
    expect(pickRandomInspiration(RANDOM_INSPIRATION_IDEAS.length)).toBe(RANDOM_INSPIRATION_IDEAS[0]);
    expect(pickRandomInspiration(-1)).toBe(RANDOM_INSPIRATION_IDEAS[RANDOM_INSPIRATION_IDEAS.length - 1]);
  });
  it("has a non-empty idea list", () => {
    expect(RANDOM_INSPIRATION_IDEAS.length).toBeGreaterThan(5);
  });
});

describe("applyConceptField — field isolation", () => {
  it("changing a FAMILY field changes only that field; every stage is untouched (same ref)", () => {
    const before = fullConcept();
    const after = applyConceptField(before, { scope: "family", key: "name" }, "Renamed");
    expect(after.family.name).toBe("Renamed");
    expect(after.family.lore).toBe(before.family.lore); // sibling family field unchanged
    expect(after.family.theme).toBe(before.family.theme);
    expect(after.stages).toBe(before.stages); // whole stages array structurally shared
    expect(before.family.name).toBe("Fammy"); // original not mutated
  });
  it("changing ONE stage field touches only that stage + only that key", () => {
    const before = fullConcept();
    const after = applyConceptField(before, { scope: "stage", index: 1, key: "name" }, "NewStage2");
    expect(after.stages[1].name).toBe("NewStage2");
    expect(after.stages[1].flavourText).toBe(before.stages[1].flavourText); // sibling field unchanged
    expect(after.stages[0]).toBe(before.stages[0]); // other stages same ref (untouched)
    expect(after.stages[2]).toBe(before.stages[2]);
    expect(after.family).toBe(before.family); // family untouched
    expect(before.stages[1].name).toBe("Stagey2"); // original not mutated
  });
  it("changing an ability never renames the creature", () => {
    const before = fullConcept();
    const after = applyConceptField(before, { scope: "stage", index: 0, key: "signatureAbility" }, "Petal Burst");
    expect(after.stages[0].signatureAbility).toBe("Petal Burst");
    expect(after.stages[0].name).toBe(before.stages[0].name); // name unchanged
  });
});

describe("collisionReport", () => {
  const existing = { familyNames: ["Flammi"], characterNames: ["Flammro", "Aquabub"], familyIds: ["GNV-F01"] };
  it("no collision when names are all fresh", () => {
    expect(collisionReport(existing, { familyName: "Newfam", stageNames: ["A", "B", "C"] }).collides).toBe(false);
  });
  it("detects a family-name collision (case-insensitive)", () => {
    const r = collisionReport(existing, { familyName: "flammi", stageNames: ["A", "B", "C"] });
    expect(r.collides).toBe(true);
    expect(r.conflicts.join(" ")).toMatch(/family name/i);
  });
  it("detects a stage-name collision", () => {
    const r = collisionReport(existing, { familyName: "Newfam", stageNames: ["A", "Flammro", "C"] });
    expect(r.collides).toBe(true);
    expect(r.conflicts.join(" ")).toMatch(/stage name/i);
  });
  it("detects a family-id collision", () => {
    const r = collisionReport(existing, { familyName: "Newfam", stageNames: ["A", "B", "C"], familyId: "GNV-F01" });
    expect(r.collides).toBe(true);
    expect(r.conflicts.join(" ")).toMatch(/family code/i);
  });
});
