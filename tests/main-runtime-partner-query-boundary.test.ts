import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

const DENIED_OPERATIONAL_RELATION =
  /\b(?:from|join)\s+(?:public\.)?partner_(?:card_jobs|connector_imports|connector_records|credit_reservations|organisations|station_calibrations|stations|submission_handoffs|submissions|users)\b/i;

function sqlTemplateBodies(source: string): string[] {
  return [...source.matchAll(/\bsql`([\s\S]*?)`/g)].map((match) => match[1]);
}

function slice(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`Could not isolate source between ${start} and ${end}`);
  return source.slice(from, to);
}

describe("main runtime Partner operational query boundary", () => {
  it("keeps the repaired main-pool callers free of denied Partner relations", () => {
    const completeFiles = [
      "server/commercial-growth-service.ts",
      "server/routes/admin-submissions.ts",
      "server/routes/grader.ts",
      "server/scanner-capture-service.ts",
      "server/partner/print-eligibility.ts",
    ];
    for (const path of completeFiles) {
      for (const body of sqlTemplateBodies(read(path))) {
        expect(body, `${path} contains a denied main-authority SQL template`).not.toMatch(DENIED_OPERATIONAL_RELATION);
      }
    }

    const routes = read("server/routes.ts");
    const gradingQueue = slice(
      routes,
      'app.get("/api/admin/grading-queue",',
      'app.get("/api/admin/grading-queue/current",'
    );
    for (const body of sqlTemplateBodies(gradingQueue)) {
      expect(body, "admin grading queue contains a denied main-authority SQL template").not.toMatch(
        DENIED_OPERATIONAL_RELATION
      );
    }

    const grading = read("server/partner/grading-routes.ts");
    const draftGuard = slice(
      grading,
      "export function partnerDraftWriteGuard",
      "export async function withLivePartnerWriteAuthority"
    );
    for (const body of sqlTemplateBodies(draftGuard)) {
      expect(body, "Partner grading main-write guard contains a denied Partner relation").not.toMatch(
        DENIED_OPERATIONAL_RELATION
      );
    }
  });

  it("uses the distinct Partner adapter for reads and holds provenance rows through main writes", () => {
    const adapter = read("server/partner/operational-authority.ts");
    expect(adapter).toContain("partnerAdminQuery");
    expect(adapter).toContain("withPartnerAdminTransaction");
    expect(adapter).toMatch(/connector operational authority: lock record first[\s\S]+FOR SHARE/);
    expect(adapter).toMatch(
      /FROM public\.partner_connector_records[\s\S]+FOR SHARE[\s\S]+FROM public\.partner_connector_imports[\s\S]+FOR SHARE[\s\S]+FROM public\.partner_submissions[\s\S]+FOR SHARE[\s\S]+FROM public\.partner_submission_handoffs[\s\S]+FOR SHARE/
    );
    expect(adapter).toMatch(/FOR SHARE OF station, calibration/);

    const grading = read("server/partner/grading-routes.ts");
    expect(grading).toContain("withLivePartnerWriteAuthority");
    expect(grading.match(/COALESCE\(\s*\(SELECT c\.submission_id/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});
