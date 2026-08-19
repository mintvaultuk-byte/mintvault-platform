import fs from "node:fs";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import {
  authorizeGrowthMcp,
  GROWTH_MCP_PATH,
  GROWTH_MCP_TOOLS,
  growthMcpAuthState,
  registerGrowthMcpRoutes,
} from "../server/routes/growth-mcp";
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
    expect(names).toEqual(
      expect.arrayContaining([
        "get_growth_summary",
        "get_review_summary",
        "get_capacity_status",
        "get_infrastructure_status",
        "get_campaign_readiness",
        "get_revenue_velocity",
      ])
    );
    expect(names.join(" ")).not.toMatch(/lead|customer|email|query|mutation|refund|deploy|scanner|grade_/i);
    const source = fs.readFileSync("server/routes/growth-mcp.ts", "utf8");
    expect(source).toContain("readOnlyHint: true");
    expect(source).toContain("destructiveHint: false");
    expect(source).toContain("growth_mcp_tool_called");
    expect(source).not.toContain("requireSuperAdmin");
    expect(source).not.toContain("getPartnerApplication(");
  });

  it("enforces bearer auth and serves the stateless JSON-RPC handshake over HTTP", async () => {
    const app = express();
    app.use(express.json());
    registerGrowthMcpRoutes(app);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}${GROWTH_MCP_PATH}`;
    const post = (body: object, authorization?: string) =>
      fetch(base, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authorization ? { authorization } : {}),
        },
        body: JSON.stringify(body),
      });

    try {
      delete process.env.GROWTH_MCP_TOKEN_SHA256;
      const unavailable = await post({ jsonrpc: "2.0", id: 1, method: "initialize" });
      expect(unavailable.status).toBe(503);

      const token = "mv_growth_" + "b".repeat(48);
      process.env.GROWTH_MCP_TOKEN_SHA256 = createHash("sha256").update(token).digest("hex");
      const unauthorized = await post({ jsonrpc: "2.0", id: 2, method: "initialize" }, "Bearer wrong");
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get("www-authenticate")).toContain("MintVault Growth Read");

      const authorization = `Bearer ${token}`;
      const initialized = await post({ jsonrpc: "2.0", id: 3, method: "initialize" }, authorization);
      expect(initialized.status).toBe(200);
      expect(await initialized.json()).toMatchObject({
        jsonrpc: "2.0",
        id: 3,
        result: { serverInfo: { name: "mintvault-growth-read" }, capabilities: { tools: { listChanged: false } } },
      });

      const listed = await post({ jsonrpc: "2.0", id: 4, method: "tools/list" }, authorization);
      const listedBody = (await listed.json()) as { result: { tools: Array<{ name: string; annotations: object }> } };
      expect(listedBody.result.tools.map((tool) => tool.name)).toEqual(GROWTH_MCP_TOOLS.map(([name]) => name));
      expect(listedBody.result.tools.every((tool) => Object.hasOwn(tool.annotations, "readOnlyHint"))).toBe(true);

      const notification = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, authorization);
      expect(notification.status).toBe(204);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        })
      );
    }
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
    expect(route).toContain('app.get("/api/population/certs", populationRateLimit');
    expect(route).toContain("result.rows.length < 5");
    expect(route.match(/Population filters must be 100 characters or fewer/g)).toHaveLength(2);
    expect(route).toContain("populationCache.size >= 100");
  });

  it("does not create thin parameterised sitemap entries", () => {
    const seo = fs.readFileSync("server/seo-config.ts", "utf8");
    const sitemapSection = seo.slice(seo.indexOf("export function getSitemapEntries"));
    expect(sitemapSection).toContain('{ loc: "/population"');
    expect(sitemapSection).not.toContain("/population?");
  });
});
