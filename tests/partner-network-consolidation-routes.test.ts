import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalLegacyPartnerDestination } from "../client/src/lib/partner-network-legacy-redirect";

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

  it("has NO consolidation feature flag, and preserves legacy redirect meaning", () => {
    /*
     * The flag is deliberately gone rather than flipped on. It shipped `false`, which left the
     * consolidated surfaces unreachable while six navigation links collapsed onto two legacy pages —
     * the flag WAS the duplication mechanism. A surface cannot drift from one that no longer exists.
     */
    expect(app).not.toContain("VITE_PARTNER_NETWORK_CONSOLIDATION");
    expect(app).toContain("window.location.search");
    expect(app).toContain("window.location.hash");
    expect(app).toContain("/admin/partner-network/partners/:partnerId");
    expect(app).toContain("canonicalLegacyPartnerDestination");
  });

  it("translates emitted dashboard alerts to canonical workspace routes without dropping unrelated state", () => {
    const partner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    expect(
      canonicalLegacyPartnerDestination(
        "/admin/partners",
        "/admin/partners/dashboard",
        `?partner=${partner}&tab=wallet&source=alert`,
        "#credits"
      )
    ).toBe(`/admin/partners/${partner}/credits?source=alert#credits`);
    expect(
      canonicalLegacyPartnerDestination(
        "/admin/partners",
        "/admin/partners/dashboard",
        `?partner=${partner}&tab=security`,
        ""
      )
    ).toBe(`/admin/partners/${partner}/security`);
    expect(
      canonicalLegacyPartnerDestination(
        "/admin/partners",
        "/admin/partners/dashboard",
        `?partner=${partner}&tab=staff`,
        ""
      )
    ).toBe(`/admin/partners/${partner}/staff`);
    expect(
      canonicalLegacyPartnerDestination(
        "/admin/partners",
        "/admin/partners/dashboard",
        `?partner=${partner}&tab=corrections`,
        ""
      )
    ).toBeNull();
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
