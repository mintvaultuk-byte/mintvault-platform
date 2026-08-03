import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const shell = readFileSync("client/src/components/partner/partner-shell.tsx", "utf8");
const css = readFileSync("client/src/styles/partner-portal.css", "utf8");
const dashboard = readFileSync("client/src/pages/partner/dashboard.tsx", "utf8");
const billing = readFileSync("client/src/pages/partner/billing.tsx", "utf8");
const security = readFileSync("client/src/pages/partner/security.tsx", "utf8");
const routes = readFileSync("server/partner/routes.ts", "utf8");
const viewService = readFileSync("server/partner/portal-view-service.ts", "utf8");

describe("Partner Portal black-and-gold shell", () => {
  it("uses a scoped dark shell, MintVault logo, shop identity and no Super Admin navigation", () => {
    expect(shell).toContain("partner-portal");
    expect(shell).toContain("/brand/logo.png");
    expect(shell).toContain("session?.tradingName");
    expect(shell).toContain("session.role");
    expect(css).toContain("background: #0e0d0b");
    expect(css).toContain("#d4af37");
    expect(shell).not.toMatch(/Super Admin|\/admin\//);
  });

  it("has keyboard focus, mobile navigation and stable horizontal containment", () => {
    expect(css).toContain(":focus-visible");
    expect(shell).toContain("aria-expanded={mobileOpen}");
    expect(shell).toContain("partner-portal__mobile-nav");
    expect(billing).toContain("overflow-x-auto");
    expect(css).toContain("max-width: 767px");
  });
});

describe("real credit values and honest unavailable states", () => {
  it("loads the partner credit API on Dashboard and Billing", () => {
    expect(dashboard).toContain("partnerCredits.view()");
    expect(billing).toContain("partnerCredits.view()");
    expect(routes).toContain('r.get("/credits"');
  });

  it("never defaults an absent wallet or unsupported metric to zero", () => {
    expect(dashboard).not.toMatch(/\?\?\s*0/);
    expect(billing).toContain("Unknown");
    expect(billing).toContain("Not available");
    expect(dashboard).toContain("Not available");
  });

  it("orders immutable ledger rows and calculates running balance in PostgreSQL", () => {
    expect(viewService).toMatch(/SUM\(l\.amount\) OVER \(ORDER BY l\.created_at ASC, l\.id ASC\)/);
    expect(viewService).toMatch(/ORDER BY l\.created_at DESC, l\.id DESC/);
    expect(billing).toContain("runningBalance");
    expect(billing).toContain("submissionReference");
  });
});

describe("session and navigation controls", () => {
  it("provides explicit sign out plus session list and revocation", () => {
    expect(shell).toContain("handleSignOut");
    expect(shell).toContain("Sign out");
    expect(security).toContain("partnerSessions.list()");
    expect(security).toContain("partnerSessions.revoke(sessionId)");
    expect(routes).toContain('r.post("/sessions/:id/revoke"');
  });
});
