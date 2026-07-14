/**
 * Vault Quest AI guardrails — IP/franchise word-boundary matching.
 *
 * Regression test for a false-positive: "fluffy" contains the banned substring
 * "luffy" (One Piece), so a plain substring check rejected completely harmless
 * creature ideas. guardInput/guardOutput must match banned terms as whole words or
 * clear phrases, never as an arbitrary substring inside an unrelated word.
 */
import { describe, it, expect } from "vitest";
import { guardInput, guardOutput } from "../server/vault-quest/ai/guardrails";

describe("IP guard — word-boundary matching (no false positives on innocent words)", () => {
  it("accepts a harmless idea containing a banned substring inside a longer word", () => {
    const r = guardInput("pink fluffy cuddly monster that loves flowers");
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it("accepts other harmless substring collisions", () => {
    // "nami" is banned (One Piece); "tsunami" must still pass.
    expect(guardInput("a small tsunami spirit that lives in the sea").ok).toBe(true);
    // "mew" is banned; "mews" / "homework"-style containment must still pass. Use a
    // realistic idea rather than a contrived word.
    expect(guardInput("a cottage with cosy mewsy alleyways").ok).toBe(true);
  });

  it("still blocks actual banned franchise names", () => {
    expect(guardInput("a creature that looks just like Pikachu").ok).toBe(false);
    expect(guardInput("inspired by Pokemon").ok).toBe(false);
    expect(guardInput("basically Luffy from One Piece").ok).toBe(false);
  });

  it("blocking is case-insensitive", () => {
    expect(guardInput("POKEMON style creature").ok).toBe(false);
    expect(guardInput("a PIKACHU look-alike").ok).toBe(false);
    expect(guardInput("pikachu").ok).toBe(false);
  });

  it("blocks a banned term separated by punctuation", () => {
    expect(guardInput("cute, Pikachu-like creature.").ok).toBe(false);
    expect(guardInput("(Pokemon) inspired idea").ok).toBe(false);
    expect(guardInput("Pikachu!").ok).toBe(false);
  });

  it("guardOutput('name', …) applies the same whole-word rule", () => {
    expect(guardOutput("name", "Fluffi").hard).toEqual([]);
    expect(guardOutput("name", "Pufflet").hard).toEqual([]);
    expect(guardOutput("name", "Pikachu Jr").hard.length).toBeGreaterThan(0);
  });

  it("a negated mention is still not flagged as a violation (existing behaviour preserved)", () => {
    const r = guardInput("no Pokemon references, just an original creature");
    expect(r.ok).toBe(true);
  });
});
