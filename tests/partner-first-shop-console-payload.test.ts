/**
 * The guided first-shop console must SEND the values it SHOWS.
 *
 * There is no React render harness in this repository, so this pins the invariant at source, in the
 * same style as tests/partner-mfa-pending-reconciliation.test.ts. The behavioural half — that the
 * server refuses the blank payload and writes nothing — is proven over real HTTP in
 * tests/partner-first-shop-save-actions.test.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PAGE = readFileSync(join(process.cwd(), "client/src/pages/admin/partner-first-shop-onboarding.tsx"), "utf8");

const BILLING = readFileSync(join(process.cwd(), "client/src/pages/partner/billing.tsx"), "utf8");

const saveAddress = PAGE.slice(PAGE.indexOf("const saveAddress = useMutation"), PAGE.indexOf("const saveContact = useMutation"));
const saveContact = PAGE.slice(PAGE.indexOf("const saveContact = useMutation"), PAGE.indexOf("const activate = useMutation"));

describe("guided first-shop console sends what it displays", () => {
  it("posts the DISPLAYED delivery address, never the raw edit state", () => {
    expect(saveAddress).toContain("deliveryAddress: addressValue,");
    expect(saveAddress).not.toContain("deliveryAddress: address,");
  });

  it("posts the DISPLAYED contact name and email, never the raw edit state", () => {
    expect(saveContact).toContain("fullName: contactNameValue,");
    expect(saveContact).toContain("email: contactEmailValue,");
    expect(saveContact).not.toContain("fullName: contactName,");
    expect(saveContact).not.toContain("email: contactEmail,");
  });

  it("still derives the displayed values from the saved record when nothing has been typed", () => {
    expect(PAGE).toContain('const addressValue = partnerId && address.line1 === "" ? existingAddress : address;');
    expect(PAGE).toContain('const contactNameValue = partnerId && contactName === "" ? contact?.full_name ?? "" : contactName;');
    expect(PAGE).toContain('const contactEmailValue = partnerId && contactEmail === "" ? contact?.email ?? "" : contactEmail;');
  });

  it("declares those derived values BEFORE the mutations that send them", () => {
    expect(PAGE.indexOf("const addressValue =")).toBeLessThan(PAGE.indexOf("const saveAddress = useMutation"));
    expect(PAGE.indexOf("const contactEmailValue =")).toBeLessThan(PAGE.indexOf("const saveContact = useMutation"));
  });

  it("stops the Credits & Billing webhook poll once a request fails", () => {
    // An unbounded 4-second poll on a page whose session has ended never recovers and never stops.
    expect(BILLING).toContain("refetchInterval: (query) => (awaitingWebhook && !query.state.error ? 4000 : false)");
    expect(BILLING).not.toContain("refetchInterval: awaitingWebhook ? 4000 : false");
  });

  it("takes BUY straight to Stripe with no MintVault password prompt in the way", () => {
    // Case 2. The prompt was produced by the generic runProtected wrapper reacting to the server's
    // 403 step_up_required. With the server gate gone, wrapping here would leave a prompt that can
    // never fire and a comment claiming a protection that no longer exists.
    const checkout = BILLING.slice(BILLING.indexOf("const checkout = useMutation"), BILLING.indexOf("return ("));
    expect(checkout).toContain("mutationFn: (packCode: string) => partnerCredits.checkout(packCode),");
    expect(checkout).not.toMatch(/runProtected\(/);
    expect(BILLING).not.toContain("usePartnerStepUp");
    // The step-up mechanism itself is untouched and still used by the surfaces that need it.
    const users = readFileSync(join(process.cwd(), "client/src/pages/partner/users.tsx"), "utf8");
    expect(users).toContain("runProtected");
  });
});
