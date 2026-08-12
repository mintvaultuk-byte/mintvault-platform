import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const MOUNT = read("server/partner/mount.ts");
const CATALOGUE = read("server/partner/catalogue-routes.ts");
const SUBMISSION_ROUTES = read("server/partner/submission-routes.ts");
const SUBMISSION_SERVICE = read("server/partner/submission-service.ts");
const API = read("client/src/lib/partner-api.ts");
const WIZARD = read("client/src/pages/partner/submission-wizard.tsx");
const GRADING = read("client/src/pages/partner/grading.tsx");
const GRADING_ROUTES = read("server/partner/grading-routes.ts");
const GRADER_SERVICE = read("server/grader.ts");
const CUSTOMERS = read("client/src/pages/partner/customers.tsx");
const SHELL = read("client/src/components/partner/partner-shell.tsx");
const CUSTOMER_ROUTES = read("server/partner/customer-routes.ts");
const CUSTOMER_SERVICE = read("server/partner/customer-service.ts");
const APP = read("client/src/App.tsx");
const ROUTE_GUARD = read("client/src/components/partner/partner-route-guard.tsx");

describe("partner customers are manageable from a real page", () => {
  it("exposes customer create/edit/search through partner APIs and nav", () => {
    expect(API).toContain("partnerCustomers");
    expect(API).toContain('PATCH", `/api/partner/customers/${id}`');
    expect(SHELL).toContain('href: "/partner/customers"');
    expect(CUSTOMERS).toContain("partnerCustomers.list");
    expect(CUSTOMERS).toContain("partnerCustomers.create");
    expect(CUSTOMERS).toContain("partnerCustomers.edit");
    expect(CUSTOMERS).toContain('data-testid="input-customer-page-search"');
  });

  it("keeps mutations tenant-scoped and rejects duplicate customer keys", () => {
    expect(CUSTOMER_SERVICE).toContain("withTenant({ tenantId: principal.tenantId }");
    expect(CUSTOMER_SERVICE).toContain("lockTenantCustomerBook");
    expect(CUSTOMER_SERVICE).toContain("assertNoDuplicateCustomer");
    expect(CUSTOMER_SERVICE).toContain("tenant_id=$1");
    expect(CUSTOMER_SERVICE).toContain("email=$3");
    expect(CUSTOMER_SERVICE).toContain("lower(reference)=lower($4)");
    expect(CUSTOMER_ROUTES).toContain('err.code === "duplicate"');
    expect(CUSTOMER_ROUTES).toContain("return 409");
  });
});

describe("partner catalogue surface is read-only and mounted under partner auth", () => {
  it("mounts the partner catalogue router and reuses the HQ snapshot provider", () => {
    expect(MOUNT).toContain("partnerCatalogueRouter()");
    expect(CATALOGUE).toContain("getCatalogueSnapshot");
    expect(CATALOGUE).toContain('r.get("/catalogue/snapshot"');
    expect(CATALOGUE).toContain('requirePartnerCapability("partner.orders.view")');
  });

  it("does not expose admin catalogue write routes through the partner catalogue router", () => {
    expect(CATALOGUE).not.toMatch(/post|put|delete/i);
    expect(CATALOGUE).not.toMatch(/createCatalogueItem|updateCatalogueItem|reorderCatalogue|importCatalogue/);
  });
});

describe("partner card image upload uses existing storage and audits front/back replacements", () => {
  it("exposes only front/back upload under the existing card ownership route", () => {
    expect(SUBMISSION_ROUTES).toContain('"/submissions/:id/cards/:cardId/images/:side"');
    expect(SUBMISSION_ROUTES).toContain('side !== "front" && side !== "back"');
    expect(SUBMISSION_ROUTES).toContain("uploadCardImage");
  });

  it("stores images under a partner-specific R2 namespace and writes event plus audit rows", () => {
    expect(SUBMISSION_SERVICE).toContain("uploadToR2");
    expect(SUBMISSION_SERVICE).toContain("partner-submissions/");
    expect(SUBMISSION_SERVICE).toContain('"card_image_uploaded"');
    expect(SUBMISSION_SERVICE).toContain('"submission.card_image_uploaded"');
    expect(SUBMISSION_SERVICE).toContain("front_image_key");
    expect(SUBMISSION_SERVICE).toContain("back_image_key");
  });

  it("requires magic-byte detection before accepting an image MIME", () => {
    expect(SUBMISSION_SERVICE).toContain("fileTypeFromBuffer(file.buffer)");
    expect(SUBMISSION_SERVICE).toContain("if (!detected?.mime)");
    expect(SUBMISSION_SERVICE).toContain("const mime = detected.mime");
    expect(SUBMISSION_SERVICE).not.toContain("detected?.mime ?? file.mimetype");
  });

  it("the client can retry/replace each side without exposing admin image upload APIs", () => {
    expect(API).toContain("uploadImage");
    expect(WIZARD).toContain("CardImageUploadButton");
    expect(WIZARD).toContain('accept="image/jpeg,image/png,image/webp,image/tiff"');
    expect(WIZARD).not.toContain("/api/admin/certificates");
  });
});

describe("partner grading adapter reuses the existing MVGS workspace", () => {
  it("routes the partner grading nav by partner.cards.assess", () => {
    expect(SHELL).toContain('href: "/partner/grading"');
    expect(SHELL).toContain('permission: "partner.cards.assess"');
    expect(APP).toContain('<PartnerRouteGuard requiredPermission="partner.cards.assess">');
    expect(ROUTE_GUARD).toContain("requiredPermission && !hasPermission(requiredPermission)");
  });

  it("mounts GradingWorkstation with the partner-scoped MVGS adapter, not a second grading engine", () => {
    expect(GRADING).toContain("<GradingWorkstation");
    expect(GRADING).toContain('apiBase="/api/partner/grading"');
    expect(GRADING).toContain("graderMode");
    expect(GRADING).toContain("assignedToMe");
    expect(GRADING).toContain("gradedByMe");
    expect(GRADING).not.toMatch(/computeMvgsScore|gradeFromMvgsScore|mvgsTierName/);
  });

  it("authorizes partner grading by tenant, location, assignment and existing connector provenance", () => {
    expect(MOUNT).toContain("partnerGradingRouter()");
    expect(GRADING_ROUTES).toContain('requirePartnerCapability("partner.cards.assess")');
    expect(GRADING_ROUTES).toContain("partner_connector_imports");
    expect(GRADING_ROUTES).toContain("pci.partner_organisation_id");
    expect(GRADING_ROUTES).toContain("pci.partner_location_id");
    expect(GRADING_ROUTES).toContain("cert.assigned_grader_id");
    expect(GRADING_ROUTES).toContain("applyCertGradeDraft");
    expect(GRADING_ROUTES).toContain("buildCertGradingPayload");
    expect(GRADING_ROUTES).toContain("buildCertImagesPayload");
    expect(GRADING_ROUTES).toContain("partnerImageFallback");
    expect(GRADING_ROUTES).toContain("partnerDraftWriteGuard");
    expect(GRADER_SERVICE).toContain("extraWhere");
    expect(GRADER_SERVICE).toContain("grade_approved_at IS NULL ${extraWhere}");
    expect(GRADING_ROUTES).toContain("review_required = true");
    expect(GRADING_ROUTES).toContain("grader_status = 'pending_review'");
    expect(GRADING_ROUTES).not.toMatch(/computeMvgsScore|gradeFromMvgsScore|mvgsTierName/);
  });
});
