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
    expect(src).toContain("/api/partner/invitations/accept");
    expect(src).toContain('autoComplete="new-password"');
    expect(src).toContain('data-testid="form-partner-invite"');
    expect(src).not.toContain("partnerId");
    expect(src).not.toContain('name="role"');
    expect(src).not.toContain('name="email"');
  });

  it("invite route is mounted before guarded partner routes", () => {
    const app = read("client/src/App.tsx");
    expect(app.indexOf('path="/partner/invite"')).toBeGreaterThan(app.indexOf('path="/partner/login"'));
    expect(app.indexOf('path="/partner/invite"')).toBeLessThan(app.indexOf('path="/partner/dashboard"'));
  });
});
