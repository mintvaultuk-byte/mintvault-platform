import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("Partner Portal team management UI source assertions", () => {
  const page = read("client/src/pages/partner/users.tsx");
  const app = read("client/src/App.tsx");
  const api = read("client/src/lib/partner-api.ts");
  const shell = read("client/src/components/partner/partner-shell.tsx");

  it("mounts the real Partner Users page instead of the coming-soon placeholder", () => {
    expect(app).toContain('path="/partner/users"');
    expect(app).toContain('import("@/pages/partner/users")');
    expect(app).not.toContain('const PartnerUsersPage = lazy(() => import("@/pages/partner/coming-soon"))');
  });

  it("keeps the navigation permission-gated to partner.users.view", () => {
    expect(shell).toContain(
      '{ href: "/partner/users", label: "Users", icon: Users, permission: "partner.users.view" }'
    );
  });

  it("renders the expected team table, empty state, invite form, and action controls", () => {
    for (const required of [
      "partner-team-page",
      "text-partner-team-title",
      "partner-team-empty",
      "partner-team-table",
      "button-team-add-member",
      "dialog-team-invite",
      "input-team-first-name",
      "input-team-last-name",
      "input-team-email",
      "select-team-invite-role",
      "button-team-resend-",
      "button-team-revoke-invite-",
      "button-team-suspend-",
      "button-team-reactivate-",
      "button-team-remove-",
      "button-team-revoke-sessions-",
      "dialog-team-action",
      "dialog-team-role",
    ]) {
      expect(page).toContain(required);
    }
  });

  it("uses permission-aware ownership controls and final-owner warning text", () => {
    expect(page).toContain('hasPermission("partner.users.manage")');
    expect(page).toContain('hasPermission("partner.sessions.revoke")');
    expect(page).toContain('currentUser?.role === "OWNER"');
    expect(page).toContain('u.role === "OWNER"');
    expect(page).toContain("A partner must keep at least one active owner.");
  });

  it("calls only the partner-scoped team endpoints and does not expose secrets", () => {
    for (const endpoint of [
      '"/api/partner/users"',
      "/resend-invitation",
      "/revoke-invitation",
      "/role",
      "/status",
      "/revoke-sessions",
    ]) {
      expect(api).toContain(endpoint);
    }
    const teamApiSection = api.slice(api.indexOf("// ---- team ----"), api.indexOf("// ---- service tiers ----"));
    const combined = `${page}\n${teamApiSection}`;
    expect(combined).not.toContain("password_hash");
    expect(combined).not.toContain("token_hash");
    expect(combined).not.toContain("invitationLink");
    expect(combined).not.toContain("partnerId:");
    expect(combined).not.toContain("tenantId:");
  });
});
