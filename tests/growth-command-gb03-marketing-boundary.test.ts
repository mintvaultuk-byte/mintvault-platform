import fs from "node:fs";
import { describe, expect, it } from "vitest";

const reelQuery = fs.readFileSync("server/ig/weekly-reel-data.ts", "utf8");
const adminRoutes = fs.readFileSync("server/routes.ts", "utf8");

describe("GB-03 marketing consent boundary", () => {
  it("requires recorded submission consent for the public weekly-reel selection and its admin curation surface", () => {
    const consentTerms = reelQuery.match(/marketing_feature_consent = true/g) ?? [];
    expect(consentTerms).toHaveLength(2); // selection + count must remain in lockstep
    expect(reelQuery).toContain("JOIN submissions s ON s.id = si.submission_id");
    expect(adminRoutes).toContain("Marketing feature consent is required for this card.");
    expect(adminRoutes).toContain("AND s.marketing_feature_consent = true");
  });
});
