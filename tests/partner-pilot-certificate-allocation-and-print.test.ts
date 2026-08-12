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
  const workflow = read("server/print-workflow.ts");
  const legacyRoutes = read("server/routes.ts");
  const preview = read("server/routes/admin/label-preview.ts");
  const qaRoutes = read("server/routes/grader.ts");
  const qaUi = read("client/src/pages/admin-staff.tsx");

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

  it("uses one Partner-specific authority for QA, settlement, mapping, and capture proof", () => {
    for (const token of [
      "partner_mapping_invalid",
      "partner_qa_incomplete",
      "partner_credit_unsettled",
      "partner_capture_evidence_missing",
      "partner_print_state_invalid",
      "grader_status = 'approved'",
      "review_required = true",
      "grade_approved_at IS NOT NULL",
      "reservation.status = 'consumed'",
      "print_state IN ('needs_printing', 'reprint_required', 'printing', 'printed', 'reprinted')",
      "count(DISTINCT evidence.side) = 2",
      "station.approved_at IS NOT NULL",
      "isUndefinedOriginColumn",
      'if (isUndefinedOriginColumn(error)) return [];',
    ]) {
      expect(eligibility).toContain(token);
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
    expect(qaRoutes).toContain("operator.first_name");
    expect(qaRoutes).toContain("station_codes");
    expect(qaRoutes).toContain("evidence_complete");
    expect(qaUi).toContain("partner-qa-provenance");
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
