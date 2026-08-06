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
const GRADER_ROUTES = read("server/routes/grader.ts");
const GRADER_SERVICE = read("server/grader.ts");
const PARTNER_ASSIGNMENT = read("server/partner/grading-assignment.ts");
const PARTNER_MIRROR = read("server/partner/grading-review-mirror.ts");
const CREDIT_LIFECYCLE = read("server/partner/partner-submission-credit-lifecycle.ts");
const IMPORTER = read("server/partner/connector-import-service.ts");
const VALIDATION = read("server/partner/connector-validation-service.ts");
const WORK_ITEM_MIGRATION = read("migrations/0045_partner_grading_work_items.sql");
const PRINT_WORKFLOW = read("server/print-workflow.ts");
const ROUTES = read("server/routes.ts");
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
    expect(SUBMISSION_SERVICE).toContain("headR2");
    expect(SUBMISSION_SERVICE).toContain("partner-submissions/");
    expect(SUBMISSION_SERVICE).toContain('"card_image_uploaded"');
    expect(SUBMISSION_SERVICE).toContain('"submission.card_image_uploaded"');
    expect(SUBMISSION_SERVICE).toContain("front_image_key");
    expect(SUBMISSION_SERVICE).toContain("back_image_key");
    expect(SUBMISSION_SERVICE).toContain("Upload a front image for every card before submitting.");
    expect(SUBMISSION_SERVICE).toContain("One or more card images could not be verified.");
  });

  it("requires magic-byte detection before accepting an image MIME", () => {
    expect(SUBMISSION_SERVICE).toContain("fileTypeFromBuffer(file.buffer)");
    expect(SUBMISSION_SERVICE).toContain("if (!detected?.mime)");
    expect(SUBMISSION_SERVICE).toContain("const mime = detected.mime");
    expect(SUBMISSION_SERVICE).toContain('if (row.status !== "draft") throw NOT_DRAFT()');
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
    expect(GRADING_ROUTES).toContain("partner_grading_work_items");
    expect(GRADING_ROUTES).toContain("pci.partner_organisation_id");
    expect(GRADING_ROUTES).toContain("pci.partner_location_id");
    expect(GRADING_ROUTES).toContain("cert.assigned_grader_id");
    expect(GRADING_ROUTES).toContain("applyCertGradeDraft");
    expect(GRADING_ROUTES).toContain("buildCertGradingPayload");
    expect(GRADING_ROUTES).not.toContain("buildCertImagesPayload");
    expect(GRADING_ROUTES).toContain("partnerImageFallback");
    expect(GRADING_ROUTES).toContain("headR2(auth.frontImageKey)");
    expect(GRADING_ROUTES).toContain("pgwi.destination_submission_id = pci.destination_submission_id");
    expect(GRADING_ROUTES).toContain("pgwi.assigned_partner_grader_id = ${req.partner!.userId}");
    expect(GRADING_ROUTES).toContain("partnerDraftWriteGuard");
    expect(GRADING_ROUTES).toContain("function partnerGradeBody");
    expect(GRADING_ROUTES).toContain("delete clean.private_notes");
    expect(GRADING_ROUTES).toContain("delete clean.privateNotes");
    // The partner submit-for-review write and the partner assignment query live in PARTNER-OWNED
    // code. server/grader.ts is a protected MVGS engine file and must stay byte-identical to main.
    //
    // An earlier revision of this branch put both inside server/grader.ts and then widened the two
    // MVGS tripwire tests to accept it — including splitting a literal as 'center' || 'ing' so the
    // content check could not match the token it exists to catch. These assertions are inverted so
    // that arrangement can never come back silently.
    expect(GRADER_SERVICE).not.toContain("extraWhere");
    expect(GRADER_SERVICE).not.toContain("submitForReviewBy");
    expect(GRADER_SERVICE).not.toContain("assignPartnerCerts");
    expect(GRADER_SERVICE).not.toMatch(/partner_grading_work_items|assigned_partner_grader_id|partner\.cards\.assess/);
    expect(GRADER_SERVICE).not.toMatch(/'center'\s*\|\|\s*'ing'/);

    expect(GRADING_ROUTES).toContain("function assertPartnerDraftWritable");
    expect(GRADING_ROUTES).toContain("function partnerSubmitForReview");
    expect(GRADING_ROUTES).toContain("grader_status = 'pending_review'");
    expect(GRADING_ROUTES).toContain("review_required = true");
    expect(GRADING_ROUTES).toContain("operator_grade = certificates.grade");
    expect(GRADING_ROUTES).not.toMatch(/applyCertGradeDraft\(certId,\s*req\.body/);
    expect(GRADER_ROUTES).toContain('"/api/admin/graders/assign-partner"');

    expect(PARTNER_ASSIGNMENT).toContain("assignPartnerCerts");
    expect(PARTNER_ASSIGNMENT).toContain("p.code = 'partner.cards.assess'");
    expect(PARTNER_ASSIGNMENT).toContain("partner_grader_assign");
    expect(PARTNER_ASSIGNMENT).toContain("pgwi.status IN ('ready_for_assignment','assigned','returned_for_change')");
    expect(PARTNER_ASSIGNMENT).toContain("pci.deleted_at IS NULL");
    // Approve/reject mirroring is partner workflow state, applied AFTER the engine has gated and
    // committed the grading decision — so it lives in partner code called from the route layer,
    // never inside the protected engine.
    expect(PARTNER_MIRROR).toContain("mirrorPartnerApproval");
    expect(PARTNER_MIRROR).toContain("mirrorPartnerRejection");
    expect(PARTNER_MIRROR).toContain("status = 'approved'");
    expect(PARTNER_MIRROR).toContain("status = 'returned_for_change'");
    expect(GRADER_ROUTES).toContain("mirrorPartnerApproval(certId, adminUser)");
    expect(GRADER_ROUTES).toContain("mirrorPartnerRejection(certId)");
    // The engine must remain the single writer of the approval, so the publish gates cannot be
    // sidestepped by a duplicated partner approval path.
    expect(PARTNER_MIRROR).not.toContain("grade_approved_at = NOW()");
    expect(GRADING_ROUTES).not.toMatch(/computeMvgsScore|gradeFromMvgsScore|mvgsTierName/);
  });

  it("keeps partner final writes atomic and blocks admin-only/private payload fields", () => {
    expect(GRADING_ROUTES).toContain("partnerGradeBody(req.body)");
    // The state transition is ONE guarded UPDATE, so the ownership predicate and the status
    // change cannot be separated by a concurrent writer.
    expect(GRADING_ROUTES).toContain("partnerSubmitForReview(certId, req.partner!)");
    expect(GRADING_ROUTES).toContain("const FINAL_WORK_ITEM_STATUSES");
    expect(GRADING_ROUTES).toContain("'returned_for_change'");
    expect(GRADING_ROUTES).toContain("pgwi.status IN ${FINAL_WORK_ITEM_STATUSES}");
    expect(GRADING_ROUTES).not.toContain("private_notes     = ${pick(req.body");

  });

  it("only exposes the deliberately allowed partner proxy actions", () => {
    expect(GRADING_ROUTES).toContain("PARTNER_GRADING_PROXY_ACTIONS");
    for (const allowed of ["recrop", "manual-centering", "detect-card-bounds", "identify"]) {
      expect(GRADING_ROUTES).toContain(`"${allowed}"`);
    }
    for (const forbidden of [
      "analyze",
      "grade-card",
      "identify-and-analyze",
      "generate-description",
      "approve",
      "reject",
    ]) {
      expect(GRADING_ROUTES).not.toContain(`"${forbidden}"`);
    }
  });

  it("materialises durable partner card-unit provenance instead of inferring by position", () => {
    expect(WORK_ITEM_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS partner_grading_work_items");
    expect(WORK_ITEM_MIGRATION).toContain("partner_submission_card_id uuid NOT NULL");
    expect(WORK_ITEM_MIGRATION).toContain("validation_run_id uuid NOT NULL");
    expect(WORK_ITEM_MIGRATION).toContain("submission_item_id integer NOT NULL");
    expect(WORK_ITEM_MIGRATION).toContain("card_ordinal integer NOT NULL");
    expect(WORK_ITEM_MIGRATION).toContain("uq_partner_grading_work_items_source_unit");
    expect(WORK_ITEM_MIGRATION).toContain("fk_partner_grading_work_items_certificate_scope");
    expect(WORK_ITEM_MIGRATION).toContain("GRANT INSERT (");
    expect(VALIDATION).toContain("front_image_key");
    expect(VALIDATION).toContain("back_image_key");
    expect(VALIDATION).toContain("evaluateImageObjectPresence");
    expect(VALIDATION).toContain("headR2(key)");
    expect(IMPORTER).toContain("createPartnerCertificateForWorkItem");
    expect(IMPORTER).toContain("'PARTNER'");
    expect(IMPORTER).toContain("grading_front_original");
    expect(IMPORTER).toContain("INSERT INTO partner_grading_work_items");
    expect(IMPORTER).toContain("certificate_id");
    expect(IMPORTER).toContain("sourceOrdinals");
    expect(IMPORTER).toContain("itemRes.rows[0].id");
    expect(ROUTES).toContain("Partner-imported cards are materialized by the Partner connector");
    expect(GRADING_ROUTES).toContain("pgwi.submission_item_id = si.id");
    expect(GRADING_ROUTES).toContain("partnerImageKeyAllowed");
    expect(GRADING_ROUTES).toContain("pgwi.front_image_key");
    expect(GRADING_ROUTES).not.toContain("sequence_number = $3");
  });

  it("settles and prints only after approved complete partner evidence", () => {
    expect(CREDIT_LIFECYCLE).toContain("assertPartnerGradingApprovedForSettlement");
    expect(CREDIT_LIFECYCLE).toContain("pgwi.status = 'approved'");
    expect(CREDIT_LIFECYCLE).toContain("cert.grade_approved_at IS NOT NULL");
    expect(PRINT_WORKFLOW).toContain("requireCompletePartnerSubmissionSet");
    expect(PRINT_WORKFLOW).toContain("Partner credits must be settled before labels are rendered.");
    expect(PRINT_WORKFLOW).toContain("Select every certificate from this Partner submission together.");
    expect(PRINT_WORKFLOW).toContain("AND cert_id = ANY(${pgTextArray(certIdStorageVariants(applied))}::text[])");
    expect(PRINT_WORKFLOW).toContain("SET status = 'completed'");
    expect(WORK_ITEM_MIGRATION).toContain("'completed'");
  });
});
