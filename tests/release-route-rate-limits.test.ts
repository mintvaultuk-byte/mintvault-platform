import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("release route rate-limit hardening", () => {
  it("uses fail-closed, CodeQL-recognised guards after authentication/capability checks", () => {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const grading = readFileSync(`${here}/../server/partner/grading-routes.ts`, "utf8");
    const stations = readFileSync(`${here}/../server/partner/station-routes.ts`, "utf8");
    const staff = readFileSync(`${here}/../server/routes/staff.ts`, "utf8");
    const grader = readFileSync(`${here}/../server/routes/grader.ts`, "utf8");
    const submissions = readFileSync(`${here}/../server/routes/submissions.ts`, "utf8");

    expect(grading).toMatch(
      /edit-submission",\s*requirePartnerCapability\("partner\.cards\.assess"\),\s*requireNotViewOnly,\s*requireNotSensitiveFrozen,\s*partnerGradingEditRateLimit/
    );
    expect(grading).toMatch(
      /grading\/certificates\/:id\/images",\s*requirePartnerCapability\("partner\.cards\.assess"\),\s*partnerGradingReadRateLimit/
    );
    expect(grading).toMatch(
      /grading\/certificates\/:id\/grading",\s*requirePartnerCapability\("partner\.cards\.assess"\),\s*partnerGradingReadRateLimit/
    );
    expect(grading).toMatch(
      /grading\/certificates\/label\/preview",\s*requirePartnerCapability\("partner\.cards\.preview"\),\s*partnerGradingPreviewRateLimit/
    );
    expect(grading).toMatch(
      /grading\/certificates\/:id\/grade",\s*requirePartnerCapability\("partner\.cards\.assess"\),\s*requireNotViewOnly,\s*requireNotSensitiveFrozen,\s*partnerGradingEditRateLimit/
    );
    expect(grading).toMatch(
      /grading\/certificates\/:id\/submit",\s*requirePartnerCapability\("partner\.cards\.assess"\),\s*requireNotViewOnly,\s*requireNotSensitiveFrozen,\s*partnerGradingEditRateLimit/
    );
    expect(stations).toMatch(
      /enrolment-status",\s*requirePartnerAuth,\s*requirePartnerCapability\("partner\.cards\.scan"\),\s*partnerStationReadRateLimit/
    );
    expect(stations).toMatch(
      /stations\/heartbeat",\s*requireSignedStation,\s*requireSignedStationOperator,\s*partnerStationHeartbeatRateLimit/
    );
    expect(stations).toMatch(
      /capture-sessions",\s*requirePartnerAuth,\s*requirePartnerCapability\("partner\.cards\.scan"\),\s*partnerStationCaptureRateLimit/
    );
    expect(stations).toMatch(
      /stations\/calibrations",\s*partnerStationCalibrationIngressRateLimit,\s*requireSignedStation,\s*requireSignedStationOperator,\s*partnerStationCalibrationRateLimit/
    );
    expect(stations).toMatch(
      /capture-sessions\/:sessionId",\s*requirePartnerAuth,\s*requirePartnerCapability\("partner\.cards\.scan"\),\s*partnerStationReadRateLimit/
    );
    // RC-F11: the three signed-station hot paths CodeQL reported as js/missing-rate-limiting. Each
    // limiter sits AFTER both station guards so its per-station key can read req.station.
    expect(stations).toMatch(
      /card-jobs",\s*requireSignedStation,\s*requireSignedStationOperator,\s*partnerStationCardJobStartRateLimit/
    );
    expect(stations).toMatch(
      /stations\/fix-queue",\s*requireSignedStation,\s*requireSignedStationOperator,\s*partnerStationFixQueueRateLimit/
    );
    expect(stations).toMatch(
      /card-jobs\/:cardJobId\/fix-authorise",\s*requireSignedStation,\s*requireSignedStationOperator,\s*partnerStationFixAuthoriseRateLimit/
    );
    expect(staff).toMatch(/scanner-capture-sessions",\s*requireCapability\("scan"\),\s*staffScanCaptureLimit/);
    expect(staff).toMatch(/scanner-capture-sessions\/:sessionId",\s*requireCapability\("scan"\),\s*staffScanReadLimit/);
    expect(staff).toMatch(
      /scan\/certificates\/:id\/upload",\s*requireCapability\("scan"\),\s*staffScanUploadLimit,\s*scanUpload\.fields/
    );
    expect(grader).toMatch(/certificates\/:id\/grade",\s*requireCapability\("grade"\),\s*graderGradeMutationRateLimit/);
    expect(grader).toMatch(
      /certificates\/:id\/submit",\s*requireCapability\("grade"\),\s*graderGradeMutationRateLimit/
    );
    expect(submissions).toMatch(/packing-slip",\s*submissionPdfRateLimit/);
    expect(submissions).toMatch(/shipping-label",\s*submissionPdfRateLimit/);
    for (const source of [grading, stations, staff, grader]) {
      expect(source).toContain("passOnStoreError: false");
    }
  });
});
