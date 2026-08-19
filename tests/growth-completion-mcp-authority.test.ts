import fs from "node:fs";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { authorizeGrowthMcp, GROWTH_MCP_PATH, GROWTH_MCP_TOOLS, growthMcpAuthState } from "../server/routes/growth-mcp";
import { getCapacityStatus } from "../server/growth-intelligence-service";
import { getSeoMeta } from "../server/seo-config";
import { renderPublicHtml } from "../server/static";

const originalHash = process.env.GROWTH_MCP_TOKEN_SHA256;
afterEach(() => {
  if (originalHash === undefined) delete process.env.GROWTH_MCP_TOKEN_SHA256;
  else process.env.GROWTH_MCP_TOKEN_SHA256 = originalHash;
});

describe("GB-04C dedicated MCP Growth-read boundary", () => {
  it("fails closed when unconfigured and accepts only the dedicated bearer preimage", () => {
    delete process.env.GROWTH_MCP_TOKEN_SHA256;
    expect(growthMcpAuthState()).toBe("NOT_CONFIGURED");
    expect(authorizeGrowthMcp("Bearer any-token-that-is-long-enough-to-look-plausible")).toBe(false);

    const token = "mv_growth_" + "a".repeat(48);
    process.env.GROWTH_MCP_TOKEN_SHA256 = createHash("sha256").update(token).digest("hex");
    expect(growthMcpAuthState()).toBe("READY");
    expect(authorizeGrowthMcp(`Bearer ${token}`)).toBe(true);
    expect(authorizeGrowthMcp(`Bearer ${token}x`)).toBe(false);
  });

  it("publishes only aggregate read tools with explicit non-destructive annotations", () => {
    expect(GROWTH_MCP_PATH).toBe("/mcp/growth");
    const names = GROWTH_MCP_TOOLS.map(([name]) => name);
    expect(names).toEqual(expect.arrayContaining(["get_growth_summary", "get_review_summary", "get_capacity_status"]));
    expect(names.join(" ")).not.toMatch(/lead|customer|email|query|mutation|refund|deploy|scanner|grade_/i);
    const source = fs.readFileSync("server/routes/growth-mcp.ts", "utf8");
    expect(source).toContain("readOnlyHint: true");
    expect(source).toContain("destructiveHint: false");
    expect(source).toContain("growth_mcp_tool_called");
    expect(source).not.toContain("requireSuperAdmin");
    expect(source).not.toContain("getPartnerApplication(");
  });

  it("exports the real capacity contract and keeps scaling disabled without telemetry", () => {
    expect(getCapacityStatus()).toMatchObject({
      status: "UNKNOWN",
      recommendation: "TELEMETRY_INCOMPLETE",
      automaticScalingEnabled: false,
    });
  });
});

describe("GB-06 public authority MVP", () => {
  it("injects one allowlisted Dataset graph into crawler-visible population HTML", () => {
    const base =
      '<html><head><title>Base</title><meta name="description" content=""><meta property="og:title" content=""><meta property="og:description" content=""><meta property="og:url" content=""><meta name="twitter:title" content=""><meta name="twitter:description" content=""></head><body></body></html>';
    const rendered = renderPublicHtml(base, "/population");
    expect(rendered.status).toBe(200);
    expect(rendered.html.match(/application\/ld\+json/g)).toHaveLength(1);
    expect(rendered.html).toContain('"@type":"Dataset"');
    expect(rendered.html).toContain("small groups suppressed");
    expect(getSeoMeta("/population").canonical).toBe("https://mintvaultuk.com/population");
  });

  it("suppresses small groups and bounds/caches the public aggregate route", () => {
    const storage = fs.readFileSync("server/storage.ts", "utf8");
    const route = fs.readFileSync("server/routes/public.ts", "utf8");
    expect(storage).toContain("HAVING COUNT(*) >= 5");
    expect(route).toContain("totalGraded >= 20");
    expect(route).toContain('state: authorityAvailable ? "PUBLISHED" : "INSUFFICIENT_DATA"');
    expect(route).toContain('Cache-Control", "public, max-age=60, stale-while-revalidate=300');
    expect(route).toContain('app.get("/api/population", populationRateLimit');
    expect(route).toContain("populationCache.size >= 100");
  });

  it("does not create thin parameterised sitemap entries", () => {
    const seo = fs.readFileSync("server/seo-config.ts", "utf8");
    const sitemapSection = seo.slice(seo.indexOf("export function getSitemapEntries"));
    expect(sitemapSection).toContain('{ loc: "/population"');
    expect(sitemapSection).not.toContain("/population?");
  });
});
