import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");
const router = read("server/partner/dashboard-routes.ts");
const service = read("server/partner/dashboard-service.ts");
const overview = read("client/src/pages/admin/partner-network-overview.tsx");
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
    expect(overview).toContain("/onboarding");
    expect(overview).toContain("/cards");
    expect(overview).toContain("/staff");
    expect(overview).toContain("/credits");
    expect(overview).toContain("/security");
    expect(overview).toContain("—, never as zero");
    expect(workspace).toContain("/api/admin/grading-queue?status=all&partnerId=");
    expect(workspace).toContain("/admin/staff?certId=${item.certId}");
    expect(workspace).toContain('item.graderStatus === "pending_review"');
  });
});
