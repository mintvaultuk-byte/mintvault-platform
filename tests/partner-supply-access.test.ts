/**
 * SUPPLIES IS PARTNER-ONLY. Proven from the route wiring, not from a page choosing to render less.
 *
 * Owner decision (2026-08-22): the supplies catalogue is never public. A shop buys through its own
 * authenticated Partner dashboard; an unauthenticated visitor has no way in at all.
 *
 * These are SOURCE assertions on purpose. Access here is decided by which router a route is mounted
 * on and which middleware sits in front of it, and that is a structural fact — a request-level test
 * against a stubbed session would prove the stub, not the mounting. The behavioural guarantees
 * (tenant isolation, capability enforcement) already have their own real-database suites; what this
 * pins is that supplies is wired into them and cannot drift out.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");
const mount = read("server/partner/mount.ts");
const partnerRoutes = read("server/partner/supply-routes.ts");
const adminRoutes = read("server/partner/supply-admin-routes.ts");
const migration = read("migrations/0112_partner_supply_commerce.sql");
const partnerPage = read("client/src/pages/partner/supplies.tsx");
const adminPage = read("client/src/pages/admin/partner-supplies.tsx");
const app = read("client/src/App.tsx");
const serverRoutes = read("server/routes.ts");

describe("supplies is reachable only by an authenticated Partner", () => {
  it("mounts the partner supply router inside the partner surface, not on a public router", () => {
    expect(mount).toContain("partnerSupplyRouter()");
    // The partner router is mounted AFTER the session/authentication gates that protect every
    // other partner route; being inside that file is what makes it non-public.
    const at = mount.indexOf("partnerSupplyRouter()");
    expect(at).toBeGreaterThan(-1);
    expect(mount.slice(0, at)).toMatch(/requirePartnerSession|partnerSessionMiddleware|requirePartner/);
  });

  it("gates every partner supply route on a capability", () => {
    // Reads need orders.view; buying needs orders.submit AND credits.purchase, so the historically
    // broad Reception grant cannot become accidental payment authority.
    expect(partnerRoutes).toContain('requirePartnerCapability("partner.orders.view")');
    expect(partnerRoutes).toContain('requirePartnerCapability("partner.orders.submit")');
    expect(partnerRoutes).toContain('requirePartnerCapability("partner.credits.purchase")');
    expect(partnerRoutes).toContain("requireNotSensitiveFrozen");
    // No route in the partner router is left unguarded.
    const handlers = partnerRoutes.match(/r\.(get|post|put|delete)\(/g) ?? [];
    const guards = partnerRoutes.match(/requirePartnerCapability\(/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(handlers.length);
  });

  it("exposes no public or unauthenticated supplies route anywhere", () => {
    // A public catalogue would have to be registered outside the partner mount. It is not.
    expect(serverRoutes).not.toMatch(/app\.(get|post)\(\s*["'`]\/api\/public\/supplies/);
    expect(serverRoutes).not.toMatch(/app\.(get|post)\(\s*["'`]\/api\/supplies/);
    expect(app).not.toContain('path="/supplies"');
  });

  it("keeps catalogue WRITES on the Super Admin router only", () => {
    expect(adminRoutes).toContain("r.use(requireSuperAdmin)");
    expect(adminRoutes).toMatch(/r\.post\(\s*"\/catalogue"/);
    expect(adminRoutes).toMatch(/r\.put\(\s*"\/catalogue\/:code"/);
    expect(adminRoutes).toMatch(/r\.post\(\s*"\/catalogue\/:code\/image"/);
    // A Partner can never reach a catalogue mutation: none exists on the partner router.
    expect(partnerRoutes).not.toContain("/catalogue");
    expect(partnerRoutes).not.toContain("activePricePence");
  });

  it("gives the Partner page no price, name or availability controls", () => {
    // The partner surface only ever reads the catalogue and starts a checkout.
    expect(partnerPage).toContain('apiRequest("GET", "/api/partner/supplies/products")');
    expect(partnerPage).toContain("/api/partner/supplies/checkout");
    expect(partnerPage).not.toContain("/catalogue");
    expect(partnerPage).not.toContain("activePricePence");
    expect(partnerPage).not.toContain("super-admin");
  });

  it("shows the Partner only ACTIVE products, and lets only priced ones be bought", () => {
    expect(partnerPage).toContain("filter((product) => product.active)");
    expect(partnerPage).toContain("disabled={!product.purchasable || busy}");
  });
});

describe("tenant isolation is enforced by the database, not by a query remembering a WHERE", () => {
  it("puts row-level security on every tenant-owned supply table", () => {
    for (const table of [
      "partner_supply_orders",
      "partner_supply_order_items",
      "partner_supply_payments",
      "partner_supply_refunds",
      "partner_supply_order_events",
    ]) {
      expect(migration).toContain(table);
    }
    expect(migration).toContain("ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("tenant_id = partner_current_tenant()");
  });

  it("denies the partner runtime any authority over price, state or refunds", () => {
    // The catalogue is global and Super-Admin-owned: the runtime may READ it and nothing more.
    expect(migration).toContain(
      "GRANT SELECT ON partner_supply_products, partner_supply_tax_settings TO partner_runtime"
    );
    expect(migration).not.toMatch(/GRANT[^;]*UPDATE[^;]*ON partner_supply_products/);
    expect(migration).not.toMatch(/GRANT[^;]*INSERT[^;]*ON partner_supply_products/);
    // The migration asserts this itself at apply time, which is stronger than trusting the grants.
    expect(migration).toContain("privilege assertion failed");
  });
});

describe("the Super Admin catalogue surface", () => {
  it("calls the base url the admin router is actually mounted on", () => {
    /*
     * A wrong base is invisible to tsc and to every source assertion that only greps for control
     * ids — it ships and every catalogue call 404s. This pins the two together: the page's BASE and
     * the mount in supply-admin-routes.ts. (Observed on staging 2026-08-22: the page used
     * /api/super-admin/partner-supply, which is not mounted.)
     */
    const mountPath = adminRoutes.match(/app\.use\("([^"]+)", partnerSupplyAdminRouter\(\)\)/)?.[1];
    expect(mountPath).toBe("/api/super-admin/supplies");
    expect(adminPage).toContain(`const BASE = "${mountPath}"`);
  });

  it("is the Supplies destination and offers add / edit / disable / image", () => {
    expect(app).toContain('path="/admin/partners/supplies" component={AdminPartnerSuppliesPage}');
    for (const control of [
      "admin-supplies-add",
      "supply-product-save",
      "supply-product-image",
      "supply-product-price",
      "admin-supplies-tab-products",
      "admin-supplies-tab-orders",
    ]) {
      expect(adminPage).toContain(control);
    }
  });

  it("states that a price change cannot rewrite a completed order", () => {
    expect(adminPage).toContain("never rewrites a completed order");
  });
});
