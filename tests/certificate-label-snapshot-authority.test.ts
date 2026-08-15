/**
 * THE PUBLISH PATH: an approved catalogue value must print the wording Super Admin approved.
 *
 * WHY THIS EXISTS. formatVariantLine() resolves rarity labels against the compiled-in SEED
 * catalogue. Every value published through the Catalogue Manager — i.e. everything the
 * Partner-contribution approval workflow will ever create — is absent from SEED, so it fell
 * through to humanising its CODE. A rarity approved as "Prize Pack Star Holo" printed
 * "Prize Pack Star", silently discarding Super Admin's approved wording. That breaks the
 * core objective: adding a catalogue value must reach the certificate WITHOUT a code deploy.
 *
 * The certificate already persists the approved wording in `certificates.rarity_label`
 * (written at save time from the LIVE catalogue by validateStructuredVariant). It simply was
 * never read at render. These tests pin that it now is, and pin the consequences:
 *
 *   1. a catalogue-published value prints its APPROVED label, not a humanised code;
 *   2. an ISSUED certificate is immutable BY DESIGN — the snapshot outranks the seed, so a
 *      later code deploy that edits a seed label cannot retroactively rewrite history;
 *   3. nothing about existing certificates changes.
 *
 * Precedence asserted here: public override > persisted snapshot > seed label > humanised code.
 */
import { describe, it, expect } from "vitest";
import { formatVariantLine } from "@shared/variant-line";
import { POKEMON_RARITIES } from "@shared/pokemon-rarity-catalogue";

const V2 = { language: "en", structuredVariantVersion: 2 } as const;
const line = (o: Record<string, unknown>) => formatVariantLine({ ...V2, ...o } as never);

describe("a catalogue-published rarity prints the label Super Admin approved", () => {
  it("uses the persisted snapshot when the code is not in the compiled seed catalogue", () => {
    // Precondition: this code is genuinely absent from SEED, i.e. it could only have come
    // from the Catalogue Manager. If someone later seeds it, this test must be revisited.
    expect(POKEMON_RARITIES.some((r) => r.value === "prize_pack_star")).toBe(false);
    expect(line({ rarityCode: "prize_pack_star", rarityLabelStructured: "Prize Pack Star Holo" })).toBe(
      "Prize Pack Star Holo"
    );
  });

  it("without the snapshot it still degrades to a humanised code rather than printing nothing", () => {
    expect(line({ rarityCode: "prize_pack_star" })).toBe("Prize Pack Star");
  });

  it("strips the catalogue's trailing disambiguation qualifier from the snapshot too", () => {
    // Catalogue labels carry "(EX era)"-style qualifiers for graders; they are not customer wording.
    expect(line({ rarityCode: "tera_hyper_rare", rarityLabelStructured: "Tera Hyper Rare (SV era)" })).toBe(
      "Tera Hyper Rare"
    );
  });

  it("combines an approved rarity with a finish without disturbing the separator model", () => {
    expect(
      line({ rarityCode: "prize_pack_star", rarityLabelStructured: "Prize Pack Star Holo", finishVariant: "holo" })
    ).toBe("Prize Pack Star Holo · Holo");
  });
});

describe("an issued certificate is immutable by design, not by accident", () => {
  it("the persisted snapshot outranks the seed catalogue for the same code", () => {
    // Simulates a later code deploy that edited the seed wording: the issued certificate
    // keeps what was approved at save time.
    expect(line({ rarityCode: "gold_star", rarityLabelStructured: "Gold Star AS APPROVED" })).toBe(
      "Gold Star AS APPROVED"
    );
  });

  it("an empty or whitespace snapshot never blanks the line — it falls back to the seed", () => {
    expect(line({ rarityCode: "gold_star", rarityLabelStructured: "" })).toBe("Gold Star");
    expect(line({ rarityCode: "gold_star", rarityLabelStructured: "   " })).toBe("Gold Star");
    expect(line({ rarityCode: "gold_star", rarityLabelStructured: null })).toBe("Gold Star");
  });

  it("deliberate public wording overrides still outrank a snapshot", () => {
    // rare_holo's catalogue label is "Rare Holo (classic)" but the customer-facing wording is
    // "Holo Rare". That override is a product decision and must not be defeated by a snapshot.
    expect(line({ rarityCode: "rare_holo", rarityLabelStructured: "Rare Holo (classic)" })).toBe("Holo Rare");
  });
});

describe("no regression for existing certificates", () => {
  // The only certificates that reach this formatter are structuredVariantVersion >= 2. Every
  // rarity_code/rarity_label pair observed on production v2 rows is pinned here.
  it.each([
    ["common", "Common", "Common"],
    ["rare", "Rare", "Rare"],
    ["holo_rare_v", "Holo Rare V", "Holo Rare V"],
  ])("%s with its persisted snapshot still prints %s", (code, snapshot, expected) => {
    expect(line({ rarityCode: code, rarityLabelStructured: snapshot })).toBe(expected);
    // and identical to what it printed before the snapshot was consulted
    expect(line({ rarityCode: code })).toBe(expected);
  });

  it.each([
    ["gold_star", "Gold Star"],
    ["illustration_rare", "Illustration Rare"],
    ["special_illustration_rare", "Special Illustration Rare"],
    ["hyper_rare", "Hyper Rare"],
    ["ace_spec", "ACE SPEC"],
    ["double_rare", "Double Rare"],
    ["rare_holo", "Holo Rare"],
  ])("seeded rarity %s is unchanged when no snapshot is present", (code, expected) => {
    expect(line({ rarityCode: code })).toBe(expected);
  });

  it("the legacy (pre-consolidation) fold-in path is untouched by the snapshot", () => {
    // A v1 certificate must keep byte-identical wording; the snapshot must not leak into it.
    expect(formatVariantLine({ language: "en", structuredVariantVersion: 1, rarity: "RARE_HOLO" } as never)).toBe(
      "Holo Rare"
    );
    expect(
      formatVariantLine({
        language: "en",
        structuredVariantVersion: 1,
        rarity: "RARE_HOLO",
        rarityLabelStructured: "SHOULD NOT APPEAR",
      } as never)
    ).toBe("Holo Rare");
  });

  it("a snapshot cannot resurrect a rarity line on a cleared consolidated certificate", () => {
    // Clearing the structured rarity must yield no rarity text, snapshot present or not.
    expect(line({ rarityCode: null, rarityLabelStructured: "Prize Pack Star Holo" })).toBe("");
  });
});
