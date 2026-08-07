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
const GRADING_AUTHORITY = read("server/partner/grading-authority.ts");
const GRADER_ROUTES = read("server/routes/grader.ts");
const GRADER_SERVICE = read("server/grader.ts");
const PARTNER_ASSIGNMENT = read("server/partner/grading-assignment.ts");
const PARTNER_MIRROR = read("server/partner/grading-review-mirror.ts");
const REAL_STORAGE_PROOF = read("tests/partner-real-r2-storage.test.ts");
const CREDIT_LIFECYCLE = read("server/partner/partner-submission-credit-lifecycle.ts");
const IMPORTER = read("server/partner/connector-import-service.ts");
const VALIDATION = read("server/partner/connector-validation-service.ts");
const WORK_ITEM_MIGRATION = read("migrations/0049_partner_grading_work_items.sql");
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
    // The two-key blacklist became an explicit default-deny WHITELIST, and moved into
    // server/partner/grading-authority.ts. Pin the stronger property: nothing crosses from the
    // partner client unless it is named evidence, so a field nobody thought of is refused by
    // default rather than passed through.
    expect(GRADING_ROUTES).toContain("partnerGradeBody,");
    expect(GRADING_AUTHORITY).toContain("export function partnerGradeBody");
    expect(GRADING_AUTHORITY).toContain("if (EVIDENCE_ALLOWED.has(key)) clean[key] = src[key];");
    expect(GRADING_AUTHORITY).not.toMatch(/delete\s+clean\.private_?[nN]otes/);
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
    // Every partner write now goes through the server-authority adapter, which whitelists the
    // evidence AND overwrites the authoritative grade with the engine's own verdict. Pinning the
    // adapter rather than the raw whitelist is what stops a future edit reinstating a write path
    // that trusts a client-supplied grade.
    expect(GRADING_ROUTES).toContain("partnerAuthoritativeBody(certId, req.body)");
    expect(GRADING_ROUTES).not.toContain("partnerGradeBody(req.body)");
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

describe("the real-storage proof cannot destroy a bucket", () => {
  it("never imports bucket- or bulk-deletion commands", () => {
    // A previous revision ran, in beforeAll and before any assertion, an UNPREFIXED
    // ListObjectsV2 -> bulk DeleteObjects -> DeleteBucket against an endpoint and bucket taken
    // from ambient R2_* env vars, with localhost only as a fallback. With real credentials
    // exported into the shell that would have deleted up to 1,000 live objects and then the
    // production bucket. These are the two commands that made that possible.
    expect(REAL_STORAGE_PROOF).not.toContain("DeleteBucketCommand");
    expect(REAL_STORAGE_PROOF).not.toContain("DeleteObjectsCommand");
    expect(REAL_STORAGE_PROOF).not.toContain("CreateBucketCommand");
  });

  it("targets only dedicated proof env vars, never ambient R2_* configuration", () => {
    // The suite may SET process.env.R2_* after proving the target is disposable, but it must
    // never READ its target from them — that is the "ambient production config wins" class.
    expect(REAL_STORAGE_PROOF).not.toMatch(/process\.env\.R2_ENDPOINT\s*\?\?/);
    expect(REAL_STORAGE_PROOF).not.toMatch(/process\.env\.R2_BUCKET_NAME\s*\?\?/);
    expect(REAL_STORAGE_PROOF).toContain("PARTNER_REAL_R2_PROOF_ENDPOINT");
    expect(REAL_STORAGE_PROOF).toContain("PARTNER_REAL_R2_PROOF_BUCKET");
  });

  it("keeps the endpoint allow-list, bucket pattern, foreign-object probe and prefixed cleanup", () => {
    expect(REAL_STORAGE_PROOF).toContain("ALLOWED_STORAGE_HOSTS");
    expect(REAL_STORAGE_PROOF).toContain("FORBIDDEN_HOST_FRAGMENTS");
    expect(REAL_STORAGE_PROOF).toContain("PROOF_BUCKET_RE");
    expect(REAL_STORAGE_PROOF).toContain("assertBucketIsEmptyOfForeignObjects");
    expect(REAL_STORAGE_PROOF).toContain("refusing to delete out-of-prefix key");
    // Exact-hostname matching, never substring — "https://evil.example/?h=127.0.0.1" must fail.
    expect(REAL_STORAGE_PROOF).toContain("ALLOWED_STORAGE_HOSTS.has(host)");
  });
});

