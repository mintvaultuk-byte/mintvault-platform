/**
 * Trusted Intake Connector — Phase G2: source-fingerprint determinism (pure, no database).
 * See SOURCE-FINGERPRINT.md for the design this proves.
 */
import { describe, it, expect } from "vitest";
import {
  calculateSourceFingerprint,
  SOURCE_FINGERPRINT_VERSION,
  type FingerprintSource,
} from "../server/partner/connector-fingerprint";

function baseSource(): FingerprintSource {
  return {
    submission: {
      locationId: "loc-1",
      customerId: "cust-1",
      serviceTierCode: "standard",
      estimatedPricePence: 5000,
      cardCount: 2,
      status: "submitted_to_mintvault",
    },
    customer: { fullName: "Ada Lovelace", email: "ada@example.com", phone: "+441234567890" },
    serviceTier: { tierCode: "standard", pricePerCardPence: 2500, isActive: true },
    cards: [
      {
        sequenceNumber: 1,
        cardName: "Charizard",
        game: "pokemon",
        cardSet: "Base Set",
        cardNumber: "4/102",
        year: 1999,
        variant: null,
        language: "en",
        declaredValuePence: 100000,
        quantity: 1,
      },
      {
        sequenceNumber: 2,
        cardName: "Blastoise",
        game: "pokemon",
        cardSet: "Base Set",
        cardNumber: "2/102",
        year: 1999,
        variant: null,
        language: "en",
        declaredValuePence: 80000,
        quantity: 1,
      },
    ],
  };
}

describe("source fingerprint determinism", () => {
  it("repeated calls with the same input produce the same hash", () => {
    const source = baseSource();
    expect(calculateSourceFingerprint(source)).toBe(calculateSourceFingerprint(source));
  });

  it("card insertion order does not affect the hash (stable ordering by sequenceNumber)", () => {
    const source = baseSource();
    const reordered = { ...source, cards: [...source.cards].reverse() };
    expect(calculateSourceFingerprint(source)).toBe(calculateSourceFingerprint(reordered));
  });

  it("null vs. a real value produces different hashes (null is not silently omitted)", () => {
    const source = baseSource();
    const nulled: FingerprintSource = { ...source, customer: { ...source.customer!, phone: null } };
    expect(calculateSourceFingerprint(source)).not.toBe(calculateSourceFingerprint(nulled));
  });

  it("leading/trailing whitespace is ignored (trimmed), but case is significant", () => {
    const source = baseSource();
    const padded: FingerprintSource = { ...source, customer: { ...source.customer!, fullName: "  Ada Lovelace  " } };
    expect(calculateSourceFingerprint(source)).toBe(calculateSourceFingerprint(padded));

    const cased: FingerprintSource = { ...source, customer: { ...source.customer!, fullName: "ada lovelace" } };
    expect(calculateSourceFingerprint(source)).not.toBe(calculateSourceFingerprint(cased));
  });

  it("a card being added changes the hash", () => {
    const source = baseSource();
    const extra: FingerprintSource = {
      ...source,
      cards: [
        ...source.cards,
        {
          sequenceNumber: 3,
          cardName: "Venusaur",
          game: "pokemon",
          cardSet: "Base Set",
          cardNumber: "15/102",
          year: 1999,
          variant: null,
          language: "en",
          declaredValuePence: 60000,
          quantity: 1,
        },
      ],
    };
    expect(calculateSourceFingerprint(source)).not.toBe(calculateSourceFingerprint(extra));
  });

  it("a card being removed changes the hash", () => {
    const source = baseSource();
    const fewer: FingerprintSource = { ...source, cards: [source.cards[0]] };
    expect(calculateSourceFingerprint(source)).not.toBe(calculateSourceFingerprint(fewer));
  });

  it("a quantity change changes the hash", () => {
    const source = baseSource();
    const changed: FingerprintSource = { ...source, cards: [{ ...source.cards[0], quantity: 2 }, source.cards[1]] };
    expect(calculateSourceFingerprint(source)).not.toBe(calculateSourceFingerprint(changed));
  });

  it("a declared-value change changes the hash", () => {
    const source = baseSource();
    const changed: FingerprintSource = {
      ...source,
      cards: [{ ...source.cards[0], declaredValuePence: 999999 }, source.cards[1]],
    };
    expect(calculateSourceFingerprint(source)).not.toBe(calculateSourceFingerprint(changed));
  });

  it("a service-tier price change changes the hash", () => {
    const source = baseSource();
    const changed: FingerprintSource = { ...source, serviceTier: { ...source.serviceTier!, pricePerCardPence: 3000 } };
    expect(calculateSourceFingerprint(source)).not.toBe(calculateSourceFingerprint(changed));
  });

  it("a customer email change changes the hash", () => {
    const source = baseSource();
    const changed: FingerprintSource = { ...source, customer: { ...source.customer!, email: "different@example.com" } };
    expect(calculateSourceFingerprint(source)).not.toBe(calculateSourceFingerprint(changed));
  });

  it("a location change changes the hash", () => {
    const source = baseSource();
    const changed: FingerprintSource = { ...source, submission: { ...source.submission, locationId: "loc-2" } };
    expect(calculateSourceFingerprint(source)).not.toBe(calculateSourceFingerprint(changed));
  });

  it("returns a 64-character lowercase hex SHA-256 digest", () => {
    const hash = calculateSourceFingerprint(baseSource());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("SOURCE_FINGERPRINT_VERSION is a stable exported constant", () => {
    expect(SOURCE_FINGERPRINT_VERSION).toBe(1);
  });

  it("a fully-null customer/service-tier (missing) still produces a stable, distinct hash", () => {
    const source = baseSource();
    const missing: FingerprintSource = { ...source, customer: null, serviceTier: null };
    const again: FingerprintSource = { ...source, customer: null, serviceTier: null };
    expect(calculateSourceFingerprint(missing)).toBe(calculateSourceFingerprint(again));
    expect(calculateSourceFingerprint(missing)).not.toBe(calculateSourceFingerprint(source));
  });
});
