/**
 * B1/B2/B3 — the three core Partner release blockers, pinned so they cannot silently return.
 *
 * WHY SOURCE ASSERTIONS AND NOT ONLY BEHAVIOUR. Each of these defects was a MISSING call site, not
 * a wrong result: a route that was never added, a guard that was never applied, a query arm that was
 * never written. A behavioural test can only exercise code that is reachable, so it cannot fail for
 * an absent route — the very shape of all three bugs. These read the shipped source and assert the
 * call site exists with the exact authority around it, which is the same technique
 * tests/scanner-station-capture-boundary.test.ts already uses for the capture boundary.
 *
 * The B3 query is ALSO proved behaviourally against a real PostgreSQL by the DB-backed suites that
 * apply the full migration set; what is pinned here is that both lineage arms remain present and
 * that neither can be deleted without a red test.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const stationRoutes = read("server/partner/station-routes.ts");

/**
 * Anchor on the ROUTE, never on the comment above it that quotes the same path. Slicing from a bare
 * indexOf() of the path string lands inside that comment and silently truncates every assertion
 * below — which is the exact class of false-green this file exists to prevent.
 */
const ARM_ROUTE = '\n  r.post("/card-jobs/:cardJobId/capture-sessions"';
const armRouteSlice = (chars: number) =>
  stationRoutes.slice(stationRoutes.indexOf(ARM_ROUTE), stationRoutes.indexOf(ARM_ROUTE) + chars);
const armRouteHandler = () => {
  const from = stationRoutes.slice(stationRoutes.indexOf(ARM_ROUTE));
  return from.slice(0, from.indexOf("\n  });"));
};
const captureAuthority = read("server/partner/capture-authority.ts");
const submissionService = read("server/partner/submission-service.ts");
const submissionRoutes = read("server/partner/submission-routes.ts");
const flags = read("server/partner/flags.ts");
const certificateHistory = read("server/partner/certificate-history-service.ts");
const scannerClient = read("scripts/scanner-app/lib/server-client.js");
const scannerMain = read("scripts/scanner-app/main.js");
const scannerPreload = read("scripts/scanner-app/preload.js");