describe("no partner-reachable proxy handler performs schema mutation", () => {
  const ROUTES = read("server/routes.ts");

  /** Slice a single app.post handler body out of routes.ts by its route literal. */
  function handlerBody(routeLiteral: string): string {
    const start = ROUTES.indexOf(routeLiteral);
    expect(start, `route ${routeLiteral} not found`).toBeGreaterThan(-1);
    const next = ROUTES.indexOf("app.post(", start + routeLiteral.length);
    const nextGet = ROUTES.indexOf("app.get(", start + routeLiteral.length);
    const end = Math.min(next === -1 ? ROUTES.length : next, nextGet === -1 ? ROUTES.length : nextGet);
    return ROUTES.slice(start, end);
  }

  // manual-centering carried four `ALTER TABLE certificates ADD COLUMN IF NOT EXISTS centering_*`
  // statements, each in an empty catch, running BEFORE the partner write guard. They were the only
  // request-path DDL in the whole server tree and the only partner-reachable one — and they were
  // dead: the columns are schema-declared, storage.getCertificate projects every one of them, and
  // all four were confirmed present on staging. Their sole effect was an ACCESS EXCLUSIVE lock on
  // the busiest table, reachable from a tenant-facing route at 60 requests/minute/user.
  it("manual-centering performs no DDL", () => {
    const body = handlerBody('"/api/admin/certificates/:id/manual-centering"');
    // Strip comments so the explanatory note above the deletion does not trip its own guard.
    const code = body.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/ALTER\s+TABLE/i);
    expect(code).not.toMatch(/ADD\s+COLUMN/i);
    expect(code).not.toMatch(/CREATE\s+TABLE/i);
    expect(code).not.toMatch(/DROP\s+/i);
  });

  it("manual-centering authorises before acting, like its sibling proxied actions", () => {
    const body = handlerBody('"/api/admin/certificates/:id/manual-centering"');
    expect(body).toContain("isPartnerGradingProxy(req)");
    const preflight = body.indexOf("isPartnerGradingProxy(req)");
    const update = body.indexOf("UPDATE certificates");
    expect(preflight).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(-1);
    // The guard must be evaluated before the mutating statement, not only inside its WHERE.
    expect(preflight).toBeLessThan(update);
  });

  it("no empty catch blocks remain in the manual-centering handler", () => {
    const body = handlerBody('"/api/admin/certificates/:id/manual-centering"');
    // `catch {}` with no binding and no body hides lock timeouts, deadlocks and privilege errors
    // alike, with no log line and no metric.
    expect(body).not.toMatch(/catch\s*\{\s*\}/);
  });
});

