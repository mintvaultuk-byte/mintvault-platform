import fs from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  cleanAttributionValue,
  generateTrackedCampaignLink,
  normaliseAttribution,
  recordSubmissionAttribution,
} from "../server/commercial-attribution";
import { getGrowthSummary, isGrowthPeriod, isPartnerLeadStatus } from "../server/commercial-growth-service";
import { attributionFromSearch } from "../client/src/lib/commercial-attribution";
import { safeExternalUrl } from "../client/src/pages/admin/growth";
import { isBodyLogSuppressed } from "../server/lib/request-logger";
import { listMigrationFiles } from "../scripts/db/migrate";

const dialect = new PgDialect();
const migration = fs.readFileSync("migrations/0100_growth_commercial_attribution.sql", "utf8");
const growthRoute = fs.readFileSync("server/routes/admin/commercial-growth.ts", "utf8");
const growthService = fs.readFileSync("server/commercial-growth-service.ts", "utf8");
const growthPage = fs.readFileSync("client/src/pages/admin/growth.tsx", "utf8");
const shell = fs.readFileSync("client/src/components/admin/admin-shell.tsx", "utf8");
const adminTokens = fs.readFileSync("client/src/styles/admin-tokens.css", "utf8");
const partnersPage = fs.readFileSync("client/src/pages/partners.tsx", "utf8");
const submissions = fs.readFileSync("server/routes/submissions.ts", "utf8");
const storage = fs.readFileSync("server/storage.ts", "utf8");

