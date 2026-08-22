/** Source-level contract guards for routing/UI composition not expressible through the DB service tests. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const PARTNER_ROUTES = read("server/partner/supplies-routes.ts");
const ADMIN_ROUTES = read("server/partner/supplies-admin-routes.ts");
const MOUNT = read("server/partner/mount.ts");
const MAIN_ROUTES = read("server/routes.ts");
const SERVICE = read("server/partner/supplies-service.ts");
const EMAIL = read("server/email.ts");
const APP = read("client/src/App.tsx");
const SHELL = read("client/src/components/partner/partner-shell.tsx");
const SUPPLIES = read("client/src/pages/partner/supplies.tsx");
const MY_ORDERS = read("client/src/pages/partner/supplies-orders.tsx");
const ADMIN_PAGE = read("client/src/pages/admin/partner-supplies-orders.tsx");

describe("Partner supplies route and UI composition", () => {
  it("mounts one authenticated Partner surface with explicit view/submit authority and no Partner status mutation", () => {
    expect(MOUNT).toContain("partnerSuppliesRouter()");
    expect(PARTNER_ROUTES).toContain("requirePartnerAuth");
    expect(PARTNER_ROUTES).toContain('requirePartnerCapability("partner.supplies.view")');
    expect(PARTNER_ROUTES).toContain('requirePartnerCapability("partner.supplies.submit")');
    expect(PARTNER_ROUTES).toContain("requireNotViewOnly");
    expect(PARTNER_ROUTES).toContain("requireNotSensitiveFrozen");
    expect(PARTNER_ROUTES).toContain('res.setHeader("Cache-Control", "private, no-store")');
    expect(PARTNER_ROUTES).toContain('res.setHeader("Vary", "Cookie")');
    expect(PARTNER_ROUTES).not.toContain("/status");
    expect(PARTNER_ROUTES).not.toMatch(/PATCH|PUT|DELETE/);
  });

  it("keeps order transitions Super Admin-only and step-up-protected", () => {
    expect(MAIN_ROUTES).toContain("registerPartnerSuppliesAdminRoutes(app)");
    expect(ADMIN_ROUTES).toContain("requireSuperAdmin");
    expect(ADMIN_ROUTES).toContain("getPartnerAdminCapability");
    expect(ADMIN_ROUTES).toContain("requireAdminStepUp()");
    expect(ADMIN_ROUTES).toContain('res.setHeader("Cache-Control", "private, no-store")');
    expect(ADMIN_ROUTES).toContain('res.setHeader("Vary", "Cookie")');
    expect(ADMIN_ROUTES).toContain('r.post("/orders/:orderId/status"');
    expect(ADMIN_ROUTES).toContain('r.post("/orders/:orderId/notification/retry"');
    expect(ADMIN_ROUTES).toContain("retrySuppliesOrderNotificationAsAdmin");
    expect(SERVICE).toContain("INVALID_STATUS_TRANSITION");
    expect(SERVICE).toContain("NOTIFICATION_REQUEUED");
    expect(SERVICE).toContain("partner_supplies_order_status_changed");
  });

  it("never introduces checkout/payment, accepts only fixed catalogue codes, and has a durable idempotent outbox", () => {
    expect(SERVICE).toContain('"PLASTIC_GRADED_SLABS"');
    expect(SERVICE).toContain('"PRINT_PAPER_LABEL_STOCK"');
    expect(SERVICE).toContain('"NFC_TAGS"');
    expect(SERVICE).toContain("uq_partner_supplies_orders_tenant_idempotency");
    expect(SERVICE).toContain("providerIdempotencyKey");
    expect(SERVICE).toContain("FOR UPDATE SKIP LOCKED");
    const serviceImports = SERVICE.slice(0, SERVICE.indexOf("export const SUPPLIES_PRODUCTS"));
    expect(serviceImports).not.toContain('from "../stripe"');
  });

  it("uses the central escaped Resend sender with the safe operational destination and stable provider key", () => {
    const suppliesEmail = EMAIL.slice(EMAIL.indexOf("export async function sendPartnerSuppliesOrderNotification"), EMAIL.indexOf("const SERVICE_TYPE_LABELS"));
    expect(suppliesEmail).toContain("CONTACT_INBOX_EMAIL");
    expect(suppliesEmail).toContain("escapeHtmlForEmail");
    expect(suppliesEmail).toContain("sendViaResend");
    expect(suppliesEmail).toContain("idempotencyKey: data.idempotencyKey");
    expect(suppliesEmail).toContain("Submitted");
    expect(suppliesEmail).toContain("data.submittedAt");
    expect(suppliesEmail).not.toContain("REPLY_TO");
    expect(SERVICE).toContain("NOTE_SECRET_RE");
    expect(SERVICE).toContain("Notes cannot contain credentials or authentication details.");
  });

  it("replaces only the legacy placeholders, keeps Supplies secondary, and has no blank action surface", () => {
    expect(APP).toContain("PartnerSuppliesPage");
    expect(APP).toContain("PartnerSuppliesOrdersPage");
    expect(APP).not.toContain('PartnerWorkflowPlaceholderPage kind="supplies"');
    expect(APP).not.toContain('PartnerWorkflowPlaceholderPage kind="orders"');
    const primary = SHELL.slice(SHELL.indexOf("const PRIMARY_NAV_ITEMS"), SHELL.indexOf("const SECONDARY_NAV_ITEMS"));
    expect((primary.match(/href:/g) ?? [])).toHaveLength(5);
    expect(SHELL).toContain("visibleSecondaryItems");
    const more = SHELL.slice(SHELL.indexOf("const SECONDARY_NAV_ITEMS"), SHELL.indexOf("function isActiveNavItem"));
    expect(more).toContain('href: "/partner/supplies"');
    expect(more).toContain('href: "/partner/orders"');
    expect(SUPPLIES).toContain('href="/partner/orders"');
    expect(MY_ORDERS).toContain('href="/partner/supplies"');
    expect(ADMIN_PAGE).toContain("runAdminProtected");
    expect(ADMIN_PAGE).toContain("Mark processing");
    expect(ADMIN_PAGE).toContain("Mark dispatched");
    expect(ADMIN_PAGE).toContain("Retry notification");
    expect(ADMIN_PAGE).toContain('order.status === "RECEIVED"');
    expect(ADMIN_PAGE).toContain("RECONCILIATION_REQUIRED");
  });
});
