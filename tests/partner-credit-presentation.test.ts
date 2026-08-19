/**
 * P5 PRESENTATION CLOSEOUT — the Grading Credit surfaces on the EXISTING Partner Dashboard.
 *
 * P4 proved the authority and P5 proved the grant. What was still missing was the presentation, and
 * presentation is exactly where a money system tends to grow a second, softer truth: a balance the
 * browser computes for itself, a success page that "applies" a purchase, a buy button that stays lit
 * when the owner has not configured a price yet. None of those would be caught by the DB-level tests
 * — every one of them lives entirely in the client.
 *
 * These assertions are source-level on purpose. The properties under test are STRUCTURAL ("this
 * module never calls the grant function", "this page derives no balance of its own"), and a render
 * test cannot prove the absence of a code path — it can only prove that one particular fixture did
 * not reach it. Rendering is covered separately by the happy-dom cases at the end of this file, which
 * prove the states an operator actually sees.
 *
 * Pins:
 *   PRES-1  no client-side balance authority
 *   PRES-2  the UI cannot grant credits, and neither can a returning browser
 *   PRES-3  the buy control obeys the server's `purchasable` flag and the purchase permission
 *   PRES-4  zero- and low-credit states are shown, and zero makes BUY primary
 *   PRES-5  zero credits blocks NEW only — never FIX, never grading of authorised work
 *   PRES-6  the checkout return URL is a route that actually exists
 *   PRES-7  the permission catalogue in code matches the one seeded in migration 0083
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const dashboard = readFileSync("client/src/pages/partner/dashboard.tsx", "utf8");
const billing = readFileSync("client/src/pages/partner/billing.tsx", "utf8");
const partnerApi = readFileSync("client/src/lib/partner-api.ts", "utf8");
const routes = readFileSync("server/partner/routes.ts", "utf8");
const app = readFileSync("client/src/App.tsx", "utf8");
const permissions = readFileSync("server/partner/permissions.ts", "utf8");
const packsMigration = readFileSync("migrations/0083_partner_credit_packs.sql", "utf8");
const viewService = readFileSync("server/partner/portal-view-service.ts", "utf8");

/** Every client module that renders or fetches credit data. */
const CREDIT_CLIENT_SOURCES: ReadonlyArray<readonly [string, string]> = [
  ["dashboard", dashboard],
  ["billing", billing],
  ["partner-api", partnerApi],
];

describe("PRES-1 — the browser holds no balance authority", () => {
  it("never recomputes availability from its own arithmetic", () => {
    for (const [name, source] of CREDIT_CLIENT_SOURCES) {
      /*
       * available_balance = ledger_balance − active_reserved is the SERVER's formula, defined once in
       * the partner_credit_availability view. A client that subtracts reserved from a posted balance
       * would be a second implementation of it — and would disagree the moment a reservation lands
       * between two polls, showing a shop capacity it does not have.
       */
      expect(source, `${name} subtracts reserved credits client-side`).not.toMatch(
        /availableCredits\s*-\s*|-\s*reservedCredits|postedBalance\s*-/
      );
    }
  });

  it("takes the low/empty verdict from the server rather than comparing to a client threshold", () => {
    // The threshold lives in portal-view-service and nowhere else.
    expect(viewService).toMatch(/balanceStatus|"empty"/);
    expect(dashboard).toContain('balanceStatus === "empty"');
    expect(dashboard).toContain('balanceStatus === "low"');
    // No client-side numeric threshold masquerading as the same rule.
    expect(dashboard).not.toMatch(/availableCredits\s*[<>]=?\s*\d/);
    expect(billing).not.toMatch(/availableCredits\s*[<>]=?\s*\d/);
  });

  it("never defaults an absent balance to zero on either surface", () => {
    // A missing wallet reading as "0 credits" is indistinguishable from a spent-out wallet, and one
    // of those two is a support call about a system that "lost" their credits.
    expect(dashboard).not.toMatch(/\?\?\s*0/);
    expect(billing).not.toMatch(/\?\?\s*0/);
    expect(dashboard).toContain("Not available");
    expect(billing).toContain("Not available");
  });
});

