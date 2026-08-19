import fs from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FeatureFlagsContext } from "../client/src/hooks/use-feature-flags";
import PartnersPage from "../client/src/pages/partners";
import {
  partnerApplicationDedupeKey,
  partnerApplicationSchema,
  persistPartnerApplication,
  sanitizePartnerAttribution,
  type PartnerApplicationInput,
} from "../server/partner-applications";
import { isBodyLogSuppressed } from "../server/lib/request-logger";
import { getSeoMeta, getSitemapEntries } from "../server/seo-config";
import { renderPublicHtml } from "../server/static";
import { arePartnerApplicationsLive, isLegalDocumentPublic } from "../server/config/publication-gates";

const BASE_HTML = `<!doctype html><html><head><title>placeholder</title><meta name="description" content="x"><meta property="og:title" content="x"><meta property="og:description" content="x"><meta property="og:url" content="x"><meta name="twitter:title" content="x"><meta name="twitter:description" content="x"></head><body>app</body></html>`;
const PUBLIC_ROUTES = fs.readFileSync("server/routes/public.ts", "utf8");
const EMAIL = fs.readFileSync("server/email.ts", "utf8");
const MIGRATION = fs.readFileSync("migrations/0095_growth_partner_applications.sql", "utf8");
const PRIVACY_NOTICE = fs.readFileSync("content/legal/privacy-policy.md", "utf8");
const DOCKERFILE = fs.readFileSync("Dockerfile", "utf8");

const validApplication: PartnerApplicationInput = {
  businessName: "North Kent Cards",
  contactName: "Alex Shopkeeper",
  email: "alex@northkentcards.example",
  city: "Rochester",
  postcode: "ME1 1AA",
  businessType: "tcg_card_shop",
  webPresence: "https://northkentcards.example/about",
  interestReason: "We would like to understand whether a local MintVault grading route could suit our collector community.",
  physicalRetail: true,
  categories: ["Pokemon", "One Piece"],
  demandBand: "25_50",
  existingGradingSubmissions: "not_currently",
  privacyAcknowledged: true,
  attribution: {
    route: "/partners",
    utmSource: "outreach",
    utmMedium: "email",
    utmCampaign: "founding-partners",
    referrer: "https://search.example/results?q=private-query#fragment",
  },
};

