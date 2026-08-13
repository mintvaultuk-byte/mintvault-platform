import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("release route rate-limit hardening", () => {
  it("uses fail-closed, CodeQL-recognised guards after authentication/capability checks", () => {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const grading = readFileSync(`${here}/../server/partner/grading-routes.ts`, "utf8");
    const stations = readFileSync(`${here}/../server/partner/station-routes.ts`, "utf8");
    const staff = readFileSync(`${here}/../server/routes/staff.ts`, "utf8");

    expect(grading).toMatch(
      /edit-submission",\s*requirePartnerCapability\("partner\.cards\.assess"\),\s*requireNotViewOnly,\s*requireNotSensitiveFrozen,\s*partnerGradingEditRateLimit/
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
    expect(staff).toMatch(/scanner-capture-sessions",\s*requireCapability\("scan"\),\s*staffScanCaptureLimit/);
    expect(staff).toMatch(/scanner-capture-sessions\/:sessionId",\s*requireCapability\("scan"\),\s*staffScanReadLimit/);
    for (const source of [grading, stations, staff]) {
      expect(source).toContain("passOnStoreError: false");
    }
  });
});
