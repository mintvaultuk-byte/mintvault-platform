/**
 * Partner credit package catalogue — server-authoritative pricing.
 *
 * These are the assertions that stop a browser choosing what it pays. They are deliberately pure
 * (no DB, no network) so they run in every CI job and can never be skipped for want of a fixture.
 */
import { describe, expect, it } from "vitest";
import {
  PARTNER_CREDIT_CURRENCY,
  PARTNER_CREDIT_PACKAGES,
  PARTNER_CREDIT_UNIT_PRICE_PENCE,
  creditPackagePricingIsConsistent,
  findCreditPackage,
  stripeCreditLedgerIdempotencyKey,
} from "@shared/partner-credit-packages";

describe("Partner credit packages — the owner-locked price list", () => {
  it("prices every package at exactly £10 per credit", () => {
    // A typo making 100 credits cost £100 is a silent 90% discount no type check would catch.
    expect(creditPackagePricingIsConsistent()).toBe(true);
    expect(PARTNER_CREDIT_UNIT_PRICE_PENCE).toBe(1000);
  });

  it("carries exactly the four launch packages the owner specified", () => {
    expect(PARTNER_CREDIT_PACKAGES.map((p) => [p.credits, p.pricePence])).toEqual([
      [10, 10_000],
      [25, 25_000],
      [50, 50_000],
      [100, 100_000],
    ]);
    expect(PARTNER_CREDIT_CURRENCY).toBe("gbp");
  });

  it("holds prices in integer pence, never floats", () => {
    for (const p of PARTNER_CREDIT_PACKAGES) {
      expect(Number.isSafeInteger(p.pricePence), `${p.id} price must be an integer`).toBe(true);
      expect(Number.isSafeInteger(p.credits), `${p.id} credits must be an integer`).toBe(true);
    }
  });

  it("has unique, stable package ids", () => {
    const ids = PARTNER_CREDIT_PACKAGES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("findCreditPackage — the forgery boundary", () => {
  it("resolves a legitimate package to server-held credits and price", () => {
    const pkg = findCreditPackage("credits-100");
    expect(pkg).toBeDefined();
    expect(pkg!.credits).toBe(100);
    expect(pkg!.pricePence).toBe(100_000);
  });

  it("REFUSES an unknown package instead of defaulting", () => {
    // The critical property: no fallback. A forged id must yield nothing, never the cheapest or
    // the first package — either of which would be a free/discounted credit grant.
    expect(findCreditPackage("credits-9999")).toBeUndefined();
    expect(findCreditPackage("")).toBeUndefined();
    expect(findCreditPackage("../credits-100")).toBeUndefined();
  });

  it("REFUSES non-string input, including an object that mimics a package", () => {
    // If a caller ever spread req.body straight in, this is what stops a self-declared price.
    expect(findCreditPackage(undefined)).toBeUndefined();
    expect(findCreditPackage(null)).toBeUndefined();
    expect(findCreditPackage(123)).toBeUndefined();
    expect(findCreditPackage({ id: "credits-100", credits: 10_000, pricePence: 1 })).toBeUndefined();
    expect(findCreditPackage(["credits-100"])).toBeUndefined();
  });

  it("ignores any client-sent credits/price even when the id is valid", () => {
    // Resolution is by id ONLY. Whatever else the body carried is not consulted, so a request
    // claiming {packageId:"credits-10", credits:100} still buys 10.
    const pkg = findCreditPackage("credits-10");
    expect(pkg!.credits).toBe(10);
    expect(pkg!.pricePence).toBe(10_000);
  });
});

describe("stripeCreditLedgerIdempotencyKey", () => {
  it("keys on the Stripe EVENT id so a redelivery collapses onto one ledger row", () => {
    expect(stripeCreditLedgerIdempotencyKey("evt_123")).toBe("stripe-evt:evt_123");
    // Same event twice => identical key => uq_partner_credit_ledger_idem (source, idempotency_key)
    // resolves it to the original row rather than minting a second credit.
    expect(stripeCreditLedgerIdempotencyKey("evt_123")).toBe(stripeCreditLedgerIdempotencyKey("evt_123"));
  });

  it("distinguishes different events", () => {
    expect(stripeCreditLedgerIdempotencyKey("evt_a")).not.toBe(stripeCreditLedgerIdempotencyKey("evt_b"));
  });

  it("stays inside the ledger's 200-char idempotency_key limit for realistic ids", () => {
    expect(stripeCreditLedgerIdempotencyKey("evt_1PxYzAbCdEfGhIjKlMnOpQrS").length).toBeLessThan(200);
  });
});
