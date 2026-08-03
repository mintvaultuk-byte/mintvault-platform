import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("partner onboarding and login-control source guards", () => {
  it("admin copy-link is feature gated, staging/local scoped, and production refused", () => {
    const svc = read("server/partner/partner-management-service.ts");
    const routes = read("server/partner/partner-management-routes.ts");
    expect(svc).toContain("function adminInviteLinkCopyAllowed()");
    expect(svc).toContain('process.env.PARTNER_INVITE_ALLOW_ADMIN_LINK_COPY !== "true"');
    expect(svc).toContain('process.env.FLY_APP_NAME ?? ""');
    expect(svc).toContain('appName === "mintvault-v2"');
    expect(svc).toContain('process.env.NODE_ENV !== "production"');
    expect(svc).toContain(
      'throw new G5RequestError("FORBIDDEN", "Invitation link copy is not available in this environment.")'
    );
    expect(routes).toContain("/copy-invitation-link");
  });

  it("server readiness owns login enablement and blocked reasons", () => {
    const svc = read("server/partner/partner-management-service.ts");
    const routes = read("server/partner/partner-management-routes.ts");
    expect(routes).toContain("/onboarding-readiness");
    expect(svc).toContain("getPartnerOnboardingReadiness");
    expect(svc).toContain("organisationActive");
    expect(svc).toContain("passwordConfigured");
    expect(svc).toContain("loginEnabled: portalEnabled && organisationActive && userActive && passwordConfigured");
    expect(svc).toContain("blockedReasons.push(`Organisation is ${row.org_status}.`)");
    expect(svc).toContain("No valid invitation is available for the partner to create a password.");
  });

  it("invitation preview is token-derived and acceptance reports pending organisation state", () => {
    const svc = read("server/partner/partner-management-service.ts");
    const routes = read("server/partner/public-routes.ts");
    expect(routes).toContain("/invitations/preview");
    expect(routes).toContain("getPartnerInvitationPreview(token)");
    expect(routes).toContain("organisationStatus: result.organisationStatus");
    expect(svc).toContain("getPartnerInvitationPreview");
    const previewStart = svc.indexOf("export async function getPartnerInvitationPreview");
    const previewEnd = svc.indexOf(
      "// ---------------------------------------------------------------------------",
      previewStart
    );
    const previewFn = svc.slice(previewStart, previewEnd);
    expect(previewFn).toContain("WHERE i.token_hash = $1");
    expect(previewFn).not.toContain("WHERE i.email = $1");
    expect(svc).toContain("sha256(token)");
    expect(svc).toContain("organisationStatus: inv.org_status");
  });
});
