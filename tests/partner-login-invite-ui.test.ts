import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("partner login and invitation UI source assertions", () => {
  it("partner login uses one generic credential failure message", () => {
    const src = read("client/src/pages/partner/login.tsx");
    expect(src).toContain("We could not sign you in with those details.");
    expect(src).toContain("status === 401 || status === 429 || status === 503");
    expect(src).not.toContain("Not found");
  });

  it("partner invitation page sets a user-owned password without exposing tenant/email/role controls", () => {
    const src = read("client/src/pages/partner/invite.tsx");
    expect(src).toContain("/api/partner/invitations/preview");
    expect(src).toContain("/api/partner/invitations/accept");
    expect(src).toContain('autoComplete="new-password"');
    expect(src).toContain('data-testid="form-partner-invite"');
    expect(src).toContain("partner-invite-preview");
    expect(src).toContain("Your account is ready, but your shop is awaiting activation.");
    expect(src).toContain("This password is created by you and is never shown to MintVault admins.");
    expect(src).not.toContain("partnerId");
    expect(src).not.toContain('name="role"');
    expect(src).not.toContain('name="email"');
  });

  it("super-admin partner detail renders server readiness and gated invitation copy controls", () => {
    const src = read("client/src/pages/admin/partner-management-detail.tsx");
    expect(src).toContain("/onboarding-readiness");
    expect(src).toContain("pm-onboarding-section");
    // The badge still renders the server's onboarding state with underscores stripped, but the
    // read must stay NULL-SAFE: Fly does a rolling deploy across two machines, so a new bundle
    // can be served alongside an older API that returns readiness without `onboardingState`.
    // A bare `onboardingState.replaceAll` would throw in render and white-screen the page, so
    // the guard is pinned here to stop it being "simplified" back.
    expect(src).toContain('onboardingState ?? "UNKNOWN"');
    expect(src).toContain('.replaceAll("_", " ")');
    expect(src).toContain("Password configured");
    expect(src).toContain("MFA configured");
    expect(src).toContain("Send password setup");
    expect(src).toContain("Reset MFA");
    expect(src).toContain("copy-invitation-link");
    expect(src).toContain("Staging/internal only.");
  });

  it("invite route is mounted before guarded partner routes", () => {
    const app = read("client/src/App.tsx");
    expect(app.indexOf('path="/partner/invite"')).toBeGreaterThan(app.indexOf('path="/partner/login"'));
    expect(app.indexOf('path="/partner/invite"')).toBeLessThan(app.indexOf('path="/partner/dashboard"'));
  });

  it("partner dashboard gives an operational Scanner handoff without inventing station readiness", () => {
    const src = read("client/src/pages/partner/dashboard.tsx");
    expect(src).toContain("action-scan-new-card");
    const flat = src.replace(/\s+/g, " ");
    expect(flat).toContain("Use the approved MintVault Scanner station.");
    expect(flat).toContain("The station confirms capture authority and credit reservation.");
    expect(src).not.toContain("card-dashboard-scanner-station");
  });
});