describe("GB-03 public Partner acquisition contract", () => {
  it("renders a premium public application page with the factual operational boundary", () => {
    const markup = renderToStaticMarkup(
      createElement(FeatureFlagsContext.Provider, { value: { legalPagesLive: true, privacyNoticeLive: true, partnerApplicationsLive: true } }, createElement(PartnersPage))
    );
    expect(markup).toContain("Founding Partner applications");
    expect(markup).toContain("does not create a Partner account or confirm approval");
    expect(markup).toContain("Apply to become a Founding Partner");
    expect(markup).toContain("Business / shop name");
    expect(markup).toContain("Privacy Notice");
    expect(markup).toContain("does not sign you up for marketing");
    expect(markup).not.toMatch(/guaranteed earnings|zero investment|exclusive territory/i);
  });

  it("keeps capture unavailable when the legal publication flag is off", () => {
    const markup = renderToStaticMarkup(
      createElement(FeatureFlagsContext.Provider, { value: { legalPagesLive: false, privacyNoticeLive: false, partnerApplicationsLive: false } }, createElement(PartnersPage))
    );
    expect(markup).toContain("No business details are collected until that notice is available.");
    expect(markup).not.toContain('data-testid="partner-application-form"');
  });

  it("uses one dual publication gate for the application, SSR and legal notice", () => {
    expect(arePartnerApplicationsLive({ PRIVACY_NOTICE_LIVE: "false", PARTNER_APPLICATIONS_LIVE: "false" })).toBe(false);
    expect(arePartnerApplicationsLive({ PRIVACY_NOTICE_LIVE: "false", PARTNER_APPLICATIONS_LIVE: "true" })).toBe(false);
    expect(arePartnerApplicationsLive({ PRIVACY_NOTICE_LIVE: "true", PARTNER_APPLICATIONS_LIVE: "false" })).toBe(false);
    expect(arePartnerApplicationsLive({ PRIVACY_NOTICE_LIVE: "true", PARTNER_APPLICATIONS_LIVE: "true" })).toBe(true);
    expect(isLegalDocumentPublic("privacy-policy", { LEGAL_PAGES_LIVE: false, PRIVACY_NOTICE_LIVE: true, PARTNER_APPLICATIONS_LIVE: false })).toBe(true);
    expect(isLegalDocumentPublic("website-terms", { LEGAL_PAGES_LIVE: false, PRIVACY_NOTICE_LIVE: true, PARTNER_APPLICATIONS_LIVE: false })).toBe(false);
  });

  it("publishes a factual, versioned Partner privacy notice without draft or bundled-marketing language", () => {
    expect(PRIVACY_NOTICE).toContain('version: "v1.0-2026-08-19"');
    expect(PRIVACY_NOTICE).toContain("Partner applications");
    expect(PRIVACY_NOTICE).toContain("Legitimate interests");
    expect(PRIVACY_NOTICE).toContain("24 months");
    expect(PRIVACY_NOTICE).toContain("Information Commissioner’s Office");
    expect(PRIVACY_NOTICE).toContain("We do **not** add Partner applicants to a marketing list");
    expect(PRIVACY_NOTICE).toContain("withdrawal excludes the card from future reel selection");
    expect(PRIVACY_NOTICE).not.toMatch(/draft|pending solicitor|\[[A-Z _]+\]/i);
    expect(DOCKERFILE).toContain("COPY --from=builder /app/content/legal ./content/legal");
  });

  it("validates the short application server-side and rejects malformed or unapproved input", () => {
    expect(partnerApplicationSchema.safeParse(validApplication).success).toBe(true);
    expect(partnerApplicationSchema.safeParse({ ...validApplication, email: "not-an-email" }).success).toBe(false);
    expect(partnerApplicationSchema.safeParse({ ...validApplication, webPresence: "javascript:alert(1)" }).success).toBe(false);
    expect(partnerApplicationSchema.safeParse({ ...validApplication, webPresence: "https://user:pass@shop.example" }).success).toBe(false);
    expect(partnerApplicationSchema.safeParse({ ...validApplication, postcode: "not-a-postcode" }).success).toBe(false);
    expect(partnerApplicationSchema.safeParse({ ...validApplication, interestReason: "too short" }).success).toBe(false);
    expect(partnerApplicationSchema.safeParse({ ...validApplication, privacyAcknowledged: false }).success).toBe(false);
    expect(partnerApplicationSchema.safeParse({ ...validApplication, internalStatus: "QUALIFIED" }).success).toBe(false);
  });

  it("uses a stable one-way duplicate key and minimises attribution", () => {
    expect(partnerApplicationDedupeKey(validApplication)).toBe(
      partnerApplicationDedupeKey({ ...validApplication, businessName: "  NORTH KENT CARDS ", email: "ALEX@NORTHKENTCARDS.EXAMPLE" })
    );
    const attribution = sanitizePartnerAttribution(validApplication.attribution);
    expect(attribution).toEqual({
      route: "/partners",
      utmSource: "outreach",
      utmMedium: "email",
      utmCampaign: "founding-partners",
      referrerOrigin: "https://search.example",
    });
    expect(JSON.stringify(attribution)).not.toContain("private-query");
  });

  it("persists and audits a new lead before any notification, with a deterministic duplicate receipt", async () => {
    const newCalls: unknown[] = [];
    const created = await persistPartnerApplication(
      {
        transaction: async (operation) => operation(async (query) => {
          newCalls.push(query);
          return newCalls.length === 1 ? { rows: [{ id: "11111111-1111-4111-8111-111111111111" }] } : { rows: [] };
        }),
      },
      validApplication,
      sanitizePartnerAttribution(validApplication.attribution)
    );
    expect(created).toEqual({ leadId: "11111111-1111-4111-8111-111111111111", created: true });
    expect(newCalls).toHaveLength(2); // lead + PII-free audit event

    const duplicateCalls: unknown[] = [];
    const duplicate = await persistPartnerApplication(
      {
        transaction: async (operation) => operation(async (query) => {
          duplicateCalls.push(query);
          return duplicateCalls.length === 1 ? { rows: [] } : { rows: [{ id: "11111111-1111-4111-8111-111111111111" }] };
        }),
      },
      validApplication,
      sanitizePartnerAttribution(validApplication.attribution)
    );
    expect(duplicate).toEqual({ leadId: "11111111-1111-4111-8111-111111111111", created: false });
    expect(duplicateCalls).toHaveLength(2); // insert attempt + existing opaque ID; no duplicate audit
    expect(PUBLIC_ROUTES).toContain("return res.status(201).json({ ok: true, leadId: result.leadId })");
    expect(PUBLIC_ROUTES).not.toContain("result.created ? 201 : 200");
  });

  it("keeps application responses out of logs and makes notification non-authoritative", () => {
    expect(isBodyLogSuppressed("/api/partner-applications")).toBe(true);
    expect(PUBLIC_ROUTES.indexOf("persistPartnerApplication")).toBeLessThan(PUBLIC_ROUTES.indexOf("sendPartnerApplicationNotification"));
    expect(PUBLIC_ROUTES).toContain("notification_error");
    expect(PUBLIC_ROUTES).not.toContain("notificationErr?.message");
    expect(PUBLIC_ROUTES).not.toContain('console.error("[partner-application] route error:", err?.message || err)');
    expect(PUBLIC_ROUTES).toContain('console.error("[partner-application] route error")');
    expect(EMAIL).toContain("subject: `MintVault Partner Application ${data.leadId}`");
    expect(EMAIL).toContain("escapeHtmlForEmail");
  });

  it("does not market an unavailable application funnel to search, while retaining its future canonical", () => {
    const meta = getSeoMeta("/partners?utm_source=organic");
    expect(meta.canonical).toBe("https://mintvaultuk.com/partners");
    expect(meta.title).toBe("MintVault Partner Programme | MintVault UK");
    expect(meta.noindex).toBe(true);
    expect(getSitemapEntries().some((entry) => entry.loc === "/partners")).toBe(false);
    const rendered = renderPublicHtml(BASE_HTML, "/partners");
    expect(rendered.status).toBe(200);
    expect(rendered.html).toContain('<link rel="canonical" href="https://mintvaultuk.com/partners" />');
    expect(rendered.noindex).toBe(true);
  });

  it("keeps the isolated table and public endpoint out of operational Partner identities", () => {
    expect(MIGRATION).toContain("CREATE TABLE IF NOT EXISTS partner_applications");
    expect(MIGRATION).toContain("chk_partner_application_status");
    expect(MIGRATION).not.toContain("REFERENCES partner_");
    expect(PUBLIC_ROUTES).toContain('app.post("/api/partner-applications"');
    expect(PUBLIC_ROUTES).not.toContain('app.get("/api/partner-applications"');
    expect(PUBLIC_ROUTES).toContain("!FEATURE_FLAGS.PARTNER_APPLICATIONS_LIVE");
    expect(MIGRATION).toContain("privacy_notice_version text NOT NULL");
    expect(MIGRATION).toContain("retention_review_at timestamptz NOT NULL DEFAULT (now() + interval '24 months')");
    expect(MIGRATION).not.toContain("marketing_opt_in");
  });

  it("uses an unoccupied forward migration number", () => {
    const numbered = fs
      .readdirSync("migrations")
      .filter((file) => /^\d{4}_.*\.sql$/.test(file))
      .map((file) => file.slice(0, 4));
    expect(numbered.filter((prefix) => prefix === "0095")).toHaveLength(1);
    expect(new Set(numbered).size).toBe(numbered.length);
  });
});
