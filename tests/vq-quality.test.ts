import { describe, it, expect } from "vitest";
// quality.ts is pure derivation (no React) — loads cleanly in the node environment.
import { scoreBand, matchBand, traitsFromBreakdown, characterHealth, poseDiversityBand, evolutionDifferenceBand, identityFullyPassing, type HealthCharacter } from "@/components/vault-quest/quality";

// ── helpers ──────────────────────────────────────────────────────────────────
const pack = (master?: number | null, action?: number | null): HealthCharacter["referencePack"] => ({
  ...(master !== undefined ? { master_portrait: { r2Key: "vq/characters/X/approved/master_portrait.png", identityScore: master } } : {}),
  ...(action !== undefined ? { action_pose: { r2Key: "vq/characters/X/approved/action_pose.png", identityScore: action } } : {}),
});

const ch = (over: Partial<HealthCharacter>): HealthCharacter => ({
  characterId: "GNV-F01-S1",
  descriptionStatus: "approved",
  approvalStatus: "approved",
  locked: false,
  referencePack: null,
  ...over,
});

// ── scoreBand / matchBand boundaries (Phase 6 spec: 90/80/70) ────────────────
describe("scoreBand boundaries", () => {
  it("maps the founder-facing bands exactly at the spec thresholds", () => {
    expect(scoreBand(90).label).toBe("Excellent");
    expect(scoreBand(100).label).toBe("Excellent");
    expect(scoreBand(89).label).toBe("Good");
    expect(scoreBand(80).label).toBe("Good");
    expect(scoreBand(79).label).toBe("Needs Review");
    expect(scoreBand(70).label).toBe("Needs Review");
    expect(scoreBand(69).label).toBe("Reject");
    expect(scoreBand(0).label).toBe("Reject");
  });
  it("null/undefined is unscored, never a verdict", () => {
    expect(scoreBand(null)).toEqual({ label: "—", state: "grey" });
    expect(scoreBand(undefined).state).toBe("grey");
  });
});

describe("matchBand boundaries", () => {
  it("Pass ≥80, Needs Review 70–79, Fail <70, grey when unscored", () => {
    expect(matchBand(80)).toEqual({ label: "Pass", state: "pass" });
    expect(matchBand(79)).toEqual({ label: "Needs Review", state: "review" });
    expect(matchBand(70).state).toBe("review");
    expect(matchBand(69)).toEqual({ label: "Fail", state: "fail" });
    expect(matchBand(null).state).toBe("grey");
  });
});

describe("poseDiversityBand (Action Reference pose-diversity fix)", () => {
  it("renders Pass/Fail from the stored verdict, not the raw difference number", () => {
    expect(poseDiversityBand({ verdict: "pass", difference: 82, threshold: 55 })).toEqual({ label: "Pass", state: "pass" });
    expect(poseDiversityBand({ verdict: "fail", difference: 15, threshold: 55 })).toEqual({ label: "Fail", state: "fail" });
  });
  it("absent (non-action-pose candidates, or scorer unavailable) renders unscored, never a fail", () => {
    expect(poseDiversityBand(undefined)).toEqual({ label: "—", state: "grey" });
    expect(poseDiversityBand(null)).toEqual({ label: "—", state: "grey" });
    expect(poseDiversityBand({})).toEqual({ label: "—", state: "grey" });
  });
});

describe("evolutionDifferenceBand (Stage 2/3 evolution-differentiation fix)", () => {
  it("renders Pass/Fail from the stored verdict, not the raw difference number", () => {
    expect(evolutionDifferenceBand({ verdict: "pass", difference: 78, threshold: 55, stageNumber: 2 })).toEqual({ label: "Pass", state: "pass" });
    expect(evolutionDifferenceBand({ verdict: "fail", difference: 15, threshold: 55, stageNumber: 2 })).toEqual({ label: "Fail", state: "fail" });
  });
  it("absent (Stage 1, non-master candidates, or scorer unavailable) renders unscored, never a fail", () => {
    expect(evolutionDifferenceBand(undefined)).toEqual({ label: "—", state: "grey" });
    expect(evolutionDifferenceBand(null)).toEqual({ label: "—", state: "grey" });
    expect(evolutionDifferenceBand({})).toEqual({ label: "—", state: "grey" });
  });
});

describe("traitsFromBreakdown", () => {
  it("maps only known traits and leaves absent ones null", () => {
    const t = traitsFromBreakdown({ eyes: 91, colours: 55 });
    expect(t.find((x) => x.label === "Face / Eyes")?.score).toBe(91);
    expect(t.find((x) => x.label === "Colour")?.score).toBe(55);
    expect(t.find((x) => x.label === "Markings")?.score).toBeNull();
  });
  it("handles null breakdown", () => {
    expect(traitsFromBreakdown(null).every((x) => x.score === null)).toBe(true);
  });
});