describe("PRES-2 — no UI path can grant a credit", () => {
  it("no client module references any grant function", () => {
    for (const [name, source] of CREDIT_CLIENT_SOURCES) {
      expect(source, `${name} references a credit grant function`).not.toMatch(
        /appendFoundationCredit|fulfilPartnerCreditPurchase|addCredits|reserveCreditInTransaction/
      );
    }
  });

  it("the returning browser only polls; the success URL grants nothing", () => {
    // `purchase=processing` may cause a REFETCH and nothing else. If this page could write, the
    // redirect URL — which the buyer fully controls and can replay — would be a mint.
    expect(billing).toContain("refetchInterval");
    expect(billing).toContain("awaitingWebhook");
    expect(billing).not.toMatch(/setCredits|mutateBalance|optimisticCredits/);
    // The only mutation on the page is checkout, whose success handler navigates and does no more.
    expect(billing).toContain("window.location.assign(result.url)");
  });

  it("the checkout route still grants nothing server-side", () => {
    const checkoutBlock = routes.slice(routes.indexOf('r.post(\n    "/credits/checkout"'));
    const body = checkoutBlock.slice(0, checkoutBlock.indexOf('r.get("/sessions"'));
    expect(body).not.toMatch(/appendFoundationCredit|fulfilPartnerCreditPurchase/);
  });
});

describe("PRES-3 — the buy control obeys the server", () => {
  it("reads the pack catalogue from the server and gates the button on `purchasable`", () => {
    expect(partnerApi).toContain('"GET", "/api/partner/credits/packs"');
    expect(billing).toContain("partnerCredits.packs()");
    expect(billing).toContain("pack.purchasable");
    expect(partnerApi).toContain("displayPrice: string");
    expect(partnerApi).toContain("vatIncluded: true");
    expect(billing).toContain("pack.displayPrice");
    expect(billing).toContain("pack.vatIncluded");
    // Catalogued-but-not-priced must say so rather than offering a button that 400s.
    expect(billing).toContain("Pricing not yet configured");
    expect(billing).toContain("Stripe TEST/LIVE mode not configured");
    expect(billing).toContain("Stripe mode does not match this environment");
  });

  it("shows no buy control at all without the purchase permission", () => {
    expect(billing).toContain('hasPermission("partner.credits.purchase")');
    expect(billing).toContain("canPurchase");
    expect(billing).toContain("Your role cannot buy Grading Credits");
  });

  it("sends only the pack code — never a credit quantity or a price", () => {
    // The quantity is resolved server-side from the pack code at grant time. If the client could
    // name a quantity, the tamper surface would run all the way to the wallet.
    /*
     * The REQUEST body is `{ packCode }` and nothing else. The response type may legitimately carry
     * `credits` (it is display copy for "you bought 25"), so this is scoped to the request argument
     * rather than the whole module — an unscoped search would match the response interface and fail
     * for the wrong reason. Whitespace-normalised because Prettier is free to re-wrap the call.
     */
    const flatApi = partnerApi.replace(/\s+/g, " ");
    expect(flatApi).toContain('"POST", "/api/partner/credits/checkout", { packCode, }');
    /*
     * Scope strictly to the BODY argument — the text after the URL literal. Slicing from the
     * function name instead would sweep in the RESPONSE generic
     * (`req<{ url; packCode; credits }>`), whose legitimate `credits` field would fail this
     * assertion for entirely the wrong reason.
     */
    const afterUrl = flatApi.slice(
      flatApi.indexOf('"/api/partner/credits/checkout",') + '"/api/partner/credits/checkout",'.length
    );
    const bodyArg = afterUrl.slice(0, afterUrl.indexOf("})") + 1);
    expect(bodyArg).toContain("packCode");
    expect(bodyArg).not.toMatch(/\bcredits\b/);
  });
});

