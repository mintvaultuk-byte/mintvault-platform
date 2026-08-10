/**
 * Partner credit purchase — the security properties, proved without a database.
 *
 * fulfilPartnerCreditPurchase deliberately makes every REFUSAL decision before it touches the
 * wallet, so the refusal paths are provable as pure functions. That matters: these assertions run
 * in every CI job with no fixture, no Postgres and no Stripe, so they can never be silently skipped
 * for want of an env var — which is the failure mode that let critical partner suites sit green at
 * zero executed tests.
 *
 * The grant path itself needs a real wallet and is covered by the DB-backed suites.
 */
import { describe, expect, it } from "vitest";
import { ROLE_PERMISSIONS } from "../server/partner/permissions";
import { fulfilPartnerCreditPurchase } from "../server/partner/credit-purchase-service";

/** A session shaped like Stripe's, with only the fields fulfilment reads. */
function session(meta: Record<string, string>, payment_status: string | null = "paid") {
  return {
    id: "cs_test_123",
    metadata: meta,
    payment_status,
    payment_intent: "pi_test_123",
  } as Parameters<typeof fulfilPartnerCreditPurchase>[1];
}

const GOOD = { type: "partner_credits", tenant_id: "11111111-1111-4111-8111-111111111111", package_id: "credits-100" };

describe("CREDIT-RBAC — spending authority is not viewing authority", () => {
  it("grants partner.credits.purchase to OWNER and MANAGER only", () => {
    expect(ROLE_PERMISSIONS.PARTNER_OWNER).toContain("partner.credits.purchase");
    expect(ROLE_PERMISSIONS.PARTNER_MANAGER).toContain("partner.credits.purchase");
  });

  it("REFUSES it to PARTNER_FINANCE_VIEWER — a read-only role must not spend £1,000", () => {
    // The whole reason the permission exists separately from partner.credits.view, which this role
    // does hold. Mutation CREDIT-RBAC1 (gate checkout on credits.view) turns this red.
    expect(ROLE_PERMISSIONS.PARTNER_FINANCE_VIEWER).toContain("partner.credits.view");
    expect(ROLE_PERMISSIONS.PARTNER_FINANCE_VIEWER).not.toContain("partner.credits.purchase");
  });

  it("REFUSES it to every operational and trainee role", () => {
    for (const role of ["MVGS_ASSESSMENT_TECHNICIAN", "PARTNER_RECEPTION", "PARTNER_TRAINEE"] as const) {
      expect(ROLE_PERMISSIONS[role], `${role} must not hold spending authority`).not.toContain(
        "partner.credits.purchase"
      );
    }
  });
});

describe("CREDIT-WEBHOOK — only a genuinely paid Stripe event grants credits", () => {
  it("grants NOTHING for an unpaid session", async () => {
    // checkout.session.completed also fires for delayed/async payment methods before funds settle.
    const r = await fulfilPartnerCreditPurchase("evt_1", session(GOOD, "unpaid"));
    expect(r.granted).toBe(false);
    expect(r.reason).toBe("not_paid");
  });

  it("grants NOTHING for a session still awaiting payment", async () => {
    const r = await fulfilPartnerCreditPurchase("evt_2", session(GOOD, "no_payment_required"));
    expect(r.granted).toBe(false);
    expect(r.reason).toBe("not_paid");
  });
});

describe("CREDIT-AMOUNT / CREDIT-PRICE — the browser cannot choose what it receives", () => {
  it("REFUSES a forged package id outright, even carrying a huge credits claim", async () => {
    // The decisive property: credits are a function of a KNOWN package id. A metadata `credits`
    // value cannot drive a grant on its own, because an unrecognised package never reaches the
    // wallet at all. Mutation CREDIT-AMOUNT1 (trust metadata.credits) turns this red.
    const r = await fulfilPartnerCreditPurchase(
      "evt_3",
      session({ ...GOOD, package_id: "credits-999999", credits: "100000" })
    );
    expect(r.granted).toBe(false);
    expect(r.reason).toBe("malformed_metadata");
  });

  it("REFUSES a session with no package id at all", async () => {
    const { package_id: _dropped, ...noPackage } = GOOD;
    const r = await fulfilPartnerCreditPurchase("evt_4", session({ ...noPackage, credits: "100000" }));
    expect(r.granted).toBe(false);
    expect(r.reason).toBe("malformed_metadata");
  });
});

describe("CREDIT-TENANT — a payment cannot be redirected to another shop", () => {
  it("REFUSES a session with no tenant id", async () => {
    const { tenant_id: _dropped, ...noTenant } = GOOD;
    const r = await fulfilPartnerCreditPurchase("evt_5", session(noTenant));
    expect(r.granted).toBe(false);
    expect(r.reason).toBe("malformed_metadata");
  });

  it("REFUSES an empty tenant id rather than defaulting to any wallet", async () => {
    const r = await fulfilPartnerCreditPurchase("evt_6", session({ ...GOOD, tenant_id: "   " }));
    expect(r.granted).toBe(false);
    expect(r.reason).toBe("malformed_metadata");
  });
});
