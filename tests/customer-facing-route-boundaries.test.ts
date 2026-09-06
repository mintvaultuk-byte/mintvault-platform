import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routes = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");

function between(start: string, end: string): string {
  const startAt = routes.indexOf(start);
  const endAt = routes.indexOf(end, startAt + start.length);
  expect(startAt, start).toBeGreaterThanOrEqual(0);
  expect(endAt, end).toBeGreaterThan(startAt);
  return routes.slice(startAt, endAt);
}

describe("customer-facing route boundary wiring", () => {
  it("authenticates and admits the retired hot-folder route before multer can buffer it", () => {
    const block = between('app.post(\n    "/api/admin/hot-folder-upload"', "// ── Build 5: AI Grading");
    const auth = block.indexOf("requireHotFolderUploadAuth");
    const admission = block.indexOf("hotFolderUploadAdmission.middleware");
    const multer = block.indexOf('hotFolderUpload.single("front")');
    const refusal = block.indexOf('code: "HOT_FOLDER_RETIRED"');

    expect(auth).toBeGreaterThanOrEqual(0);
    expect(admission).toBeGreaterThan(auth);
    expect(multer).toBeGreaterThan(admission);
    expect(refusal).toBeGreaterThan(multer);
    expect(block).not.toMatch(/bearerToken|validToken|headers\.authorization/);
    expect(routes).toContain("createHotFolderUploadAuth(process.env, requireAdmin)");
    expect(block).not.toContain("parseHotFolderUploadSide");
    expect(block).not.toContain("uploadToR2");
  });

  it("mounts retired scan-ingest as a sole pre-body 410 refusal", () => {
    const block = between("// ── Retired unbound scanner ingest", "// ── Scan-status poll");
    expect(block).toContain('app.post("/api/admin/scan-ingest", refuseRetiredScanIngest)');
    expect(block).not.toMatch(/requireScannerOrAdmin|scanUpload|multer|\.single\(|\.fields\(/);
  });

  it("requires live customer-session authority before owner PDF and reissue handlers", () => {
    expect(routes).toContain('app.get("/logbook/:certId/owner.pdf", requireCustomer, async (req, res) =>');
    expect(routes).toContain(
      'app.post("/api/logbook/:certId/reissue", requireCustomer, reissueRateLimit, async (req, res) =>'
    );
  });

  it.each([
    ["slab image", "// ── Slab showcase image proxy", "// ── Instagram share images"],
    ["share image", "/** Shared loader for the share endpoints", "// Variant-aware share image handler"],
    ["NFC scan", "// ── NFC PUBLIC SCAN ROUTE", "// ── PUBLIC CLAIM FLOW"],
  ])("uses the canonical approved-active resolver for %s", (_name, start, end) => {
    const block = between(start, end);
    expect(block).toContain("findCertByIdFlex(");
    expect(block).not.toContain("storage.getCertificateByCertId(");
  });

  it("rejects a hidden NFC record before telemetry and keys telemetry on resolved req.ip", () => {
    const block = between("// ── NFC PUBLIC SCAN ROUTE", "// ── PUBLIC CLAIM FLOW");
    expect(block.indexOf("if (!cert)")).toBeLessThan(block.indexOf("recordNfcScan"));
    expect(block).toContain("const ip = req.ip || req.socket.remoteAddress || undefined");
    expect(block).not.toContain('headers["x-forwarded-for"]');
  });

  it("filters certificate search through the canonical approved-active list boundary", () => {
    const block = between('app.get("/api/certs/search"', "// ── AI-ASSISTED GRADING");
    expect(block).toContain("filterPublicCertificates(dbResults).map");
  });
});