describe("GB-04 Growth Command commercial authority", () => {
  it("keeps Growth in the next forward migration identity after immutable Partner 0099", () => {
    const names = listMigrationFiles().map((file) => file.filename);
    expect(names).toContain("0100_growth_commercial_attribution.sql");
    expect(names).not.toContain("0099_growth_commercial_attribution.sql");
  });

  it("accepts only MintVault-owned campaign tokens and rejects PII-shaped values on both boundaries", () => {
    const campaigns = new Set(["medway_cataclysm"]);
    for (const unsafe of [
      "alice@example.com",
      "07700900123",
      "Jane Smith",
      "alice-smith",
      "https://campaign.example/private",
      "<img>",
    ]) {
      expect(cleanAttributionValue(unsafe, campaigns)).toBeUndefined();
    }
    expect(cleanAttributionValue("medway_cataclysm", campaigns)).toBe("medway_cataclysm");
    expect(
      normaliseAttribution({ utm_source: "outreach", utm_medium: "email", utm_campaign: "medway_cataclysm" })
    ).toMatchObject({
      source: "outreach",
      medium: "email",
      campaign: "medway_cataclysm",
      category: "PARTNER_OUTREACH",
    });
    expect(
      attributionFromSearch(
        "?utm_source=alice%40example.com&utm_term=07700900123&utm_campaign=Jane%20Smith&utm_medium=email"
      )
    ).toEqual({ utm_medium: "email" });
  });

  it("does not manufacture Direct attribution when a paid submission has no approved reference", async () => {
    const calls: unknown[] = [];
    await recordSubmissionAttribution(
      42,
      { utm_source: "alice@example.com" },
      {
        execute: async (query) => {
          calls.push(query);
          return { rows: [] };
        },
      }
    );
    expect(calls).toHaveLength(0);

    await recordSubmissionAttribution(
      42,
      { utm_source: "outreach", utm_medium: "email", utm_campaign: "medway_cataclysm" },
      {
        execute: async (query) => {
          calls.push(dialect.sqlToQuery(query));
          return { rows: [] };
        },
      }
    );
    expect(calls).toHaveLength(1);
    const query = calls[0] as { sql: string; params: unknown[] };
    expect(query.sql).toContain("INSERT INTO submission_acquisition");
    expect(query.params).toContain("medway_cataclysm");
    expect(query.params).not.toContain("alice@example.com");
  });

  it("generates the approved Medway Cataclysm Partner outreach link on server-owned targets", () => {
    const link = generateTrackedCampaignLink({
      target: "partner",
      source: "outreach",
      medium: "email",
      campaign: "medway_cataclysm",
    });
    expect(link.url).toMatch(/\/partners\?utm_source=outreach/);
    expect(link.url).toContain("utm_medium=email");
    expect(link.url).toContain("utm_campaign=medway_cataclysm");
    expect(() =>
      generateTrackedCampaignLink({
        target: "https://evil.example",
        source: "outreach",
        medium: "email",
        campaign: "medway_cataclysm",
      })
    ).toThrow();
    expect(attributionFromSearch(new URL(link.url).search)).toMatchObject({
      utm_source: "outreach",
      utm_medium: "email",
      utm_campaign: "medway_cataclysm",
    });
    expect(partnersPage).toContain("const params = attributionFromSearch(window.location.search)");
  });

  it("reports only verified paid rows and labels legacy/unapproved values as unattributed", async () => {
    const replies = [
      {
        rows: [{ paid_submissions: "2", paid_cards: "7", revenue_pence: "4400", avg_cards: "3.5", unattributed: "1" }],
      },
      {
        rows: [
          {
            category: "EMAIL",
            campaign: "email-pilot",
            paid_submissions: "1",
            paid_cards: "2",
            revenue_pence: "1900",
            partner_applications: "0",
          },
          {
            category: "UNATTRIBUTED",
            campaign: "alice-smith",
            paid_submissions: "1",
            paid_cards: "5",
            revenue_pence: "2500",
            partner_applications: "0",
          },
        ],
      },
      {
        rows: [
          {
            total: "3",
            new_count: "1",
            contacted_count: "1",
            qualified_count: "1",
            not_a_fit_count: "0",
            onboarding_count: "0",
          },
        ],
      },
      { rows: [{ source: "outreach", medium: "email", campaign: "founding-partners", partner_applications: "3" }] },
      { rows: [{ active_count: "4" }] },
    ];
    let index = 0;
    const summary = await getGrowthSummary(
      "30d",
      { execute: async () => replies[index++] as { rows: unknown[] } },
      async () => 4
    );
    expect(summary.paid).toMatchObject({
      paidSubmissions: { value: 2 },
      paidCards: { value: 7 },
      revenuePence: { value: 4400 },
      unattributedPaidSubmissions: { value: 1 },
    });
    expect(summary.campaignPerformance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "EMAIL", campaign: "email-pilot", paidSubmissions: 1 }),
        expect.objectContaining({ category: "UNATTRIBUTED", campaign: "UNATTRIBUTED", paidSubmissions: 1 }),
        expect.objectContaining({
          category: "PARTNER_OUTREACH",
          campaign: "founding-partners",
          partnerApplications: 3,
        }),
      ])
    );
    expect(summary.partnerRevenue.state).toBe("NOT_INSTRUMENTED");
    expect(summary.repeatCustomerRate.state).toBe("NOT_INSTRUMENTED");
    expect(summary.historical.state).toBe("NOT_INSTRUMENTED");
  });

  it("keeps the paid transition single-winner while recording only verified Stripe payment facts", () => {
    expect(submissions).toContain("amountPence: piAmount");
    expect(submissions).toContain("currency: payment.currency");
    expect(storage).toContain("payment_amount = CASE WHEN");
    expect(storage).toContain("payment_timestamp = COALESCE");
    expect(storage).toContain("AND payment_status != 'paid'");
    expect(submissions).toContain("recordSubmissionAttribution(Number(submission.id), attribution)");
  });

  it("keeps Super Admin API/UI capability narrow, auditable, responsive and non-provisioning", () => {
    expect(isGrowthPeriod("today")).toBe(true);
    expect(isGrowthPeriod("tomorrow")).toBe(false);
    expect(isPartnerLeadStatus("ONBOARDING")).toBe(true);
    expect(isPartnerLeadStatus("ACTIVE")).toBe(false);
    expect(growthRoute).toContain("router.use(requireSuperAdmin, readLimit)");
    expect(growthService).toContain("growth_status_changed");
    expect(growthRoute).not.toMatch(/partner_organisations\s+(INSERT|UPDATE)/i);
    expect(isBodyLogSuppressed("/api/super-admin/growth/summary")).toBe(true);
    expect(shell).toContain('href: "/admin/growth"');
    expect(shell).toContain("superAdminOnly: true");
    expect(growthPage).toContain("No tenant, user, location, station, credit or approval");
    expect(growthPage).toContain("grid gap-3 sm:grid-cols-2 xl:grid-cols-5");
    expect(adminTokens).toMatch(/\.admin-panel\s*\{[\s\S]*?min-width:\s*0;/);
  });

  it("uses an additive next-free migration without browser identifiers or PII columns", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS submission_acquisition");
    expect(migration).toContain("idx_submissions_paid_growth_window");
    expect(migration).not.toMatch(/\n\s*(cookie|referrer|ip_address|email|phone)\s/i);
    const numbered = fs
      .readdirSync("migrations")
      .filter((file) => /^\d{4}_.*\.sql$/.test(file))
      .map((file) => file.slice(0, 4));
    /*
     * 0099 belongs to Partner checkout hardening, not to Growth. It used to be ABSENT from the
     * release tree — the journal owned the number but the file did not ship — and this assertion
     * pinned that absence. That gap was the defect: the staging database carried 0099's schema while
     * neither this branch nor main carried the code that speaks to it, so a partner's second
     * checkout of a pack 502'd permanently. The file is now shipped, with a checksum byte-identical
     * to the applied journal row, so it reconciles instead of colliding.
     *
     * The invariant that actually protects Growth is unchanged and asserted below: Growth owns 0100,
     * exactly one file claims each number, and 0099 is somebody else's.
     */
    expect(numbered.filter((number) => number === "0099")).toHaveLength(1);
    expect(fs.readdirSync("migrations").filter((file) => /^0099_/.test(file))).toEqual([
      "0099_partner_credit_checkout_operation_idempotency.sql",
    ]);
    expect(numbered.filter((number) => number === "0100")).toHaveLength(1);
    expect(new Set(numbered).size).toBe(numbered.length);
  });

  it("opens only safe optional Partner web presence URLs", () => {
    expect(safeExternalUrl("https://shop.example/about")).toBe("https://shop.example/about");
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl("https://user:pass@shop.example")).toBeNull();
  });
});
