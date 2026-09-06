import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("Partner Pilot certificate allocation", () => {
  const migration = read("migrations/0076_partner_pilot_certificate_allocation.sql");
  const importer = read("server/partner/connector-import-service.ts");

  it("allocates only through a narrow fixed-search-path definer with immutable Partner provenance", () => {
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("SET search_path = pg_catalog, public, pg_temp");
    expect(migration).toContain("pg_has_role(session_user, 'partner_connector_runtime', 'member')");
    expect(migration).toContain("public.partner_current_tenant()");
    expect(migration).toContain("'PARTNER'");
    expect(migration).toContain("origin_partner_id");
    expect(migration).toContain("origin_location_id");
    expect(migration).toContain("assigned_grader_id");
    expect(migration).toContain("uq_certificates_live_submission_item");
    expect(migration).toContain("partner_credit_reservations");
    expect(migration).toContain("one active credit reservation per source card");
    expect(migration).toContain("REVOKE ALL ON FUNCTION public.partner_allocate_import_certificates");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION public.partner_allocate_import_certificates");
  });

  /*
   * 0081 REPLACES this function, so 0076's body is no longer what runs. Without this block the
   * assertions above would keep passing while the DEPLOYED allocator silently lost SECURITY DEFINER,
   * its fixed search_path, the caller-role check or the tenant-GUC check. Every security property
   * asserted for 0076 is re-asserted here against the version that actually executes.
   */
  const binding = read("migrations/0081_partner_card_job_certificate_binding.sql");

  it("carries every 0076 security property forward into the replacement allocator (0081)", () => {
    expect(binding).toContain("CREATE OR REPLACE FUNCTION public.partner_allocate_import_certificates");
    expect(binding).toContain("SECURITY DEFINER");
    expect(binding).toContain("SET search_path = pg_catalog, public, pg_temp");
    expect(binding).toContain("pg_has_role(session_user, 'partner_connector_runtime', 'member')");
    expect(binding).toContain("public.partner_current_tenant()");
    expect(binding).toContain("'PARTNER'");
    expect(binding).toContain("origin_partner_id");
    expect(binding).toContain("one active credit reservation per source card");
    expect(binding).toContain("existing live certificate for this destination");
    expect(binding).toContain("OWNER TO partner_credit_lifecycle_definer");
  });

  it("binds each allocated certificate to exactly one source Card Job and refuses to rebind", () => {
    // The Nth destination item pairs with the Nth source unit, ordered exactly as
    // submission-service.ts expands credit units.
    expect(binding).toContain("row_number() OVER (ORDER BY sc.sequence_number, sc.id, cj.ordinal)");
    // Never re-point an identity that already exists.
    expect(binding).toContain("j.certificate_id IS NULL");
    // A position that fails to stamp exactly one job aborts the WHOLE allocation, rather than
    // leaving a minted MV number with no Card Job to own it.
    expect(binding).toContain("GET DIAGNOSTICS v_stamped = ROW_COUNT");
    expect(binding).toContain("v_stamped <> 1");
    // And no source job may be left without an identity (more jobs than destination items).
    expect(binding).toContain("left a source Card Job without a certificate identity");
    // The connector role reaches partner_card_jobs ONLY through the definer, never directly.
    expect(binding).not.toMatch(/GRANT[^;]*ON public\.partner_card_jobs[^;]*TO partner_connector_runtime/i);
  });

  it("keeps the connector on the allocator authority rather than granting broad certificate writes", () => {
    expect(importer).toContain('resolveFlag(client, "partner_grading_enabled"');
    expect(importer).toContain("partner_allocate_import_certificates");
    expect(importer).toContain("Partner pilot certificate allocation failed; the import was rolled back.");
    expect(importer).not.toMatch(/INSERT\s+INTO\s+certificates/i);
    expect(importer).not.toMatch(/UPDATE\s+cert_counter/i);
  });
});

