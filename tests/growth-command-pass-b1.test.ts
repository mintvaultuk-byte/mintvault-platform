import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { generatePdfToken, verifyPdfToken } from "../server/lib/pdf-token";
import { paidSubmissionConfirmation } from "../server/lib/paid-submission-confirmation";
import { getSeoMeta, getSitemapEntries, isKnownPublicRoute, isNoindexRoute } from "../server/seo-config";
import { publicRequestPath, renderPublicHtml, staticAssetOptions } from "../server/static";

const BASE_HTML = `<!doctype html><html><head><title>placeholder</title><meta name="description" content="x"><meta property="og:title" content="x"><meta property="og:description" content="x"><meta property="og:url" content="x"><meta name="twitter:title" content="x"><meta name="twitter:description" content="x"></head><body>app</body></html>`;
const SUBMISSION_ROUTES = fs.readFileSync("server/routes/submissions.ts", "utf8");
const SUBMIT_PAGE = fs.readFileSync("client/src/pages/submit.tsx", "utf8");
const REDIRECT_ROUTES = fs.readFileSync("server/routes/redirects.ts", "utf8");

describe("GB-01 paid confirmation capability", () => {
  const previousSecret = process.env.SIGNED_URL_SECRET;
  afterEach(() => {
    if (previousSecret === undefined) delete process.env.SIGNED_URL_SECRET;
    else process.env.SIGNED_URL_SECRET = previousSecret;
  });

  it("returns a minimal authoritative confirmation for valid paid single and multi-card submissions", () => {
    for (const cardCount of [1, 3]) {
      expect(
        paidSubmissionConfirmation({
          submissionId: `MV-SUB-${cardCount}`,
          status: "paid",
          serviceTier: "standard",
          serviceType: "grading",
          cardCount,
          totalPrice: "57.00",
          createdAt: "2026-08-19T00:00:00Z",
          customerEmail: "private@example.test",
          returnPostcode: "AB1 2CD",
        })
      ).toEqual({
        submissionId: `MV-SUB-${cardCount}`,
        status: "paid",
        serviceTier: "standard",
        serviceType: "grading",
        cardCount,
        totalPrice: "57.00",
        createdAt: "2026-08-19T00:00:00Z",
      });
    }
  });

  it("fails closed for drafts, failed/cancelled payments, and nonexistent records", () => {
    expect(paidSubmissionConfirmation(undefined)).toBeNull();
    expect(paidSubmissionConfirmation({ status: "draft" })).toBeNull();
    expect(paidSubmissionConfirmation({ status: "failed" })).toBeNull();
    expect(paidSubmissionConfirmation({ status: "cancelled" })).toBeNull();
  });

  it("uses an expiry-bound submission token that cannot be replayed against another submission", () => {
    process.env.SIGNED_URL_SECRET = "test-success-token-secret";
    const token = generatePdfToken("MV-SUB-1", 60_000);
    expect(verifyPdfToken("MV-SUB-1", token)).toBe(true);
    expect(verifyPdfToken("MV-SUB-2", token)).toBe(false);
    expect(verifyPdfToken("MV-SUB-1", "malformed")).toBe(false);
  });

  it("keeps the ordinary email ownership lookup intact and gates the new read by token and paid state", () => {
    const successRoute = SUBMISSION_ROUTES.slice(
      SUBMISSION_ROUTES.indexOf('app.get("/api/submissions/:submissionId/success"'),
      SUBMISSION_ROUTES.indexOf('app.get("/api/submissions/:submissionId",')
    );
    expect(successRoute).toContain("verifyPdfToken(submissionId, req.query.token)");
    expect(successRoute).toContain("paidSubmissionConfirmation");
    expect(successRoute).toContain('"private, no-store"');
    expect(successRoute).not.toMatch(/customerEmail|returnAddress|returnPostcode/);
    const ownerLookup = SUBMISSION_ROUTES.slice(SUBMISSION_ROUTES.indexOf('app.get("/api/submissions/:submissionId",'));
    expect(ownerLookup).toContain('res.status(401).json({ error: "Email required" })');
  });

  it("does not redirect from Stripe confirmation unless the server confirms paid status and a token", () => {
    expect(SUBMIT_PAGE).toContain("confirmData?.success !== true");
    expect(SUBMIT_PAGE).toContain('confirmData?.status !== "paid"');
    expect(SUBMIT_PAGE).toContain('typeof confirmData?.packingSlipToken !== "string"');
    expect(SUBMIT_PAGE).toContain("Payment was not completed. Please try again when you are ready.");
    expect(SUBMISSION_ROUTES).toContain("await fulfilPaidSubmission(submission");
  });

  it("normalises and blocks mismatched multi-card drafts before payment while retaining the server guard", () => {
    expect(SUBMIT_PAGE).toContain("state.quantity > 1 && state.cardItems.length !== state.quantity");
    expect(SUBMIT_PAGE).toContain("const detailsRequired = qty > 1");
    expect(SUBMIT_PAGE).toContain("if (state.quantity > 1) return");
    expect(SUBMISSION_ROUTES).toContain('"Card details required for multi-card submissions"');
    expect(SUBMISSION_ROUTES).toContain("Card details count (${cardItems.length}) must match quantity (${quantity})");
  });
});