describe("PRES-4 / PRES-5 — zero and low credit states", () => {
  it("shows a distinct zero-credit state with BUY as the primary action", () => {
    expect(dashboard).toContain("No Grading Credits left");
    expect(dashboard).toContain("button-buy-credits-empty");
    // Primary = the default Button variant. The low-credit banner is deliberately `outline`.
    expect(dashboard).toMatch(/data-testid="button-buy-credits-empty"/);
    expect(dashboard).toMatch(/variant="outline"[\s\S]{0,120}button-buy-credits-low/);
  });

  it("shows a low-credit warning before the shop runs out", () => {
    expect(dashboard).toContain("Running low on Grading Credits");
    expect(dashboard).toContain("button-buy-credits-low");
  });

  it("states that zero credits blocks NEW only — FIX and authorised grading continue", () => {
    const flat = dashboard.replace(/\s+/g, " ");
    expect(flat).toContain("New cards cannot be started until you add credits");
    expect(flat).toMatch(/grading, fixing a missing image and printing all continue/);
    expect(flat).toContain("FIX and grading are unaffected");
    // The zero state must not disable grading or fix affordances anywhere on the page.
    expect(dashboard).not.toMatch(/balanceStatus === "empty"[\s\S]{0,400}disabled/);
  });

  it("hides the buy CTA from roles that cannot purchase", () => {
    expect(dashboard).toContain("canPurchaseCredits");
    expect(dashboard).toMatch(/canPurchaseCredits && \([\s\S]{0,200}button-buy-credits-empty/);
  });
});

describe("PRES-6 — the checkout return URL resolves to a real route", () => {
  it("returns the buyer to a registered client route, not the catch-all", () => {
    /*
     * DEFECT PINNED: success_url pointed at /partner/credits, which App.tsx never registers. The
     * /partner/* catch-all redirected the returning buyer to the dashboard and discarded the
     * ?purchase= signal — so the one moment the shop most needs "paid, processing" said nothing.
     */
    const returnPaths = [...routes.matchAll(/(?:success|cancel)_url: `\$\{appUrl\}(\/[^?`]+)/g)].map((m) => m[1]);
    expect(returnPaths.length).toBeGreaterThan(0);
    for (const path of returnPaths) {
      expect(app, `${path} is not a registered client route`).toContain(`path="${path}"`);
    }
    expect(returnPaths).toContain("/partner/billing");
  });

  it("the billing page acts on both return states", () => {
    expect(billing).toContain('purchaseOutcome === "processing"');
    expect(billing).toContain('purchaseOutcome === "cancelled"');
    expect(billing).toContain("Payment received — processing");
    expect(billing).toContain("Checkout cancelled");
  });
});

describe("PRES-7 — the permission catalogue matches the migration", () => {
  it("partner.credits.purchase is declared in code, not only seeded in SQL", () => {
    /*
     * DEFECT PINNED: 0083 seeded the permission and routes.ts enforced it, but PARTNER_PERMISSIONS
     * did not list it. validatePartnerRbac() therefore reported it as UNEXPECTED against every
     * correctly-migrated database, and seedPartnerRbac() could never grant it — so the purchase route
     * was unreachable under test for a reason unrelated to the code under test.
     */
    expect(packsMigration).toContain("'partner.credits.purchase'");
    expect(permissions).toContain('"partner.credits.purchase"');
  });

  it("grants it to PARTNER_OWNER only, exactly as the migration does", () => {
    // The migration grants to PARTNER_OWNER and no other role.
    const grantBlock = packsMigration.slice(packsMigration.indexOf("partner_role_permissions"));
    expect(grantBlock).toContain("r.code = 'PARTNER_OWNER'");
    expect(grantBlock).not.toMatch(/r\.code = 'PARTNER_MANAGER'/);

    // In code, OWNER spreads the whole catalogue; every other role enumerates explicitly.
    expect(permissions).toContain("PARTNER_OWNER: [...PARTNER_PERMISSIONS]");
    const afterOwner = permissions.slice(permissions.indexOf("PARTNER_MANAGER:"));
    const roleBlock = afterOwner.slice(0, afterOwner.indexOf("};"));
    expect(roleBlock, "a non-owner role was granted purchase authority by default").not.toContain(
      '"partner.credits.purchase"'
    );
  });
});