describe("recrop never writes a canonical object before the guard succeeds", () => {
  const ROUTES = read("server/routes.ts");

  function recropBody(): string {
    const start = ROUTES.indexOf('"/api/admin/certificates/:id/recrop"');
    expect(start).toBeGreaterThan(-1);
    const next = ROUTES.indexOf("app.post(", start + 40);
    return ROUTES.slice(start, next === -1 ? ROUTES.length : next);
  }

  it("defers the partner canonical writes until after the guarded UPDATE", () => {
    const body = recropBody();
    // The three canonical keys — including images/{cert}/{side}.jpg, the customer-visible key the
    // certificate row points at — must be written through one helper that the partner path invokes
    // only after the guard, not inline before it.
    expect(body).toContain("const writeCanonicalObjects");
    expect(body).toContain("if (!partnerProxied) await writeCanonicalObjects()");
    expect(body).toContain("if (partnerProxied) await writeCanonicalObjects()");

    const adminWrite = body.indexOf("if (!partnerProxied) await writeCanonicalObjects()");
    // NOT indexOf — the FIRST guard usage is the pre-flight SELECT. The ordering that matters is
    // against the guard inside the persisting UPDATE, which is the atomic authority.
    const guardedUpdate = body.indexOf("UPDATE certificates SET");
    const refusal = body.indexOf("partnerProxied && imageUpdate.rows.length !== 1");
    const partnerWrite = body.indexOf("if (partnerProxied) await writeCanonicalObjects()");

    // Admin keeps the original ordering: write, then update.
    expect(adminWrite).toBeLessThan(guardedUpdate);
    // Partner: guard, then refuse-or-write. The write must come AFTER the refusal branch, so a 409
    // leaves every canonical object byte-for-byte unchanged.
    expect(refusal).toBeGreaterThan(guardedUpdate);
    expect(partnerWrite).toBeGreaterThan(refusal);
  });

  it("performs no bare uploadToR2 before the guarded UPDATE on the partner path", () => {
    const body = recropBody();
    const guardedUpdate = body.indexOf("UPDATE certificates SET");
    const beforeGuard = body.slice(0, guardedUpdate);
    // Any uploadToR2 in the pre-guard region must be inside the deferred helper, never a direct
    // call — a direct one would replace a live customer image before authorisation is confirmed.
    const helperStart = beforeGuard.indexOf("const writeCanonicalObjects");
    const helperEnd = beforeGuard.indexOf("};", helperStart);
    const outsideHelper = beforeGuard.slice(0, helperStart) + beforeGuard.slice(helperEnd);
    expect(outsideHelper).not.toContain("await uploadToR2(");
  });
});

describe("every partner grading route is rate limited", () => {
  const GRADING = read("server/partner/grading-routes.ts");
  const LIMITS = read("server/partner/rate-limit.ts");

  it("applies a limiter to every registered grading route", () => {
    // Match each route registration and the text up to its handler, so a limiter on the line
    // above a multi-line registration still counts.
    const registrations = [...GRADING.matchAll(/r\.(get|post|put|patch|delete)\(([\s\S]{0,400}?)(?:async )?\(req/g)];
    expect(registrations.length, "no grading routes found — the regex has rotted").toBeGreaterThanOrEqual(8);
    const unlimited = registrations
      .filter((m) => !/partnerGradingReadLimiter|partnerGradingMutationLimiter/.test(m[2]))
      .map((m) => m[2].slice(0, 60).replace(/\s+/g, " ").trim());
    expect(unlimited, `grading routes with no rate limiter: ${unlimited.join(" | ")}`).toEqual([]);
  });

  it("keeps reads and mutations on separate ceilings, keyed per partner user", () => {
    expect(GRADING).toContain("partnerGradingReadLimiter");
    expect(GRADING).toContain("partnerGradingMutationLimiter");
    // Per-user, not per-IP: the ceiling must bound one account regardless of source address.
    expect(LIMITS).toContain("req.partner?.userId");
    expect(LIMITS).toMatch(/max:\s*240/);
    expect(LIMITS).toMatch(/max:\s*60/);
  });

  it("uses a limiter shape static analysis can recognise", () => {
    // The hand-rolled partnerRateLimit wrapper is real at runtime but invisible to CodeQL's
    // js/missing-rate-limiting query, which recognises known libraries. Six HIGH alerts persisted
    // on routes that were demonstrably limited. A control the scanner cannot see is one the next
    // reviewer must re-derive by hand.
    const gradingBlock = LIMITS.slice(LIMITS.indexOf("partnerGradingReadLimiter"));
    expect(gradingBlock).toMatch(/partnerGradingReadLimiter\s*=\s*rateLimit\(/);
    expect(gradingBlock).toMatch(/partnerGradingMutationLimiter\s*=\s*rateLimit\(/);
  });
});