describe("B1 — a station can arm its own capture session", () => {
  it("exposes the signed-station arming route", () => {
    expect(stationRoutes).toContain('r.post("/card-jobs/:cardJobId/capture-sessions"');
  });

  it("guards that route with station signature, operator session and a rate limit, in that order", () => {
    // The same ordering the boundary suite pins for the other station routes: signature first so an
    // unsigned request never reaches session resolution, operator second, budget last.
    expect(armRouteSlice(300)).toMatch(
      /requireSignedStation,\s*requireSignedStationOperator,\s*partnerStationCaptureAuthoriseRateLimit/
    );
  });

  it("derives the certificate from the Card Job and never from the request body", () => {
    const handler = armRouteHandler();
    // The certificate id must come from the authorisation the server computed.
    expect(handler).toContain("certificateId: authorisation.certificateId");
    // …and must never be read off the request.
    expect(handler).not.toMatch(/req\.body\??\.\s*certificateId/);
    expect(handler).not.toMatch(/certificateId:\s*Number\(req\./);
  });

  it("takes tenant, location and station from the authenticated principals, not the body", () => {
    const handler = armRouteHandler();
    expect(handler).toContain("tenantId: station.tenantId");
    expect(handler).toContain("locationId: station.locationId");
    expect(handler).toContain("stationId: station.id");
    expect(handler).not.toMatch(/tenantId:\s*req\.body/);
    expect(handler).not.toMatch(/locationId:\s*req\.body/);
  });

  it("refuses a station that is not ACTIVE", () => {
    expect(captureAuthority).toContain("STATION_NOT_ACTIVE");
    expect(captureAuthority).toMatch(/status\s*!==\s*"ACTIVE"/);
  });

  it("scopes the Card Job lookup to the authenticated tenant and rejects a cancelled job", () => {
    expect(captureAuthority).toMatch(/WHERE id = \$1 AND tenant_id = \$2 AND cancelled_at IS NULL/);
  });

  it("reports a wrong-tenant and a wrong-location card identically, so an id is never confirmed", () => {
    // Both the tenant miss and the location miss must raise the SAME code. A different code for a
    // real-but-forbidden id tells the caller the id exists.
    const notFoundCount = (captureAuthority.match(/CARD_JOB_NOT_FOUND/g) ?? []).length;
    expect(notFoundCount).toBeGreaterThanOrEqual(3); // type union + tenant miss + location miss
    expect(captureAuthority).toMatch(/stationRow\.location_id !== job\.location_id[\s\S]{0,200}CARD_JOB_NOT_FOUND/);
  });

  it("only arms from states that are genuinely waiting for a photograph", () => {
    expect(captureAuthority).toMatch(
      /CAPTURABLE_STATUSES = new Set\(\["NEEDS_SCAN", "CAPTURING", "FIX_REQUIRED"\]\)/
    );
    // READY_TO_GRADE and GRADING must NOT be armable: both sides are present, so arming there would
    // overwrite an accepted image without the invalidation that is supposed to precede it.
    const setLine = captureAuthority.slice(
      captureAuthority.indexOf("CAPTURABLE_STATUSES = new Set("),
      captureAuthority.indexOf("CAPTURABLE_STATUSES = new Set(") + 120
    );
    expect(setLine).not.toContain("READY_TO_GRADE");
    expect(setLine).not.toContain("GRADING");
  });

  it("refuses a side that already has a current image rather than silently arming another", () => {
    expect(captureAuthority).toContain("SIDE_ALREADY_PRESENT");
    expect(captureAuthority).toContain("NOTHING_TO_CAPTURE");
    expect(captureAuthority).toMatch(/if \(!missing\.includes\(requested\)\)/);
  });

  it("reads outstanding sides from the evidence ledger, not from the job status", () => {
    expect(captureAuthority).toMatch(
      /FROM certificate_image_evidence\s*\n\s*WHERE certificate_id = \$1 AND is_current = true/
    );
  });

  it("spends nothing: the capture authority contains no wallet, ledger or allocator call", () => {
    expect(captureAuthority).not.toMatch(/reserveCredit|partner_credit_ledger|cert_counter|appendFoundationCredit/);
  });

  it("audits every authorisation", () => {
    expect(captureAuthority).toContain("partner_station_capture_authorised");
    expect(captureAuthority).toContain("writePartnerAudit");
  });

  it("never passes recapture:true from the station path", () => {
    const handler = armRouteHandler();
    expect(handler).toMatch(/recapture:\s*false/);
    expect(handler).not.toMatch(/recapture:\s*(true|req\.)/);
  });

  it("the Scanner app uses the canonical station path and no browser arming", () => {
    expect(scannerClient).toContain("/capture-sessions");
    expect(scannerClient).toMatch(/async function armCapture\(cardJobId, side\)/);
    // It must NOT reach the cookie-authenticated portal arming route.
    expect(scannerClient).not.toContain("/api/partner/stations/${encodeURIComponent(stationCode)}/capture-sessions");
    expect(scannerMain).toContain("server.armCapture");
    expect(scannerPreload).toContain('ipcRenderer.invoke("arm-capture"');
  });

  it("a failed arm does not discard the card the shop has already paid for", () => {
    const handler = scannerMain.slice(scannerMain.indexOf('ipcMain.handle("start-new-card"'));
    const body = handler.slice(0, handler.indexOf("\n  });"));
    // The success branch still returns ok:true with the cardJob even when arming failed.
    expect(body).toMatch(/captureError/);
    expect(body).toMatch(/return \{ ok: true, cardJob: job, capture, captureError \}/);
  });
});

describe("B2 — the submission wizard cannot strand a credit", () => {
  it("declares the intake flag", () => {
    expect(flags).toContain('"partner_submission_intake_enabled"');
  });

  it("fails closed: a flag with no row resolves false", () => {
    expect(flags).toMatch(/if \(rows\.length === 0\) return false; \/\/ fail closed/);
  });

  it("gates submitSubmission on the flag", () => {
    expect(submissionService).toContain('resolveFlag(c, "partner_submission_intake_enabled"');
    expect(submissionService).toContain("submission_intake_disabled");
  });

  it("gates BEFORE any credit is reserved", () => {
    const gate = submissionService.indexOf('resolveFlag(c, "partner_submission_intake_enabled"');
    const reserve = submissionService.indexOf("reserveCreditInTransaction", gate);
    expect(gate).toBeGreaterThan(-1);
    expect(reserve).toBeGreaterThan(gate);
  });

  it("gates AFTER the idempotency short-circuit, so an already-successful submit still reads back", () => {
    const idempotency = submissionService.indexOf("Idempotency short-circuit");
    const gate = submissionService.indexOf('resolveFlag(c, "partner_submission_intake_enabled"');
    expect(idempotency).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(idempotency);
  });

  it("answers 503, not 400 — the request is well-formed, the capability is off", () => {
    expect(submissionRoutes).toMatch(/err\.code === "submission_intake_disabled"\s*\n?\s*\?\s*503/);
  });

  it("leaves drafting, reading and cancelling untouched — only the reserving step is gated", () => {
    // The gate must appear exactly once, inside submitSubmission, and nowhere near cancel/create.
    const occurrences = (submissionService.match(/partner_submission_intake_enabled/g) ?? []).length;
    expect(occurrences).toBe(1);
    const cancel = submissionService.indexOf("export async function cancelSubmission");
    const gate = submissionService.indexOf("partner_submission_intake_enabled");
    const submit = submissionService.indexOf("export async function submitSubmission");
    expect(gate).toBeGreaterThan(submit);
    if (cancel > submit) expect(gate).toBeLessThan(cancel);
  });

  it("does not weaken any credit reservation invariant", () => {
    // The reservation call and its idempotency key convention must be untouched.
    expect(submissionService).toContain("partner-submission-credit:");
    expect(submissionService).toContain("reserveCreditInTransaction");
  });
});

describe("B3 — Scanner-origin cards are visible in the Partner certificate history", () => {
  it("the list query has BOTH lineage arms", () => {
    const list = certificateHistory.slice(
      certificateHistory.indexOf("export async function listPartnerCertificateHistory"),
      certificateHistory.indexOf("export async function getPartnerCertificateDetail")
    );
    expect(list).toContain("partner_connector_imports");
    expect(list).toContain("FROM partner_card_jobs job");
    expect(list).toContain("UNION ALL");
  });

  it("the detail query has BOTH lineage arms", () => {
    const detail = certificateHistory.slice(certificateHistory.indexOf("export async function getPartnerCertificateDetail"));
    expect(detail).toContain("partner_connector_imports");
    expect(detail).toContain("FROM partner_card_jobs job");
    expect(detail).toContain("UNION ALL");
  });

  it("de-duplicates so a certificate present in both lineages is listed once, Card Job winning", () => {
    // Migration 0081 stamps certificate_id onto connector Card Jobs too, so both arms can match the
    // same certificate. lineage_rank 0 (Card Job) must sort before 1 (connector).
    const occurrences = (certificateHistory.match(/SELECT DISTINCT ON \(certificate_id\)/g) ?? []).length;
    expect(occurrences).toBe(2); // list + detail
    expect(certificateHistory).toMatch(/ORDER BY certificate_id, lineage_rank/);
    expect(certificateHistory).toMatch(/job\.status AS card_job_status,\s*\n\s*0 AS lineage_rank/);
    expect(certificateHistory).toMatch(/NULL::text AS card_job_status,\s*\n\s*1 AS lineage_rank/);
  });

  it("proves tenant AND location independently in the Card Job arm", () => {
    expect(certificateHistory).toMatch(/WHERE job\.tenant_id = \$1::uuid/);
    expect(certificateHistory).toMatch(/cert\.origin_partner_id = job\.tenant_id/);
    expect(certificateHistory).toMatch(/cert\.origin_location_id = job\.location_id/);
    expect(certificateHistory).toContain("AND job.cancelled_at IS NULL");
  });

  it("keeps the location filter on BOTH arms for a location-scoped user", () => {
    expect(certificateHistory).toContain("cardJobLocationWhere");
    expect(certificateHistory).toContain("connectorLocationWhere");
    expect(certificateHistory).toMatch(/cardJobLocationWhere = `AND job\.location_id = \$\$\{params\.length\}::uuid`/);
  });

  it("re-asserts the immutable origin snapshot in the Card Job arm too", () => {
    const cardJobArms = certificateHistory.match(/FROM partner_card_jobs job[\s\S]{0,700}?\)/g) ?? [];
    expect(cardJobArms.length).toBeGreaterThanOrEqual(2);
    for (const arm of cardJobArms) {
      expect(arm).toContain("cert.origin_type = 'PARTNER'");
      expect(arm).toContain("cert.deleted_at IS NULL");
    }
  });

  it("surfaces the walk-in lifecycle state so a list can separate waiting from finished", () => {
    expect(certificateHistory).toContain("cardJobStatus: string | null");
    expect(certificateHistory).toMatch(/cardJobStatus: row\.card_job_status/);
  });

  it("copies no Card Job row into another table for presentation", () => {
    expect(certificateHistory).not.toMatch(/INSERT INTO|UPDATE .*SET|DELETE FROM/i);
  });

  it("no orphaned connector-only predicate survives in either WHERE clause", () => {
    // The rewrite moved every pci.* predicate into the connector CTE arm. A stray reference outside
    // it would be a runtime error, because `pci` is no longer in scope for the outer query.
    const outerList = certificateHistory.slice(
      certificateHistory.indexOf("       resolved AS ("),
      certificateHistory.indexOf("export async function getPartnerCertificateDetail")
    );
    expect(outerList).not.toContain("pci.");
  });
});
