/**
 * Action Reference — STRICT per-trait identity gate. Pure, no network/DB.
 *
 * Regression for the founder-reported bug: a candidate averaged an overall 75
 * ("Needs Review") while Markings/Style scored well below an acceptable match,
 * yet the old code (single averaged verdict) still allowed approval. This gate
 * must block approval unless the overall verdict AND every critical trait are
 * each an individual, genuine Pass.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  evaluateIdentityGate,
  identityCriticalMin,
  traitVerdict,
  CRITICAL_IDENTITY_TRAITS,
} from "../server/vault-quest/ai/identity-gate";

const OLD_CRIT = process.env.VQ_IDENTITY_CRITICAL_MIN;
const OLD_MIN = process.env.VQ_IDENTITY_MIN;
afterEach(() => {
  if (OLD_CRIT == null) delete process.env.VQ_IDENTITY_CRITICAL_MIN;
  else process.env.VQ_IDENTITY_CRITICAL_MIN = OLD_CRIT;
  if (OLD_MIN == null) delete process.env.VQ_IDENTITY_MIN;
  else process.env.VQ_IDENTITY_MIN = OLD_MIN;
});

const ALL_PASS = { bodyShape: 95, colours: 95, markings: 95, eyes: 95, accessories: 95, silhouette: 95 };

describe("identityCriticalMin", () => {
  it("defaults to 80 (matches the existing UI Pass band)", () => {
    delete process.env.VQ_IDENTITY_CRITICAL_MIN;
    expect(identityCriticalMin()).toBe(80);
  });
  it("honours a valid env override", () => {
    process.env.VQ_IDENTITY_CRITICAL_MIN = "90";
    expect(identityCriticalMin()).toBe(90);
  });
  it("ignores an out-of-range / non-numeric override", () => {
    process.env.VQ_IDENTITY_CRITICAL_MIN = "abc";
    expect(identityCriticalMin()).toBe(80);
    process.env.VQ_IDENTITY_CRITICAL_MIN = "150";
    expect(identityCriticalMin()).toBe(80);
  });
});

describe("traitVerdict", () => {
  it("a missing score is needs_review, never a silent pass", () => {
    expect(traitVerdict(null)).toBe("needs_review");
    expect(traitVerdict(undefined)).toBe("needs_review");
  });
  it(">=80 is pass, 70-79 is needs_review, <70 is fail (default thresholds)", () => {
    expect(traitVerdict(80)).toBe("pass");
    expect(traitVerdict(95)).toBe("pass");
    expect(traitVerdict(75)).toBe("needs_review");
    expect(traitVerdict(70)).toBe("needs_review");
    expect(traitVerdict(69)).toBe("fail");
    expect(traitVerdict(0)).toBe("fail");
  });
});

describe("evaluateIdentityGate — the founder's exact reported scenario", () => {
  it("overall 75 (Needs Review) blocks approval even with a good pose score elsewhere", () => {
    const gate = evaluateIdentityGate(75, { ...ALL_PASS });
    expect(gate.overallVerdict).toBe("needs_review");
    expect(gate.approvalReady).toBe(false);
    expect(gate.failReasons).toContain("Overall Identity: Needs Review");
  });

  it("overall above threshold but Markings Fail blocks approval (averaging cannot hide a drifted trait)", () => {
    const gate = evaluateIdentityGate(88, { ...ALL_PASS, markings: 55 });
    expect(gate.traitVerdicts.markings).toBe("fail");
    expect(gate.approvalReady).toBe(false);
    expect(gate.failReasons).toContain("Markings: Fail");
  });

  it("overall above threshold but Style (silhouette) Fail blocks approval", () => {
    const gate = evaluateIdentityGate(88, { ...ALL_PASS, silhouette: 60 });
    expect(gate.traitVerdicts.silhouette).toBe("fail");
    expect(gate.approvalReady).toBe(false);
    expect(gate.failReasons).toContain("Style: Fail");
  });

  it("a single trait at Needs Review (not Fail) still blocks approval — Needs Review is not approval-ready", () => {
    const gate = evaluateIdentityGate(90, { ...ALL_PASS, bodyShape: 74 });
    expect(gate.traitVerdicts.bodyShape).toBe("needs_review");
    expect(gate.approvalReady).toBe(false);
    expect(gate.failReasons).toContain("Body Shape: Needs Review");
  });

  it("every critical trait pass + overall pass → approval-ready", () => {
    const gate = evaluateIdentityGate(92, { ...ALL_PASS });
    expect(gate.overallVerdict).toBe("pass");
    expect(CRITICAL_IDENTITY_TRAITS.every((t) => gate.traitVerdicts[t] === "pass")).toBe(true);
    expect(gate.approvalReady).toBe(true);
    expect(gate.failReasons).toEqual([]);
  });

  it("a missing breakdown (legacy candidate) is treated as needs_review on every trait, not a silent pass", () => {
    const gate = evaluateIdentityGate(90, null);
    expect(gate.approvalReady).toBe(false);
    expect(CRITICAL_IDENTITY_TRAITS.every((t) => gate.traitVerdicts[t] === "needs_review")).toBe(true);
  });
});