describe("GB-02 rendered search policy", () => {
  it("gives priority public URLs stable absolute canonicals independent of query strings", () => {
    expect(getSeoMeta("/pokemon-card-grading-uk?utm_source=test").canonical).toBe(
      "https://mintvaultuk.com/pokemon-card-grading-uk"
    );
    expect(getSeoMeta("/pricing").canonical).toBe("https://mintvaultuk.com/pricing");
    expect(getSeoMeta("/submit").canonical).toBe("https://mintvaultuk.com/submit");
    expect(REDIRECT_ROUTES).toContain('app.get("/cert", (_req, res) => res.redirect(301, "/verify"))');
  });

  it("renders Journal articles under current URLs with their article metadata", () => {
    const meta = getSeoMeta("/journal/how-to-grade-pokemon-cards-uk");
    expect(meta.title).toBe("How to Grade Pokémon Cards in the UK | MintVault UK");
    expect(meta.canonical).toBe("https://mintvaultuk.com/journal/how-to-grade-pokemon-cards-uk");
    expect(meta.description).toContain("Learn how to grade Pokémon cards");
  });

  it("returns a real noindex 404 for unknown routes and preserves known private routes", () => {
    const unknown = renderPublicHtml(BASE_HTML, "/not-a-real-mv-path");
    expect(unknown.status).toBe(404);
    expect(unknown.noindex).toBe(true);
    expect(unknown.html).toContain('<meta name="robots" content="noindex, nofollow" />');
    expect(isKnownPublicRoute("/not-a-real-mv-path")).toBe(false);

    const privatePage = renderPublicHtml(BASE_HTML, "/account/settings");
    expect(privatePage.status).toBe(200);
    expect(privatePage.noindex).toBe(true);
    expect(isNoindexRoute("/cert/MV-123")).toBe(true);
    const reportMeta = getSeoMeta("/cert/MV-123/report");
    expect(reportMeta.canonical).toBe("https://mintvaultuk.com/cert/MV-123/report");
    expect(reportMeta.noindex).toBe(true);
  });

  it("keeps customer ownership workflows out of indexes even when they have descriptive metadata", () => {
    for (const route of ["/ownership", "/claim", "/transfer", "/dashboard"]) {
      const page = renderPublicHtml(BASE_HTML, route);
      expect(page.status).toBe(200);
      expect(page.noindex).toBe(true);
      expect(page.html).toContain('<meta name="robots" content="noindex, nofollow" />');
      expect(getSeoMeta(route).noindex).toBe(true);
    }
  });

  it("injects search-visible title, description and canonical tags into rendered public HTML", () => {
    const page = renderPublicHtml(BASE_HTML, "/pokemon-card-grading-uk?utm_source=test");
    expect(page.status).toBe(200);
    expect(page.html).toContain("Pokemon Card Grading UK | Professional Grading Service | MintVault");
    expect(page.html).toContain('href="https://mintvaultuk.com/pokemon-card-grading-uk"');
    expect(renderPublicHtml(BASE_HTML, "/journal/first-submission").html).toContain(
      'href="https://mintvaultuk.com/journal/first-submission"'
    );
  });

  it("preserves the original request URL at the mounted SPA catch-all boundary", () => {
    expect(publicRequestPath("/pokemon-card-grading-uk?utm_source=test")).toBe(
      "/pokemon-card-grading-uk?utm_source=test"
    );
    const page = renderPublicHtml(BASE_HTML, publicRequestPath("/not-a-real-mv-path"));
    expect(page.status).toBe(404);
    expect(page.noindex).toBe(true);
    expect(staticAssetOptions.index).toBe(false);
  });

  it("uses current Journal URLs and excludes redirected, private, and unbounded record routes from the deterministic sitemap", () => {
    const entries = getSitemapEntries();
    const locs = entries.map((entry) => entry.loc);
    expect(locs).toContain("/journal");
    expect(locs).toContain("/journal/first-submission");
    expect(locs.filter((loc) => loc.startsWith("/journal/"))).toHaveLength(20);
    expect(locs).toContain("/yugioh-card-grading-uk");
    expect(locs).toContain("/card-grading-near-me");
    expect(locs).not.toContain("/guides");
    expect(locs.some((loc) => loc.startsWith("/guides/"))).toBe(false);
    expect(locs.some((loc) => /^(?:\/admin|\/partner|\/cert\/|\/vault\/|\/population\/certs)/.test(loc))).toBe(false);
    expect(new Set(locs).size).toBe(locs.length);
  });
});
