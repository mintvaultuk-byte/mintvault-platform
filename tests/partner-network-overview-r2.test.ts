import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");
const router = read("server/partner/dashboard-routes.ts");
const service = read("server/partner/dashboard-service.ts");
const overview = read("client/src/pages/admin/partner-network-overview.tsx");
/*
 * The per-shop table and the alert-destination mapping MOVED out of Overview during the four-tab
 * consolidation: the table is now built once, on Shops, and the mapping is a pure function shared by
 * both surfaces. These assertions follow them rather than being deleted.
 */
const shops = read("client/src/pages/admin/partner-network-shops.tsx");
const attention = read("client/src/pages/admin/partner-network-attention.ts");
const lifecycle = read("client/src/pages/admin/partner-network-lifecycle.ts");
const app = read("client/src/App.tsx");
const workspace = read("client/src/pages/admin/partner-management-detail.tsx");

describe("Partner Network R2 consolidated overview", () => {
  it("adds one base-router projection behind the existing guard chain", () => {
    const guards = router.indexOf("r.use(requireSuperAdmin)");
    const rateLimit = router.indexOf("r.use(dashboardReadRateLimit)");
    const visibility = router.indexOf("r.use(requirePartnerReadVisibility)");
    const projection = router.indexOf('r.get("/", async');
    expect(guards).toBeGreaterThan(-1);
    expect(guards).toBeLessThan(rateLimit);
    expect(rateLimit).toBeLessThan(visibility);
    expect(visibility).toBeLessThan(projection);
    expect(router).toContain("getPartnerNetworkOverview(walletSchemaOf(req))");
    expect(router).toContain("dashboard_network_overview_viewed");
  });

  it("uses bounded set-based server composition and no browser fan-out", () => {
    expect(service).toContain("listPartnersForDashboard({ sort: \"created_at\", direction: \"desc\" }, 1, 50, walletSchema)");
    expect(service).toContain("getAlerts(50, walletSchema)");
    expect(overview).toContain('apiRequest("GET", BASE)');
    expect(overview).not.toContain("/summary");
    expect(overview).not.toContain("/alerts");
    expect(overview).not.toContain("/partners?");
  });

  it("mounts the canonical overview and provides real workspace destinations", () => {
    expect(app).toContain("AdminPartnerNetworkOverviewPage");
    // Per-shop destinations now hang off the Shops table, which owns the shop list.
    for (const destination of ["/onboarding", "/cards", "/staff", "/credits", "/security"]) {
      expect(shops).toContain(destination);
    }
    // Overview keeps the honesty rule for its own summary numbers.
    expect(overview).toContain("never as zero");
    expect(workspace).toContain("/api/admin/grading-queue?status=all&partnerId=");
    expect(workspace).toContain("/admin/staff?certId=${item.certId}");
    expect(workspace).toContain('item.graderStatus === "pending_review"');
  });

  it("uses the stable alert source contract and authoritative location/station signals", () => {
    expect(attention).toContain('alert.id.startsWith("sec-")');
    expect(attention).toContain('alert.id.startsWith("credit-")');
    expect(attention).toContain('alert.id.startsWith("lock-")');
    expect(attention).toContain('alert.id.startsWith("esc-")');
    /*
     * Needs Attention no longer hard-codes a destination per condition. It renders the server's
     * single next-action verdict and resolves WHERE that points through the one shared helper, so
     * the authoritative "no active location" signal still lands on that shop's Locations — it is
     * just no longer a literal in this file. Asserting the literal would now be asserting the
     * duplication that was removed.
     */
    expect(attention).toContain("nextActionHref");
    expect(lifecycle).toContain('suffix: "/locations"');
    expect(shops).toContain("/stations");
    expect(service).toContain("active_locations");
    expect(service).toContain("station_attention");
    expect(service).toContain("FROM partner_stations GROUP BY tenant_id");
  });
});