// ── identityFullyPassing — client-side mirror of the server strict identity gate ──
describe("identityFullyPassing (client mirror of server/vault-quest/ai/identity-gate.ts)", () => {
  const ALL_PASS = { bodyShape: 95, colours: 95, markings: 95, eyes: 95, accessories: 95, silhouette: 95 };
  it("overall 75 (Needs Review) is not fully passing, even with all traits high", () => {
    expect(identityFullyPassing(75, ALL_PASS)).toBe(false);
  });
  it("overall above threshold but one critical trait fails is not fully passing", () => {
    expect(identityFullyPassing(88, { ...ALL_PASS, markings: 55 })).toBe(false);
    expect(identityFullyPassing(88, { ...ALL_PASS, silhouette: 60 })).toBe(false);
  });
  it("all traits pass + overall pass → fully passing", () => {
    expect(identityFullyPassing(92, ALL_PASS)).toBe(true);
  });
  it("missing breakdown is never a silent pass", () => {
    expect(identityFullyPassing(92, null)).toBe(false);
    expect(identityFullyPassing(92, undefined)).toBe(false);
  });
});

// ── characterHealth — the Ready-for-Cards gate ───────────────────────────────
describe("characterHealth gates", () => {
  it("fully complete character is READY FOR CARDS", () => {
    const h = characterHealth(ch({ locked: true, referencePack: pack(95, 92) }));
    expect(h.readyForCards).toBe(true);
    expect(h.missing).toEqual([]);
    expect(h.bucket).toBe("ready");
    expect(h.identityScore).toBe(94); // round((95+92)/2)
  });

  it("missing description blocks everything and points at description", () => {
    const h = characterHealth(ch({ descriptionStatus: "draft", referencePack: null }));
    expect(h.readyForCards).toBe(false);
    expect(h.missing[0]).toBe("Approve Description");
    expect(h.nextStepKey).toBe("description");
    expect(h.bucket).toBe("needs_description");
  });

  it("master approved but no action → needs_action, action step next", () => {
    const h = characterHealth(ch({ referencePack: pack(95) }));
    expect(h.readyForCards).toBe(false);
    expect(h.missing).toContain("Approve Action Pose");
    expect(h.nextStepKey).toBe("action");
    expect(h.bucket).toBe("needs_action");
  });

  it("identity below the 70 safety threshold FAILS the gate (threshold not weakened)", () => {
    const h = characterHealth(ch({ locked: true, referencePack: pack(95, 40) }));
    expect(h.readyForCards).toBe(false);
    expect(h.bucket).toBe("failed_identity");
    expect(h.missing.some((m) => /identity score too low/i.test(m))).toBe(true);
  });

  it("unlocked-but-otherwise-complete lists Lock Character and is not ready", () => {
    const h = characterHealth(ch({ locked: false, referencePack: pack(95, 92) }));
    expect(h.readyForCards).toBe(false);
    expect(h.missing).toContain("Lock Character");
    expect(h.nextStepKey).toBe("lock");
  });

  it("pack complete but references not review-approved surfaces Approve References (engine order)", () => {
    const h = characterHealth(ch({ approvalStatus: "draft", locked: false, referencePack: pack(95, 92) }));
    expect(h.missing).toContain("Approve References");
    // Approve References must come BEFORE Lock Character in the checklist
    expect(h.missing.indexOf("Approve References")).toBeLessThan(h.missing.indexOf("Lock Character"));
  });

  it("no artwork is ever auto-approved: absent pack rows stay grey, not fail", () => {
    const h = characterHealth(ch({ referencePack: null }));
    const master = h.items.find((i) => i.label === "Master Reference Approved")!;
    const bg = h.items.find((i) => i.label === "Background Check")!;
    expect(master.state).toBe("grey");
    expect(bg.state).toBe("grey"); // background is only PASS once a validated master exists
  });
});

// ── Phase-1 regression: consistency uses the WORST score, not the average ────
describe("characterHealth consistency rows (regression: min, not mean)", () => {
  it("a 95 master must not smooth over a 72 action — consistency shows REVIEW", () => {
    const h = characterHealth(ch({ locked: true, referencePack: pack(95, 72) }));
    const colour = h.items.find((i) => i.label === "Colour Consistency")!;
    const style = h.items.find((i) => i.label === "Style Consistency")!;
    // average is 84 (would read PASS) — the worst-score rule keeps these in review
    expect(h.identityScore).toBe(84);
    expect(colour.state).toBe("review");
    expect(style.state).toBe("review");
  });
  it("both references ≥80 → consistency PASS", () => {
    const h = characterHealth(ch({ locked: true, referencePack: pack(95, 85) }));
    expect(h.items.find((i) => i.label === "Colour Consistency")!.state).toBe("pass");
  });
});
