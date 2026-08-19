import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(process.cwd());
const app = readFileSync(join(root, "client/src/App.tsx"), "utf8");
const staff = readFileSync(join(root, "client/src/pages/admin-staff.tsx"), "utf8");
const routes = readFileSync(join(root, "server/routes.ts"), "utf8");

describe("Partner Network P7 route contract", () => {
  it("declares static routes before the Partner UUID route", () => {
    const stations = app.indexOf('path="/admin/partners/stations"');
    const infrastructure = app.indexOf('path="/admin/partners/infrastructure"');
    const settings = app.indexOf('path="/admin/partners/settings"');
    const partner = app.indexOf('path="/admin/partners/:partnerId"');
    expect(stations).toBeGreaterThan(-1);
    expect(infrastructure).toBeGreaterThan(-1);
    expect(settings).toBeGreaterThan(-1);
    expect(stations).toBeLessThan(partner);
    expect(infrastructure).toBeLessThan(partner);
    expect(settings).toBeLessThan(partner);
    expect(app.indexOf('path="/admin/partners/:partnerId/stations"')).toBeLessThan(partner);
  });

  it("has one exposure-only feature flag and preserves legacy redirect state", () => {
    expect(app).toContain("VITE_PARTNER_NETWORK_CONSOLIDATION");
    expect(app).toContain("window.location.search");
    expect(app).toContain("window.location.hash");
    expect(app).toContain("/admin/partner-network/partners/:partnerId");
  });

  it("keeps QA in the existing Staff review path and adds no grade mutation", () => {
    expect(staff).toContain('get("certId")');
    expect(staff).toContain("openReview(target)");
    expect(staff).toContain("not available for Staff review in the current queue");
    expect(staff).toContain('target?.graderStatus === "pending_review"');
    expect(staff).toContain("requested certificate id is invalid");
    expect(staff).toContain("GradingWorkstation");
  });

  it("extends the existing guarded queue with Partner provenance and an optional UUID filter", () => {
    expect(routes).toContain('app.get("/api/admin/grading-queue", requireAdmin');
    expect(routes).toContain("cert.origin_partner_id AS partner_id");
    expect(routes).toContain("partner.legal_name AS partner_name");
    expect(routes).toContain("partnerId must be a Partner UUID");
    expect(routes).toContain("cert.id = ${Number(certIdParam)}");
    expect(staff).toContain('params.set("certId", String(requestedCertId))');
  });
});