describe("Partner Pilot physical evidence and output gate", () => {
  const grading = read("server/partner/grading-routes.ts");
  const eligibility = read("server/partner/print-eligibility.ts");
  const operationalAuthority = read("server/partner/operational-authority.ts");
  const workflow = read("server/print-workflow.ts");
  const legacyRoutes = read("server/routes.ts");
  const preview = read("server/routes/admin/label-preview.ts");
  const qaRoutes = read("server/routes/grader.ts");
  const qaUi = read("client/src/pages/admin-staff.tsx");
  const historyService = read("server/partner/certificate-history-service.ts");
  const historyRoutes = read("server/partner/submission-routes.ts");
  const historyUi = read("client/src/pages/partner/certificates.tsx");

  it("requires current, station-bound TIFF evidence and immutable origin before Partner submission", () => {
    expect(grading).toContain("cert.origin_type = 'PARTNER'");
    expect(grading).toContain("cert.origin_partner_id = pci.partner_organisation_id");
    expect(grading).toContain("cert.origin_location_id = pci.partner_location_id");
    expect(grading).toContain("certificate_image_evidence evidence");
    expect(grading).toContain("scanner_capture_sessions session");
    expect(grading).toContain("session.state = 'captured'");
    expect(grading).toContain("evidence.evidence_class = 'NEW_IMMUTABLE_MASTER'");
    expect(grading).toContain("evidence.format = 'tiff'");
    expect(grading).toContain("station.status = 'ACTIVE'");
  });

  it("shows incomplete capture states but never calls either lineage ready before authoritative evidence agrees", () => {
    const queue = grading.slice(
      grading.indexOf('r.get("/grading/queue"'),
      grading.indexOf('r.get("/grading/certificates/:id/images"')
    );
    // Incomplete cards must be visible to the shop floor, not filtered out. The authoritative
    // evidence projection labels each side, and tests exercise the no-false-ready branch directly.
    expect(queue).toContain("'NEEDS_SCAN', 'CAPTURING', 'FIX_REQUIRED', 'READY_TO_GRADE', 'GRADING'");
    expect(queue).toContain("buildPartnerWorkingEvidencePayloads");
    expect(queue).toContain("projectPartnerQueueEvidence");
    expect(grading).toContain('input.cardJobStatus !== null && input.cardJobStatus !== "READY_TO_GRADE"');
    expect(grading).toContain('"AWAITING_CAPTURE_ACCEPTANCE"');

    // A Card Job can only be opened after its own lifecycle records READY_TO_GRADE (or when it is
    // already in GRADING under lease authority). The final submit gate continues to prove both
    // current station-bound TIFF masters separately.
    expect(queue).toContain('row.card_job_status === "READY_TO_GRADE"');
    expect(queue).toContain('row.card_job_status === "GRADING"');
    expect(queue).toContain("job.cancelled_at IS NULL");
  });

  it("uses one Partner-specific authority for QA, settlement, mapping, and capture proof", () => {
    for (const token of [
      "partner_mapping_invalid",
      "partner_qa_incomplete",
      "partner_credit_unsettled",
      "partner_capture_evidence_missing",
      "partner_print_state_invalid",
      "isUndefinedOriginColumn",
      "if (isUndefinedOriginColumn(error)) return [];",
    ]) {
      expect(eligibility).toContain(token);
    }
    expect(eligibility).toContain("readPartnerPrintAuthority");
    for (const token of [
      "grader_status='approved'",
      "review_required=true",
      "grade_approved_at IS NOT NULL",
      "reservation.status='consumed'",
      "print_state IN ('needs_printing','reprint_required','printing','printed','reprinted')",
      "count(DISTINCT evidence.side)=2",
      "station.approved_at IS NOT NULL",
    ]) {
      expect(operationalAuthority).toContain(token);
    }
  });

  it("applies that authority to workflow batches, legacy output, cached artefacts, and normal preview", () => {
    expect(workflow).toContain("getPartnerPrintEligibilityBlocks(requested)");
    expect(workflow).toContain("getPartnerPrintEligibilityBlocks(certIds)");
    expect(legacyRoutes).toContain("PARTNER_PRINT_INELIGIBLE");
    expect(legacyRoutes).toContain("getPartnerPrintEligibilityBlocks(certIds)");
    expect(preview).toContain("getPartnerPrintEligibilityBlocks");
    expect(preview).toContain("allowPartnerQaInspection");
  });

  it("gives Super Admin QA the Partner, operator, station, evidence, and correction context", () => {
    expect(qaRoutes).toContain("/partner-context");
    expect(qaRoutes).toContain("origin_partner_legal_name");
    expect(qaRoutes).toContain("readPartnerQaAuthority");
    expect(qaRoutes).toContain("operator: authority.operatorName");
    expect(qaRoutes).toContain("stationCodes: authority.stationCodes");
    expect(qaRoutes).toContain("evidenceComplete:");
    expect(operationalAuthority).toContain("first_name");
    expect(operationalAuthority).toContain("station_code");
    expect(operationalAuthority).toContain("approved_at IS NOT NULL AS approved");
    expect(qaUi).toContain("partner-qa-provenance");
  });

  it("allows a Partner to open only their immutable-origin card detail", () => {
    expect(historyService).toContain("getPartnerCertificateDetail");
    expect(historyService).toContain("cert.certificate_number = $2::text");
    expect(historyService).toContain("cert.origin_partner_id = pci.partner_organisation_id");
    expect(historyService).toContain("cert.origin_location_id = pci.partner_location_id");
    expect(historyService).toContain("getR2SignedUrl");
    expect(historyRoutes).toContain('"/certificates/:certificateNumber"');
    expect(historyUi).toContain("partner-certificate-detail");
    expect(historyUi).toContain("Open FRONT master");
    expect(historyUi).toContain("Server-authoritative subgrades");
  });

  /*
   * P11 — NFC BINDING INTEGRITY.
   *
   * The NFC facility has no migration of its own and its twelve columns were hand-applied to
   * production, so "one tag, one certificate" was enforced ONLY by a read-then-write that two
   * concurrent binds both pass. And nothing checked the certificate's state at all, so a chip could
   * be written for a card the PUBLIC scan route already refuses to resolve — a physical object in a
   * customer's hand that taps to "not found".
   */
  it("binds an NFC tag only to an approved certificate, under a real database constraint, and audits it", () => {
    const nfcGuard = read("shared/nfc-binding.ts");
    const migration = read("migrations/0088_nfc_binding_integrity.sql");
    const storage = read("server/storage.ts");

    // The bind gate is the SAME fact the public scan route uses, so the two cannot drift apart.
    expect(nfcGuard).toContain("cert.gradeApprovedAt == null");
    expect(nfcGuard).toContain("not_approved");
    expect(legacyRoutes).toContain("checkNfcBindable(target)");

    // The real authority is the index, not the read: the loser of a race gets a 409, not a 500.
    expect(migration).toContain("CREATE UNIQUE INDEX IF NOT EXISTS uq_certificates_nfc_uid");
    expect(migration).toContain("ON certificates (lower(nfc_uid))");
    expect(migration).toContain("WHERE nfc_uid IS NOT NULL");
    // Pre-existing damage must be surfaced to a human, never resolved by whichever row an index
    // build happened to reject.
    expect(migration).toContain("RAISE EXCEPTION");
    expect(legacyRoutes).toContain('code: "NFC_UID_TAKEN"');

    // Binding, overwriting and clearing were entirely unlogged, and nfc_written_by was always NULL
    // because no client ever sent it. Attribution now comes from the authenticated admin.
    expect(storage).toContain("'nfc_bound'");
    expect(storage).toContain("'nfc_cleared'");
    expect(legacyRoutes).toContain("renderAdminUser(req)");
  });

  /*
   * P11 — the Card Job output lifecycle. 0080 ends APPROVED → PRINTABLE → COMPLETED and nothing drove
   * either edge, so a Partner Card Job stopped dead at APPROVED however far its certificate travelled
   * through the HQ print workflow.
   */
  it("drives the Partner Card Job output lifecycle from the EXISTING print workflow, not a second one", () => {
    const workflowSrc = read("server/print-workflow.ts");
    const cardJobLifecycle = read("server/partner/card-job-lifecycle.ts");

    expect(workflowSrc).toContain('advanceCardJobsForOutputSafely(reserved, "printable"');
    expect(workflowSrc).toContain('advanceCardJobsForOutputSafely(applied, "completed"');
    expect(cardJobLifecycle).toContain("markCardJobPrintable");
    expect(cardJobLifecycle).toContain("markCardJobCompleted");
    // Keyed on mv_number because the print workflow speaks in certificate_number throughout.
    expect(cardJobLifecycle).toContain("WHERE mv_number = $1 AND cancelled_at IS NULL");
    // A lifecycle hiccup must never report a genuinely produced label as a failure.
    expect(cardJobLifecycle).toContain("advanceCardJobsForOutputSafely");
    // And no Partner-specific renderer, batcher or eligibility engine was introduced.
    expect(cardJobLifecycle).not.toMatch(/generateLabelPNG|generateLabelPDF|createBatch/);
  });

  it("keeps unsupported scanner releases fail-closed and retires mutable Git/npm updates", () => {
    const main = read("scripts/scanner-app/main.js");
    const update = read("scripts/scanner-app/update.sh");
    expect(main).toContain('stage: "update_required"');
    expect(main).toContain("signed_release_required");
    expect(main).not.toContain('spawn("/bin/bash", [script]');
    expect(update).toContain("RETIRED mutable-update entry point");
    expect(update).not.toContain("git -C");
    expect(update).not.toContain("npm install");
  });
});
